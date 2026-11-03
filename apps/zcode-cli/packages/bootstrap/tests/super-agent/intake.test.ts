import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createDecisionLog } from "../../src/super-agent/decision-log/index.js";
import {
  createSuperAgentIntake,
  runSubscriptionBackfill,
  TRIGGER_PAYLOAD_MAX_BYTES,
  type SuperAgentIntakeContract,
  type TriggerEnvelope,
} from "../../src/super-agent/intake/index.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

interface Harness {
  intake: SuperAgentIntakeContract;
  guardAdmissions: TriggerEnvelope[];
}

async function createHarness(options?: {
  guardAdmit?: boolean | ((envelope: TriggerEnvelope) => boolean);
  now?: () => number;
  /** 注入 decision_log 失败（首次 record 抛错），验证行收敛与 decision 同事务回滚。 */
  decisionLogFailFirst?: boolean;
}): Promise<Harness> {
  db = await openSuperAgentDatabase({ databasePath: ":memory:" });
  const realDecisionLog = createDecisionLog(db);
  let failNextRecord = options?.decisionLogFailFirst === true;
  const decisionLog = {
    record(entry: Parameters<typeof realDecisionLog.record>[0]): void {
      if (failNextRecord) {
        failNextRecord = false;
        throw new Error("注入：decision_log.record 失败");
      }
      realDecisionLog.record(entry);
    },
  };
  const guardAdmissions: TriggerEnvelope[] = [];
  const intake = createSuperAgentIntake({
    db,
    decisionLog,
    autoReplyGuard: {
      admit: async (envelope) => {
        guardAdmissions.push(envelope);
        const guard = options?.guardAdmit;
        if (typeof guard === "function") return guard(envelope);
        return guard ?? true;
      },
    },
    now: options?.now,
  });
  return { intake, guardAdmissions };
}

function envelope(overrides?: Partial<TriggerEnvelope>): TriggerEnvelope {
  return {
    workspaceIdentity: "ws-a",
    source: "im",
    provider: "feishu",
    providerMessageId: "om-1",
    threadKeyHint: "bot:b1+u1",
    actor: { kind: "human", id: "u1" },
    payload: {
      botId: "b1",
      chatType: "private",
      mentionedBot: false,
      senderType: "user",
      text: "hello",
    },
    taint: true,
    ...overrides,
  };
}

function insertActiveSubscription(input: {
  workspaceIdentity: string;
  threadKey: string;
  sessionId: string;
}): void {
  db!.prepare(
    `insert into trigger_subscriptions (
      id, workspace_identity, thread_key, session_id, lane, filters,
      owner_kind, owner_ref, status, lease_expires_at, created_at, updated_at
    ) values (?, ?, ?, ?, 'followup', NULL, 'session', NULL, 'active', ?, ?, ?)`,
  ).run(
    "sub-1",
    input.workspaceIdentity,
    input.threadKey,
    input.sessionId,
    Date.now() + 60_000,
    Date.now(),
    Date.now(),
  );
}

function triggerRow(providerMessageId: string): Record<string, unknown> {
  return db!
    .prepare("select * from trigger_events where provider_message_id = ?")
    .get(providerMessageId) as Record<string, unknown>;
}

function decisionRows(): Record<string, unknown>[] {
  return db!.prepare("select * from decision_log order by created_at").all() as Record<
    string,
    unknown
  >[];
}

