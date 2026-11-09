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
} from "@zcode/contracts";
import {
  aggregateModelUsageFromEvents,
  extractSubagentFailedUsage,
} from "../src/subagent/runner.js";
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
});
