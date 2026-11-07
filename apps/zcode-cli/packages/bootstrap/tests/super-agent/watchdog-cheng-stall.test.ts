import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WATCHDOG_CONFIG,
  executeRepair,
  isWorkflowStallCandidate,
  runProbes,
  type BackgroundRunRow,
  type WatchdogRepairCommandSurface,
} from "../../src/super-agent/watchdog/index.js";

function row(overrides: Partial<BackgroundRunRow> = {}): BackgroundRunRow {
  return {
    id: "cheng-stall-1",
    kind: "cheng-job",
    owner: "cheng-host",
    state: "running",
    stallClockRef: "cheng-job:cheng-stall-1",
    heartbeat: true,
    registeredAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("cheng-job stall candidate", () => {
  it("includes a stalled cheng-job in workflow-run-stalled with cancel-stalled", () => {
    const stalled = row();
    const now = stalled.updatedAt + DEFAULT_WATCHDOG_CONFIG.workflowStallMs;
    expect(isWorkflowStallCandidate(stalled, now, DEFAULT_WATCHDOG_CONFIG)).toBe(true);
    const probes = runProbes({
      now,
      rows: [stalled],
      config: DEFAULT_WATCHDOG_CONFIG,
    });
    expect(probes.find((probe) => probe.probe === "workflow-run-stalled")).toMatchObject({
      status: "hit",
      targetId: "cheng-stall-1",
      repair: "cancel-stalled",
    });
  });

  it("keeps a healthy or non-running cheng-job out of the stall probe", () => {
    const healthy = row({ updatedAt: 999_000 });
    const now = 1_000_000;
    expect(isWorkflowStallCandidate(healthy, now, DEFAULT_WATCHDOG_CONFIG)).toBe(false);
    const probes = runProbes({ now, rows: [healthy], config: DEFAULT_WATCHDOG_CONFIG });
    expect(probes.find((probe) => probe.probe === "workflow-run-stalled")?.status).toBe("ok");

    const done = row({ state: "completed" });
    expect(isWorkflowStallCandidate(done, now, DEFAULT_WATCHDOG_CONFIG)).toBe(false);
  });

  it("requires a stall clock and keeps non-stall kinds out", () => {
    const noClock = row({ stallClockRef: undefined });
    expect(isWorkflowStallCandidate(noClock, 10_000_000, DEFAULT_WATCHDOG_CONFIG)).toBe(false);
    const automation = row({ kind: "automation", owner: "automation" });
    expect(isWorkflowStallCandidate(automation, 10_000_000, DEFAULT_WATCHDOG_CONFIG)).toBe(false);
  });

  it("routes cancel-stalled for a cheng-job through the same command surface", async () => {
    const cancelStalledRun = vi.fn(async () => ({ ok: true }));
    const surface: WatchdogRepairCommandSurface = {
      cancelStalledRun,
      pauseWorkspaceAutomation: vi.fn(async () => ({ ok: true })),
      notifyUser: vi.fn(async () => ({ ok: true })),
      pauseGoal: vi.fn(async () => ({ ok: true })),
    };
    const result = await executeRepair(surface, "cancel-stalled", {
      id: "cheng-stall-1",
      row: row(),
    });
    expect(result).toEqual({ ok: true });
    expect(cancelStalledRun).toHaveBeenCalledWith("cheng-stall-1");
  });
});
