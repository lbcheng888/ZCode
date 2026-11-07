import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  SessionEventType,
  type GoalStatus,
  type SessionGoal,
  type SessionId,
  type SessionStorePort,
  type TargetChangedPayload,
} from "@zcode/contracts";

import { verifyActiveTargetCompletionForContinuation } from "../src/runtime/methods/target-completion-verification.js";
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
