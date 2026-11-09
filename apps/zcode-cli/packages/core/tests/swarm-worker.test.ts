import { describe, expect, it, vi } from "vitest";
import { AgentType, createSessionId, createTraceId } from "@zcode/contracts";
import type {
  AgentCompletedOutput,
  AgentOutput,
  SessionId,
  SubagentPort,
  SubagentRunOptions,
  SubagentRunRequest,
  SubagentTaskSnapshot,
  TurnId,
} from "@zcode/contracts";
import { SwarmWorker } from "../src/runtime/swarm-worker.js";
import type { SwarmTask } from "../src/runtime/swarm-orchestrator.js";

interface RunCall {
  request: SubagentRunRequest;
  options?: SubagentRunOptions;
}

/** 测试替身：只实现 SwarmWorker 会用的执行边界，可挂后台 wait/stop。 */
function createPort(
  run: SubagentPort["run"],
  extras: Pick<SubagentPort, "waitForTask" | "stopTask"> = {},
): SubagentPort & { readonly runCalls: RunCall[] } {
  const runCalls: RunCall[] = [];
  return {
    runCalls,
    async launch(): Promise<AgentOutput> {
      throw new Error("SwarmWorker must not call launch()");
    },
    run(request, options) {
      runCalls.push({ request, options });
      return run(request, options);
    },
    ...extras,
  };
}

const parentSessionId: SessionId = createSessionId("parent-session");

function createTask(overrides: Partial<SwarmTask> = {}): SwarmTask {
  return {
    taskId: "subtask-1",
    agentType: AgentType.GeneralPurpose,
    description: "summarize module",
    prompt: "summarize packages/core runtime",
    status: "pending",
    sessionId: parentSessionId,
    turnId: "turn-1" as TurnId,
    parentToolCallId: "tool-call-1",
    workingDirectory: "/repo/packages/core",
    workspaceRoot: "/repo",
    trace: { traceId: createTraceId(), sessionId: parentSessionId },
    ...overrides,
  };
}

function completedOutput(): AgentCompletedOutput {
  return {
    status: "completed",
    agentId: "agent-1",
    agentType: AgentType.GeneralPurpose,
    description: "summarize module",
    prompt: "summarize packages/core runtime",
    content: [{ type: "text", text: "done" }],
    totalToolUseCount: 3,
    totalDurationMs: 1234,
    totalTokens: 567,
    usage: { inputTokens: 400, outputTokens: 167, totalTokens: 567 },
  };
}

function backgroundedOutput(): AgentOutput {
  return {
    status: "async_launched",
    isAsync: true,
    agentId: "agent-bg",
    agentType: AgentType.GeneralPurpose,
    description: "summarize module",
    prompt: "summarize packages/core runtime",
    childSessionId: "child-session",
    backgroundTaskId: "bg-task-1",
    outputFile: "/tmp/agent-bg.output",
    canReadOutputFile: true,
  };
}

function completedSnapshot(): SubagentTaskSnapshot {
  return {
    taskId: "bg-task-1",
    agentId: "agent-bg",
    agentType: AgentType.GeneralPurpose,
    description: "summarize module",
    status: "completed",
    startedAt: new Date(),
    output: completedOutput(),
  };
}

