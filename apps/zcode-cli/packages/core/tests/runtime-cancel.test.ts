import { describe, expect, it } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  type SessionGoal,
  type SessionStorePort,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("AgentRuntime turn cancellation", () => {
  // Bugfix 回归：用户主动取消（TurnCancelled）属于正常结束，事件流应以 TurnComplete(cancelled)
  // 结尾、绝不出现 TurnError，避免被下游映射成 turn.failed。
  it("emits TurnComplete(cancelled) instead of TurnError when the turn is aborted", async () => {
    const sessionId = createSessionId("runtime-cancel-turn");
    const eventStore = createTestSessionEventStore();
    const abortController = new AbortController();

    const runtime = createTestAgentRuntime(
      sessionId,
      { systemPrompt: "You are a cancel test agent." },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            // 模拟用户在模型请求进行中按下取消。
            abortController.abort(new Error("user cancelled"));
            throw new Error("user cancelled");
          },
        } as never),
      },
    );

    await expect(
      runtime.executeTurn("do something long", undefined, {
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });

    const events = await eventStore.getEvents(sessionId);
    const types = events.map((event) => event.type);

    expect(types).not.toContain(SessionEventType.TurnError);
    expect(types[types.length - 1]).toBe(SessionEventType.TurnComplete);

    const completeEvent = events[events.length - 1];
    expect((completeEvent.payload as { resultType?: string }).resultType).toBe("cancelled");
  });

  it("keeps a cancelled goal paused when resuming the session", async () => {
    const sessionId = createSessionId("runtime-cancel-paused-goal-resume");
    let target: SessionGoal = {
      sessionID: sessionId,
      targetID: "target-paused" as never,
      objective: "Ship the paused goal",
      summaryTitle: null,
      status: "paused",
      revision: 1,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      time: {
        created: 1,
        updated: 1,
      },
    };
    let updateTargetStatusCalls = 0;
    const sessionStore = {
      async readTarget() {
        return target;
      },
      async updateTargetStatus(input: { status: SessionGoal["status"] }) {
        updateTargetStatusCalls += 1;
        target = {
          ...target,
          status: input.status,
          time: {
            ...target.time,
            updated: target.time.updated + 1,
          },
        };
        return target;
      },
    } as unknown as SessionStorePort;
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore,
      },
    );

    const resumedTarget = await runtime.activatePausedTargetAfterResume(
      createRootTraceContext({ sessionId }),
    );

    expect(resumedTarget).toMatchObject({ status: "paused" });
    expect(updateTargetStatusCalls).toBe(0);
    await expect(sessionStore.readTarget({ sessionID: sessionId })).resolves.toMatchObject({
      status: "paused",
    });
  });

  it("forces an active goal to paused at the session-start edge (disarm)", async () => {
    const sessionId = createSessionId("runtime-cancel-active-goal-disarm");
    let target: SessionGoal = {
      sessionID: sessionId,
      targetID: "target-active" as never,
      objective: "Ship the active goal",
      summaryTitle: null,
      status: "active",
      revision: 1,
      tokenBudget: null,
      tokensUsed: 3,
      timeUsedSeconds: 1,
      time: {
        created: 1,
        updated: 1,
      },
    };
    const updateCalls: Array<{ status: string; reason?: string }> = [];
    const sessionStore = {
      async readTarget() {
        return target;
      },
      async updateTargetStatus(input: { status: SessionGoal["status"]; reason?: string }) {
        updateCalls.push({ reason: input.reason, status: input.status });
        target = {
          ...target,
          status: input.status,
          time: {
            ...target.time,
            updated: target.time.updated + 1,
          },
        };
        return target;
      },
    } as unknown as SessionStorePort;
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        sessionStore,
      },
    );

    const resumedTarget = await runtime.activatePausedTargetAfterResume(
      createRootTraceContext({ sessionId }),
    );

    // session-start 边缘(重启/resume/fork)必须 disarm:active → paused,
    // 续跑需人显式 /goal resume(设计 §3.2);事件携带 session-start-disarm 缘由。
    expect(resumedTarget).toMatchObject({ status: "paused" });
    expect(updateCalls).toEqual([{ reason: "session-start-disarm", status: "paused" }]);
    const events = await eventStore.getEvents(sessionId);
    const targetChanged = events.find(
      (event) => event.type === SessionEventType.TargetChanged,
    );
    expect(targetChanged?.payload).toMatchObject({
      action: "status_updated",
      reason: "session-start-disarm",
      source: "runtime",
      target: { status: "paused" },
    });
  });


  // cancel 类型化 + keepInbox(设计 §3.5):keepInbox=false 时收件箱积压显式清账,
  // 缺省(true)保留为 held——guide 改投 queue、inject 留在 next-step 车道。
  it("discards the inbox backlog when a typed cancel requests keepInbox=false", async () => {
    const sessionId = createSessionId("runtime-cancel-keep-inbox-false");
    const eventStore = createTestSessionEventStore();
    const firstModelStarted = deferred<void>();
    const firstModelCanFinish = deferred<void>();

    const runtime = createTestAgentRuntime(
      sessionId,
      { goalLayerEnabled: true, systemPrompt: "You are a keepInbox cancel test agent." },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            firstModelStarted.resolve();
            await firstModelCanFinish.promise;
            return modelTextResult("in flight");
          },
        } as never),
      },
    );

    const turn = runtime.executeTurn("prompt that will be stopped");
    await firstModelStarted.promise;
    await runtime.steerTurn({ input: "queued followup", delivery: "queue" });
    await runtime.steerTurn({ input: "ambient inject", delivery: "inject" });

    const stopResult = runtime.stopActiveForegroundExecution({
      cause: "user",
      keepInbox: false,
      reason: "test keepInbox=false stop",
    });
    expect(stopResult.kind).toBe("stopped");
    firstModelCanFinish.resolve();
    await expect(turn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });

    const projection = await runtime.getProjection();
    expect(projection.pendingSteerInputs).toHaveLength(0);
    const events = await eventStore.getEvents(sessionId);
    const discarded = events.find(
      (event) => event.type === SessionEventType.TurnSteerDiscarded,
    );
    expect(discarded?.payload).toMatchObject({ reason: "turn_cancelled" });
  });

  it("keeps the inbox backlog as held by default on typed cancel", async () => {
    const sessionId = createSessionId("runtime-cancel-keep-inbox-default");
    const eventStore = createTestSessionEventStore();
    const firstModelStarted = deferred<void>();
    const firstModelCanFinish = deferred<void>();

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        goalLayerEnabled: true,
        systemPrompt: "You are a default keepInbox cancel test agent.",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            firstModelStarted.resolve();
            await firstModelCanFinish.promise;
            return modelTextResult("in flight");
          },
        } as never),
      },
    );

    const turn = runtime.executeTurn("prompt that will be stopped");
    await firstModelStarted.promise;
    await runtime.steerTurn({ input: "queued followup", delivery: "queue" });
    await runtime.steerTurn({ input: "ambient inject", delivery: "inject" });

    // 缺省 keepInbox=true(现状语义):取消后积压保留,guide 类改投 queue。
    expect(
      runtime.stopActiveForegroundExecution({ cause: "user", reason: "test default stop" })
        .kind,
    ).toBe("stopped");
    firstModelCanFinish.resolve();
    await expect(turn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });

    const projection = await runtime.getProjection();
    expect(projection.pendingSteerInputs.map((item) => [item.input, item.delivery])).toEqual([
      ["queued followup", "queue"],
      ["ambient inject", "inject"],
    ]);
    const events = await eventStore.getEvents(sessionId);
    expect(
      events.find((event) => event.type === SessionEventType.TurnSteerDiscarded),
    ).toBeUndefined();
  });

  it("rejects a cancelled queued prompt before the active turn finishes", async () => {
    const sessionId = createSessionId("runtime-cancel-queued-prompt");
    const firstModelStarted = deferred<void>();
    const firstModelCanFinish = deferred<void>();
    const abortController = new AbortController();
    let modelCallCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      { systemPrompt: "You are a command queue cancellation test agent." },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCallCount += 1;
            if (modelCallCount === 1) {
              firstModelStarted.resolve();
              await firstModelCanFinish.promise;
              return modelTextResult("first complete");
            }
            return modelTextResult("second should not start");
          },
        } as never),
      },
    );

    const firstTurn = runtime.executeTurn("first prompt");
    await firstModelStarted.promise;

    const secondTurn = runtime.executeTurn("second prompt", undefined, {
      abortSignal: abortController.signal,
    });
    let secondRejected = false;
    let secondError: unknown;
    const observedSecondTurn = secondTurn.catch((error) => {
      secondRejected = true;
      secondError = error;
      return error;
    });

    try {
      abortController.abort(new Error("queued prompt cancelled"));
      await waitForMacrotask();

      expect(secondRejected).toBe(true);
      expect(modelCallCount).toBe(1);
    } finally {
      firstModelCanFinish.resolve();
      await firstTurn.catch(() => undefined);
      await observedSecondTurn;
    }

    expect(secondError).toMatchObject({ type: CoreErrorType.TurnCancelled });
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function modelTextResult(text: string) {
  return {
    finishReason: "stop",
    model: "test",
    providerMetadata: undefined,
    text,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };
}

async function waitForMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