describe("super-agent-intake Fast Path 三边矩阵（spec §3.1）", () => {
  it("命中 active 订阅 → owned：fast_path=owned、decision routed，零 adjudication", async () => {
    const { intake } = await createHarness();
    insertActiveSubscription({
      workspaceIdentity: "ws-a",
      threadKey: "ws-a|bot:b1+u1",
      sessionId: "session-1",
    });

    const result = await intake.ingest(envelope());

    expect(result.route).toBe("owned");
    const row = triggerRow("om-1");
    expect(row.fast_path).toBe("owned");
    expect(row.adjudication_status).toBeNull();
    expect(row.final_disposition).toBeNull();
    expect(row.taint).toBe(1);
    expect(decisionRows()).toEqual([
      expect.objectContaining({
        origin: "fast_path",
        disposition: "routed",
        trigger_id: result.triggerId,
        reason: "fast-path-owned",
      }),
    ]);
  });

  it("未命中订阅 + 私聊人类 → human_explicit", async () => {
    const { intake } = await createHarness();
    const result = await intake.ingest(envelope());
    expect(result.route).toBe("human_explicit");
    expect(triggerRow("om-1").fast_path).toBe("human_explicit");
  });

  it("未命中订阅 + 群内被 @ 的人类 → human_explicit", async () => {
    const { intake } = await createHarness();
    const result = await intake.ingest(
      envelope({
        threadKeyHint: "bot:b1+chat-9/t-1",
        actor: { kind: "human", id: "u1" },
        payload: {
          botId: "b1",
          chatType: "group",
          chatId: "chat-9",
          threadId: "t-1",
          mentionedBot: true,
          senderType: "user",
          text: "@bot 继续",
        },
      }),
    );
    expect(result.route).toBe("human_explicit");
  });

  it("addressed 且非人（environment-triggered explicit）→ unowned_candidate + adjudication pending", async () => {
    const { intake } = await createHarness();
    const result = await intake.ingest(
      envelope({
        actor: { kind: "bot", id: "other-bot" },
        payload: {
          botId: "b1",
          chatType: "group",
          chatId: "chat-9",
          mentionedBot: true,
          senderType: "app",
          text: "deploy finished",
        },
      }),
    );
    expect(result.route).toBe("unowned_candidate");
    const row = triggerRow("om-1");
    expect(row.fast_path).toBe("unowned_candidate");
    expect(row.adjudication_status).toBe("pending");
    expect(decisionRows()[0]).toMatchObject({ disposition: "record_only" });
  });

  it("来源不在白名单（schedule 不经 intake，§5.2）→ rejected：fast_path NULL + 终态", async () => {
    const { intake } = await createHarness();
    const result = await intake.ingest(envelope({ source: "schedule" }));
    expect(result.route).toBe("rejected");
    const row = triggerRow("om-1");
    expect(row.fast_path).toBeNull();
    expect(row.final_disposition).toBe("rejected");
    expect(Number(row.settled_at)).toBeGreaterThan(0);
    expect(decisionRows()[0]).toMatchObject({
      disposition: "reject",
      reason: "fast-path-rejected:source-not-in-whitelist",
    });
  });

  it("互答守卫拒绝（admitAutoReplyTurn 语义复用）→ rejected", async () => {
    const { intake, guardAdmissions } = await createHarness({ guardAdmit: false });
    const result = await intake.ingest(envelope());
    expect(result.route).toBe("rejected");
    expect(guardAdmissions).toHaveLength(1);
    expect(decisionRows()[0]).toMatchObject({ reason: "fast-path-rejected:auto-reply-guard" });
  });

  it("群内 observed（未 @、非交互）且无订阅 → rejected（observed-not-addressed），不进互答守卫", async () => {
    const { intake, guardAdmissions } = await createHarness();
    const result = await intake.ingest(
      envelope({
        threadKeyHint: "bot:b1+chat-9",
        payload: {
          botId: "b1",
          chatType: "group",
          chatId: "chat-9",
          mentionedBot: false,
          senderType: "user",
          text: "旁听消息",
        },
      }),
    );
    expect(result.route).toBe("rejected");
    // §3.1 顺序：无订阅 observed 在 admitAutoReplyTurn 之前丢弃，守卫不得被旁观消息消耗/改写状态。
    expect(guardAdmissions).toHaveLength(0);
    expect(decisionRows()[0]).toMatchObject({ reason: "fast-path-rejected:observed-not-addressed" });
  });

  it("无订阅的话题延续消息（legacy 不丢弃）P2 按 observed 拒，不进守卫（实施偏差锁定）", async () => {
    const { intake, guardAdmissions } = await createHarness();
    // legacy 例外依赖 topicActive/topicRootIsCurrentBot/continuation，信封 payload 未携带；
    // P2 只对齐主干旁听丢弃，该取舍由 spec §2.1 ws6-intake 实施偏差声明并用本用例锁定。
    const result = await intake.ingest(
      envelope({
        threadKeyHint: "bot:b1+chat-9/t-topic",
        payload: {
          botId: "b1",
          chatType: "group",
          chatId: "chat-9",
          threadId: "t-topic",
          mentionedBot: false,
          senderType: "user",
          text: "话题延续消息",
        },
      }),
    );
    expect(result.route).toBe("rejected");
    expect(guardAdmissions).toHaveLength(0);
    expect(decisionRows()[0]).toMatchObject({
      reason: "fast-path-rejected:observed-not-addressed",
    });
  });

  it("群内 observed 但命中订阅 → owned（订阅优先于 addressed 判定，仍过守卫）", async () => {
    const { intake, guardAdmissions } = await createHarness();
    insertActiveSubscription({
      workspaceIdentity: "ws-a",
      threadKey: "ws-a|bot:b1+chat-9/t-1",
      sessionId: "session-1",
    });
    const result = await intake.ingest(
      envelope({
        threadKeyHint: "bot:b1+chat-9/t-1",
        payload: {
          botId: "b1",
          chatType: "group",
          chatId: "chat-9",
          threadId: "t-1",
          mentionedBot: false,
          senderType: "user",
          text: "话题内旁听",
        },
      }),
    );
    expect(result.route).toBe("owned");
    expect(guardAdmissions).toHaveLength(1);
  });

  it("拿不到域键（无 hint 且无 botId/peer）→ rejected:unscoped-thread", async () => {
    const { intake } = await createHarness();
    const result = await intake.ingest(
      envelope({
        threadKeyHint: undefined,
        actor: { kind: "human" },
        payload: { chatType: "private", text: "x" },
      }),
    );
    expect(result.route).toBe("rejected");
    expect(triggerRow("om-1").thread_key).toBe("ws-a|unscoped");
  });

  it("无 threadKeyHint 时按 payload 同规则铸造域键（出口缺 hint 也能对上回填订阅）", async () => {
    const { intake } = await createHarness();
    runSubscriptionBackfill({
      db: db!,
      seeds: [
        {
          workspaceIdentity: "ws-a",
          sessionId: "session-1",
          botId: "b1",
          peerId: "u1",
        },
      ],
    });
    const result = await intake.ingest(
      envelope({
        threadKeyHint: undefined,
        payload: {
          botId: "b1",
          chatType: "private",
          // peer 槽：私聊无 chatId 时回退 actor.id。
          mentionedBot: false,
          senderType: "user",
          text: "hi",
        },
      }),
    );
    expect(result.route).toBe("owned");
  });
});

