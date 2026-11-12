// Task ④ 灰度链 E2E：真域库（临时文件）+ 生产组合根装配的真 intake / trigger /
// mandate / decision-log / adjudication 模块。eventRouter 语义由控制面 start() 接管
// （leader 后 sink 才 handled）；mandateGate=true 打开 M4 三档与 M6 方案门。
// specWriteLease / durableSchedulerDispatch 不在本链路，未参与断言。
//
// 只替身宿主边界之外的两端：CommandInbox 网关（真 CommandInbox admission，入站宿主
// 进程不在测试内）、裁决 model 会话（脚本化，零 LLM）与 specRun 发行口（记录调用，
// 证明 commit 后确实发起执行）。模块内部零 mock。
//
// 链路：human-explicit → CommandInbox createTask；unowned 候选 → 裁决 → 隐式
// record_only → would-accept 卡（五字段 scheme）→ promote → mandate(auto) 行 →
// 下一候选命中显式 auto → specRun 发行。注意 mandateGate 开时「显式 record-only
// 决议」不产卡（proposalGate），卡来自 accept 决议 + 隐式 record_only 档位解析；
// 若这里改成 record-only 决议，本链在 (c) 就断了。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandInbox } from "../../src/zcode-protocol-v4/command-inbox.js";
import {
  createSuperAgentControlPlane,
  type SuperAgentCommandHandle,
  type SuperAgentControlPlane,
} from "../../src/app/super-agent-control-plane.js";
import type {
  TriggerSpecRunInput,
  TriggerSpecRunPort,
} from "../../src/super-agent/trigger/index.js";

const WS = "ws-e2e-gray";
const SESSION = "session-e2e-gray";
/** 人触发与候选用不同 bot：human-explicit 会写订阅，同 thread 候选会被 owned 抢走。 */
const HUMAN_THREAD_HINT = "bot:human-bot+u1";
const HUMAN_BOT_ID = "human-bot";
const CANDIDATE_THREAD_HINT = "bot:env-bot+u1";
const CANDIDATE_BOT_ID = "env-bot";
const CANDIDATE_TRIGGER_CLASS = "bot:env-bot";

/** M6 五字段方案卡（accept 决议必需；缺字段 proposalGate 会降级 record_only）。 */
const SCHEME_CARD = {
  currentEvidence: "nightly 构建在 runner.ts:2178 失败，日志显示工具白名单过滤误杀",
  candidateOptions: [
    { option: "双闸过滤（白名单 + 前缀）", cost: "需同步维护两张表" },
    { option: "只过滤 mcp 前缀", cost: "漏掉 WebFetch 别名" },
  ],
  recommendation: "双闸过滤：白名单兜未知新工具，前缀兜已知别名",
  impact: "core/subagent/tool-policy.ts；无协议/存储兼容性变化",
  verification: "npx vitest run spec-restricted-profile；白名单用例全绿",
} as const;

interface InboxHarness {
  handleCommand: SuperAgentCommandHandle;
  envelopes: CommandEnvelope[];
}

/** 真 CommandInbox admission + 立即 settle（入站宿主进程的进程内等价物）。 */
function makeInboxHandle(): InboxHarness {
  const envelopes: CommandEnvelope[] = [];
  const inbox = new CommandInbox({
    getRevision: () => 1,
    getLogEpoch: () => "epoch-e2e-gray",
  });
  const handleCommand: SuperAgentCommandHandle = async (raw) => {
    envelopes.push(raw as CommandEnvelope);
    const outcome = await inbox.handle(raw);
    if (outcome.kind === "ack") return outcome.ack;
    outcome.settle({ status: "accepted" });
    return outcome.ack;
  };
  return { handleCommand, envelopes };
}

const planes: SuperAgentControlPlane[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const plane of planes.splice(0)) {
    try {
      plane.stop();
    } catch {
      // 已关/重复关不掩盖用例失败。
    }
  }
  void Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function readDecisionRows(plane: SuperAgentControlPlane, triggerId: string) {
  return plane.database
    .prepare(
      `select origin, disposition, card_payload from decision_log
        where trigger_id = ? order by rowid`,
    )
    .all(triggerId) as Array<{
    origin: string;
    disposition: string;
    card_payload: string | null;
  }>;
}

function readTriggerState(plane: SuperAgentControlPlane, triggerId: string) {
  return plane.database
    .prepare(
      `select fast_path, adjudication_status, final_disposition
         from trigger_events where id = ?`,
    )
    .get(triggerId) as {
    fast_path: string | null;
    adjudication_status: string | null;
    final_disposition: string | null;
  };
}

function readMandateRows(plane: SuperAgentControlPlane) {
  return plane.database
    .prepare(
      `select workspace_identity, trigger_class, tier, status from mandate
        order by created_at, rowid`,
    )
    .all() as Array<{
    workspace_identity: string;
    trigger_class: string;
    tier: string;
    status: string;
  }>;
}

