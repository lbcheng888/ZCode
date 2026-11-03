// 终态唤醒再投喂（spec: docs/architecture/super-agent-wake-refeed-spec.md，设计 M7①）。
//
// 冷 resume 的 sweep 把残留 admitted 的 wake 收口为 discarded(session_resumed)——可追责
// 不可恢复。这里钉死重投的三条边界：
//   1. 主体仍可恢复（journal 终态非 superseded）的 terminal workflow wake → 幂等重投恰好一次，
//      同一 runtime 再 resume 也不双投（claim-once = 键行任意状态在场即跳过）；
//   2. 死 Bash 的 wake → 保持 discarded，账本审计可查，journal 不被查询；
//   3. 已消费（promoted）的 wake → 不在候选集，零重投。
import { describe, expect, it, vi } from "vitest";
import {
  createProjectId,
  createSessionId,
  type BackgroundResultOriginMeta,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
  type MessageWithParts,
  type SessionId,
  type SessionInfo,
  type SessionInputDelivery,
  type SessionInputRecord,
  type SessionInputStatus,
  type SessionStorePort,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

interface FakeSessionInputLedger {
  rows: Map<string, SessionInputRecord>;
  saved: Array<{ id: string; kind: string; payload: { text: string; [key: string]: unknown } }>;
  settled: Array<{ id: string; status: string; reason?: string }>;
}

function seedWakeRow(input: {
  id: string;
  sessionID: SessionId;
  status: SessionInputStatus;
  payload: { text: string; [key: string]: unknown };
  statusReason?: string;
}): SessionInputRecord {
  return {
    id: input.id,
    sessionID: input.sessionID,
    kind: "backgroundNotification",
    delivery: "queue",
    payload: input.payload,
    admittedSequence: 0,
    status: input.status,
    ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    time: { created: 1, updated: 1 },
  };
}

/**
 * 最小 resume 面 + session_input 账本内存桩。账本语义对齐 adapters 仓库：
 * upsert 冲突不复位 status、settle/promote 只认 admitted——claim-once 依赖的正是这两条，
 * 桩必须如实复刻，否则测试会替错误语义背书。
 */
function createResumeStore(
  session: SessionInfo,
  seedRows: SessionInputRecord[],
  options?: {
    /** claim 写失败注入：命中则 saveSessionInput reject（模拟账本写盘失败）。 */
    failClaimWriteForId?: (id: string) => boolean;
  },
): {
  ledger: FakeSessionInputLedger;
  store: SessionStorePort;
} {
  const rows = new Map(seedRows.map((row) => [row.id, row]));
  const ledger: FakeSessionInputLedger = { rows, saved: [], settled: [] };
  let sequence = seedRows.length;
  const saveSessionInput = vi.fn(
    async (input: {
      id: string;
      sessionID: SessionId;
      kind: string;
      delivery: SessionInputDelivery;
      payload: { text: string; [key: string]: unknown };
    }) => {
      if (options?.failClaimWriteForId?.(input.id)) {
        throw new Error("ledger write failed");
      }
      ledger.saved.push({ id: input.id, kind: input.kind, payload: input.payload });
      const existing = rows.get(input.id);
      // 仓库语义：upsert 冲突只更新 kind/delivery/payload，不复位 status。
      if (existing) {
        existing.kind = input.kind;
        existing.delivery = input.delivery;
        existing.payload = input.payload;
        existing.time = { ...existing.time, updated: 2 };
        return;
      }
      rows.set(input.id, {
        id: input.id,
        sessionID: input.sessionID,
        kind: input.kind,
        delivery: input.delivery,
        payload: input.payload,
        admittedSequence: sequence++,
        status: "admitted",
        time: { created: 1, updated: 1 },
      });
    },
  );
  const store = {
    getSession: vi.fn(async () => session),
    messages: vi.fn(async () => [] as MessageWithParts[]),
    sessionEntries: vi.fn(async () => []),
    readTodos: vi.fn(async () => []),
    readTarget: vi.fn(async () => null),
    saveMessage: vi.fn(async () => {}),
    savePart: vi.fn(async () => {}),
    saveSessionEntry: vi.fn(async () => {}),
    updateSession: vi.fn(async () => session),
    listSessionInputs: vi.fn(
      async (input: { sessionID: SessionId; status?: SessionInputStatus }) => {
        const all = [...rows.values()].filter((row) => row.sessionID === input.sessionID);
        return input.status ? all.filter((row) => row.status === input.status) : all;
      },
    ),
    settleSessionInput: vi.fn(
      async (input: {
        id: string;
        status: "cancelled" | "discarded" | "failed";
        reason?: string;
      }) => {
        const row = rows.get(input.id);
        ledger.settled.push({ id: input.id, status: input.status, reason: input.reason });
        // 仓库语义：只收口 admitted；promoted 的迟到 discard 不得回退状态。
        if (!row || row.status !== "admitted") return;
        row.status = input.status;
        if (input.reason !== undefined) row.statusReason = input.reason;
        row.time = { ...row.time, updated: 2 };
      },
    ),
    saveSessionInput,
  } as unknown as SessionStorePort;
  return { ledger, store };
}

function makeSession(sessionId: SessionId): SessionInfo {
  return {
    id: sessionId,
    projectID: createProjectId("wake-refeed"),
    directory: "/workspace/project",
    slug: "wake-refeed",
    title: "wake refeed",
    version: "test",
    taskType: "interactive",
    time: { created: 1, updated: 1 },
  };
}

const terminalWorkflowOriginMeta: BackgroundResultOriginMeta = {
  backgroundSource: "workflow",
  title: "nightly audit",
  workId: "dwfrun-1",
  workflowNotification: {
    kind: "terminal",
    status: "completed",
    summary: "nightly audit",
    result: "done",
    resultForm: "prose",
  },
};

function makeRuntime(input: {
  sessionId: SessionId;
  store: SessionStorePort;
  getTask?: DynamicWorkflowRunPort["getTask"];
}): AgentRuntime {
  const runtime = new AgentRuntime(
    input.sessionId,
    { workingDirectory: "/workspace/project", titleGeneration: { enabled: false } },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: input.store,
      modelFactory: createTestModelFactory({}),
      hookRunner: { run: vi.fn(async () => ({ additionalContexts: [] })) },
      ...(input.getTask
        ? { dynamicWorkflowRunPort: { getTask: input.getTask } as DynamicWorkflowRunPort }
        : {}),
    },
  );
  // drain 占住：通知命令留在队列里可直接断言（同 dynamic-workflow-run-settings.test.ts 先例）。
  (runtime as unknown as { runtimeCommandDrainActive: boolean }).runtimeCommandDrainActive = true;
  return runtime;
}

