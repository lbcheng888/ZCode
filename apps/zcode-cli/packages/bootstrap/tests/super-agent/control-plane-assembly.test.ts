// lane W 装配级集成测试（spec super-agent-trigger-subsystem-spec §4.1 A1/A2/A4 的
// 里程碑 A 装配面）：真域库（openSuperAgentDatabase）+ 真 CommandInbox + 模块 contract
// 工厂全链接线。跨层端口按测试替身纪律注入（guard/裁决 model 会话只存在于测试代码）。
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

import { CommandInbox } from "../../src/zcode-protocol-v4/command-inbox.js";
import {
  createCommandInboxDispatchPush,
  createCommandInboxTriggerDelivery,
  createSuperAgentControlPlane,
  type SuperAgentCommandHandle,
  type SuperAgentControlPlane,
} from "../../src/app/super-agent-control-plane.js";
import { dispatchCommandIdForRun } from "../../src/super-agent/trigger/index.js";

interface Harness {
  plane: SuperAgentControlPlane;
  /** handleCommand 收到的全部信封（按投递顺序）。 */
  envelopes: CommandEnvelope[];
  errors: Array<{ error: unknown; context: string }>;
  guardAdmit: ReturnType<typeof vi.fn>;
  adjudicationRun: ReturnType<typeof vi.fn>;
  root: string;
}

const WS = "ws-assembly";
const SESSION = "session-assembly";
const THREAD_HINT = "bot:b1+u1";
const THREAD_KEY = `${WS}|${THREAD_HINT}`;

const planes: SuperAgentControlPlane[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const plane of planes.splice(0)) {
    try {
      plane.stop();
    } catch {
      // 已关/重复关在断言后不掩盖失败。
    }
  }
  // rm 串行清理；失败不阻断其它用例（tmp 目录由系统回收）。
  void Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function makeInboxHandle(): {
  handleCommand: SuperAgentCommandHandle;
  envelopes: CommandEnvelope[];
} {
  const envelopes: CommandEnvelope[] = [];
  const inbox = new CommandInbox({
    getRevision: () => 1,
    getLogEpoch: () => "epoch-assembly",
  });
  const handleCommand: SuperAgentCommandHandle = async (raw) => {
    // 测试侧 handleCommand = gateway.handleCommand 的 admission 等价物：inbox 准入即回执，
    // execute 分支立刻 settle（生产由协议宿主执行命令后 settle，回执语义同为 admission ACK）。
    const outcome = await inbox.handle(raw);
    if (outcome.kind === "ack") return outcome.ack;
    outcome.settle({ status: "accepted" });
    return outcome.ack;
  };
  // 包一层捕获信封（断言用；不改变准入语义）。
  const capturing: SuperAgentCommandHandle = async (raw) => {
    envelopes.push(raw as CommandEnvelope);
    return handleCommand(raw);
  };
  return { handleCommand: capturing, envelopes };
}

async function makePlane(
  overrides: {
    tasksIndexDatabasePath?: string;
    sessionIdle?: () => boolean;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "zcode-sa-plane-"));
  roots.push(root);
  const { handleCommand, envelopes } = makeInboxHandle();
  const errors: Array<{ error: unknown; context: string }> = [];
  const guardAdmit = vi.fn(async () => true);
  const adjudicationRun = vi.fn(async () => {
    throw new Error("零 LLM 锚点：本用例不应触达裁决模型会话");
  });
  const plane = await createSuperAgentControlPlane({
    workspaceIdentity: WS,
    ownerId: `owner-${root}`,
    onError: (error, context) => errors.push({ error, context }),
    sessionFace: {
      sessionId: SESSION,
      isIdle: overrides.sessionIdle ?? (() => true),
    },
    hostPorts: {
      handleCommand,
      autoReplyGuard: { admit: guardAdmit },
      superAgentDatabasePath: join(root, "super-agent.sqlite"),
      ...(overrides.tasksIndexDatabasePath
        ? { tasksIndexDatabasePath: overrides.tasksIndexDatabasePath }
        : {}),
    },
    adjudicationSession: { run: adjudicationRun, destroySession: vi.fn() },
  });
  planes.push(plane);
  await plane.start();
  return { plane, envelopes, errors, guardAdmit, adjudicationRun, root };
}

