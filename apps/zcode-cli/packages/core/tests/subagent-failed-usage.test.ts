import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ModelTransportKind,
  SessionEventType,
  createSessionEvent,
  createSessionId,
  createTraceId,
  createTurnId,
  type SessionEvent,
  type SubagentPort,
} from "@zcode/contracts";
import {
  aggregateModelUsageFromEvents,
  createExploreSubagentPort,
  extractSubagentFailedUsage,
  type ExploreSubagentRuntimeRequest,
} from "../src/subagent/runner.js";
import { SwarmWorker, type SwarmTask } from "../src/runtime/swarm/index.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

describe("subagent failed usage", () => {
  it("过 cause 链读取 defineProperty 挂载的 usage/totalTokens", () => {
    const usage = { inputTokens: 7, outputTokens: 2, totalTokens: 9 };
    const original = new Error("provider rejected request");
    // 生产挂载是非枚举属性；读取不能依赖枚举或 JSON 序列化。
    Object.defineProperty(original, "usage", {
      configurable: true,
      enumerable: false,
      value: usage,
      writable: true,
    });
    Object.defineProperty(original, "totalTokens", {
      configurable: true,
      enumerable: false,
      value: 9,
      writable: true,
    });
    const wrapper = new Error("Explore subagent failed", { cause: original });

    expect(extractSubagentFailedUsage(wrapper)).toEqual({ usage, totalTokens: 9 });
    expect(extractSubagentFailedUsage(original)).toEqual({ usage, totalTokens: 9 });
  });

  it("链上没有用量事实时返回空对象，不读取无效 usage", () => {
    expect(extractSubagentFailedUsage(new Error("plain failure"))).toEqual({});
    expect(extractSubagentFailedUsage(undefined)).toEqual({});
    expect(extractSubagentFailedUsage("not an error")).toEqual({});

    const withEmptyUsage = new Error("empty usage");
    Object.defineProperty(withEmptyUsage, "usage", { configurable: true, value: {} });
    expect(extractSubagentFailedUsage(withEmptyUsage)).toEqual({});
  });

  it("汇总 ModelComplete 与 model_request_failed 的 usage/totalTokens", () => {
    const sessionId = createSessionId("failed-usage-events");
    const eventOptions = { traceId: createTraceId("failed-usage-trace"), turnId: createTurnId() };
    const events = [
      // 空 usage 不产生汇总事实。
      createSessionEvent(SessionEventType.ModelComplete, sessionId, { usage: {} }, eventOptions),
      createSessionEvent(
        SessionEventType.ModelComplete,
        sessionId,
        { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
        eventOptions,
      ),
      createSessionEvent(
        SessionEventType.ModelNetworkStatus,
        sessionId,
        {
          type: "model_request_failed",
          usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 40, reasoningTokens: 1 },
        },
        eventOptions,
      ),
      // 非失败状态的网络事件不贡献失败用量。
      createSessionEvent(
        SessionEventType.ModelNetworkStatus,
        sessionId,
        { type: "model_request_completed", usage: { inputTokens: 100, outputTokens: 100 } },
        eventOptions,
      ),
    ];

    expect(aggregateModelUsageFromEvents(events)).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 35,
      cacheReadTokens: 40,
      reasoningTokens: 1,
    });
  });

  it("真实 runExploreAgent 失败路径把已落库的失败请求用量挂到 error", async () => {
    const sessionId = createSessionId("failed-usage-subagent-parent");
    const turnId = createTurnId("failed-usage-subagent-turn");
    const traceId = createTraceId("failed-usage-subagent-trace");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-failed-usage-"));
    const failedUsage = {
      inputTokens: 80,
      outputTokens: 5,
      totalTokens: 85,
      cacheReadTokens: 60,
      reasoningTokens: 5,
    };
    const eventStore = createTestSessionEventStore();

    try {
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "yolo",
          workingDirectory: outputRootDir,
          subagents: { outputRootDir },
        },
        {
          eventStore,
          sessionStore: createRecordingSubagentSessionStore(),
          modelFactory: createTestModelFactory({
            async generateText(_request, observation) {
              // 测试 Model 在 provider 边界替身：像 adapter 一样先发失败状态（含 provider 报告的用量），
              // 再回到真实 Runtime 的失败收口与 runExploreAgent 包装链路。
              await observation.invocationContext?.statusSink?.publish({
                attempt: 1,
                maxAttempts: 1,
                providerId: String(observation.model.providerId),
                modelId: String(observation.model.modelId),
                requestId: "failed-usage-request",
                timestamp: new Date().toISOString(),
                traceId:
                  observation.invocationContext?.traceContext?.traceId ??
                  createTraceId("failed-usage-fallback"),
                transport: ModelTransportKind.Sse,
                type: "model_request_failed",
                reason: "invalid_request",
                retryable: false,
                message: "provider rejected request",
                usage: failedUsage,
              });
              throw new Error("provider rejected request");
            },
          }),
        },
      );

      let caught: unknown;
      try {
        await runtime.launchSubagent({
          agentType: "Explore",
          description: "Failed usage",
          prompt: "Inspect failed usage",
          parentToolCallId: "call_failed_usage",
          sessionId,
          turnId,
          trace: { traceId, sessionId, turnId },
          workingDirectory: outputRootDir,
          workspaceRoot: outputRootDir,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(extractSubagentFailedUsage(caught)).toEqual({
        usage: failedUsage,
        totalTokens: 85,
      });
    } finally {
      await rm(outputRootDir, { recursive: true, force: true });
    }
  });

  it("真实后台子代理失败后的 waitForTask 快照带 modelUsage/totalTokens，worker 按同一事实记账", async () => {
    const sessionId = createSessionId("failed-usage-background-parent");
    const turnId = createTurnId("failed-usage-background-turn");
    const traceId = createTraceId("failed-usage-background-trace");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-failed-background-"));
    const failedUsage = {
      inputTokens: 80,
      outputTokens: 5,
      totalTokens: 85,
      cacheReadTokens: 60,
      reasoningTokens: 5,
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        workingDirectory: outputRootDir,
        subagents: { outputRootDir },
      },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: createRecordingSubagentSessionStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            // 与前台链路同一条 provider 边界：先落失败状态（含真实用量），再让 turn 失败。
            await observation.invocationContext?.statusSink?.publish({
              attempt: 1,
              maxAttempts: 1,
              providerId: String(observation.model.providerId),
              modelId: String(observation.model.modelId),
              requestId: "failed-usage-background-request",
              timestamp: new Date().toISOString(),
              traceId:
                observation.invocationContext?.traceContext?.traceId ??
                createTraceId("failed-usage-background-fallback"),
              transport: ModelTransportKind.Sse,
              type: "model_request_failed",
              reason: "invalid_request",
              retryable: false,
              message: "provider rejected request",
              usage: failedUsage,
            });
            throw new Error("provider rejected request");
          },
        }),
      },
    );
    const port = (runtime as unknown as { subagentPort: SubagentPort }).subagentPort;
    const trace = { traceId, sessionId, turnId };
    const parentToolCallId = "call_failed_usage_background";

    try {
      const launched = await port.start!({
        sessionId,
        turnId,
        parentToolCallId,
        agentType: "Explore",
        description: "Failed background usage",
        prompt: "Inspect failed background usage",
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
        trace,
      });
      expect(launched.status).toBe("async_launched");

      const snapshot = await port.waitForTask!(launched.backgroundTaskId);
      expect(snapshot?.status).toBe("failed");
      expect(snapshot?.usage).toEqual({
        durationMs: expect.any(Number),
        modelUsage: failedUsage,
        totalTokens: 85,
      });

      // worker 只把 snapshot.usage.modelUsage/totalTokens 交给预算，结果与 runner 快照一致。
      const workerPort: SubagentPort = {
        async launch() {
          throw new Error("SwarmWorker must not call launch()");
        },
        async run() {
          return launched;
        },
        async waitForTask(taskId, options) {
          return await port.waitForTask!(taskId, options);
        },
        async stopTask(taskId, options) {
          return await port.stopTask!(taskId, options);
        },
      };
      const swarmTask: SwarmTask = {
        taskId: "failed-usage-swarm-task",
        agentType: "Explore",
        description: "Failed background usage",
        prompt: "Inspect failed background usage",
        status: "pending",
        sessionId,
        turnId,
        parentToolCallId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
        trace,
      };
      const result = await new SwarmWorker(workerPort).execute(swarmTask);
      expect(result).toMatchObject({
        status: "failed",
        usage: failedUsage,
        totalTokens: 85,
      });
    } finally {
      await runtime.close();
      await rm(outputRootDir, { recursive: true, force: true });
    }
  });
});

