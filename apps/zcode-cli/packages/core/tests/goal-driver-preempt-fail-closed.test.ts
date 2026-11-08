import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  SessionEventType,
  type GoalStatus,
  type ModelRequest,
  type ModelResult,
  type SessionGoal,
  type SessionId,
  type SessionStorePort,
  type TargetChangedPayload,
  type TargetCompletionVerificationPayload,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";

import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { verifyActiveTargetCompletionForContinuation } from "../src/runtime/methods/target-completion-verification.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

interface TargetStatusUpdate {
  sessionID: SessionId;
  status: GoalStatus;
  reason?: string;
  expectedTargetID?: string;
  expectedRevision?: number;
  expectedStatus?: GoalStatus;
}

/** 只实现 goal 读写；CAS 语义与 sqlite 适配器保持一致（同 cheng-gate 测试）。 */
function createTargetStore(initial: SessionGoal): {
  sessionStore: SessionStorePort;
  statusUpdates: TargetStatusUpdate[];
  current: () => SessionGoal;
} {
  let current = initial;
  const statusUpdates: TargetStatusUpdate[] = [];
  const sessionStore = {
    readTarget: async () => current,
    updateTargetStatus: async (input: TargetStatusUpdate) => {
      statusUpdates.push(input);
      if (
        input.expectedTargetID !== undefined &&
        input.expectedTargetID !== current.targetID
      ) {
        return null;
      }
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== current.revision
      ) {
        return null;
      }
      if (input.expectedStatus !== undefined && input.expectedStatus !== current.status) {
        return null;
      }
      current = { ...current, status: input.status };
      return current;
    },
  } as unknown as SessionStorePort;
  return { sessionStore, statusUpdates, current: () => current };
}

function createTestTarget(
  sessionID: SessionId,
  targetID: string,
  overrides: Partial<SessionGoal> = {},
): SessionGoal {
  return {
    sessionID,
    targetID,
    objective: "ship the goal driver fix",
    summaryTitle: null,
    status: "active",
    revision: 1,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 1_000, updated: 1_000 },
    ...overrides,
  };
}

async function waitFor(probe: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 观察窗口：驱动器若在失败边缘重约，verifier 请求会在窗口内增长。
 * 提前返回让断言立刻拿到真实请求数，而不是靠超时表达失败。
 */
async function observeRequestGrowth(
  requests: readonly ModelRequest[],
  baseline: number,
  windowMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline && requests.length <= baseline) {
    await sleep(20);
  }
}

/**
 * 观测 drain 的空闲沿：scheduleIdleGoalRound 是驱动器唯一的自动预约入口。
 * 记录每次边缘发生时已发出的 verifier 请求数，便于断言「这一边缘没有重约」。
 */
function observeIdleEdges(
  internal: AgentRuntimeInternal,
  requests: readonly ModelRequest[],
): number[] {
  const observed: number[] = [];
  const original = internal.scheduleIdleGoalRound!.bind(internal);
  internal.scheduleIdleGoalRound = () => {
    observed.push(requests.length);
    original();
  };
  return observed;
}

