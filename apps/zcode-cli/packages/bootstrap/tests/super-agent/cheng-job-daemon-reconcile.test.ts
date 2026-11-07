import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  ChengJobNotification,
  ChengJobNotificationLedger,
} from "../../src/super-agent/cheng-job-registry.js";
import { ChengJobRegistryOwner } from "../../src/super-agent/cheng-job-registry.js";
import { reconcileChengJobsOnDaemonStartup } from "../../src/super-agent/daemon/cheng-job-startup.js";
import { SqliteBackgroundRunStore } from "../../src/super-agent/storage/background-run-store.js";
import { openSuperAgentDatabase } from "../../src/super-agent/storage/database.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";

const JOB_RUNNING = "cheng-daemon-running";
const JOB_COMPLETED = "cheng-daemon-completed";

function fakeLedger() {
  const claims = new Set<string>();
  const deliveries: ChengJobNotification[] = [];
  const ledger: ChengJobNotificationLedger = {
    async hasClaim(commandId) {
      return claims.has(commandId);
    },
    async claim(commandId) {
      claims.add(commandId);
    },
    async enqueue(notification) {
      deliveries.push(notification);
    },
  };
  return { ledger, claims, deliveries };
}

describe("daemon startup cheng-job reconcile", () => {
  it("marks stale running jobs failed(host_restarted) without delivering, then the session backfills only real terminals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cheng-daemon-reconcile-"));
    try {
      const db = await openSuperAgentDatabase({ databasePath: join(dir, "super-agent.sqlite") });
      const store = new SqliteBackgroundRunStore(db);
      const registry = new BackgroundRunRegistry(100, store);
      registry.register(
        { id: JOB_RUNNING, kind: "cheng-job", owner: "cheng-host", ownerSession: "sess-1" },
        1_000,
      );
      registry.register(
        { id: JOB_COMPLETED, kind: "cheng-job", owner: "cheng-host", ownerSession: "sess-1" },
        1_000,
      );
      registry.settle(JOB_COMPLETED, "cheng-host", "completed", 2_000, {
        narrowResultRef: "cheng-run://m5-daemon",
      });

      const daemon = reconcileChengJobsOnDaemonStartup(db, {
        now: 100_000,
        staleAfterMs: 30_000,
      });
      expect(daemon).toEqual({ failed: 1, suppressed: 1 });
      expect(store.loadAll().find((row) => row.id === JOB_RUNNING)).toMatchObject({
        state: "failed",
        terminalReason: "host_restarted",
      });
      expect(store.loadAll().find((row) => row.id === JOB_COMPLETED)?.state).toBe("completed");

      // Session app backfill: suppressed row never notifies; completed row claims once.
      const restartedRegistry = new BackgroundRunRegistry(100, store);
      restartedRegistry.hydrate(store.loadAll());
      const { ledger, claims, deliveries } = fakeLedger();
      const owner = new ChengJobRegistryOwner({ registry: restartedRegistry, ledger });
      const first = await owner.reconcileAfterRestart({ ownerSession: "sess-1" });
      expect(first).toEqual({ failed: 0, suppressed: 0, notified: 1, alreadyClaimed: 0 });
      expect(deliveries.map((notification) => notification.jobId)).toEqual([JOB_COMPLETED]);
      expect(claims.has(`cheng_${JOB_RUNNING}`)).toBe(false);
      expect(claims.has(`cheng_${JOB_COMPLETED}`)).toBe(true);

      const second = await owner.reconcileAfterRestart({ ownerSession: "sess-1" });
      expect(second).toEqual({ failed: 0, suppressed: 0, notified: 0, alreadyClaimed: 1 });
      expect(deliveries).toHaveLength(1);

      // The daemon reconcile is wired into the control-plane startup and daemon planes only.
      const controlPlaneSource = readFileSync(
        fileURLToPath(new URL("../../src/app/super-agent-control-plane.ts", import.meta.url)),
        "utf8",
      );
      expect(controlPlaneSource).toContain("reconcileChengJobsOnDaemonStartup(db)");
      const planeManagerSource = readFileSync(
        fileURLToPath(new URL("../../src/super-agent/daemon/planeManager.ts", import.meta.url)),
        "utf8",
      );
      expect(planeManagerSource).toContain("reconcileChengJobsOnStartup: true");
      db.close();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not touch recent running rows inside the staleness window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cheng-daemon-fresh-"));
    try {
      const db = await openSuperAgentDatabase({ databasePath: join(dir, "super-agent.sqlite") });
      const store = new SqliteBackgroundRunStore(db);
      const registry = new BackgroundRunRegistry(100, store);
      registry.register(
        { id: "fresh", kind: "cheng-job", owner: "cheng-host", ownerSession: "sess-1" },
        99_000,
      );
      const result = reconcileChengJobsOnDaemonStartup(db, {
        now: 100_000,
        staleAfterMs: 30_000,
      });
      expect(result).toEqual({ failed: 0, suppressed: 0 });
      expect(store.loadAll().find((row) => row.id === "fresh")?.state).toBe("running");
      db.close();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