function envelope(input: {
  providerMessageId: string;
  actorKind?: "human" | "bot";
  payload?: Record<string, unknown>;
  threadKeyHint?: string;
}) {
  return {
    workspaceIdentity: WS,
    source: "im" as const,
    provider: "feishu",
    providerMessageId: input.providerMessageId,
    ...(input.threadKeyHint !== undefined ? { threadKeyHint: input.threadKeyHint } : {}),
    actor: { kind: input.actorKind ?? "human", id: "u1" },
    payload: input.payload ?? { text: "你好" },
    taint: true as const,
  };
}

function readDecisionRows(plane: SuperAgentControlPlane, triggerId: string) {
  return plane.database
    .prepare(
      "select origin, disposition from decision_log where trigger_id = ? order by created_at",
    )
    .all(triggerId) as Array<{ origin: string; disposition: string }>;
}

function readFinalDisposition(plane: SuperAgentControlPlane, triggerId: string): string | null {
  const row = plane.database
    .prepare("select final_disposition from trigger_events where id = ?")
    .get(triggerId) as { final_disposition: string | null } | undefined;
  return row?.final_disposition ?? null;
}

function readSubscriptions(plane: SuperAgentControlPlane) {
  return plane.database
    .prepare(
      "select session_id, lane, status from trigger_subscriptions where workspace_identity = ?",
    )
    .all(WS) as Array<{ session_id: string; lane: string; status: string }>;
}