describe("idle goal round driver and preemption marker", () => {
  it(
    "does not re-reserve on the failure edge or after the next user message when a user Stop pause write fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-goal-stop-"));
      const sqliteStore = await createSqliteSessionStore({
        dbPath: join(root, "session.sqlite"),
      });
      const sessionID = createSessionId("goal-stop-pause-failure");
      // 复现形态：用户 Stop（不带 preserve 标记）时取消暂停链的 pause 写入失败，
      // 目标保持 active。正确契约：Stop 必须 disarm 驱动器；未带 preserve 的取消
      // 按预约未兑现落 standing-down，下一条用户消息排空后也不得自动续跑。
      const sessionStore = Object.create(sqliteStore) as SessionStorePort;
      sessionStore.updateTargetStatus = async (input) => {
        if (input.status === "paused") {
          throw new Error("simulated pause write failure");
        }
        return sqliteStore.updateTargetStatus(input);
      };

      const requests: ModelRequest[] = [];
      const releaseVerifier = new Map<number, () => void>();
      const modelFactory = createTestModelFactory({
        generateText: async (request): Promise<ModelResult> => {
          const index = requests.push(request);
          if ((request.tools?.length ?? 0) > 0) {
            // 用户消息回合（Stop 后的下一条输入）直接收尾。若目标被错误重约，
            // 其续跑回合也会走到这里，随后新增的 verifier 请求会让请求数超标。
            return { text: "user reply", finishReason: "stop", usage: {} };
          }
          // 第一轮 verifier 挂起，等用户 Stop 取消；若被重约会出现第二次请求，
          // 由断言直接失败，不需要第二个观测点。
          await new Promise<void>((resolve) => {
            releaseVerifier.set(index, resolve);
          });
          throw new Error("verifier request aborted by user stop");
        },
      });
      const runtime = createTestAgentRuntime(
        sessionID,
        {
          goalLayerEnabled: true,
          modelStreaming: "off",
          titleGeneration: { enabled: false },
          targetCompletionVerification: { enabled: true },
          workspacePath: root,
        },
        {
          sessionStore,
          eventStore: createTestSessionEventStore(),
          modelFactory,
        },
      );
      const internal = runtime as unknown as AgentRuntimeInternal;

      try {
        await runtime.ensureSessionPersistedForExternalActivity(
          "/goal ship the goal driver fix",
        );
        await sqliteStore.setTarget({
          sessionID,
          objective: "ship the goal driver fix",
        });
        internal.goalRoundDriverArmed = true;

        internal.scheduleIdleGoalRound();
        await waitFor(() => requests.length === 1);

        // 用户手动 Stop：不带 preserve 标记（cause 缺省 user、keepInbox 缺省 true，
        // 与真实 Stop 调用同形）。
        expect(
          runtime.stopActiveForegroundExecution({
            reason: "user stops the goal round",
          }),
        ).toMatchObject({ kind: "stopped" });
        releaseVerifier.get(1)?.();

        // 等失败边缘收口：命令 reject → drain finally → 空闲沿 → 驱动器消费
        // standing-down。先等 drain 真正空闲，再观察后续边沿。
        await waitFor(
          () =>
            !internal.runtimeCommandDrainActive &&
            !internal.runtimeCommandQueue.hasPending() &&
            internal.activeForegroundExecution === undefined,
        );
        expect(requests).toHaveLength(1);

        // 制造失败边缘之后的下一个空闲沿：pause 失败时目标仍 active；若 Stop 没有
        // disarm 驱动器，这里会重新预约并发起第二次 verifier 请求。
        internal.scheduleIdleGoalRound();
        await observeRequestGrowth(requests, 1, 500);
        expect(requests).toHaveLength(1);

        // Stop + pause 失败后，用户下一条消息排空也不得自动续跑目标。
        const followUp = await runtime.admitPrompt("follow-up after stop");
        await followUp.completion;
        await waitFor(
          () =>
            !internal.runtimeCommandDrainActive &&
            !internal.runtimeCommandQueue.hasPending() &&
            internal.activeForegroundExecution === undefined,
        );
        // 用户回合自身消耗一次模型请求；目标续跑/verifier 不得再出现。
        expect(requests).toHaveLength(2);
        internal.scheduleIdleGoalRound();
        await observeRequestGrowth(requests, 2, 500);
        expect(requests).toHaveLength(2);

        // pause 写失败，目标仍 active——不是静默完成、也不是误判暂停。
        expect(
          (await sessionStore.readTarget({ sessionID }))?.status,
        ).toBe("active");
      } finally {
        internal.goalRoundDriverArmed = false;
        for (const release of releaseVerifier.values()) release();
        await runtime.closeBrowserSession();
        sqliteStore.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "re-reserves on the next idle edge when send-now preempts with preserveQueueAutoDrainOnCancel",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-goal-send-now-"));
      const sqliteStore = await createSqliteSessionStore({
        dbPath: join(root, "session.sqlite"),
      });
      const sessionID = createSessionId("goal-send-now-preserve");
      const requests: ModelRequest[] = [];
      const releaseVerifier = new Map<number, () => void>();
      const runtime = createTestAgentRuntime(
        sessionID,
        {
          goalLayerEnabled: true,
          modelStreaming: "off",
          titleGeneration: { enabled: false },
          targetCompletionVerification: { enabled: true },
          workspacePath: root,
        },
        {
          sessionStore: sqliteStore,
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            generateText: async (request): Promise<ModelResult> => {
              const index = requests.push(request);
              if (index <= 2) {
                // 前两次 verifier 请求挂起：第一次等 send-now 抢占取消；第二次作为
                // 「下一空闲沿已重预约」的同步观测点（假模型瞬间返回会把预算跑完）。
                await new Promise<void>((resolve) => {
                  releaseVerifier.set(index, resolve);
                });
                if (index === 1) throw new Error("verifier request aborted by send-now");
              }
              if (request.tools?.length === 0) {
                return {
                  text: JSON.stringify({
                    passed: false,
                    reason: "work remains",
                    nextAction: "Continue the fix",
                  }),
                  finishReason: "stop",
                  usage: {},
                };
              }
              return { text: "continuation turn done", finishReason: "stop", usage: {} };
            },
          }),
        },
      );
      const internal = runtime as unknown as AgentRuntimeInternal;
      const idleEdges = observeIdleEdges(internal, requests);

      try {
        await runtime.ensureSessionPersistedForExternalActivity(
          "/goal ship the goal driver fix",
        );
        await sqliteStore.setTarget({
          sessionID,
          objective: "ship the goal driver fix",
        });
        internal.goalRoundDriverArmed = true;

        internal.scheduleIdleGoalRound();
        await waitFor(() => requests.length === 1);

        // 真实 send-now 抢占路径的核心调用：v4 sendQueuedNow 经 preemptActiveTurnAndWait
        // 以同一组参数调用 Core（bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts
        // 的 sendQueuedNow 分支）。
        expect(
          runtime.stopActiveForegroundExecution({
            preserveQueueAutoDrainOnCancel: true,
            reason: "v4 sendQueuedNow preempts active turn",
          }),
        ).toMatchObject({ kind: "stopped" });
        releaseVerifier.get(1)?.();

        // 带 preserve 的抢占不落 standing-down：用户回合排空后的空闲沿照常预约，
        // 驱动器发起第二次 verifier 请求（挂起中）。
        await waitFor(() => requests.length >= 2);
        expect(idleEdges.some((count) => count === 1)).toBe(true);
        expect(
          requests.filter((request) => request.tools?.length === 0).length,
        ).toBeGreaterThanOrEqual(2);
        // send-now 只是为了交付用户输入，目标必须保持 active（不暂停）。
        expect((await sqliteStore.readTarget({ sessionID }))?.status).toBe("active");

        internal.goalRoundDriverArmed = false;
        releaseVerifier.get(2)?.();
        await waitFor(() => requests.length >= 3);
      } finally {
        internal.goalRoundDriverArmed = false;
        for (const release of releaseVerifier.values()) release();
        await runtime.closeBrowserSession();
        sqliteStore.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "does not re-reserve on external idle edges when a failed-closed verifier pause write fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-goal-verifier-pause-fail-"));
      const sqliteStore = await createSqliteSessionStore({
        dbPath: join(root, "session.sqlite"),
      });
      const sessionID = createSessionId("goal-driver-verifier-pause-failure");
      // pause 写入失败：failed_closed 收口后目标仍 active。只有独立 disarm 能阻止
      // 下一个外部空闲沿重新预约并再次发起 verifier 请求。
      const sessionStore = Object.create(sqliteStore) as SessionStorePort;
      sessionStore.updateTargetStatus = async (input) => {
        if (input.status === "paused") {
          throw new Error("simulated pause write failure");
        }
        return sqliteStore.updateTargetStatus(input);
      };
      const requests: ModelRequest[] = [];
      const runtime = createTestAgentRuntime(
        sessionID,
        {
          goalLayerEnabled: true,
          modelStreaming: "off",
          titleGeneration: { enabled: false },
          targetCompletionVerification: { enabled: true },
          workspacePath: root,
        },
        {
          sessionStore,
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            generateText: async (request): Promise<ModelResult> => {
              requests.push(request);
              if ((request.tools?.length ?? 0) === 0) {
                throw new Error("Model request exceeded the provider context window.");
              }
              return { text: "continuation turn done", finishReason: "stop", usage: {} };
            },
          }),
        },
      );
      const internal = runtime as unknown as AgentRuntimeInternal;

      try {
        await runtime.ensureSessionPersistedForExternalActivity(
          "/goal ship the goal driver fix",
        );
        await sqliteStore.setTarget({
          sessionID,
          objective: "ship the goal driver fix",
        });
        internal.goalRoundDriverArmed = true;

        internal.scheduleIdleGoalRound();
        await waitFor(
          () =>
            requests.length >= 1 &&
            !internal.runtimeCommandDrainActive &&
            !internal.runtimeCommandQueue.hasPending() &&
            internal.activeForegroundExecution === undefined,
        );

        // verifier 请求失败 → failed_closed；pause 写失败使目标仍 active。
        // disarm 必须独立于 pause 成败，否则失败边缘之后的外部空闲沿会重约。
        expect((await sessionStore.readTarget({ sessionID }))?.status).toBe("active");
        expect(internal.goalRoundDriverArmed).toBe(false);

        // 失败边缘的 drain 空闲沿只消费 standing-down；再制造下一次外部空闲沿。
        internal.scheduleIdleGoalRound();
        await observeRequestGrowth(requests, 1, 500);
        // 再来一条外部边缘也不得重约（armed 已落定，不依赖 standing-down 的一次性消费）。
        internal.scheduleIdleGoalRound();
        await observeRequestGrowth(requests, 1, 500);
        expect(requests).toHaveLength(1);
      } finally {
        internal.goalRoundDriverArmed = false;
        await runtime.closeBrowserSession();
        sqliteStore.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "does not enqueue a reserved idle goal round when Stop disarms during the projection await",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-goal-reserve-disarm-"));
      const sqliteStore = await createSqliteSessionStore({
        dbPath: join(root, "session.sqlite"),
      });
      const sessionID = createSessionId("goal-reserve-disarm-window");
      // Stop 的 disarm 先于 pause 写入；pause 写失败时目标保持 active，因此只有
      // 入队前复查 armed 才能挡住预约。
      const sessionStore = Object.create(sqliteStore) as SessionStorePort;
      sessionStore.updateTargetStatus = async (input) => {
        if (input.status === "paused") {
          throw new Error("simulated pause write failure");
        }
        return sqliteStore.updateTargetStatus(input);
      };
      const requests: ModelRequest[] = [];
      const runtime = createTestAgentRuntime(
        sessionID,
        {
          goalLayerEnabled: true,
          modelStreaming: "off",
          titleGeneration: { enabled: false },
          targetCompletionVerification: { enabled: true },
          workspacePath: root,
        },
        {
          sessionStore,
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            generateText: async (request): Promise<ModelResult> => {
              requests.push(request);
              if ((request.tools?.length ?? 0) === 0) {
                return {
                  text: JSON.stringify({
                    nextAction: "continue the goal",
                    passed: false,
                    reason: "work remains",
                  }),
                  finishReason: "stop",
                  usage: {},
                };
              }
              return { text: "continuation turn done", finishReason: "stop", usage: {} };
            },
          }),
        },
      );
      const internal = runtime as unknown as AgentRuntimeInternal;

      let releaseProjection!: () => void;
      const projectionGate = new Promise<void>((resolve) => {
        releaseProjection = resolve;
      });
      let projectionEntered!: () => void;
      const enteredProjection = new Promise<void>((resolve) => {
        projectionEntered = resolve;
      });
      let projectionGated = false;
      const originalRebuildProjection = internal.rebuildProjection.bind(internal);
      internal.rebuildProjection = async () => {
        if (!projectionGated) {
          projectionGated = true;
          projectionEntered();
          await projectionGate;
        }
        return originalRebuildProjection();
      };

      try {
        await runtime.ensureSessionPersistedForExternalActivity(
          "/goal ship the goal driver fix",
        );
        await sqliteStore.setTarget({
          sessionID,
          objective: "ship the goal driver fix",
        });
        internal.goalRoundDriverArmed = true;

        internal.scheduleIdleGoalRound();
        await enteredProjection;

        // Stop 收口落在投影 await 窗口内：disarm 先行，pause 写入失败。
        await expect(
          internal.pauseActiveTargetForCancellation(
            createRootTraceContext({ sessionId: sessionID }),
          ),
        ).rejects.toThrow("Failed to pause active goal after turn cancellation");
        expect(internal.goalRoundDriverArmed).toBe(false);
        releaseProjection();

        await waitFor(() => !internal.goalRoundDriverReservationPending);
        await sleep(200);
        expect(internal.runtimeCommandQueue.hasPending()).toBe(false);
        expect(requests).toHaveLength(0);
        expect((await sessionStore.readTarget({ sessionID }))?.status).toBe("active");
      } finally {
        internal.goalRoundDriverArmed = false;
        await runtime.closeBrowserSession();
        sqliteStore.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("goal completion verifier fail-closed", () => {
  it("pauses the target with a reason when the verifier request fails instead of returning silently", async () => {
    const sessionID = createSessionId("goal-verifier-context-window");
    const target = createTestTarget(sessionID, "goal-ctx-window");
    const store = createTargetStore(target);
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore,
        sessionStore: store.sessionStore,
        modelFactory: createTestModelFactory({
          generateText: async () => {
            // 实测形态（sess_21a0b4b5）：transcript 超上下文窗口导致 verifier 请求失败。
            throw new Error("Model request exceeded the provider context window.");
          },
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      { target, traceContext: createRootTraceContext({ sessionId: sessionID }) },
    );

    // 基建失败＝未判定，绝不等于完成；也不能静默留在 active 让驱动器空转。
    expect(result?.verification.passed).toBe(false);
    expect(result?.verification.reason).toBe(
      "Completion verifier request failed: Model request exceeded the provider context window.",
    );
    expect(result?.verification.nextAction).toBeUndefined();
    expect(store.statusUpdates).toMatchObject([
      {
        reason: "goal_verifier_unavailable",
        status: "paused",
        expectedTargetID: "goal-ctx-window",
        expectedRevision: 1,
        expectedStatus: "active",
      },
    ]);
    expect(store.current()).toMatchObject({ status: "paused", targetID: "goal-ctx-window" });
    const events = await eventStore.getEvents(sessionID);
    const verificationEvents = events
      .filter((event) => event.type === SessionEventType.TargetCompletionVerification)
      .map((event) => event.payload as TargetCompletionVerificationPayload);
    expect(verificationEvents).toMatchObject([
      { status: "started", targetId: "goal-ctx-window" },
      {
        status: "failed_closed",
        targetId: "goal-ctx-window",
        verification: {
          passed: false,
          reason:
            "Completion verifier request failed: Model request exceeded the provider context window.",
        },
      },
    ]);
    // reason 上浮会话：TargetChanged 带同一 reason。
    expect(
      events
        .filter((event) => event.type === SessionEventType.TargetChanged)
        .map((event) => event.payload as TargetChangedPayload)
        .filter((payload) => payload.action === "status_updated"),
    ).toMatchObject([
      {
        action: "status_updated",
        reason: "goal_verifier_unavailable",
        target: { status: "paused", targetID: "goal-ctx-window" },
      },
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === SessionEventType.TargetChanged &&
          (event.payload as TargetChangedPayload).action === "status_updated" &&
          (event.payload as TargetChangedPayload).target?.status === "complete",
      ),
    ).toHaveLength(0);
  });

  it("still returns failed_closed verification when the pause write throws", async () => {
    const sessionID = createSessionId("goal-verifier-pause-write-failure");
    const target = createTestTarget(sessionID, "goal-pause-write-failure");
    const store = createTargetStore(target);
    // 事件已落盘后暂停写失败：函数不得把异常抛给调用方丢掉 failed_closed 结论。
    store.sessionStore.updateTargetStatus = async () => {
      throw new Error("simulated pause write failure");
    };
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore,
        sessionStore: store.sessionStore,
        modelFactory: createTestModelFactory({
          generateText: async () => {
            throw new Error("Model request exceeded the provider context window.");
          },
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      { target, traceContext: createRootTraceContext({ sessionId: sessionID }) },
    );

    expect(result?.verification).toEqual({
      passed: false,
      reason:
        "Completion verifier request failed: Model request exceeded the provider context window.",
    });
    const verificationEvents = (await eventStore.getEvents(sessionID))
      .filter((event) => event.type === SessionEventType.TargetCompletionVerification)
      .map((event) => event.payload as TargetCompletionVerificationPayload);
    expect(verificationEvents).toMatchObject([
      { status: "started", targetId: "goal-pause-write-failure" },
      {
        status: "failed_closed",
        targetId: "goal-pause-write-failure",
        verification: { passed: false },
      },
    ]);
    // 暂停写失败，目标仍是 active；结论已如实返回，不静默、不伪造暂停成功。
    expect(store.current()).toMatchObject({
      status: "active",
      targetID: "goal-pause-write-failure",
    });
  });

  it("records verifier tool misuse as failed_closed instead of a completed conclusion", async () => {
    const sessionID = createSessionId("goal-verifier-tool-call");
    const target = createTestTarget(sessionID, "goal-tool-call");
    const store = createTargetStore(target);
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore,
        sessionStore: store.sessionStore,
        modelFactory: createTestModelFactory({
          generateText: async () => ({
            text: "",
            finishReason: "tool-calls",
            usage: {},
            toolCalls: [
              { id: "verifier-tool-1", name: "Read", input: { path: "/tmp/evidence" } },
            ],
          }),
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      { target, traceContext: createRootTraceContext({ sessionId: sessionID }) },
    );

    expect(result?.verification.passed).toBe(false);
    expect(result?.verification.reason).toBe(
      "The completion verifier attempted to call tools instead of returning a verification result.",
    );
    // 工具误用是裁判链路故障（protocol failure），不是「模型确认未完成」的有效结论；
    // 生命周期统一 failed_closed，并与请求异常一致显式暂停目标（reason 上浮），
    // 消灭 active 上的静默停摆。
    const verificationEvents = (await eventStore.getEvents(sessionID))
      .filter((event) => event.type === SessionEventType.TargetCompletionVerification)
      .map((event) => event.payload as TargetCompletionVerificationPayload);
    expect(verificationEvents).toMatchObject([
      { status: "started", targetId: "goal-tool-call" },
      {
        status: "failed_closed",
        targetId: "goal-tool-call",
        verification: { passed: false },
      },
    ]);
    expect(store.statusUpdates).toMatchObject([
      {
        reason: "goal_verifier_unavailable",
        status: "paused",
        expectedTargetID: "goal-tool-call",
        expectedRevision: 1,
        expectedStatus: "active",
      },
    ]);
    expect(store.current()).toMatchObject({ status: "paused", targetID: "goal-tool-call" });
    // 摘要账本只记一次（failed_closed lifecycle），model_complete 不重复入账。
    const projection = await (
      runtime as unknown as AgentRuntimeInternal
    ).rebuildProjection();
    expect(projection.targetCompletionVerifications).toEqual([
      {
        passed: false,
        reason:
          "The completion verifier attempted to call tools instead of returning a verification result.",
      },
    ]);
  });

  it("records malformed verifier json as failed_closed instead of a completed conclusion", async () => {
    const sessionID = createSessionId("goal-verifier-bad-json");
    const target = createTestTarget(sessionID, "goal-bad-json");
    const store = createTargetStore(target);
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore,
        sessionStore: store.sessionStore,
        modelFactory: createTestModelFactory({
          generateText: async () => ({
            text: "done, all requirements are complete",
            finishReason: "stop",
            usage: {},
          }),
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      { target, traceContext: createRootTraceContext({ sessionId: sessionID }) },
    );

    expect(result?.verification).toEqual({
      passed: false,
      reason: "The completion verifier did not return valid JSON.",
    });
    const verificationEvents = (await eventStore.getEvents(sessionID))
      .filter((event) => event.type === SessionEventType.TargetCompletionVerification)
      .map((event) => event.payload as TargetCompletionVerificationPayload);
    expect(verificationEvents).toMatchObject([
      { status: "started", targetId: "goal-bad-json" },
      {
        status: "failed_closed",
        targetId: "goal-bad-json",
        verification: {
          passed: false,
          reason: "The completion verifier did not return valid JSON.",
        },
      },
    ]);
    // 坏 JSON 与请求异常同收口：显式暂停目标，reason 上浮，目标不悬在 active。
    expect(store.statusUpdates).toMatchObject([
      {
        reason: "goal_verifier_unavailable",
        status: "paused",
        expectedTargetID: "goal-bad-json",
        expectedRevision: 1,
        expectedStatus: "active",
      },
    ]);
    expect(store.current()).toMatchObject({ status: "paused", targetID: "goal-bad-json" });
  });

  it(
    "does not re-reserve or burn a turn on the failure edge after the verifier request fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-goal-verifier-fail-"));
      const sqliteStore = await createSqliteSessionStore({
        dbPath: join(root, "session.sqlite"),
      });
      const sessionID = createSessionId("goal-verifier-driver-failure");
      const requests: ModelRequest[] = [];
      const runtime = createTestAgentRuntime(
        sessionID,
        {
          goalLayerEnabled: true,
          modelStreaming: "off",
          titleGeneration: { enabled: false },
          targetCompletionVerification: { enabled: true },
          workspacePath: root,
        },
        {
          sessionStore: sqliteStore,
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            generateText: async (request): Promise<ModelResult> => {
              const index = requests.push(request);
              if (index === 1) {
                throw new Error("Model request exceeded the provider context window.");
              }
              return { text: "continuation turn done", finishReason: "stop", usage: {} };
            },
          }),
        },
      );
      const internal = runtime as unknown as AgentRuntimeInternal;

      try {
        await runtime.ensureSessionPersistedForExternalActivity(
          "/goal ship the goal driver fix",
        );
        await sqliteStore.setTarget({
          sessionID,
          objective: "ship the goal driver fix",
        });
        internal.goalRoundDriverArmed = true;

        internal.scheduleIdleGoalRound();
        await waitFor(
          () =>
            !internal.runtimeCommandDrainActive &&
            !internal.runtimeCommandQueue.hasPending() &&
            internal.activeForegroundExecution === undefined &&
            requests.length >= 1,
        );
        await observeRequestGrowth(requests, 1);

        // verifier 请求失败 → 目标显式 paused（reason 上浮），失败边缘只发生一次。
        expect(requests).toHaveLength(1);
        // 制造失败边缘之后的下一个空闲沿：目标已 paused，候选闸门必须挡住重约；
        // 若驱动器绕过闸门，会新增 verifier 请求（或 continuation 回合）。
        internal.scheduleIdleGoalRound();
        await observeRequestGrowth(requests, 1, 500);
        expect(requests).toHaveLength(1);
        expect(requests.every((request) => (request.tools?.length ?? 0) === 0)).toBe(true);
        expect((await sqliteStore.readTarget({ sessionID }))?.status).toBe("paused");
      } finally {
        internal.goalRoundDriverArmed = false;
        await runtime.closeBrowserSession();
        sqliteStore.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
