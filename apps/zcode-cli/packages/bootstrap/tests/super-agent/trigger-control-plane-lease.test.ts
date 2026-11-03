import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import {
  createControlPlaneLease,
  CONTROL_PLANE_LEASE_TTL_MS,
} from "../../src/super-agent/trigger/control-plane-lease.js";

const openDatabases: DatabaseSync[] = [];
let cleanupDir: string | undefined;

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  if (cleanupDir) {
    rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = undefined;
  }
});

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

async function openPair(): Promise<{ db1: DatabaseSync; db2: DatabaseSync; path: string }> {
  cleanupDir = mkdtempSync(join(tmpdir(), "zcode-trigger-lease-"));
  const path = join(cleanupDir, "super-agent.sqlite");
  const first = await openSuperAgentDatabase({ databasePath: path });
  const second = await openSuperAgentDatabase({ databasePath: path });
  openDatabases.push(first, second);
  return { db1: first, db2: second, path };
}

describe("super-agent-trigger leader 租约（§3.3 control_plane_leases）", () => {
  it("双竞争者同时 tryClaim：恰好一个 leader，另一个 follower（changes()>0 断言）", async () => {
    const { db1, db2 } = await openPair();
    const claimantA = createControlPlaneLease(db1);
    const claimantB = createControlPlaneLease(db2);

    const a = claimantA.tryClaim({ workspaceIdentity: "ws-a", ownerId: "daemon-a", now: NOW });
    const b = claimantB.tryClaim({ workspaceIdentity: "ws-a", ownerId: "daemon-b", now: NOW });

    expect(a.kind).toBe("leader");
    expect(b.kind).toBe("follower");
    // follower 读回持有者：租约行归 a。
    const held = claimantB.read("ws-a");
    expect(held?.ownerId).toBe("daemon-a");
    expect(held?.expiresAt).toBe(NOW + CONTROL_PLANE_LEASE_TTL_MS);
  });

  it("同 owner 续约恒 leader；他人租约未过期时续约失败", async () => {
    const { db1, db2 } = await openPair();
    const claimantA = createControlPlaneLease(db1);
    const claimantB = createControlPlaneLease(db2);

    claimantA.tryClaim({ workspaceIdentity: "ws-a", ownerId: "daemon-a", now: NOW });
    // owner_id=me 守卫：本人续约成功（幂等）。
    const renew = claimantA.tryClaim({
      workspaceIdentity: "ws-a",
      ownerId: "daemon-a",
      now: NOW + 1_000,
    });
    expect(renew.kind).toBe("leader");

    // 未过期、非 owner：B 失败。
    const blocked = claimantB.tryClaim({
      workspaceIdentity: "ws-a",
      ownerId: "daemon-b",
      now: NOW + 2_000,
    });
    expect(blocked.kind).toBe("follower");

    // 过期后（> TTL）B 胜出：崩溃恢复语义（§3.3）。
    const afterExpiry = claimantB.tryClaim({
      workspaceIdentity: "ws-a",
      ownerId: "daemon-b",
      now: NOW + 1_000 + CONTROL_PLANE_LEASE_TTL_MS + 1,
    });
    expect(afterExpiry.kind).toBe("leader");
    // A 的 heartbeat 随即失败（已非 owner）→ 必须降级 follower 并停循环。
    expect(
      claimantA.heartbeat({ workspaceIdentity: "ws-a", ownerId: "daemon-a", now: NOW + 1_000 + CONTROL_PLANE_LEASE_TTL_MS + 2 }),
    ).toBe(false);
  });

  it("heartbeat 仅 owner 本人可续；掉锁返回 false", async () => {
    const { db1 } = await openPair();
    const lease = createControlPlaneLease(db1);
    lease.tryClaim({ workspaceIdentity: "ws-a", ownerId: "daemon-a", now: NOW });

    expect(
      lease.heartbeat({ workspaceIdentity: "ws-a", ownerId: "daemon-a", now: NOW + 5_000 }),
    ).toBe(true);
    const held = lease.read("ws-a");
    expect(held?.heartbeatAt).toBe(NOW + 5_000);
    expect(held?.expiresAt).toBe(NOW + 5_000 + CONTROL_PLANE_LEASE_TTL_MS);

    expect(
      lease.heartbeat({ workspaceIdentity: "ws-a", ownerId: "daemon-x", now: NOW + 6_000 }),
    ).toBe(false);
    expect(
      lease.heartbeat({ workspaceIdentity: "ws-missing", ownerId: "daemon-a", now: NOW }),
    ).toBe(false);
  });
});