describe("flag-on 灰度链（真域库 + 真模块，仅宿主端口替身）", () => {
  it("human-explicit → 候选裁决 → would-accept → promote → auto 档 dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-sa-e2e-"));
    roots.push(root);
    const inbox = makeInboxHandle();
    const errors: Array<{ error: unknown; context: string }> = [];

    const specRunStarts: TriggerSpecRunInput[] = [];
    const specRun: TriggerSpecRunPort = {
      async start(input) {
        specRunStarts.push(input);
      },
    };

    let plane: SuperAgentControlPlane | undefined;
    // 脚本化裁决输出直接读真库 pending 行：固定 verdictId 列表会与自动唤醒
    // （最老年龄 ≥ T 的 fireWake）赛跑，导致批次可能在 id 入列前被消费。
    const adjudicationRun = vi.fn(async () => {
      if (!plane) throw new Error("裁决会话在控制面装配前被调用");
      const pending = plane.database
        .prepare(
          `select id from trigger_events
            where workspace_identity = ? and fast_path = 'unowned_candidate'
              and adjudication_status = 'pending'
            order by created_at, id`,
        )
        .all(WS) as Array<{ id: string }>;
      return {
        outputText: JSON.stringify({
          decisions: pending.map((row) => ({
            triggerId: row.id,
            disposition: "accept",
            reason: "问题明确，按方案执行",
            evidence: ["payload 摘要"],
            scheme: SCHEME_CARD,
          })),
        }),
      };
    });

    plane = await createSuperAgentControlPlane({
      workspaceIdentity: WS,
      ownerId: "owner-e2e-gray",
      onError: (error, context) => errors.push({ error, context }),
      sessionFace: { sessionId: SESSION, isIdle: () => true },
      hostPorts: {
        handleCommand: inbox.handleCommand,
        autoReplyGuard: { admit: async () => true },
        superAgentDatabasePath: join(root, "super-agent.sqlite"),
      },
      adjudicationSession: { run: adjudicationRun, destroySession: vi.fn() },
      mandateGate: true,
      specRun,
    });
    planes.push(plane);
    await plane.start();
    expect(plane.isLeader()).toBe(true);

    // (b) human-explicit：无 worker → createTask，经 CommandInbox 唯一 admission。
    const humanResult = await plane.triggerSink.ingest({
      workspaceIdentity: WS,
      source: "im",
      provider: "feishu",
      providerMessageId: "pm-e2e-human-1",
      threadKeyHint: HUMAN_THREAD_HINT,
      actor: { kind: "human", id: "u1" },
      payload: {
        text: "帮我把 nightly 失败的构建修了",
        chatType: "private",
        botId: HUMAN_BOT_ID,
      },
      taint: true,
    });
    expect(humanResult).toMatchObject({ handled: true, route: "human_explicit" });
    if (!humanResult.handled) throw new Error("unreachable");
    expect(errors).toEqual([]);

    expect(inbox.envelopes).toHaveLength(1);
    const wakeEnvelope = inbox.envelopes[0]!;
    expect(wakeEnvelope).toMatchObject({
      commandId: `${humanResult.triggerId}:${SESSION}`,
      clientId: "super-agent-trigger",
      sessionId: SESSION,
      type: "sendText",
      triggerId: humanResult.triggerId,
      taint: true,
      payload: {
        requestedDelivery: "queue",
        text: expect.stringContaining("nightly 失败的构建"),
      },
    });
    // spec §8-13：human_explicit 的终态以 decision_log(fast_path,routed) + fast_path
    // 表达，final_disposition 保持 NULL（现有写者仅 intake=rejected / routeOwned=routed）。
    expect(readTriggerState(plane, humanResult.triggerId)).toMatchObject({
      fast_path: "human_explicit",
      final_disposition: null,
    });
    expect(readDecisionRows(plane, humanResult.triggerId)).toEqual([
      expect.objectContaining({ origin: "fast_path", disposition: "routed" }),
    ]);
    // createTask 分支落订阅（lane=followup），供后续同 thread 触发走 owned。
    expect(
      plane.database
        .prepare(
          `select thread_key, lane, status from trigger_subscriptions
            where workspace_identity = ?`,
        )
        .all(WS),
    ).toEqual([
      {
        thread_key: `${WS}|${HUMAN_THREAD_HINT}`,
        lane: "followup",
        status: "active",
      },
    ]);

    // (c) unowned 候选：裁决 accept + 隐式 record_only 档 → would-accept 卡。
    const candidate1 = await plane.triggerSink.ingest({
      workspaceIdentity: WS,
      source: "im",
      provider: "feishu",
      providerMessageId: "pm-e2e-cand-1",
      threadKeyHint: CANDIDATE_THREAD_HINT,
      actor: { kind: "bot", id: "b-env" },
      payload: {
        text: "构建机器人通报：nightly failed",
        chatType: "private",
        botId: CANDIDATE_BOT_ID,
      },
      taint: true,
    });
    expect(candidate1).toMatchObject({ handled: true, route: "unowned_candidate" });
    if (!candidate1.handled) throw new Error("unreachable");

    const batch1 = await plane.contracts.adjudication.runBatch(WS);
    expect(batch1.status).toBe("applied");
    expect(batch1.mandateTier).toBe("record_only");
    expect(batch1.decisions).toEqual([
      expect.objectContaining({ triggerId: candidate1.triggerId, disposition: "accept" }),
    ]);
    expect(errors).toEqual([]);

    expect(readTriggerState(plane, candidate1.triggerId)).toMatchObject({
      fast_path: "unowned_candidate",
      adjudication_status: "record_only",
    });
    const candidate1Decisions = readDecisionRows(plane, candidate1.triggerId);
    expect(candidate1Decisions).toContainEqual(
      expect.objectContaining({ origin: "fast_path", disposition: "record_only" }),
    );
    const cardRow = candidate1Decisions.find((row) => row.origin === "adjudication");
    expect(cardRow).toMatchObject({ disposition: "would_accept" });
    expect(JSON.parse(cardRow!.card_payload!)).toEqual(SCHEME_CARD);

    const cards = plane.listPendingWouldAccept();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({
      source: "im",
      suggestedTier: "record_only",
      summary: expect.stringContaining("nightly failed"),
      scheme: SCHEME_CARD,
    });
    // record_only 档不执行：无 CommandInbox 新投递、无 specRun、无 mandate 行。
    expect(inbox.envelopes).toHaveLength(1);
    expect(specRunStarts).toEqual([]);
    expect(readMandateRows(plane)).toEqual([]);

    // (d) promote：写 auto mandate 行 + 转化行，读面收敛。
    await plane.promoteWouldAccept(card.cardId);
    expect(readMandateRows(plane)).toEqual([
      {
        workspace_identity: WS,
        trigger_class: CANDIDATE_TRIGGER_CLASS,
        tier: "auto",
        status: "active",
      },
    ]);
    expect(
      readDecisionRows(plane, candidate1.triggerId).find(
        (row) => row.origin === "would_accept_convert",
      ),
    ).toMatchObject({ disposition: "accept" });
    expect(plane.listPendingWouldAccept()).toEqual([]);
    expect(inbox.envelopes).toHaveLength(1);
    // 批转当前卡也立即派发：不是只给未来事件写授权。
    await vi.waitFor(() => expect(specRunStarts).toHaveLength(1));
    expect(specRunStarts[0]).toMatchObject({
      triggerId: candidate1.triggerId,
      workspaceIdentity: WS,
      threadKey: `${WS}|${CANDIDATE_THREAD_HINT}`,
      source: "im",
      tier: "auto",
      card: SCHEME_CARD,
    });

    // (e) 下一候选命中显式 auto 档：commit 后 specRun 发行即派发事实。
    const candidate2 = await plane.triggerSink.ingest({
      workspaceIdentity: WS,
      source: "im",
      provider: "feishu",
      providerMessageId: "pm-e2e-cand-2",
      threadKeyHint: CANDIDATE_THREAD_HINT,
      actor: { kind: "bot", id: "b-env" },
      payload: {
        text: "构建机器人通报：nightly failed（第二次）",
        chatType: "private",
        botId: CANDIDATE_BOT_ID,
      },
      taint: true,
    });
    expect(candidate2).toMatchObject({ handled: true, route: "unowned_candidate" });
    if (!candidate2.handled) throw new Error("unreachable");

    const batch2 = await plane.contracts.adjudication.runBatch(WS);
    expect(batch2.status).toBe("applied");
    expect(batch2.mandateTier).toBe("auto");
    expect(batch2.decisions).toEqual([
      expect.objectContaining({ triggerId: candidate2.triggerId, disposition: "accept" }),
    ]);
    expect(errors).toEqual([]);

    await vi.waitFor(() => expect(specRunStarts).toHaveLength(2));
    expect(specRunStarts[1]).toMatchObject({
      triggerId: candidate2.triggerId,
      workspaceIdentity: WS,
      threadKey: `${WS}|${CANDIDATE_THREAD_HINT}`,
      source: "im",
      tier: "auto",
      card: SCHEME_CARD,
    });
    expect(readTriggerState(plane, candidate2.triggerId)).toMatchObject({
      adjudication_status: "accepted",
    });
    const candidate2Decisions = readDecisionRows(plane, candidate2.triggerId);
    expect(candidate2Decisions).toContainEqual(
      expect.objectContaining({ origin: "adjudication", disposition: "accept" }),
    );
    expect(
      candidate2Decisions.some((row) => row.disposition === "would_accept"),
    ).toBe(false);
    // auto 档走 spec lane，不新增 CommandInbox 投递；卡与 mandate 行保持收敛。
    expect(inbox.envelopes).toHaveLength(1);
    expect(plane.listPendingWouldAccept()).toEqual([]);
    expect(readMandateRows(plane)).toHaveLength(1);
  });
});