describe("subagent message producer", () => {
  it("child 模型回复正文转成父会话 SubagentMessage 且关联键完整", async () => {
    const parentSessionId = createSessionId("message-producer-parent");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-message-producer-"));
    const parentEvents: SessionEvent[] = [];
    const requests: ExploreSubagentRuntimeRequest[] = [];
    const port = createExploreSubagentPort({
      outputRootDir,
      emitParentEvent: async (event) => {
        parentEvents.push(event);
      },
      runExploreAgent: async (request) => {
        requests.push(request);
        request.onChildAssistantMessage?.("child says hi");
        return {
          response: "done",
          traceId: request.traceContext.traceId,
          events: [],
        };
      },
    });

    try {
      const result = await port.run({
        sessionId: parentSessionId,
        agentType: "general-purpose",
        description: "message producer",
        parentToolCallId: "tool-call-message",
        prompt: "say hi",
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
        trace: { traceId: createTraceId("message-producer-trace"), sessionId: parentSessionId },
      });
      if (result.status !== "completed") throw new Error("expected a completed run");

      const messageEvent = parentEvents.find(
        (event) => event.type === SessionEventType.SubagentMessage,
      );
      expect(messageEvent?.sessionId).toBe(parentSessionId);
      expect(messageEvent?.payload).toMatchObject({
        agentId: result.agentId,
        agentType: "general-purpose",
        childSessionId: requests[0]?.sessionId,
        parentToolCallId: "tool-call-message",
        summaryText: "child says hi",
      });
      // 摘要必须排在终态事件之前，父 timeline 才能先看到进度再看到收口。
      const messageIndex = parentEvents.findIndex(
        (event) => event.type === SessionEventType.SubagentMessage,
      );
      const stoppedIndex = parentEvents.findIndex(
        (event) => event.type === SessionEventType.SubagentStopped,
      );
      expect(messageIndex).toBeGreaterThanOrEqual(0);
      expect(stoppedIndex).toBeGreaterThan(messageIndex);
    } finally {
      await port.close();
      await rm(outputRootDir, { recursive: true, force: true });
    }
  });

  it("child 在模型回复后失败：摘要仍先于 SubagentStopped 收口", async () => {
    const parentSessionId = createSessionId("message-producer-failure-parent");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-message-failure-"));
    const parentEvents: SessionEvent[] = [];
    const port = createExploreSubagentPort({
      outputRootDir,
      emitParentEvent: async (event) => {
        parentEvents.push(event);
      },
      runExploreAgent: async (request) => {
        // 真实 child 先 persist session（ready）再发首次模型请求；失败发生在 ready 之后。
        await request.onSessionReady?.();
        request.onChildAssistantMessage?.("child progress before failure");
        throw new Error("child failed after a model reply");
      },
    });

    try {
      await expect(
        port.run({
          sessionId: parentSessionId,
          agentType: "general-purpose",
          description: "message producer failure",
          parentToolCallId: "tool-call-message-failure",
          prompt: "fail after progress",
          workingDirectory: outputRootDir,
          workspaceRoot: outputRootDir,
          trace: {
            traceId: createTraceId("message-producer-failure-trace"),
            sessionId: parentSessionId,
          },
        }),
      ).rejects.toThrow();

      const messageIndex = parentEvents.findIndex(
        (event) => event.type === SessionEventType.SubagentMessage,
      );
      const stoppedIndex = parentEvents.findIndex(
        (event) => event.type === SessionEventType.SubagentStopped,
      );
      expect(messageIndex).toBeGreaterThanOrEqual(0);
      expect(stoppedIndex).toBeGreaterThan(messageIndex);
      expect(parentEvents[messageIndex]?.payload).toMatchObject({
        parentToolCallId: "tool-call-message-failure",
        summaryText: "child progress before failure",
      });
      expect(parentEvents[stoppedIndex]?.payload).toMatchObject({
        parentToolCallId: "tool-call-message-failure",
        status: "failed",
        error: "child failed after a model reply",
      });
    } finally {
      await port.close();
      await rm(outputRootDir, { recursive: true, force: true });
    }
  });

  it("SubagentMessage 摘要按 200 码元截断且不留下半个 emoji", async () => {
    const parentSessionId = createSessionId("message-producer-truncate-parent");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-message-truncate-"));
    const parentEvents: SessionEvent[] = [];
    const port = createExploreSubagentPort({
      outputRootDir,
      emitParentEvent: async (event) => {
        parentEvents.push(event);
      },
      runExploreAgent: async (request) => {
        // 199 个 ASCII + 1 个 emoji（2 个码元）：第 200 个码元正好是 emoji 的高位代理。
        request.onChildAssistantMessage?.(`${"a".repeat(199)}😀tail`);
        return {
          response: "done",
          traceId: request.traceContext.traceId,
          events: [],
        };
      },
    });

    try {
      const result = await port.run({
        sessionId: parentSessionId,
        agentType: "general-purpose",
        description: "message producer truncate",
        parentToolCallId: "tool-call-message-truncate",
        prompt: "say a lot",
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
        trace: {
          traceId: createTraceId("message-producer-truncate-trace"),
          sessionId: parentSessionId,
        },
      });
      if (result.status !== "completed") throw new Error("expected a completed run");

      const messageEvent = parentEvents.find(
        (event) => event.type === SessionEventType.SubagentMessage,
      );
      const summaryText = (messageEvent?.payload as { summaryText?: string } | undefined)
        ?.summaryText;
      expect(summaryText).toBe("a".repeat(199));
      const tail = summaryText?.charCodeAt(summaryText.length - 1) ?? 0;
      expect(tail >= 0xd800 && tail <= 0xdbff).toBe(false);
    } finally {
      await port.close();
      await rm(outputRootDir, { recursive: true, force: true });
    }
  });

  it("真实 child 的 ModelComplete 正文经 eventSink 产出父会话 SubagentMessage", async () => {
    const sessionId = createSessionId("message-producer-real-parent");
    const turnId = createTurnId("message-producer-real-turn");
    const traceId = createTraceId("message-producer-real-trace");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-real-message-"));
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        workingDirectory: outputRootDir,
        subagents: { outputRootDir },
      },
      {
        eventStore,
        sessionStore: createRecordingSubagentSessionStore(),
        modelFactory: createTestModelFactory({
          async generateText() {
            return {
              finishReason: "stop",
              text: "child says hi",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    const port = (runtime as unknown as { subagentPort: SubagentPort }).subagentPort;
    const trace = { traceId, sessionId, turnId };

    try {
      const result = await port.run({
        sessionId,
        turnId,
        parentToolCallId: "tool-call-real-message",
        agentType: "Explore",
        description: "Real message producer",
        prompt: "say hi",
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
        trace,
      });
      if (result.status !== "completed") throw new Error("expected a completed run");

      const messageEvent = (await eventStore.getEvents(sessionId)).find(
        (event) => event.type === SessionEventType.SubagentMessage,
      );
      expect(messageEvent?.payload).toMatchObject({
        agentId: result.agentId,
        agentType: "Explore",
        parentToolCallId: "tool-call-real-message",
        summaryText: "child says hi",
      });
    } finally {
      await runtime.close();
      await rm(outputRootDir, { recursive: true, force: true });
    }
  });
});