function taskNotificationCommands(runtime: AgentRuntime): Array<{
  id: string;
  mode: string;
  taskId?: string;
  text: string;
}> {
  const internal = runtime as unknown as {
    runtimeCommandQueue: { snapshot(): readonly { id: string; mode: string; taskId?: string; text: string }[] };
  };
  return internal.runtimeCommandQueue
    .snapshot()
    .filter((command) => command.mode === "task-notification") as Array<{
    id: string;
    mode: string;
    taskId?: string;
    text: string;
  }>;
}

describe("终态唤醒再投喂（resume 后的 wake re-feed）", () => {
  it("崩溃残留的终态 workflow wake：resume 恰好重投一次，再 resume 不双投", async () => {
    const sessionId = createSessionId("wake-refeed-terminal");
    const session = makeSession(sessionId);
    // 模拟 kill -9：终态通知已写账本（admitted），进程死在消费前。
    const { ledger, store } = createResumeStore(session, [
      seedWakeRow({
        id: "runtime_command_7",
        sessionID: sessionId,
        status: "admitted",
        payload: {
          text: "<task-notification>run dwfrun-1 completed</task-notification>",
          taskId: "dwfrun-1",
          originMeta: terminalWorkflowOriginMeta,
        },
      }),
    ]);
    const getTask = vi.fn(
      async (taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined> =>
        taskId === "dwfrun-1"
          ? {
              runId: "dwfrun-1",
              taskId: "dwfrun-1",
              startedAt: new Date(0),
              status: "completed",
              runStatus: "completed",
            }
          : undefined,
    );
    const runtime = makeRuntime({ sessionId, store, getTask });

    await runtime.resumeFromStore();

    // sweep 收口原 wake：审计保留。
    expect(ledger.rows.get("runtime_command_7")).toMatchObject({
      status: "discarded",
      statusReason: "session_resumed",
    });
    // 幂等键行落库 + 队列一条同键命令：恰好一次。
    expect(ledger.saved).toEqual([
      expect.objectContaining({ id: "refeed_dwfrun-1", kind: "backgroundNotification" }),
    ]);
    expect(ledger.rows.get("refeed_dwfrun-1")?.payload).toMatchObject({
      taskId: "dwfrun-1",
      originMeta: terminalWorkflowOriginMeta,
    });
    expect(taskNotificationCommands(runtime)).toEqual([
      expect.objectContaining({
        id: "refeed_dwfrun-1",
        taskId: "dwfrun-1",
        text: "<task-notification>run dwfrun-1 completed</task-notification>",
      }),
    ]);
    expect(getTask).toHaveBeenCalledTimes(1);

    // 同一 runtime 再 resume：上一轮的键行此刻被 sweep 收口为 discarded，claim 仍吸收。
    await runtime.resumeFromStore();

    expect(ledger.saved).toHaveLength(1);
    expect(taskNotificationCommands(runtime)).toHaveLength(1);
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(ledger.settled.filter((entry) => entry.id === "refeed_dwfrun-1")).toEqual([
      { id: "refeed_dwfrun-1", status: "discarded", reason: "session_resumed" },
    ]);
  });

  it("死 Bash 的 wake：不重投，discarded(session_resumed) 审计保留，journal 不被查询", async () => {
    const sessionId = createSessionId("wake-refeed-bash");
    const session = makeSession(sessionId);
    const { ledger, store } = createResumeStore(session, [
      seedWakeRow({
        id: "runtime_command_8",
        sessionID: sessionId,
        status: "admitted",
        payload: {
          text: "<task-notification>bash task bg-9 finished</task-notification>",
          taskId: "bg-9",
          originMeta: {
            backgroundSource: "bash",
            title: "npm test",
            workId: "bg-9",
          },
        },
      }),
    ]);
    const getTask = vi.fn(async () => undefined);
    const runtime = makeRuntime({ sessionId, store, getTask });

    await runtime.resumeFromStore();

    expect(ledger.rows.get("runtime_command_8")).toMatchObject({
      status: "discarded",
      statusReason: "session_resumed",
    });
    expect(ledger.saved).toEqual([]);
    expect(taskNotificationCommands(runtime)).toEqual([]);
    expect(getTask).not.toHaveBeenCalled();
  });

  it("已消费的 wake（promoted）：不在候选集，零重投", async () => {
    const sessionId = createSessionId("wake-refeed-consumed");
    const session = makeSession(sessionId);
    const { ledger, store } = createResumeStore(session, [
      seedWakeRow({
        id: "runtime_command_9",
        sessionID: sessionId,
        status: "promoted",
        payload: {
          text: "<task-notification>run dwfrun-1 completed</task-notification>",
          taskId: "dwfrun-1",
          originMeta: terminalWorkflowOriginMeta,
        },
      }),
    ]);
    const getTask = vi.fn(
      async (): Promise<DynamicWorkflowRunSnapshot | undefined> => ({
        runId: "dwfrun-1",
        taskId: "dwfrun-1",
        startedAt: new Date(0),
        status: "completed",
        runStatus: "completed",
      }),
    );
    const runtime = makeRuntime({ sessionId, store, getTask });

    await runtime.resumeFromStore();

    expect(ledger.rows.get("runtime_command_9")?.status).toBe("promoted");
    expect(ledger.saved).toEqual([]);
    expect(taskNotificationCommands(runtime)).toEqual([]);
    expect(getTask).not.toHaveBeenCalled();
  });

  it("journal 已无该主体：保持丢弃，不重投（死主体不可复活）", async () => {
    const sessionId = createSessionId("wake-refeed-dead-subject");
    const session = makeSession(sessionId);
    const { ledger, store } = createResumeStore(session, [
      seedWakeRow({
        id: "runtime_command_10",
        sessionID: sessionId,
        status: "admitted",
        payload: {
          text: "<task-notification>run dwfrun-gone completed</task-notification>",
          taskId: "dwfrun-gone",
          originMeta: {
            ...terminalWorkflowOriginMeta,
            workId: "dwfrun-gone",
          },
        },
      }),
    ]);
    const getTask = vi.fn(async () => undefined);
    const runtime = makeRuntime({ sessionId, store, getTask });

    await runtime.resumeFromStore();

    expect(ledger.rows.get("runtime_command_10")).toMatchObject({
      status: "discarded",
      statusReason: "session_resumed",
    });
    expect(ledger.saved).toEqual([]);
    expect(taskNotificationCommands(runtime)).toEqual([]);
    expect(getTask).toHaveBeenCalledWith("dwfrun-gone");
  });

  it("superseded 终态：工作已归后继 run，不重投", async () => {
    const sessionId = createSessionId("wake-refeed-superseded");
    const session = makeSession(sessionId);
    const { ledger, store } = createResumeStore(session, [
      seedWakeRow({
        id: "runtime_command_11",
        sessionID: sessionId,
        status: "admitted",
        payload: {
          text: "<task-notification>run dwfrun-1 superseded</task-notification>",
          taskId: "dwfrun-1",
          originMeta: {
            ...terminalWorkflowOriginMeta,
            workflowNotification: {
              kind: "terminal",
              status: "stopped",
              stopReason: "superseded",
              summary: "nightly audit",
            },
          },
        },
      }),
    ]);
    const getTask = vi.fn(
      async (): Promise<DynamicWorkflowRunSnapshot | undefined> => ({
        runId: "dwfrun-1",
        taskId: "dwfrun-1",
        startedAt: new Date(0),
        status: "cancelled",
        runStatus: "stopped",
        stopReason: "superseded",
      }),
    );
    const runtime = makeRuntime({ sessionId, store, getTask });

    await runtime.resumeFromStore();

    expect(ledger.saved).toEqual([]);
    expect(taskNotificationCommands(runtime)).toEqual([]);
    expect(getTask).toHaveBeenCalledWith("dwfrun-1");
  });

  it("claim 键行写失败：不入队、不认领，恢复后下一次 resume 恰好一次（claim-first）", async () => {
    const sessionId = createSessionId("wake-refeed-claim-fail");
    const session = makeSession(sessionId);
    const { ledger, store } = createResumeStore(
      session,
      [
        seedWakeRow({
          id: "runtime_command_12",
          sessionID: sessionId,
          status: "admitted",
          payload: {
            text: "<task-notification>run dwfrun-1 completed</task-notification>",
            taskId: "dwfrun-1",
            originMeta: terminalWorkflowOriginMeta,
          },
        }),
      ],
      { failClaimWriteForId: (id) => id.startsWith("refeed_") },
    );
    const getTask = vi.fn(
      async (): Promise<DynamicWorkflowRunSnapshot | undefined> => ({
        runId: "dwfrun-1",
        taskId: "dwfrun-1",
        startedAt: new Date(0),
        status: "completed",
        runStatus: "completed",
      }),
    );
    const runtime = makeRuntime({ sessionId, store, getTask });

    await runtime.resumeFromStore();

    // claim 写失败 ⇒ 不入队（键行在场才可双投的风险不存在）、不认领（键行缺位可重试）。
    expect(ledger.saved).toEqual([]);
    expect(taskNotificationCommands(runtime)).toEqual([]);
    expect(ledger.rows.get("runtime_command_12")).toMatchObject({
      status: "discarded",
      statusReason: "session_resumed",
    });

    // 恢复写入后下一次 resume：claim-first 落库 + 恰好一次入队。
    (store.saveSessionInput as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: {
        id: string;
        sessionID: SessionId;
        kind: string;
        delivery: SessionInputDelivery;
        payload: { text: string; [key: string]: unknown };
      }) => {
        ledger.saved.push({ id: input.id, kind: input.kind, payload: input.payload });
        if (!ledger.rows.has(input.id)) {
          ledger.rows.set(input.id, {
            id: input.id,
            sessionID: input.sessionID,
            kind: input.kind,
            delivery: input.delivery,
            payload: input.payload,
            admittedSequence: 99,
            status: "admitted",
            time: { created: 1, updated: 1 },
          });
        }
      },
    );
    await runtime.resumeFromStore();

    expect(ledger.saved).toEqual([
      expect.objectContaining({ id: "refeed_dwfrun-1", kind: "backgroundNotification" }),
    ]);
    expect(taskNotificationCommands(runtime)).toEqual([
      expect.objectContaining({ id: "refeed_dwfrun-1", taskId: "dwfrun-1" }),
    ]);
    expect(getTask).toHaveBeenCalledTimes(2);
  });

  it("同实例队列已有同 taskId 通知：不入队第二条，代写 claim 行，后续 resume 不再重投", async () => {
    const sessionId = createSessionId("wake-refeed-already-queued");
    const session = makeSession(sessionId);
    const { ledger, store } = createResumeStore(session, [
      seedWakeRow({
        id: "runtime_command_13",
        sessionID: sessionId,
        status: "admitted",
        payload: {
          text: "<task-notification>run dwfrun-1 completed</task-notification>",
          taskId: "dwfrun-1",
          originMeta: terminalWorkflowOriginMeta,
        },
      }),
    ]);
    const getTask = vi.fn(
      async (): Promise<DynamicWorkflowRunSnapshot | undefined> => ({
        runId: "dwfrun-1",
        taskId: "dwfrun-1",
        startedAt: new Date(0),
        status: "completed",
        runStatus: "completed",
      }),
    );
    const runtime = makeRuntime({ sessionId, store, getTask });
    // 模拟同实例二次 resume：原 wake 命令仍在内存队列未消费（sweep 会收口其账本行）。
    (runtime as unknown as { runtimeCommandQueue: { enqueue(command: unknown): void } })
      .runtimeCommandQueue.enqueue({
      branchGeneration: 0,
      createdAt: new Date(),
      id: "runtime_command_13",
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      taskId: "dwfrun-1",
      text: "<task-notification>run dwfrun-1 completed</task-notification>",
      traceContext: { sessionId, traceId: "trace-already-queued" },
    });

    await runtime.resumeFromStore();

    // 不入队第二条：队列仍只有原命令一条 task-notification。
    expect(taskNotificationCommands(runtime)).toEqual([
      expect.objectContaining({ id: "runtime_command_13", taskId: "dwfrun-1" }),
    ]);
    // 代写 claim 行：投递责任由在队命令承担，后续 resume 由 claim-once 吸收。
    expect(ledger.saved).toEqual([
      expect.objectContaining({ id: "refeed_dwfrun-1", kind: "backgroundNotification" }),
    ]);

    await runtime.resumeFromStore();

    expect(taskNotificationCommands(runtime)).toHaveLength(1);
    expect(ledger.saved).toHaveLength(1);
  });
});
