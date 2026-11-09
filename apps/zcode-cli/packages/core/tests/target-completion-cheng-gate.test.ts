import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  modelMessageContentToText,
  SessionEventType,
  type AgentCompletedOutput,
  type AgentOutput,
  type GoalStatus,
  type Logger,
  type ModelRequest,
  type ModelResult,
  type SessionGoal,
  type SessionId,
  type SessionStorePort,
  type SubagentPort,
  type SubagentRunOptions,
  type SubagentRunRequest,
  type TargetChangedPayload,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";

import { verifyActiveTargetCompletionForContinuation } from "../src/runtime/methods/target-completion-verification.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import type { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

interface TargetStatusUpdate {
  sessionID: SessionId;
  status: GoalStatus;
  reason?: string;
  expectedTargetID?: string;
  expectedRevision?: number;
}

/** 只实现完成写入路径需要的 target 读写；CAS 语义与 sqlite 适配器保持一致。 */
function createTargetStore(initial: SessionGoal): {
  sessionStore: SessionStorePort;
  statusUpdates: TargetStatusUpdate[];
  current: () => SessionGoal;
  replace: (next: SessionGoal) => void;
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
  return {
    sessionStore,
    statusUpdates,
    current: () => current,
    replace: (next) => {
      current = next;
    },
  };
}

