import { describe, expect, it } from "vitest";
import {
  SwarmAggregator,
  SwarmRoundCancelledError,
} from "../src/runtime/swarm-aggregator.js";
import type { SwarmTaskResult } from "../src/runtime/swarm-orchestrator.js";

function completed(taskId: string, text: string): SwarmTaskResult {
  return {
    status: "completed",
    taskId,
    agentId: `agent-${taskId}`,
    agentType: "general-purpose",
    description: taskId,
    content: [{ type: "text", text }],
    totalToolUseCount: 1,
    totalDurationMs: 10,
  };
}

function cancelled(taskId: string, reason: string): SwarmTaskResult {
  return {
    status: "cancelled",
    taskId,
    agentType: "general-purpose",
    description: taskId,
    reason,
    totalDurationMs: 1,
  };
}

function failed(taskId: string, error: string): SwarmTaskResult {
  return {
    status: "failed",
    taskId,
    agentType: "general-purpose",
    description: taskId,
    error,
    totalDurationMs: 1,
  };
}

describe("SwarmAggregator.aggregate", () => {
  const aggregator = new SwarmAggregator();

  it("returns an empty aggregation for empty results", async () => {
    await expect(aggregator.aggregate([])).resolves.toEqual({
      output: "",
      completedTaskIds: [],
      failures: [],
    });
  });

  it("returns the single output unchanged", async () => {
    await expect(aggregator.aggregate([completed("t1", "only result")])).resolves.toEqual({
      output: "only result",
      completedTaskIds: ["t1"],
      failures: [],
    });
  });

  it("joins multiple outputs in input order separated by blank lines", async () => {
    const results = [completed("t1", "first"), completed("t2", "second"), completed("t3", "third")];
    await expect(aggregator.aggregate(results)).resolves.toEqual({
      output: "first\n\nsecond\n\nthird",
      completedTaskIds: ["t1", "t2", "t3"],
      failures: [],
    });
  });

  it("keeps partial output when only some tasks completed", async () => {
    const results: SwarmTaskResult[] = [
      completed("t1", "good part"),
      failed("t2", "bad part"),
    ];
    await expect(aggregator.aggregate(results)).resolves.toEqual({
      output: "good part",
      completedTaskIds: ["t1"],
      failures: [{ taskId: "t2", reason: "bad part" }],
    });
  });

  it("treats an empty-text completed task as a failure but keeps other deliverables", async () => {
    const results = [completed("t1", "text"), completed("t2", "   ")];
    await expect(aggregator.aggregate(results)).resolves.toEqual({
      output: "text",
      completedTaskIds: ["t1"],
      failures: [{ taskId: "t2", reason: "produced no text output" }],
    });
  });

  it("keeps partial output when a task was cancelled, preserving the abort reason", async () => {
    const results: SwarmTaskResult[] = [
      completed("t1", "good part"),
      {
        status: "cancelled",
        taskId: "t2",
        agentType: "general-purpose",
        description: "t2",
        reason: "user stopped the swarm",
        totalDurationMs: 3,
      },
    ];
    await expect(aggregator.aggregate(results)).resolves.toEqual({
      output: "good part",
      completedTaskIds: ["t1"],
      failures: [{ taskId: "t2", reason: "cancelled (user stopped the swarm)" }],
    });
  });

  it("throws SwarmRoundCancelledError when no output and every task was cancelled", async () => {
    const results = [cancelled("t1", "user stopped"), cancelled("t2", "target changed")];
    await expect(aggregator.aggregate(results)).rejects.toBeInstanceOf(SwarmRoundCancelledError);
    await expect(aggregator.aggregate(results)).rejects.toMatchObject({
      code: "swarm_round_cancelled",
    });
    await expect(aggregator.aggregate(results)).rejects.toThrow(/t1: cancelled \(user stopped\)/);
  });

  it("still throws the failure error when failed and cancelled results are mixed", async () => {
    const results = [failed("t1", "boom"), cancelled("t2", "user stopped")];
    const error = await aggregator.aggregate(results).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(SwarmRoundCancelledError);
    expect((error as Error).message).toMatch(/Swarm aggregation failed for all 2 task\(s\)/);
    expect((error as Error).message).toMatch(/t1: boom/);
  });

  it("throws only when every task failed, surfacing each original error", async () => {
    const results: SwarmTaskResult[] = [failed("t1", "boom one"), failed("t2", "boom two")];
    await expect(aggregator.aggregate(results)).rejects.toThrow(
      /Swarm aggregation failed for all 2 task\(s\)/,
    );
    await expect(aggregator.aggregate(results)).rejects.toThrow(/t1: boom one/);
    await expect(aggregator.aggregate(results)).rejects.toThrow(/t2: boom two/);
  });

  it("throws when every completed task delivered no text", async () => {
    const results = [completed("t1", "   "), completed("t2", "")];
    await expect(aggregator.aggregate(results)).rejects.toThrow(
      /Swarm aggregation failed for all 2 task\(s\)/,
    );
  });
});