describe("SwarmWorker", () => {
  it("executes the task through SubagentPort.run and returns the completed result", async () => {
    const port = createPort(async () => completedOutput());
    const task = createTask();

    const result = await new SwarmWorker(port).execute(task);

    expect(result).toEqual({
      status: "completed",
      taskId: "subtask-1",
      agentId: "agent-1",
      agentType: AgentType.GeneralPurpose,
      description: "summarize module",
      content: [{ type: "text", text: "done" }],
      totalToolUseCount: 3,
      totalDurationMs: 1234,
      totalTokens: 567,
      usage: { inputTokens: 400, outputTokens: 167, totalTokens: 567 },
    });
    expect(port.runCalls).toHaveLength(1);
    expect(port.runCalls[0]?.request).toEqual({
      sessionId: parentSessionId,
      turnId: "turn-1",
      parentToolCallId: "tool-call-1",
      agentType: AgentType.GeneralPurpose,
      description: "summarize module",
      prompt: "summarize packages/core runtime",
      workingDirectory: "/repo/packages/core",
      workspaceRoot: "/repo",
      trace: task.trace,
    });
    expect(port.runCalls[0]?.options).toBeUndefined();
  });

  it("forwards the round signal to SubagentPort.run", async () => {
    const controller = new AbortController();
    const port = createPort(async () => completedOutput());

    await new SwarmWorker(port).execute(createTask(), { signal: controller.signal });

    expect(port.runCalls[0]?.options?.signal).toBe(controller.signal);
  });

  it("reports a rejected run as failed while preserving the original error", async () => {
    const error = new Error("child runtime exploded");
    const port = createPort(async () => {
      throw error;
    });

    const result = await new SwarmWorker(port).execute(createTask());

    expect(result).toMatchObject({
      status: "failed",
      taskId: "subtask-1",
      agentType: AgentType.GeneralPurpose,
      description: "summarize module",
      error: "child runtime exploded",
    });
    if (result.status !== "failed") throw new Error("expected a failed result");
    expect(result.cause).toBe(error);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("extracts usage and totalTokens from an error's cause chain", async () => {
    const providerError = Object.assign(new Error("provider failed"), {
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      totalTokens: 10,
    });
    const childError = new Error("child runtime failed");
    Object.assign(childError, { cause: providerError });
    const port = createPort(async () => {
      throw childError;
    });

    const result = await new SwarmWorker(port).execute(createTask());

    expect(result).toMatchObject({
      status: "failed",
      error: "child runtime failed",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      totalTokens: 10,
    });
  });

  it("carries usage from the abort error into a cancelled result", async () => {
    const controller = new AbortController();
    const providerError = Object.assign(new Error("aborted mid-flight"), {
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
    const childError = new Error("subagent aborted");
    Object.assign(childError, { cause: providerError });
    const port = createPort(async () => {
      controller.abort(new Error("user stopped the swarm"));
      throw childError;
    });

    const result = await new SwarmWorker(port).execute(createTask(), {
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: "cancelled",
      reason: "user stopped the swarm",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
  });

  it("returns cancelled without spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("swarm stopped"));
    const port = createPort(async () => completedOutput());

    const result = await new SwarmWorker(port).execute(createTask(), {
      signal: controller.signal,
    });

    expect(result).toEqual({
      status: "cancelled",
      taskId: "subtask-1",
      agentType: AgentType.GeneralPurpose,
      description: "summarize module",
      reason: "swarm stopped",
      totalDurationMs: expect.any(Number),
    });
    expect(port.runCalls).toHaveLength(0);
  });

  it("maps an abort during execution to cancelled instead of failed", async () => {
    const controller = new AbortController();
    const port = createPort(async () => {
      controller.abort(new Error("user stopped the swarm"));
      throw new Error("subagent aborted");
    });

    const result = await new SwarmWorker(port).execute(createTask(), {
      signal: controller.signal,
    });

    expect(result).toEqual({
      status: "cancelled",
      taskId: "subtask-1",
      agentType: AgentType.GeneralPurpose,
      description: "summarize module",
      reason: "user stopped the swarm",
      totalDurationMs: expect.any(Number),
    });
  });

  it("waits for an auto-backgrounded worker and returns its real completed output", async () => {
    const waitForTask = vi.fn(async () => completedSnapshot());
    const port = createPort(async () => backgroundedOutput(), {
      waitForTask,
      stopTask: vi.fn(),
    });

    const result = await new SwarmWorker(port).execute(createTask());

    expect(waitForTask).toHaveBeenCalledWith("bg-task-1", undefined);
    expect(result).toMatchObject({
      status: "completed",
      taskId: "subtask-1",
      content: [{ type: "text", text: "done" }],
      totalToolUseCount: 3,
    });
  });

  it("stops the background worker when the round aborts while waiting", async () => {
    const controller = new AbortController();
    const stopTask = vi.fn(async () => completedSnapshot());
    const waitForTask = vi.fn(
      async (_taskId: string, options?: { signal?: AbortSignal }) =>
        await new Promise<SubagentTaskSnapshot | undefined>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    const port = createPort(async () => backgroundedOutput(), { waitForTask, stopTask });

    const running = new SwarmWorker(port).execute(createTask(), { signal: controller.signal });
    await vi.waitFor(() => expect(waitForTask).toHaveBeenCalled(), { timeout: 1_000 });
    controller.abort(new Error("user stopped the swarm"));
    const result = await running;

    // abort 收口是运行时行为，不是用户显式 Stop。
    expect(stopTask).toHaveBeenCalledWith("bg-task-1");
    expect(result).toMatchObject({
      status: "cancelled",
      taskId: "subtask-1",
      reason: "user stopped the swarm",
    });
  });

  it("fails a backgrounded worker when waitForTask is missing but stops it instead of losing it", async () => {
    const stopTask = vi.fn(async () => completedSnapshot());
    const port = createPort(async () => backgroundedOutput(), { stopTask });

    const result = await new SwarmWorker(port).execute(createTask());

    expect(stopTask).toHaveBeenCalledWith("bg-task-1");
    expect(result).toMatchObject({
      status: "cancelled",
      reason: /waitForTask is unavailable; the backgrounded worker was stopped/,
    });
  });

  it("fails a backgrounded worker when the port has neither waitForTask nor stopTask", async () => {
    const port = createPort(async () => backgroundedOutput());

    const result = await new SwarmWorker(port).execute(createTask());

    expect(result).toMatchObject({
      status: "failed",
      error:
        "SubagentPort.waitForTask or stopTask is required to collect a backgrounded swarm worker",
    });
  });

  it("fails a backgrounded worker whose wait returns no snapshot", async () => {
    const port = createPort(async () => backgroundedOutput(), {
      waitForTask: async () => undefined,
      stopTask: vi.fn(),
    });

    const result = await new SwarmWorker(port).execute(createTask());

    expect(result).toMatchObject({
      status: "failed",
      error: /was lost: waitForTask returned no snapshot/,
    });
  });

  it("rejects invalid tasks before touching the execution port", async () => {
    const port = createPort(async () => completedOutput());
    const worker = new SwarmWorker(port);

    await expect(worker.execute(createTask({ taskId: "" }))).rejects.toThrow(
      "Swarm task requires a non-empty taskId",
    );
    await expect(worker.execute(createTask({ prompt: "" }))).rejects.toThrow(
      "Swarm task subtask-1 requires a non-empty prompt",
    );
    expect(port.runCalls).toHaveLength(0);
  });
});