function createTestTarget(
  sessionID: SessionId,
  targetID: string,
  overrides: Partial<SessionGoal> = {},
): SessionGoal {
  return {
    sessionID,
    targetID,
    objective: "ship the Cheng fix",
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

function targetChangedEvents(
  events: Awaited<ReturnType<ReturnType<typeof createTestSessionEventStore>["getEvents"]>>,
) {
  return events.filter((event) => event.type === SessionEventType.TargetChanged);
}

describe("S4 goal completion ChengGate", () => {
  it("red ChengGate short-circuits the LLM verifier and hands the reasons back as next action", async () => {
    const generateText = vi.fn(async () => {
      throw new Error("LLM verifier must not be called for a red gate");
    });
    const emitPlanCard = vi.fn(async () => undefined);
    const sessionID = createSessionId("goal-cheng-gate");
    const target = createTestTarget(sessionID, "goal-1");
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        sessionStore: {} as never,
        modelFactory: createTestModelFactory({ generateText } as never),
        goalContinuationChengPlan: emitPlanCard,
        targetCompletionChengGate: async () => ({
          ok: false,
          level: "BLOCKED",
          reasons: ["settle_not_solved", "program_not_authenticated"],
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      {
        target,
        traceContext: createRootTraceContext({ sessionId: sessionID }),
      },
    );

    expect(result).toMatchObject({
      target: { targetID: "goal-1", status: "active" },
      verification: {
        passed: false,
        reason: "cheng_gate_blocked:settle_not_solved,program_not_authenticated",
        nextAction:
          "Cheng gate blocked: settle_not_solved,program_not_authenticated. Inspect the run evidence, fix the failing gate, then re-verify.",
      },
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(emitPlanCard).not.toHaveBeenCalled();
  });

  it("pauses the target when a production target only has a diagnostic gate", async () => {
    const generateText = vi.fn(async () => {
      throw new Error("LLM verifier must not be called for diagnostic-as-production");
    });
    const sessionID = createSessionId("goal-diagnostic-gate");
    const target = createTestTarget(sessionID, "goal-2");
    const store = createTargetStore(target);
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore,
        sessionStore: store.sessionStore,
        modelFactory: createTestModelFactory({ generateText } as never),
        targetCompletionChengGate: async () => ({
          ok: true,
          level: "DIAGNOSTIC_NOT_ACCEPTANCE",
          reasons: [],
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      {
        target,
        traceContext: createRootTraceContext({ sessionId: sessionID }),
      },
    );

    expect(result?.verification).toMatchObject({
      passed: false,
      reason: "Cheng gate did not reach production acceptance.",
    });
    expect(store.statusUpdates).toMatchObject([
      { reason: "cheng_gate_not_production", status: "paused" },
    ]);
    expect(store.current()).toMatchObject({ status: "paused", targetID: "goal-2" });
    const events = await eventStore.getEvents(sessionID);
    expect(targetChangedEvents(events)).toMatchObject([
      {
        payload: {
          action: "status_updated",
          reason: "cheng_gate_not_production",
          target: { status: "paused", targetID: "goal-2" },
        },
      },
    ]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("persisted goal acceptanceLevel overrides the runtime fallback and still pauses", async () => {
    const generateText = vi.fn(async () => {
      throw new Error("LLM verifier must not be called when goal requires production");
    });
    const sessionID = createSessionId("goal-persisted-acceptance");
    const target = createTestTarget(sessionID, "goal-3", { acceptanceLevel: "production" });
    const store = createTargetStore(target);
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore,
        sessionStore: store.sessionStore,
        // runtime 级 fallback 允许 diagnostic，但目标行显式 production 必须优先。
        targetCompletionAcceptanceLevel: "diagnostic",
        modelFactory: createTestModelFactory({ generateText } as never),
        targetCompletionChengGate: async () => ({
          ok: true,
          level: "DIAGNOSTIC_NOT_ACCEPTANCE",
          reasons: [],
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      {
        target,
        traceContext: createRootTraceContext({ sessionId: sessionID }),
      },
    );

    expect(result?.verification).toMatchObject({
      passed: false,
      reason: "Cheng gate did not reach production acceptance.",
    });
    expect(store.statusUpdates).toMatchObject([
      { reason: "cheng_gate_not_production", status: "paused" },
    ]);
    expect(store.current()).toMatchObject({ status: "paused", acceptanceLevel: "production" });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("a persisted diagnostic level lets a diagnostic gate reach the LLM verifier", async () => {
    const generateText = vi.fn(async () => ({
      finishReason: "stop" as const,
      providerMetadata: undefined,
      text: JSON.stringify({ passed: false, reason: "the work is not complete yet" }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const sessionID = createSessionId("goal-diagnostic-accepted");
    const target = createTestTarget(sessionID, "goal-4", {
      acceptanceLevel: "diagnostic",
      revision: 2,
    });
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: createTargetStore(target).sessionStore,
        // runtime fallback 要求 production；目标行改为 diagnostic 后必须按 row 走。
        targetCompletionAcceptanceLevel: "production",
        modelFactory: createTestModelFactory({ generateText } as never),
        targetCompletionChengGate: async () => ({
          ok: true,
          level: "DIAGNOSTIC_NOT_ACCEPTANCE",
          reasons: [],
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      {
        target,
        traceContext: createRootTraceContext({ sessionId: sessionID }),
      },
    );

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result?.verification).toMatchObject({
      passed: false,
      reason: "the work is not complete yet",
    });
    expect(result?.target).toMatchObject({ status: "active", acceptanceLevel: "diagnostic" });
  });

  it("pauses the target instead of rejecting when the Cheng gate RPC throws", async () => {
    const sessionID = createSessionId("goal-gate-error");
    const target = createTestTarget(sessionID, "goal-5");
    const store = createTargetStore(target);
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore,
        sessionStore: store.sessionStore,
        modelFactory: createTestModelFactory({} as never),
        targetCompletionChengGate: async () => {
          throw new Error("cheng host RPC timeout");
        },
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      {
        target,
        traceContext: createRootTraceContext({ sessionId: sessionID }),
      },
    );

    expect(result?.verification).toMatchObject({
      passed: false,
      reason: "Cheng gate is unavailable (cheng_host_unavailable).",
    });
    expect(store.statusUpdates).toMatchObject([
      { reason: "cheng_gate_unavailable", status: "paused" },
    ]);
    expect(store.current()).toMatchObject({ status: "paused", targetID: "goal-5" });
    const events = await eventStore.getEvents(sessionID);
    expect(targetChangedEvents(events)).toMatchObject([
      {
        payload: {
          action: "status_updated",
          reason: "cheng_gate_unavailable",
          target: { status: "paused", targetID: "goal-5" },
        },
      },
    ]);
  });

  it("pauses the target when the gate reports the Cheng host is unavailable", async () => {
    const sessionID = createSessionId("goal-host-unavailable");
    const target = createTestTarget(sessionID, "goal-6");
    const store = createTargetStore(target);
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore,
        sessionStore: store.sessionStore,
        modelFactory: createTestModelFactory({} as never),
        targetCompletionChengGate: async () => ({
          ok: false,
          level: "BLOCKED",
          reasons: ["cheng_host_unavailable"],
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      {
        target,
        traceContext: createRootTraceContext({ sessionId: sessionID }),
      },
    );

    expect(result?.verification).toMatchObject({
      passed: false,
      reason: "Cheng gate is unavailable (cheng_host_unavailable).",
    });
    expect(store.statusUpdates).toMatchObject([
      { reason: "cheng_gate_unavailable", status: "paused" },
    ]);
    expect(store.current()).toMatchObject({ status: "paused", targetID: "goal-6" });
  });

  it("does not complete a target that was replaced while the verifier was running", async () => {
    const sessionID = createSessionId("goal-replaced-during-verify");
    const target = createTestTarget(sessionID, "goal-old", { revision: 1 });
    const replacement = createTestTarget(sessionID, "goal-new", { revision: 1 });
    const store = createTargetStore(target);
    const eventStore = createTestSessionEventStore();
    const generateText = vi.fn(async () => {
      // 模拟用户命令在验证期间替换目标。
      store.replace(replacement);
      return {
        finishReason: "stop" as const,
        providerMetadata: undefined,
        text: JSON.stringify({ passed: true, reason: "done", nextAction: "" }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore,
        sessionStore: store.sessionStore,
        modelFactory: createTestModelFactory({ generateText } as never),
        targetCompletionChengGate: async () => ({
          ok: true,
          level: "PRODUCTION",
          reasons: [],
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      {
        target,
        traceContext: createRootTraceContext({ sessionId: sessionID }),
      },
    );

    // 完成写入被跳过：跳过路径不调用 updateTargetStatus，新目标保持 active。
    expect(store.statusUpdates).toHaveLength(0);
    expect(store.current()).toMatchObject({ status: "active", targetID: "goal-new" });
    const events = await eventStore.getEvents(sessionID);
    expect(
      events.filter(
        (event) =>
          event.type === SessionEventType.TargetChanged &&
          (event.payload as TargetChangedPayload).action === "status_updated" &&
          (event.payload as TargetChangedPayload).target?.status === "complete",
      ),
    ).toHaveLength(0);
    // 目标身份变化后旧 verifier 的 passed 被降级为非通过；调用方不得完成新目标。
    expect(result?.verification.passed).toBe(false);
    expect(result?.verification.reason).toBe(
      "Completion verification was superseded by a target change.",
    );
    expect(result?.target.targetID).toBe("goal-old");
  });

  it("does not overwrite a target paused while the verifier was running", async () => {
    const sessionID = createSessionId("goal-paused-during-verify");
    const target = createTestTarget(sessionID, "goal-paused", { revision: 1 });
    const store = createTargetStore(target);
    const generateText = vi.fn(async () => {
      // 状态迁移不递增 revision；只靠 targetID/revision 的 CAS 拦不住这次覆盖。
      store.replace({ ...target, status: "paused" });
      return {
        finishReason: "stop" as const,
        providerMetadata: undefined,
        text: JSON.stringify({ passed: true, reason: "done", nextAction: "" }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: store.sessionStore,
        modelFactory: createTestModelFactory({ generateText } as never),
        targetCompletionChengGate: async () => ({
          ok: true,
          level: "PRODUCTION",
          reasons: [],
        }),
      },
    );

    const result = await verifyActiveTargetCompletionForContinuation.call(
      runtime as unknown as never,
      {
        target,
        traceContext: createRootTraceContext({ sessionId: sessionID }),
      },
    );

    expect(store.current()).toMatchObject({ status: "paused", targetID: "goal-paused" });
    expect(result?.verification.passed).toBe(false);
  });

  it("a green gate emits one compact plan card event, independent of continuation", async () => {
    const sessionID = createSessionId("goal-green-plan-card");
    const eventStore = createTestSessionEventStore();
    const generateText = vi.fn(async () => ({
      finishReason: "stop" as const,
      providerMetadata: undefined,
      text: JSON.stringify({ passed: false, reason: "still working" }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const planCard = {
      planId: "cheng-plan://job-1",
      runId: "run-1",
      frontier: {
        stage: "spec",
        target: "p02_min2",
        evidence: ["jobId:job-1", "settle_not_solved"],
      },
      recommended: { action: "fix_spec", target: "p02_min2" },
      evidenceRefs: ["jobId:job-1", "settle_not_solved", "gate:blocked"],
    };
    const target = createTestTarget(sessionID, "goal-green-card", {
      acceptanceLevel: "production",
    });
    const runtime = createTestAgentRuntime(
      sessionID,
      { targetCompletionVerification: { enabled: true } },
      {
        eventStore,
        sessionStore: {} as never,
        modelFactory: createTestModelFactory({ generateText } as never),
        goalContinuationChengPlan: async () => planCard,
        targetCompletionChengGate: async () => ({
          ok: true,
          level: "PRODUCTION",
          reasons: [],
        }),
      },
    );
    const traceContext = createRootTraceContext({ sessionId: sessionID });
    await runtime.recordTargetChanged({
      action: "set",
      previousTarget: null,
      source: "command",
      target,
      traceContext,
    });

    await verifyActiveTargetCompletionForContinuation.call(runtime as unknown as never, {
      target,
      traceContext,
    });
    // 第二次验证复用同一 plan/run：事件账本不重复写卡。
    await verifyActiveTargetCompletionForContinuation.call(runtime as unknown as never, {
      target,
      traceContext,
    });

    const events = await eventStore.getEvents(sessionID);
    const cardEvents = events.filter(
      (event) =>
        event.type === SessionEventType.TargetChanged &&
        (event.payload as TargetChangedPayload).action === "cheng_plan_card",
    );
    expect(cardEvents).toHaveLength(1);
    expect((cardEvents[0]!.payload as TargetChangedPayload).chengPlanCard).toEqual(planCard);
    expect(generateText).toHaveBeenCalledTimes(2);
  });
});

const SWARM_DECOMPOSE_MARKER = "decomposing a goal into parallel subtasks";
const SWARM_ROUND_MARKER = "<goal_swarm_round>";
const SWARM_BUDGET_MARKER = "The session goal budget is exhausted.";
/** 与 swarm-orchestrator.ts 的 SWARM_OUTPUT_TRUNCATION_MARKER 对齐。 */
const SWARM_TRUNCATION_MARKER = "\n[truncated]";
/** 与 swarm-orchestrator.ts 的 SWARM_WORKER_OUTPUT_MAX_CHARS 对齐：总量 2000 字符含标记。 */
const SWARM_TRUNCATED_BODY_CHARS = 2_000 - SWARM_TRUNCATION_MARKER.length;
const VERIFIER_MARKER = "Verify whether the active session goal is actually complete.";

const SWARM_TASK_DESCRIPTIONS = {
  tasks: [{ description: "inspect core" }, { description: "write tests" }],
};

function modelResult(text: string): ModelResult {
  return {
    finishReason: "stop",
    text,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function renderedRequest(request: ModelRequest): string {
  return request.messages.map((message) => modelMessageContentToText(message.content)).join("\n");
}

/**
 * 按 prompt 特征把请求路由到 verifier / 分解 / 主回合三个角色。
 * 子任务执行走 SubagentPort（见 createSwarmSubagentPort），不再经过会话模型。
 */
function swarmRequestDispatcher(input: {
  requests: string[];
  verifier?: (text: string) => ModelResult;
  decompose?: (text: string) => ModelResult | Promise<ModelResult>;
}): (request: ModelRequest) => Promise<ModelResult> {
  return async (request) => {
    const text = renderedRequest(request);
    input.requests.push(text);
    if (text.includes(VERIFIER_MARKER)) {
      return (
        input.verifier?.(text) ??
        modelResult(
          JSON.stringify({ passed: false, reason: "still working", nextAction: "keep working" }),
        )
      );
    }
    if (text.includes(SWARM_DECOMPOSE_MARKER)) {
      return input.decompose
        ? await input.decompose(text)
        : modelResult(JSON.stringify(SWARM_TASK_DESCRIPTIONS));
    }
    return modelResult("round complete");
  };
}

type SwarmTestSubagentPort = SubagentPort & {
  readonly runCalls: SubagentRunRequest[];
  readonly runOptions: Array<SubagentRunOptions | undefined>;
};

/** worker 执行面替身：按子任务 prompt 返回可控的 completed 交付正文与 usage。 */
function createSwarmSubagentPort(
  workerOutput: (
    request: SubagentRunRequest,
    options: SubagentRunOptions | undefined,
  ) => string | Promise<string> = (request) =>
    request.prompt.includes("inspect core") ? "core finding" : "tests written",
  completedOverrides: Partial<AgentCompletedOutput> = {},
): SwarmTestSubagentPort {
  const runCalls: SubagentRunRequest[] = [];
  const runOptions: Array<SubagentRunOptions | undefined> = [];
  return {
    runCalls,
    runOptions,
    async launch(): Promise<AgentOutput> {
      throw new Error("Swarm execution must use SubagentPort.run");
    },
    async run(request, options) {
      runCalls.push(request);
      runOptions.push(options);
      const text = await workerOutput(request, options);
      return {
        status: "completed",
        agentId: `agent:${request.description}`,
        agentType: request.agentType,
        description: request.description,
        prompt: request.prompt,
        content: [{ type: "text", text }],
        totalToolUseCount: 0,
        totalDurationMs: 1,
        ...completedOverrides,
      } satisfies AgentCompletedOutput;
    },
  };
}

/** 每个 swarm 测试用自己的临时 git 仓库：worker 工作树与合并闸门走真实 git。 */
async function initSwarmGitRepo(root: string): Promise<void> {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "ZCode Swarm Test");
  git("config", "user.email", "swarm-test@zcode.local");
  git("config", "commit.gpgsign", "false");
  // 会话 sqlite（含 WAL/SHM）落在基准仓库内；编排层的清洁前置会拒绝脏树，
  // 因此测试仓库必须把它声明为构建产物而不是未跟踪文件。
  await writeFile(join(root, ".gitignore"), "session.sqlite*\n");
  git("add", ".gitignore");
  git("commit", "--no-verify", "-q", "-m", "init");
}

/** 基准仓库 HEAD；合并闸门拒绝时用它证明零回写。 */
function gitHead(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
}

async function createSwarmGoalRuntime(input: {
  sessionID: SessionId;
  root: string;
  goalLayerEnabled: boolean;
  swarmEnabled: boolean;
  generateText: (request: ModelRequest) => Promise<ModelResult>;
  subagentPort?: SubagentPort;
  logger?: Logger;
}) {
  await initSwarmGitRepo(input.root);
  const store = await createSqliteSessionStore({ dbPath: join(input.root, "session.sqlite") });
  const eventStore = createTestSessionEventStore();
  const subagentPort = input.subagentPort ?? createSwarmSubagentPort();
  const config = {
    modelStreaming: "off",
    titleGeneration: { enabled: false },
    targetCompletionVerification: { enabled: true },
    workingDirectory: input.root,
    workspacePath: input.root,
    ...(input.goalLayerEnabled ? { goalLayerEnabled: true } : {}),
    ...(input.swarmEnabled ? { swarm: true } : {}),
  } as AgentRuntimeConfig;
  const runtime = createTestAgentRuntime(input.sessionID, config, {
    eventStore,
    sessionStore: store,
    subagentPort,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    modelFactory: createTestModelFactory({ generateText: input.generateText }),
  });
  return { runtime, store, eventStore, subagentPort };
}

type SwarmGoalStore = Awaited<ReturnType<typeof createSqliteSessionStore>>;

/** 走与协议 Pause 相同的两条事实：持久状态写 paused + TargetChanged 事件。 */
async function pauseTargetWithEvent(input: {
  runtime: AgentRuntime;
  store: SwarmGoalStore;
  sessionID: SessionId;
}): Promise<void> {
  const previousTarget = await input.store.readTarget({ sessionID: input.sessionID });
  const target = await input.store.updateTargetStatus({
    sessionID: input.sessionID,
    status: "paused",
    reason: "user-pause",
  });
  if (!target) throw new Error("test pause wrote nothing");
  await input.runtime.recordTargetChanged({
    action: "status_updated",
    previousTarget,
    reason: "user-pause",
    source: "command",
    target,
    traceContext: createRootTraceContext({ sessionId: input.sessionID }),
  });
}

/** 走与 v4 GoalUpdate 相同的 CAS 写 + TargetChanged 事件（revision 递增）。 */
async function editTargetObjectiveWithEvent(input: {
  runtime: AgentRuntime;
  store: SwarmGoalStore;
  sessionID: SessionId;
  objective: string;
}): Promise<void> {
  const previousTarget = await input.store.readTarget({ sessionID: input.sessionID });
  if (!previousTarget) throw new Error("test objective edit requires an existing target");
  const target = await input.store.updateTargetObjective({
    sessionID: input.sessionID,
    targetID: previousTarget.targetID,
    revision: previousTarget.revision,
    objective: input.objective,
  });
  if (!target) throw new Error("test objective edit hit a stale revision");
  await input.runtime.recordTargetChanged({
    action: "objective_edited",
    previousTarget,
    reason: "user-edit",
    source: "command",
    target,
    traceContext: createRootTraceContext({ sessionId: input.sessionID }),
  });
}

/** worker 一直挂起，直到回合取消信号落地；用于验证 Pause/Stop 真的会 abort 在途执行。 */
function waitForAbortWorker(
  _request: SubagentRunRequest,
  options: SubagentRunOptions | undefined,
): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    const signal = options?.signal;
    if (!signal) {
      reject(new Error("swarm worker requires an abort signal"));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("swarm goal continuation", () => {
  it("decomposes the active goal, executes subtasks in parallel, and hands the aggregate to the verifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-"));
    const sessionID = createSessionId("goal-swarm-round");
    const requests: string[] = [];
    const port = createSwarmSubagentPort();
    const generateText = vi.fn(
      swarmRequestDispatcher({
        requests,
        verifier: () =>
          modelResult(
            JSON.stringify({
              passed: true,
              reason: "the aggregated swarm output covers the goal",
              nextAction: "",
            }),
          ),
      }),
    );
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal ship the swarm integration");
      await store.setTarget({ sessionID, objective: "ship the swarm integration" });

      await runtime.continueActiveTargetIfIdle({ inputId: "swarm-round-1" });

      const decomposeRequest = requests.find((text) => text.includes(SWARM_DECOMPOSE_MARKER));
      expect(decomposeRequest).toContain("ship the swarm integration");
      expect(port.runCalls.map((request) => request.description)).toEqual([
        "inspect core",
        "write tests",
      ]);
      const roundRequest = requests.find((text) => text.includes(SWARM_ROUND_MARKER));
      expect(roundRequest).toContain("Continue working toward the active session goal.");
      expect(roundRequest).toContain("inspect core");
      expect(roundRequest).toContain("core finding");
      expect(roundRequest).toContain("tests written");

      await runtime.continueActiveTargetIfIdle({ verifyBeforeContinue: true });

      const verifierRequest = requests.find((text) => text.includes(VERIFIER_MARKER));
      expect(verifierRequest).toContain("core finding");
      expect(verifierRequest).toContain("tests written");
      expect(await store.readTarget({ sessionID })).toMatchObject({ status: "complete" });
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the single-agent continuation when the swarm gray flag is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-off-"));
    const sessionID = createSessionId("goal-swarm-disabled");
    const requests: string[] = [];
    const port = createSwarmSubagentPort();
    const generateText = vi.fn(async (request: ModelRequest) => {
      requests.push(renderedRequest(request));
      return modelResult("single agent round");
    });
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: false,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal ship without swarm");
      await store.setTarget({ sessionID, objective: "ship without swarm" });

      await runtime.continueActiveTargetIfIdle({ inputId: "single-round-1" });

      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toContain(SWARM_DECOMPOSE_MARKER);
      expect(requests[0]).not.toContain(SWARM_ROUND_MARKER);
      expect(port.runCalls).toHaveLength(0);
      expect(await store.readTarget({ sessionID })).toMatchObject({ status: "active" });
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips the swarm when swarm is on but the goal layer is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-no-goal-layer-"));
    const sessionID = createSessionId("goal-swarm-no-goal-layer");
    const requests: string[] = [];
    const port = createSwarmSubagentPort();
    const generateText = vi.fn(async (request: ModelRequest) => {
      requests.push(renderedRequest(request));
      return modelResult("single agent round");
    });
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: false,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal no budget gate");
      await store.setTarget({ sessionID, objective: "no budget gate" });

      await runtime.continueActiveTargetIfIdle({ inputId: "no-goal-layer-round-1" });

      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toContain(SWARM_DECOMPOSE_MARKER);
      expect(requests[0]).not.toContain(SWARM_ROUND_MARKER);
      expect(port.runCalls).toHaveLength(0);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes the verifier nextAction into swarm decomposition", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-next-action-"));
    const sessionID = createSessionId("goal-swarm-next-action");
    const requests: string[] = [];
    const port = createSwarmSubagentPort();
    const generateText = vi.fn(
      swarmRequestDispatcher({
        requests,
        verifier: () =>
          modelResult(
            JSON.stringify({
              passed: false,
              reason: "the gate is still red",
              nextAction: "repair the settle gate",
            }),
          ),
      }),
    );
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal repair settle");
      await store.setTarget({ sessionID, objective: "repair settle" });

      await runtime.continueActiveTargetIfIdle({
        inputId: "swarm-next-action-round",
        verifyBeforeContinue: true,
      });

      const decomposeRequest = requests.find((text) => text.includes(SWARM_DECOMPOSE_MARKER));
      expect(decomposeRequest).toContain("repair settle");
      expect(decomposeRequest).toContain("repair the settle gate");
      expect(port.runCalls).toHaveLength(2);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("truncates each worker output before aggregation", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-truncate-"));
    const sessionID = createSessionId("goal-swarm-truncate");
    const requests: string[] = [];
    const longOutput = `${"A".repeat(2_500)}TAIL-INSPECT`;
    const longOutputB = `${"B".repeat(2_500)}TAIL-TESTS`;
    const port = createSwarmSubagentPort((request) =>
      request.prompt.includes("inspect core") ? longOutput : longOutputB,
    );
    const generateText = vi.fn(swarmRequestDispatcher({ requests }));
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal bound swarm output");
      await store.setTarget({ sessionID, objective: "bound swarm output" });

      await runtime.continueActiveTargetIfIdle({ inputId: "swarm-truncate-round" });

      const roundRequest = requests.find((text) => text.includes(SWARM_ROUND_MARKER));
      expect(roundRequest).toBeDefined();
      expect(roundRequest).not.toContain("TAIL-INSPECT");
      expect(roundRequest).not.toContain("TAIL-TESTS");
      // 每份输出恰好 2000 字符（正文 + 截断标记），两份按输入顺序拼接。
      const expectedAggregate = [
        `${"A".repeat(SWARM_TRUNCATED_BODY_CHARS)}${SWARM_TRUNCATION_MARKER}`,
        `${"B".repeat(SWARM_TRUNCATED_BODY_CHARS)}${SWARM_TRUNCATION_MARKER}`,
      ].join("\n\n");
      expect(roundRequest).toContain(expectedAggregate);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hands partial swarm evidence to the turn instead of pausing the goal", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-partial-"));
    const sessionID = createSessionId("goal-swarm-partial");
    const requests: string[] = [];
    const port = createSwarmSubagentPort(
      (request) => {
        if (request.prompt.includes("write tests")) throw new Error("provider boom");
        return "core finding";
      },
      {
        totalTokens: 30,
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        totalDurationMs: 1_000,
      },
    );
    const generateText = vi.fn(swarmRequestDispatcher({ requests }));
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal partial swarm");
      await store.setTarget({ sessionID, objective: "partial swarm" });

      await runtime.continueActiveTargetIfIdle({ inputId: "swarm-partial-round" });

      const roundRequest = requests.find((text) => text.includes(SWARM_ROUND_MARKER));
      expect(roundRequest).toContain("core finding");
      expect(roundRequest).toContain("1 of 2 subtasks completed");
      expect(roundRequest).toContain("provider boom");
      // H2：分解 2 + completed worker 30 + 主回合 2 全部入目标预算。
      expect(await store.readTarget({ sessionID })).toMatchObject({
        status: "active",
        tokensUsed: 34,
      });
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses the target with the full cause chain when every worker fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-fail-"));
    const sessionID = createSessionId("goal-swarm-failure");
    const requests: string[] = [];
    const port = createSwarmSubagentPort((request) => {
      if (request.prompt.includes("write tests")) {
        throw new Error("provider boom", { cause: new Error("socket closed") });
      }
      throw new Error("worker exploded");
    });
    const generateText = vi.fn(swarmRequestDispatcher({ requests }));
    const { runtime, store, eventStore } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal fail the swarm round");
      await store.setTarget({ sessionID, objective: "fail the swarm round" });
      const target = await store.readTarget({ sessionID });

      await expect(
        runtime.continueActiveTargetLoop({ inputId: "swarm-round-fail", trigger: "manual" }),
      ).rejects.toThrow(/Swarm aggregation failed for all 2 task\(s\)/);

      const paused = await store.readTarget({ sessionID });
      expect(paused).toMatchObject({ status: "paused" });
      // H2：失败回合也要记账已发生的分解调用。
      expect(paused?.tokensUsed).toBe(2);
      const events = await eventStore.getEvents(sessionID);
      const failureEvents = targetChangedEvents(events).filter(
        (event) =>
          (event.payload as TargetChangedPayload).action === "status_updated" &&
          (event.payload as TargetChangedPayload).reason?.startsWith("swarm_execution_failed"),
      );
      expect(failureEvents).toHaveLength(1);
      const reason = (failureEvents[0]!.payload as TargetChangedPayload).reason ?? "";
      // M7：聚合失败的 pause reason 展开整条 cause 链，原始 worker 错误不丢。
      expect(reason).toContain("worker exploded");
      expect(reason).toContain("provider boom");
      expect(reason).toContain("socket closed");
      expect(reason).toContain("caused by:");
      expect(failureEvents[0]!.payload).toMatchObject({
        target: { status: "paused", targetID: target?.targetID },
      });
      // 回合从未启动；目标已 pause，后续 idle/手动续跑候选闸门直接关闭。
      expect(requests.filter((text) => text.includes(SWARM_ROUND_MARKER))).toHaveLength(0);
      await expect(runtime.continueActiveTargetIfIdle()).resolves.toBeNull();
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not merge swarm output into an objective rewritten during the round", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-revision-"));
    const sessionID = createSessionId("goal-swarm-target-revision");
    const requests: string[] = [];
    const port = createSwarmSubagentPort(undefined, {
      totalTokens: 30,
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      totalDurationMs: 1_000,
    });
    let editTarget: (() => Promise<void>) | undefined;
    const generateText = vi.fn(
      swarmRequestDispatcher({
        requests,
        decompose: async () => {
          // 蜂群长 await 期间 GoalUpdate 改写 objective：状态仍 active、revision 递增。
          await editTarget!();
          return modelResult(JSON.stringify(SWARM_TASK_DESCRIPTIONS));
        },
      }),
    );
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    editTarget = () =>
      editTargetObjectiveWithEvent({
        runtime,
        store,
        sessionID,
        objective: "rewritten objective",
      });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal rewrite during swarm");
      await store.setTarget({ sessionID, objective: "original objective" });
      const before = await store.readTarget({ sessionID });

      const result = await runtime.continueActiveTargetIfIdle({ inputId: "swarm-revision-round" });

      expect(result).toBeNull();
      // 旧目标的 worker 已经跑完，但旧产出不得拼进新 objective 的回合提示。
      expect(port.runCalls).toHaveLength(2);
      expect(requests.filter((text) => text.includes(SWARM_ROUND_MARKER))).toHaveLength(0);
      const target = await store.readTarget({ sessionID });
      expect(target).toMatchObject({ objective: "rewritten objective", status: "active" });
      expect(target?.revision).toBe((before?.revision ?? 0) + 1);
      // H2：蜂群开销仍记在同一 targetID 的预算行上。
      expect(target?.tokensUsed).toBe(62);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts before spawning workers when the goal is paused during decomposition", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-pause-decompose-"));
    const sessionID = createSessionId("goal-swarm-pause-decompose");
    const requests: string[] = [];
    const port = createSwarmSubagentPort();
    let pauseTarget: (() => Promise<void>) | undefined;
    const generateText = vi.fn(
      swarmRequestDispatcher({
        requests,
        decompose: async () => {
          await pauseTarget!();
          return modelResult(JSON.stringify(SWARM_TASK_DESCRIPTIONS));
        },
      }),
    );
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    pauseTarget = () => pauseTargetWithEvent({ runtime, store, sessionID });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal pause during swarm");
      await store.setTarget({ sessionID, objective: "pause during swarm" });

      const result = await runtime.continueActiveTargetIfIdle({ inputId: "swarm-pause-decompose" });

      expect(result).toBeNull();
      // 分解阶段目标已失效：worker 不再 spawn，旧结果不得启动真实回合。
      expect(port.runCalls).toHaveLength(0);
      expect(requests.filter((text) => text.includes(SWARM_ROUND_MARKER))).toHaveLength(0);
      const target = await store.readTarget({ sessionID });
      expect(target).toMatchObject({ status: "paused" });
      // H2：已发生的分解调用仍然记账。
      expect(target?.tokensUsed).toBe(2);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts in-flight workers when the goal is paused during execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-pause-workers-"));
    const sessionID = createSessionId("goal-swarm-pause-workers");
    const requests: string[] = [];
    const port = createSwarmSubagentPort(waitForAbortWorker);
    const generateText = vi.fn(swarmRequestDispatcher({ requests }));
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal pause workers");
      await store.setTarget({ sessionID, objective: "pause workers" });

      const running = runtime.continueActiveTargetIfIdle({ inputId: "swarm-pause-workers" });
      await vi.waitFor(() => expect(port.runCalls).toHaveLength(2), { timeout: 5_000 });
      await pauseTargetWithEvent({ runtime, store, sessionID });

      const result = await running;

      expect(result).toBeNull();
      expect(port.runCalls).toHaveLength(2);
      // M5：Pause 不是只改目标状态——在途 worker 的 SubagentPort.run signal 已 abort。
      expect(port.runOptions.every((options) => options?.signal?.aborted === true)).toBe(true);
      expect(requests.filter((text) => text.includes(SWARM_ROUND_MARKER))).toHaveLength(0);
      expect(await store.readTarget({ sessionID })).toMatchObject({ status: "paused" });
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips the round when the foreground execution is stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-stop-workers-"));
    const sessionID = createSessionId("goal-swarm-stop-workers");
    const requests: string[] = [];
    const port = createSwarmSubagentPort(waitForAbortWorker);
    const generateText = vi.fn(swarmRequestDispatcher({ requests }));
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal stop workers");
      await store.setTarget({ sessionID, objective: "stop workers" });

      const running = runtime.continueActiveTargetIfIdle({ inputId: "swarm-stop-workers" });
      await vi.waitFor(() => expect(port.runCalls).toHaveLength(2), { timeout: 5_000 });
      runtime.stopActiveForegroundExecution({ reason: "user-stop" });

      const result = await running;

      // Stop 语义：旧轮按取消收口为 skip，不上浮失败、不 pause 目标、不起普通回合。
      expect(result).toBeNull();
      // M5：Stop 的取消域覆盖整条 runtime command，在途 worker 立即中止。
      expect(port.runOptions.every((options) => options?.signal?.aborted === true)).toBe(true);
      expect(requests.filter((text) => text.includes(SWARM_ROUND_MARKER))).toHaveLength(0);
      expect(await store.readTarget({ sessionID })).toMatchObject({ status: "active" });
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips the continuation when Stop lands after the swarm round completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-late-stop-"));
    const sessionID = createSessionId("goal-swarm-late-stop");
    const requests: string[] = [];
    const infos: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn((message: string, context?: Record<string, unknown>) => {
        infos.push({ message, context });
      }),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
    } as unknown as Logger;
    const port = createSwarmSubagentPort();
    const generateText = vi.fn(swarmRequestDispatcher({ requests }));
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
      logger,
    });
    const originalAccountTargetUsage = store.accountTargetUsage.bind(store);
    let stopped = false;
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal late stop");
      await store.setTarget({ sessionID, objective: "late stop" });
      // 聚合/journal 已完成、证据已到手；Stop 恰好落在预算记账期间。
      store.accountTargetUsage = async (input) => {
        if (!stopped) {
          stopped = true;
          runtime.stopActiveForegroundExecution({ reason: "late-user-stop" });
        }
        return originalAccountTargetUsage(input);
      };

      const result = await runtime.continueActiveTargetIfIdle({ inputId: "swarm-late-stop" });

      expect(result).toBeNull();
      expect(
        infos.some(
          (entry) => entry.context?.event === "target.continuation.skipped_after_swarm_cancel",
        ),
      ).toBe(true);
      // 带旧蜂群证据的续跑回合从未启动。
      expect(requests.filter((text) => text.includes(SWARM_ROUND_MARKER))).toHaveLength(0);
      expect(await store.readTarget({ sessionID })).toMatchObject({ status: "active" });
    } finally {
      store.accountTargetUsage = originalAccountTargetUsage;
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("charges decomposition and every worker usage to the goal budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-budget-"));
    const sessionID = createSessionId("goal-swarm-budget");
    const requests: string[] = [];
    const port = createSwarmSubagentPort(undefined, {
      totalTokens: 30,
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      totalDurationMs: 1_000,
    });
    const generateText = vi.fn(swarmRequestDispatcher({ requests }));
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal account swarm");
      await store.setTarget({ sessionID, objective: "account swarm" });

      await runtime.continueActiveTargetIfIdle({ inputId: "swarm-budget-round" });

      // H2：分解 2 + worker 30×2 + 主回合 2 = 64；墙钟开销也写入目标。
      const target = await store.readTarget({ sessionID });
      expect(target?.tokensUsed).toBe(64);
      expect(target?.timeUsedSeconds).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces the wall-clock budget against swarm execution time", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-wallclock-"));
    const sessionID = createSessionId("goal-swarm-wallclock");
    const requests: string[] = [];
    const port = createSwarmSubagentPort(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      return "slow work";
    });
    const generateText = vi.fn(swarmRequestDispatcher({ requests }));
    const { runtime, store } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal slow swarm");
      await store.setTarget({
        sessionID,
        objective: "slow swarm",
        wallClockBudgetSeconds: 1,
      });

      await runtime.continueActiveTargetIfIdle({ inputId: "swarm-wallclock-round" });

      const target = await store.readTarget({ sessionID });
      // H2：蜂群执行时间计入 wallClockBudgetSeconds，越过 100% 走宽限终局回合。
      expect(target).toMatchObject({ status: "budget_limited" });
      expect(target?.timeUsedSeconds).toBeGreaterThanOrEqual(2);
      expect(requests.some((text) => text.includes(SWARM_BUDGET_MARKER))).toBe(true);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses workspace merges and leaves the base HEAD untouched when the objective is rewritten mid-round", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-merge-gate-"));
    const sessionID = createSessionId("goal-swarm-merge-gate");
    const requests: string[] = [];
    const port = createSwarmSubagentPort(async (request) => {
      // 真实改动留在 worker 的隔离工作树里：只有闸门放行时才会出现 merge commit。
      await writeFile(
        join(request.workingDirectory, `worker-${request.description.replace(/\s+/g, "-")}.txt`),
        `work by ${request.description}\n`,
      );
      return request.prompt.includes("inspect core") ? "core finding" : "tests written";
    });
    let editTarget: (() => Promise<void>) | undefined;
    const generateText = vi.fn(
      swarmRequestDispatcher({
        requests,
        decompose: async () => {
          // 蜂群长 await 期间 GoalUpdate 改写 objective：状态仍 active、revision 递增。
          await editTarget!();
          return modelResult(JSON.stringify(SWARM_TASK_DESCRIPTIONS));
        },
      }),
    );
    const { runtime, store, eventStore } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    editTarget = () =>
      editTargetObjectiveWithEvent({
        runtime,
        store,
        sessionID,
        objective: "rewritten objective",
      });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal rewrite during merge gate");
      await store.setTarget({ sessionID, objective: "original objective" });
      const headBefore = gitHead(root);

      const result = await runtime.continueActiveTargetIfIdle({ inputId: "swarm-merge-gate-round" });

      expect(result).toBeNull();
      // 合并闸门按当前 revision 拒绝：worker 已跑完，但基准 HEAD 零推进。
      expect(gitHead(root)).toBe(headBefore);
      expect(port.runCalls).toHaveLength(2);
      expect(requests.filter((text) => text.includes(SWARM_ROUND_MARKER))).toHaveLength(0);
      const target = await store.readTarget({ sessionID });
      expect(target).toMatchObject({ objective: "rewritten objective", status: "active" });
      // 旧轮产出作废时不得把新目标当成失败轮来 pause。
      const pausedEvents = targetChangedEvents(await eventStore.getEvents(sessionID)).filter(
        (event) => (event.payload as TargetChangedPayload).target?.status === "paused",
      );
      expect(pausedEvents).toHaveLength(0);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not pause a target whose objective was rewritten during a failed round", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-fail-revision-"));
    const sessionID = createSessionId("goal-swarm-fail-revision");
    const requests: string[] = [];
    const port = createSwarmSubagentPort(() => {
      throw new Error("worker exploded");
    });
    let editTarget: (() => Promise<void>) | undefined;
    const generateText = vi.fn(
      swarmRequestDispatcher({
        requests,
        decompose: async () => {
          // 失败发生在旧 objective 的回合里；改写后的新目标不承担旧轮失败。
          await editTarget!();
          return modelResult(JSON.stringify(SWARM_TASK_DESCRIPTIONS));
        },
      }),
    );
    const { runtime, store, eventStore } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    editTarget = () =>
      editTargetObjectiveWithEvent({
        runtime,
        store,
        sessionID,
        objective: "rewritten objective",
      });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal fail after rewrite");
      await store.setTarget({ sessionID, objective: "original objective" });
      const before = await store.readTarget({ sessionID });

      const result = await runtime.continueActiveTargetIfIdle({ inputId: "swarm-fail-revision" });

      expect(result).toBeNull();
      expect(port.runCalls).toHaveLength(2);
      expect(requests.filter((text) => text.includes(SWARM_ROUND_MARKER))).toHaveLength(0);
      const target = await store.readTarget({ sessionID });
      expect(target).toMatchObject({ objective: "rewritten objective", status: "active" });
      expect(target?.revision).toBe((before?.revision ?? 0) + 1);
      // 旧轮全部失败的 pause 不落到改写后的新目标上。
      const failurePauses = targetChangedEvents(await eventStore.getEvents(sessionID)).filter(
        (event) =>
          (event.payload as TargetChangedPayload).reason?.startsWith("swarm_execution_failed"),
      );
      expect(failurePauses).toHaveLength(0);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not pause a target rewritten between the failure recheck and the pause CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-fail-race-"));
    const sessionID = createSessionId("goal-swarm-fail-race");
    const requests: string[] = [];
    const port = createSwarmSubagentPort(() => {
      throw new Error("worker exploded");
    });
    const generateText = vi.fn(swarmRequestDispatcher({ requests }));
    const { runtime, store, eventStore } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    const originalUpdateTargetStatus = store.updateTargetStatus.bind(store);
    const pauseInputs: TargetStatusUpdate[] = [];
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal fail after late rewrite");
      await store.setTarget({ sessionID, objective: "race objective" });
      const before = await store.readTarget({ sessionID });
      // 模拟 GoalUpdate 恰好落在失败复核之后、pause CAS 之前：pause 发起时先提交
      // objective 改写（revision+1），旧 revision 的 pause 必须落空。
      store.updateTargetStatus = async (input) => {
        pauseInputs.push(input);
        if (input.status === "paused" && input.reason?.startsWith("swarm_execution_failed")) {
          const current = await store.readTarget({ sessionID });
          if (current) {
            await store.updateTargetObjective({
              sessionID,
              targetID: current.targetID,
              revision: current.revision,
              objective: "rewritten before pause CAS",
            });
          }
        }
        return originalUpdateTargetStatus(input);
      };

      await expect(
        runtime.continueActiveTargetLoop({ inputId: "swarm-fail-race", trigger: "manual" }),
      ).rejects.toThrow(/Swarm aggregation failed for all 2 task\(s\)/);

      expect(pauseInputs).toHaveLength(1);
      expect(pauseInputs[0]).toMatchObject({
        expectedRevision: before?.revision,
        expectedStatus: "active",
        expectedTargetID: before?.targetID,
      });
      const target = await store.readTarget({ sessionID });
      expect(target).toMatchObject({ objective: "rewritten before pause CAS", status: "active" });
      expect(target?.revision).toBe((before?.revision ?? 0) + 1);
      // 旧 revision 的失败 pause 没有落到改写后的目标上。
      const failurePauses = targetChangedEvents(await eventStore.getEvents(sessionID)).filter(
        (event) =>
          (event.payload as TargetChangedPayload).reason?.startsWith("swarm_execution_failed"),
      );
      expect(failurePauses).toHaveLength(0);
    } finally {
      store.updateTargetStatus = originalUpdateTargetStatus;
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the budget grace turn instead of pausing when failed-round accounting exhausts the token budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-goal-swarm-fail-budget-"));
    const sessionID = createSessionId("goal-swarm-fail-budget");
    const requests: string[] = [];
    const port = createSwarmSubagentPort(() => {
      throw new Error("worker exploded");
    });
    const generateText = vi.fn(swarmRequestDispatcher({ requests }));
    const { runtime, store, eventStore } = await createSwarmGoalRuntime({
      sessionID,
      root,
      goalLayerEnabled: true,
      swarmEnabled: true,
      generateText,
      subagentPort: port,
    });
    try {
      await runtime.ensureSessionPersistedForExternalActivity("/goal failed swarm budget");
      // 分解调用 2 token 已越过 1 token 的预算：记账会在失败收口前把目标翻 budget_limited。
      await store.setTarget({
        sessionID,
        objective: "failed swarm budget",
        tokenBudget: 1,
      });

      const result = await runtime.continueActiveTargetIfIdle({
        inputId: "swarm-fail-budget-round",
      });

      expect(result).not.toBeNull();
      const target = await store.readTarget({ sessionID });
      expect(target).toMatchObject({ status: "budget_limited", tokensUsed: 2 });
      // 宽限终局回合必须先于失败 pause：prompt 真实进入会话模型。
      expect(requests.some((text) => text.includes(SWARM_BUDGET_MARKER))).toBe(true);
      const failurePauses = targetChangedEvents(await eventStore.getEvents(sessionID)).filter(
        (event) =>
          (event.payload as TargetChangedPayload).reason?.startsWith("swarm_execution_failed"),
      );
      expect(failurePauses).toHaveLength(0);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