describe("super-agent-intake 幂等（裁定 3：DB unique 权威）", () => {
  it("同 providerMessageId 双 ingest：单行、同 triggerId、decision_log 单行", async () => {
    const { intake } = await createHarness();
    const first = await intake.ingest(envelope());
    const replay = await intake.ingest(envelope({ payload: { text: "changed on replay" } }));

    expect(replay).toEqual(first);
    const rows = db!.prepare("select count(*) as n from trigger_events").get() as { n: number };
    expect(Number(rows.n)).toBe(1);
    expect(decisionRows()).toHaveLength(1);
  });

  it("重复 rejected 摄取同样短路：终态行不重写、不落第二条 decision", async () => {
    const { intake } = await createHarness();
    const first = await intake.ingest(envelope({ source: "schedule" }));
    const replay = await intake.ingest(envelope({ source: "schedule" }));
    expect(replay).toEqual(first);
    expect(decisionRows()).toHaveLength(1);
  });

  it("崩溃缝（行已插、Fast Path 未收敛）重投 → 重算并收敛，不新增行", async () => {
    const { intake } = await createHarness();
    // 直接落一条未收敛行，模拟 ingest 在 Fast Path 前中断。
    db!.prepare(
      `insert into trigger_events (
        id, workspace_identity, source, thread_key, actor_kind, actor_id,
        payload, payload_digest, taint, provider, provider_message_id,
        fast_path, adjudication_status, final_disposition, settled_at, created_at, updated_at
      ) values ('crash-1', 'ws-a', 'im', 'ws-a|bot:b1+u1', 'human', 'u1',
        '{}', 'x', 1, 'feishu', 'om-crash', NULL, NULL, NULL, NULL, 1, 1)`,
    ).run();

    const result = await intake.ingest(envelope({ providerMessageId: "om-crash" }));

    expect(result).toEqual({ triggerId: "crash-1", route: "human_explicit" });
    const count = db!.prepare("select count(*) as n from trigger_events").get() as { n: number };
    expect(Number(count.n)).toBe(1);
    expect(triggerRow("om-crash").fast_path).toBe("human_explicit");
  });

  it("taint 非 true 一律抛错（信封伪造 fail-loud，§5）", async () => {
    const { intake } = await createHarness();
    const forged = { ...envelope(), taint: false } as unknown as TriggerEnvelope;
    await expect(intake.ingest(forged)).rejects.toThrow(/taint/);
    const count = db!.prepare("select count(*) as n from trigger_events").get() as { n: number };
    expect(Number(count.n)).toBe(0);
  });

  it("decision_log.record 失败：行收敛同事务回滚，重投补写恰好一行 decision_log（T6）", async () => {
    const { intake } = await createHarness({ decisionLogFailFirst: true });

    await expect(intake.ingest(envelope())).rejects.toThrow(/decision_log\.record 失败/);

    // 首次：INSERT 已提交，但 fast_path 收敛与 decision 同事务回滚 → 行未收敛、零 decision。
    const afterFail = triggerRow("om-1");
    expect(afterFail.fast_path).toBeNull();
    expect(afterFail.final_disposition).toBeNull();
    expect(decisionRows()).toHaveLength(0);

    // 重投走幂等短路 → routeFromRow 未收敛 → 重算 Fast Path 并原子补写。
    const replay = await intake.ingest(envelope());
    expect(replay.route).toBe("human_explicit");
    expect(triggerRow("om-1").fast_path).toBe("human_explicit");
    expect(decisionRows()).toHaveLength(1);
    expect(decisionRows()[0]).toMatchObject({
      origin: "fast_path",
      disposition: "routed",
      trigger_id: replay.triggerId,
    });
    const count = db!.prepare("select count(*) as n from trigger_events").get() as { n: number };
    expect(Number(count.n)).toBe(1);
  });
});