describe("super-agent 控制面装配（flag-on，真 DB + 真 CommandInbox）", () => {
  it("owned 直通：订阅命中 → 零 LLM → CommandInbox admission（A1）", async () => {
    const { plane, envelopes, errors, guardAdmit, adjudicationRun } = await makePlane();
    plane.contracts.trigger.upsertSubscription({
      workspaceIdentity: WS,
      threadKey: THREAD_KEY,
      sessionId: SESSION,
      lane: "followup",
      ownerKind: "session",
    });

    const result = await plane.triggerSink.ingest(
      envelope({
        providerMessageId: "pm-owned-1",
        actorKind: "bot",
        // 群内旁听（无 @）也走 owned：订阅命中先于 addressed 判定（§3.1 顺序）。
        payload: { text: "PR #42 有新评论", chatType: "group", botId: "b1", chatId: "u1" },
        threadKeyHint: THREAD_HINT,
      }),
    );

    expect(result).toEqual({
      handled: true,
      triggerId: expect.any(String),
      route: "owned",
    });
    const triggerId = result.handled ? result.triggerId : "";
    expect(triggerId).not.toBe("");
    // 守卫被咨询（装配接线证据），裁决会话零调用（热路径零 LLM）。
    expect(guardAdmit).toHaveBeenCalledTimes(1);
    expect(adjudicationRun).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    // CommandInbox 收到单播投递：幂等键 triggerId+sessionId、taint 透传、followup→queue。
    expect(envelopes).toHaveLength(1);
    const delivered = envelopes[0]!;
    expect(delivered.commandId).toBe(`${triggerId}:${SESSION}`);
    expect(delivered.sessionId).toBe(SESSION);
    expect(delivered.triggerId).toBe(triggerId);
    expect(delivered.taint).toBe(true);
    expect(delivered.type).toBe("sendText");
    expect(delivered.payload).toMatchObject({
      text: "PR #42 有新评论",
      requestedDelivery: "queue",
    });
    // 行收敛 + decision_log 同事务（§3.1 步 2）。
    expect(readFinalDisposition(plane, triggerId)).toBe("routed");
    expect(readDecisionRows(plane, triggerId)).toEqual([
      { origin: "fast_path", disposition: "routed" },
    ]);
  });

  it("human-explicit 直通：无 worker → createTask 经 CommandInbox + 写订阅（A2 装配面）", async () => {
    const { plane, envelopes, errors, adjudicationRun } = await makePlane();

    const result = await plane.triggerSink.ingest(
      envelope({
        providerMessageId: "pm-hx-create-1",
        actorKind: "human",
        payload: { text: "帮我把这个登录闪退修了", chatType: "private", botId: "b1" },
        threadKeyHint: THREAD_HINT,
      }),
    );

    expect(result).toMatchObject({ handled: true, route: "human_explicit" });
    const triggerId = result.handled ? result.triggerId : "";
    expect(adjudicationRun).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    // createTask：向本会话提交唤醒输入（幂等键同 fan-out 键），随后分派器 upsert 订阅。
    expect(envelopes).toHaveLength(1);
    const delivered = envelopes[0]!;
    expect(delivered.commandId).toBe(`${triggerId}:${SESSION}`);
    expect(delivered.triggerId).toBe(triggerId);
    expect(delivered.taint).toBe(true);
    expect(delivered.payload).toMatchObject({
      text: expect.stringContaining("登录闪退"),
      requestedDelivery: "queue",
    });
    expect(readSubscriptions(plane)).toEqual([
      { session_id: SESSION, lane: "followup", status: "active" },
    ]);
    expect(readDecisionRows(plane, triggerId)).toEqual([
      { origin: "fast_path", disposition: "routed" },
    ]);
  });

  it("owned 直通按订阅车道投递：lane=guide → wire requestedDelivery=guide（M1 车道表）", async () => {
    // human-explicit 的 busy 分支在 sink 全链不可达（human_explicit 前提 = 无订阅，
    // 而 findWorker 读同一张订阅表）——车道语义改由 guide 订阅的 owned 直通覆盖，
    // dispatchHumanExplicit busy 矩阵归 trigger 单测（trigger-human-explicit.test）。
    const { plane, envelopes, errors, adjudicationRun } = await makePlane({
      sessionIdle: () => false,
    });
    plane.contracts.trigger.upsertSubscription({
      workspaceIdentity: WS,
      threadKey: THREAD_KEY,
      sessionId: SESSION,
      lane: "guide",
      ownerKind: "session",
    });

    const result = await plane.triggerSink.ingest(
      envelope({
        providerMessageId: "pm-owned-guide-1",
        actorKind: "human",
        payload: { text: "改一下验收步骤", chatType: "private", botId: "b1" },
        threadKeyHint: THREAD_HINT,
      }),
    );

    expect(result).toMatchObject({ handled: true, route: "owned" });
    expect(errors).toEqual([]);
    expect(adjudicationRun).not.toHaveBeenCalled();
    expect(envelopes).toHaveLength(1);
    const delivered = envelopes[0]!;
    expect(delivered.commandId).toBe(
      `${result.handled ? result.triggerId : ""}:${SESSION}`,
    );
    expect(delivered.payload).toMatchObject({ requestedDelivery: "guide" });
    expect(readFinalDisposition(plane, result.handled ? result.triggerId : "")).toBe("routed");
    // 车道不被 followup 回写降级（首写者胜）。
    expect(readSubscriptions(plane)).toEqual([
      { session_id: SESSION, lane: "guide", status: "active" },
    ]);
  });

  it("would-accept 落卡：unowned 候选 → 裁决批 → decision_log 卡片 → 投影读面（A3/A4）", async () => {
    const verdictTriggerIds: string[] = [];
    const root = await mkdtemp(join(tmpdir(), "zcode-sa-adj-"));
    roots.push(root);
    const { handleCommand, envelopes } = makeInboxHandle();
    const errors: Array<{ error: unknown; context: string }> = [];
    const adjudicationRun = vi.fn(
      async (request: { prompt: string; toolAllowlist: readonly string[] }) => {
        // T1 锚点（装配侧）：裁决请求必须带只读白名单且 prompt 含候选 triggerId。
        expect(request.toolAllowlist.length).toBeGreaterThan(0);
        return {
          outputText: JSON.stringify({
            decisions: verdictTriggerIds.map((id) => ({
              triggerId: id,
              disposition: "record-only",
              reason: "环境噪音，仅记录",
              evidence: ["payload 摘要无任务语义"],
            })),
          }),
        };
      },
    );
    const plane = await createSuperAgentControlPlane({
      workspaceIdentity: WS,
      ownerId: `owner-adj-${root}`,
      onError: (error, context) => errors.push({ error, context }),
      sessionFace: { sessionId: SESSION, isIdle: () => true },
      hostPorts: {
        handleCommand,
        autoReplyGuard: { admit: async () => true },
        superAgentDatabasePath: join(root, "super-agent.sqlite"),
      },
      adjudicationSession: { run: adjudicationRun, destroySession: vi.fn() },
    });
    planes.push(plane);
    await plane.start();

    const result = await plane.triggerSink.ingest(
      envelope({
        providerMessageId: "pm-cand-1",
        actorKind: "bot",
        // 无订阅 + addressed + 非人 → unowned_candidate（§3.1 第三边）。
        payload: { text: "构建机器人通报：nightly failed", chatType: "private", botId: "b1" },
        threadKeyHint: THREAD_HINT,
      }),
    );
    expect(result).toMatchObject({ handled: true, route: "unowned_candidate" });
    if (!result.handled) throw new Error("unreachable");
    verdictTriggerIds.push(result.triggerId);

    // 手动跑一批（契约允许未受评估点驱动的直调；A3：无 goal 也评估）。
    const outcome = await plane.contracts.adjudication.runBatch(WS);
    expect(outcome.status).toBe("applied");
    expect(outcome.decisions).toHaveLength(1);
    expect(outcome.decisions[0]).toMatchObject({
      triggerId: result.triggerId,
      disposition: "record-only",
    });
    expect(errors).toEqual([]);
    // 无 Mandate 行为：全部收敛 record_only + would-accept 卡片（不建订阅不执行）。
    const statusRow = plane.database
      .prepare("select adjudication_status from trigger_events where id = ?")
      .get(result.triggerId) as { adjudication_status: string };
    expect(statusRow.adjudication_status).toBe("record_only");
    expect(readSubscriptions(plane)).toEqual([]);
    const decisionRows = readDecisionRows(plane, result.triggerId);
    expect(decisionRows).toHaveLength(2);
    expect(decisionRows).toContainEqual({ origin: "fast_path", disposition: "record_only" });
    expect(decisionRows).toContainEqual({ origin: "adjudication", disposition: "would_accept" });
    const cards = plane.listPendingWouldAccept();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      source: "im",
      suggestedTier: "record_only",
      summary: "构建机器人通报：nightly failed",
    });
    expect(typeof cards[0]!.cardId).toBe("string");
    expect(cards[0]!.createdAt).toBeGreaterThan(0);
    // 裁决链不产生 CommandInbox 投递（record-only 不执行）。
    expect(envelopes).toEqual([]);
    expect(adjudicationRun).toHaveBeenCalledTimes(1);
    // 重复读面稳定（幂等投影）。
    expect(plane.listPendingWouldAccept()).toEqual(cards);
  });

  it("非 leader（同域库已有他人租约）：sink 纯转发 handled=false（§3.3）", async () => {
    const first = await makePlane();
    const secondRoot = await mkdtemp(join(tmpdir(), "zcode-sa-follower-"));
    roots.push(secondRoot);
    const { handleCommand, envelopes } = makeInboxHandle();
    const follower = await createSuperAgentControlPlane({
      workspaceIdentity: WS,
      ownerId: "owner-follower",
      onError: () => undefined,
      sessionFace: { sessionId: SESSION, isIdle: () => true },
      hostPorts: {
        handleCommand,
        autoReplyGuard: { admit: async () => true },
        // 与 first 同域库：first 已持有未过期租约 → 本实例竞争失败。
        superAgentDatabasePath: join(first.root, "super-agent.sqlite"),
      },
      adjudicationSession: {
        run: async () => {
          throw new Error("follower 不得启动裁决");
        },
        destroySession: () => undefined,
      },
    });
    planes.push(follower);
    await follower.start();

    expect(first.plane.isLeader()).toBe(true);
    expect(follower.isLeader()).toBe(false);
    const outcome = await follower.triggerSink.ingest(
      envelope({ providerMessageId: "pm-follower-1" }),
    );
    expect(outcome).toEqual({ handled: false });
    // 纯转发：不落 trigger_events、不投递。
    expect(envelopes).toEqual([]);
    const count = follower.database
      .prepare("select count(*) as n from trigger_events")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("派发桥 push → CommandInbox admission → onHostAck settle dispatched（milestone A 真适配器）", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-sa-bridge-"));
    roots.push(root);
    const bridgeInbox = makeInboxHandle();
    const errors: Array<{ error: unknown; context: string }> = [];
    const tasksIndexDatabasePath = join(root, "tasks-index.sqlite");
    // dispatch_requests DDL 与 packages/services tasksDatabase 迁移 0007 同文
    // （bootstrap 测试不能 import services；结构变更需两处同步，见 spec §1.6）。
    const tasks = new DatabaseSync(tasksIndexDatabasePath);
    tasks.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        command_id TEXT NOT NULL UNIQUE,
        workspace_identity TEXT NOT NULL,
        session_id TEXT,
        payload TEXT,
        status TEXT NOT NULL,
        skip_reason TEXT,
        dispatch_policy TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
        pushed_at INTEGER,
        acked_at INTEGER,
        settled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_requests_status_updated
      ON dispatch_requests (status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_dispatch_requests_workspace_status
      ON dispatch_requests (workspace_identity, status);
    `);
    tasks.close();

    const bridgePlane = await createSuperAgentControlPlane({
      workspaceIdentity: WS,
      ownerId: `owner-bridge-${root}`,
      onError: (error, context) => errors.push({ error, context }),
      sessionFace: { sessionId: SESSION, isIdle: () => true },
      hostPorts: {
        handleCommand: bridgeInbox.handleCommand,
        autoReplyGuard: { admit: async () => true },
        superAgentDatabasePath: join(root, "bridge-super-agent.sqlite"),
        tasksIndexDatabasePath,
      },
      adjudicationSession: {
        run: async () => {
          throw new Error("桥用例不应触达裁决");
        },
        destroySession: () => undefined,
      },
    });
    planes.push(bridgePlane);
    await bridgePlane.start();
    const bridge = bridgePlane.contracts.dispatchBridge;
    expect(bridge).toBeDefined();

    const claim = bridge!.claimDue({
      runId: "run-bridge-1",
      workspaceIdentity: WS,
      sessionId: SESSION,
      payload: "执行 automation run-bridge-1 的 prompt",
    });
    expect(claim).toMatchObject({ created: true, status: "pending_dispatch" });
    expect(claim.commandId).toBe(dispatchCommandIdForRun("run-bridge-1"));

    const pushOutcome = await bridge!.pushDispatch(claim.requestId);
    expect(pushOutcome).toMatchObject({
      kind: "pushed",
      commandId: claim.commandId,
      receipt: { status: "admitted" },
    });

    // admission 回执 → onHostAck → dispatched 终态（M7② ACK 后才 settle）。
    expect(bridgeInbox.envelopes).toHaveLength(1);
    const delivered = bridgeInbox.envelopes[0]!;
    expect(delivered.commandId).toBe(claim.commandId);
    expect(delivered.clientId).toBe("super-agent-dispatch");
    expect(delivered.triggerId).toBeUndefined();
    expect(delivered.payload).toMatchObject({
      text: "执行 automation run-bridge-1 的 prompt",
    });
    const verify = new DatabaseSync(tasksIndexDatabasePath, { readOnly: true });
    try {
      const status = verify
        .prepare("select status, attempts from dispatch_requests where run_id = ?")
        .get("run-bridge-1") as { status: string; attempts: number };
      expect(status).toMatchObject({ status: "dispatched", attempts: 1 });
    } finally {
      verify.close();
    }
    expect(errors).toEqual([]);
    // 终态行零重推（T3③）。
    const repeat = await bridge!.pushDispatch(claim.requestId);
    expect(repeat).toMatchObject({ kind: "already_terminal", status: "dispatched" });
    expect(bridgeInbox.envelopes).toHaveLength(1);
  });

  it("tasks-index 未迁移（缺文件）：装配响亮失败且不落 0 字节空库文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-sa-unmigrated-"));
    roots.push(root);
    const { handleCommand } = makeInboxHandle();
    const tasksIndexDatabasePath = join(root, "tasks-index.sqlite");
    // node:sqlite 开库先落文件再 prepare：不先探测存在性会在抛 no such table 之前
    // 留下 0 字节空库污染「未迁移」现场（回归锚点，见 super-agent-control-plane.ts）。
    await expect(
      createSuperAgentControlPlane({
        workspaceIdentity: WS,
        ownerId: `owner-unmigrated-${root}`,
        onError: () => undefined,
        sessionFace: { sessionId: SESSION, isIdle: () => true },
        hostPorts: {
          handleCommand,
          autoReplyGuard: { admit: async () => true },
          superAgentDatabasePath: join(root, "super-agent.sqlite"),
          tasksIndexDatabasePath,
        },
        adjudicationSession: {
          run: async () => {
            throw new Error("未迁移装配失败用例不应触达裁决");
          },
          destroySession: () => undefined,
        },
      }),
    ).rejects.toThrow(/tasks-index 未迁移/);
    expect(existsSync(tasksIndexDatabasePath)).toBe(false);
  });

  it("inject 车道 wire 不可表达：响亮拒绝 proto.deliveryLaneUnsupported，不静默改车道", async () => {
    const { handleCommand, envelopes } = makeInboxHandle();
    const delivery = createCommandInboxTriggerDelivery({ handleCommand });
    const receipt = await delivery.deliver({
      sessionId: SESSION,
      commandId: "cmd-inject-1",
      triggerId: "trigger-inject-1",
      taint: true,
      lane: "inject",
      text: "watch 事件",
      workspaceIdentity: WS,
    });
    expect(receipt).toEqual({
      status: "rejected",
      reasonCode: "proto.deliveryLaneUnsupported",
    });
    expect(envelopes).toEqual([]);
  });
});

describe("派发桥 push 端口单接（结构合同）", () => {
  it("无会话/无载荷响亮拒绝，不向空目标刷推送", async () => {
    const { handleCommand, envelopes } = makeInboxHandle();
    const push = createCommandInboxDispatchPush({ handleCommand });
    const noSession = await push.push({
      requestId: "r1",
      commandId: "c1",
      runId: "run-1",
      workspaceIdentity: WS,
      sessionId: null,
      payload: "text",
    });
    expect(noSession).toEqual({ status: "rejected", reasonCode: "dispatch.sessionRequired" });
    const noPayload = await push.push({
      requestId: "r2",
      commandId: "c2",
      runId: "run-2",
      workspaceIdentity: WS,
      sessionId: SESSION,
      payload: null,
    });
    expect(noPayload).toEqual({ status: "rejected", reasonCode: "dispatch.payloadMissing" });
    expect(envelopes).toEqual([]);
  });
});
