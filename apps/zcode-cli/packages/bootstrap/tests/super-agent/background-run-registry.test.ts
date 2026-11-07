import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BackgroundRunOwnershipError } from "../../src/super-agent/watchdog/contract.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";
import { SqliteBackgroundRunStore } from "../../src/super-agent/storage/background-run-store.js";
import { openSuperAgentDatabase } from "../../src/super-agent/storage/database.js";

describe("background_run_registry persistence", () => {
  it("hydrates rows across a database reopen and keeps ownership checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bg-run-registry-"));
    const dbPath = join(dir, "super-agent.sqlite");
    try {
      let db = await openSuperAgentDatabase({ databasePath: dbPath });
      let registry = new BackgroundRunRegistry(100, new SqliteBackgroundRunStore(db));
      registry.register(
        {
          id: "cheng-1",
          kind: "cheng-job",
          owner: "cheng-host",
          ownerSession: "sess-1",
          stallClockRef: "cheng-job:cheng-1",
          heartbeat: true,
        },
        1000,
      );
      registry.settle("cheng-1", "cheng-host", "completed", 2000, {
        narrowResultRef: "cheng-run://run-1",
      });
      db.close();

      db = await openSuperAgentDatabase({ databasePath: dbPath });
      registry = new BackgroundRunRegistry(100, new SqliteBackgroundRunStore(db));
      registry.hydrate(new SqliteBackgroundRunStore(db).loadAll());
      expect(registry.get("cheng-1")).toMatchObject({
        kind: "cheng-job",
        owner: "cheng-host",
        state: "completed",
        narrowResultRef: "cheng-run://run-1",
        terminalAt: 2000,
      });

      expect(() => registry.settle("cheng-1", "dynamic-workflow", "failed", 3000)).toThrow(
        BackgroundRunOwnershipError,
      );
      db.close();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("merges externally written automation rows without touching local rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bg-run-refresh-"));
    try {
      const db = await openSuperAgentDatabase({
        databasePath: join(dir, "super-agent.sqlite"),
      });
      const store = new SqliteBackgroundRunStore(db);
      const appRegistry = new BackgroundRunRegistry(100, store);
      const external = new BackgroundRunRegistry(100, store);
      external.register(
        {
          id: "auto-1:manual:run-1",
          kind: "automation",
          owner: "automation",
          ownerSession: "session-1",
          workspaceKey: "/ws/a",
        },
        1_000,
      );
      external.register({ id: "wf-1", kind: "workflow", owner: "dynamic-workflow" }, 1_000);

      appRegistry.refreshFromPersistence((row) => row.kind === "automation");
      expect(appRegistry.get("auto-1:manual:run-1")).toMatchObject({
        kind: "automation",
        state: "running",
        ownerSession: "session-1",
      });
      expect(appRegistry.get("wf-1")).toBeUndefined();

      external.settle("auto-1:manual:run-1", "automation", "completed", 2_000);
      appRegistry.refreshFromPersistence((row) => row.kind === "automation");
      expect(appRegistry.get("auto-1:manual:run-1")).toMatchObject({
        state: "completed",
        terminalAt: 2_000,
      });
      db.close();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("evicts terminal rows beyond retention from both memory and the table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bg-run-retention-"));
    try {
      const db = await openSuperAgentDatabase({
        databasePath: join(dir, "super-agent.sqlite"),
      });
      const store = new SqliteBackgroundRunStore(db);
      const registry = new BackgroundRunRegistry(1, store);
      for (const id of ["a", "b"]) {
        registry.register({ id, kind: "workflow", owner: "dynamic-workflow" }, 1000);
        registry.settle(id, "dynamic-workflow", "completed", 2000);
      }
      expect(registry.get("a")).toBeUndefined();
      expect(store.loadAll().map((row) => row.id)).toEqual(["b"]);
      db.close();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