describe("super-agent-intake payload 摘要（§1.2）", () => {
  it("≤64KB 原样落库且 digest=sha256(payload)；超限截断 + 标记", async () => {
    const { intake } = await createHarness();
    const huge = "字".repeat(TRIGGER_PAYLOAD_MAX_BYTES); // UTF-8 三字节字符，远超上限
    await intake.ingest(envelope({ providerMessageId: "om-big", payload: { text: huge, botId: "b1" } }));
    const bigRow = triggerRow("om-big");
    const bigPayload = String(bigRow.payload);
    expect(Buffer.byteLength(bigPayload, "utf8")).toBeLessThanOrEqual(TRIGGER_PAYLOAD_MAX_BYTES);
    expect(bigPayload.endsWith("…[truncated]")).toBe(true);
    expect(bigRow.payload_digest).toBe(createHash("sha256").update(bigPayload).digest("hex"));

    await intake.ingest(envelope({ providerMessageId: "om-small", payload: { text: "hi" } }));
    const smallRow = triggerRow("om-small");
    expect(smallRow.payload).toBe(JSON.stringify({ text: "hi" }));
    expect(smallRow.payload_digest).toBe(
      createHash("sha256").update(String(smallRow.payload)).digest("hex"),
    );
  });
});

describe("super-agent-intake 存量订阅回填（§5.1）", () => {
  it("回填落 active followup/session 行；重复执行零新增；与 ingest 域键格式对齐", async () => {
    const { intake } = await createHarness();
    const seeds = [
      { workspaceIdentity: "ws-a", sessionId: "session-1", botId: "b1", peerId: "u1" },
      {
        workspaceIdentity: "ws-a",
        sessionId: "session-2",
        botId: "b1",
        peerId: "chat-9",
        threadId: "t-1",
      },
      // 重复种子：同 (ws, threadKey, session) 被 partial unique index 吸收。
      { workspaceIdentity: "ws-a", sessionId: "session-1", botId: "b1", peerId: "u1" },
    ];
    const firstRun = runSubscriptionBackfill({ db: db!, seeds, now: 1_000 });
    expect(firstRun).toEqual({ scanned: 3, inserted: 2 });

    const secondRun = runSubscriptionBackfill({ db: db!, seeds, now: 2_000 });
    expect(secondRun).toEqual({ scanned: 3, inserted: 0 });

    const rows = db!
      .prepare(
        "select thread_key, session_id, lane, owner_kind, status from trigger_subscriptions order by session_id",
      )
      .all() as Record<string, unknown>[];
    expect(rows).toEqual([
      {
        thread_key: "ws-a|bot:b1+u1",
        session_id: "session-1",
        lane: "followup",
        owner_kind: "session",
        status: "active",
      },
      {
        thread_key: "ws-a|bot:b1+chat-9/t-1",
        session_id: "session-2",
        lane: "followup",
        owner_kind: "session",
        status: "active",
      },
    ]);

    // 回填订阅立即服务 owned 直通：同一会话地址的新消息命中。
    const ownedHit = await intake.ingest(
      envelope({
        providerMessageId: "om-after-backfill",
        threadKeyHint: "bot:b1+chat-9/t-1",
        payload: {
          botId: "b1",
          chatType: "group",
          chatId: "chat-9",
          threadId: "t-1",
          mentionedBot: false,
          senderType: "user",
          text: "回填线程消息",
        },
      }),
    );
    expect(ownedHit.route).toBe("owned");
  });
});
