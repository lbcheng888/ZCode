import { describe, expect, it, vi } from "vitest";

import { createChengJobObserver } from "../../src/super-agent/cheng-job-observer.js";
import {
  ChengJobRegistryOwner,
  type ChengJobNotification,
  type ChengJobNotificationLedger,
} from "../../src/super-agent/cheng-job-registry.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";

function fakeLedger(): {
  ledger: ChengJobNotificationLedger;
  claimed: string[];
  enqueued: ChengJobNotification[];
} {
  const claimed: string[] = [];
  const enqueued: ChengJobNotification[] = [];
  return {
    claimed,
    enqueued,
    ledger: {
      hasClaim: async (commandId) => claimed.includes(commandId),
      claim: async (commandId) => {
        claimed.push(commandId);
      },
      enqueue: async (notification) => {
        enqueued.push(notification);
      },
    },
  };
}

describe("Cheng job 产出后 delivery gate", () => {
  it("red gate: settle 写 gate_blocked 原因，不 claim/enqueue，重启补投也跳过", async () => {
    const registry = new BackgroundRunRegistry(10);
    const { ledger, claimed, enqueued } = fakeLedger();
    const owner = new ChengJobRegistryOwner({ registry, ledger, now: () => 1_000 });
    owner.register({ jobId: "job-red", ownerSession: "sess-1" });

    const settlement = await owner.terminal({
      jobId: "job-red",
      state: "completed",
      runId: "run-red",
      gate: { ok: false, level: "BLOCKED", reasons: ["settle_not_solved"] },
    });

    expect(settlement).toBe("gate_blocked");
    expect(claimed).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(registry.get("job-red")).toMatchObject({
      state: "completed",
      narrowResultRef: "cheng-run://run-red",
      terminalReason: "cheng_gate_blocked",
    });

    const reconciled = await owner.reconcileAfterRestart({ now: 2_000 });
    expect(reconciled).toEqual({ failed: 0, suppressed: 0, notified: 0, alreadyClaimed: 0 });
    expect(claimed).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("green gate: 保持唯一 claim-first task-notification 路径", async () => {
    const registry = new BackgroundRunRegistry(10);
    const { ledger, claimed, enqueued } = fakeLedger();
    const owner = new ChengJobRegistryOwner({ registry, ledger, now: () => 1_000 });
    owner.register({ jobId: "job-green", ownerSession: "sess-1" });

    const settlement = await owner.terminal({
      jobId: "job-green",
      state: "completed",
      runId: "run-green",
      gate: { ok: true, level: "DIAGNOSTIC_NOT_ACCEPTANCE", reasons: [] },
    });

    expect(settlement).toBe("notified");
    expect(claimed).toEqual(["cheng_job-green"]);
    expect(enqueued).toHaveLength(1);
    expect(registry.get("job-green")?.terminalReason).toBeUndefined();
  });

  it("observer 在 succeeded 时解析 gate；红 gate 不进入 ledger", async () => {
    const registry = new BackgroundRunRegistry(10);
    const { ledger, claimed, enqueued } = fakeLedger();
    const resolveGate = vi.fn(async () => ({
      ok: false,
      level: "BLOCKED" as const,
      reasons: ["settle_receipt_missing"],
    }));
    const observer = createChengJobObserver({
      registry,
      ledger,
      ownerSession: "sess-1",
      workspaceKey: "ws-1",
      resolveGate,
    });

    observer.started({ jobId: "job-observer" });
    await observer.terminal({ jobId: "job-observer", state: "succeeded", runId: "run-1" });

    expect(resolveGate).toHaveBeenCalledWith({ jobId: "job-observer", runId: "run-1" });
    expect(claimed).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(registry.get("job-observer")?.terminalReason).toBe("cheng_gate_blocked");
  });
});
