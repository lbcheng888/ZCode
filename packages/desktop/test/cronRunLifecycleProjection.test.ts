import { describe, expect, it, vi } from "vitest";

import {
  recordCronRunOutcomeBestEffort,
  startCronRunOutcomeHeartbeat,
} from "../src/host/cronRunLifecycle.js";

const IDENTITY = {
  runId: "auto-1:1700000000000",
  automationId: "auto-1",
  workspaceKey: "/ws/a",
  scheduledAt: 1_700_000_000_000,
  trigger: "schedule" as const,
};

describe("cron run outcome projection", () => {
  it("settles the shared automation row after the run outcome is persisted", async () => {
    const ensureRunClaimed = vi.fn(async () => undefined);
    const markRunOutcome = vi.fn(async () => undefined);
    const settle = vi.fn();
    await recordCronRunOutcomeBestEffort({
      ...IDENTITY,
      repo: { ensureRunClaimed, markRunOutcome } as never,
      outcome: "succeeded",
      projection: { settle },
      logWarn: vi.fn(),
    });

    expect(ensureRunClaimed).toHaveBeenCalledWith(expect.objectContaining(IDENTITY));
    expect(markRunOutcome).toHaveBeenCalledWith(IDENTITY.runId, "succeeded", undefined);
    expect(settle).toHaveBeenCalledWith(IDENTITY.runId, "automation", "completed");
  });

  it("maps failed/stopped and skips running outcomes", async () => {
    const ensureRunClaimed = vi.fn(async () => undefined);
    const markRunOutcome = vi.fn(async () => undefined);
    const settle = vi.fn();
    await recordCronRunOutcomeBestEffort({
      ...IDENTITY,
      repo: { ensureRunClaimed, markRunOutcome } as never,
      outcome: "failed",
      projection: { settle },
      logWarn: vi.fn(),
    });
    await recordCronRunOutcomeBestEffort({
      ...IDENTITY,
      repo: { ensureRunClaimed, markRunOutcome } as never,
      outcome: "stopped",
      projection: { settle },
      logWarn: vi.fn(),
    });
    await recordCronRunOutcomeBestEffort({
      ...IDENTITY,
      repo: { ensureRunClaimed, markRunOutcome } as never,
      outcome: "running",
      projection: { settle },
      logWarn: vi.fn(),
    });

    expect(settle.mock.calls).toEqual([
      [IDENTITY.runId, "automation", "failed"],
      [IDENTITY.runId, "automation", "cancelled"],
    ]);
  });

  it("does not claim terminal state when the run outcome write fails", async () => {
    const settle = vi.fn();
    const logWarn = vi.fn();
    await recordCronRunOutcomeBestEffort({
      ...IDENTITY,
      repo: {
        ensureRunClaimed: async () => undefined,
        markRunOutcome: async () => {
          throw new Error("automation_runs locked");
        },
      } as never,
      outcome: "succeeded",
      projection: { settle },
      logWarn,
    });

    expect(settle).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("回写定时任务运行结果失败"),
      expect.any(Error),
    );
  });

  it("heartbeats running runs and registry rows without touching state", async () => {
    vi.useFakeTimers();
    try {
      const markRunOutcome = vi.fn(async () => undefined);
      const touch = vi.fn();
      const logWarn = vi.fn();
      const heartbeat = startCronRunOutcomeHeartbeat({
        runId: IDENTITY.runId,
        repo: { markRunOutcome },
        projection: { touch },
        logWarn,
        intervalMs: 60_000,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(markRunOutcome).toHaveBeenCalledWith(IDENTITY.runId, "running");
      expect(touch).toHaveBeenCalledWith(IDENTITY.runId, "automation", {});

      heartbeat.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(markRunOutcome).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports heartbeat write failure without touching the registry row", async () => {
    vi.useFakeTimers();
    try {
      const error = new Error("automation_runs locked");
      const markRunOutcome = vi.fn(async () => {
        throw error;
      });
      const touch = vi.fn();
      const logWarn = vi.fn();
      const heartbeat = startCronRunOutcomeHeartbeat({
        runId: IDENTITY.runId,
        repo: { markRunOutcome },
        projection: { touch },
        logWarn,
        intervalMs: 60_000,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(touch).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining("续租 automation run 失败"),
        error,
      );
      heartbeat.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
