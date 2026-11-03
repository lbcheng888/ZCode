import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createWriteLeases } from "../../src/super-agent/write-leases/index.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("super-agent-write-leases 仓储（P2 建表不启用）", () => {
  it("acquire / getActive / release 一轮后 active 清空", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const leases = createWriteLeases(db);
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);

    const lease = leases.acquire({
      workspaceIdentity: "ws-a",
      ownerRunId: "run-1",
      scope: JSON.stringify(["src/a.ts"]),
      leaseExpiresAt: now + 30 * 60_000,
      now,
    });
    expect(lease.status).toBe("active");

    const active = leases.getActive("ws-a");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(lease.id);
    expect(active[0]!.ownerRunId).toBe("run-1");
    expect(JSON.parse(active[0]!.scope)).toEqual(["src/a.ts"]);

    expect(leases.release(lease.id, now)).toBe(true);
    expect(leases.getActive("ws-a")).toHaveLength(0);
    // 幂等：已释放再 release 返回 false。
    expect(leases.release(lease.id, now)).toBe(false);
  });

  it("sweepExpired 回收过期租约且幂等", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const leases = createWriteLeases(db);
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);

    leases.acquire({
      workspaceIdentity: "ws-a",
      ownerRunId: "run-stale",
      scope: "[]",
      leaseExpiresAt: now - 1_000,
      now: now - 60_000,
    });
    leases.acquire({
      workspaceIdentity: "ws-a",
      ownerRunId: "run-fresh",
      scope: "[]",
      leaseExpiresAt: now + 60_000,
      now,
    });

    expect(leases.sweepExpired(now)).toBe(1);
    const active = leases.getActive("ws-a");
    expect(active.map((row) => row.ownerRunId)).toEqual(["run-fresh"]);
    expect(leases.sweepExpired(now)).toBe(0);
  });
});
