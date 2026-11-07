import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTROL_PLANE_RPC_METHODS } from "@zcode/shared/super-agent-control-plane-protocol";

import { runsList } from "../../src/super-agent/runs-list.js";
import { SqliteBackgroundRunStore } from "../../src/super-agent/storage/background-run-store.js";
import { openSuperAgentDatabase } from "../../src/super-agent/storage/database.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";

describe("runs.list control-plane method", () => {
  it("reads the persistent registry with filters and a bounded limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-list-"));
    try {
      const db = await openSuperAgentDatabase({ databasePath: join(dir, "super-agent.sqlite") });
      const store = new SqliteBackgroundRunStore(db);
      const registry = new BackgroundRunRegistry(100, store);
      registry.register(
        { id: "wf-1", kind: "workflow", owner: "dynamic-workflow", workspaceKey: "ws-1" },
        1000,
      );
      registry.settle("wf-1", "dynamic-workflow", "completed", 2000);
      registry.register(
        { id: "cheng-1", kind: "cheng-job", owner: "cheng-host", workspaceKey: "ws-1" },
        1500,
      );
      registry.settle("cheng-1", "cheng-host", "completed", 2500, {
        narrowResultRef: "cheng-run://m5-1",
      });

      const cheng = runsList(db, { kind: "cheng-job" }) as {
        runs: Array<Record<string, unknown>>;
      };
      expect(cheng.runs).toHaveLength(1);
      expect(cheng.runs[0]).toMatchObject({
        id: "cheng-1",
        kind: "cheng-job",
        owner: "cheng-host",
        state: "completed",
        narrowResultRef: "cheng-run://m5-1",
      });

      const limited = runsList(db, { limit: 1 }) as { runs: Array<Record<string, unknown>> };
      expect(limited.runs).toHaveLength(1);

      const none = runsList(db, { kind: "automation" }) as { runs: unknown[] };
      expect(none.runs).toEqual([]);
      expect(() => runsList(db, { extra: true })).toThrow();
      db.close();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("is wired into the control-plane protocol and dispatch switch", () => {
    expect(CONTROL_PLANE_RPC_METHODS).toContain("runs.list");
    const source = readFileSync(
      fileURLToPath(new URL("../../src/super-agent/daemon/planeManager.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain('case "runs.list":');
    expect(source).toContain("runsList(this.options.database");
  });
});
