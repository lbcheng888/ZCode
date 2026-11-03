import type { DatabaseSync } from "node:sqlite";

import type { LeaderClaimInput, LeaderClaimResult } from "./contract.js";

/** leader 心跳周期（§3.3：每 H 续期，TTL=3H；连续失联 → 主动降级 follower 并停循环）。 */
export const CONTROL_PLANE_HEARTBEAT_INTERVAL_MS = 15_000;

/** 租约 TTL = 3 × 心跳周期（§1.8）。 */
export const CONTROL_PLANE_LEASE_TTL_MS = 3 * CONTROL_PLANE_HEARTBEAT_INTERVAL_MS;

/**
 * control_plane_leases 仓储（§1.8 / §3.3）：per-workspace leader 租约，唯一写者 =
 * 本文件。竞争语义依赖 BEGIN IMMEDIATE（写锁串行化两个竞争者）+ upsert 的 WHERE
 * 守卫（未过期且非本人 → no-op）+ changes()>0 断言——SQLite 的 upsert 在 WHERE
 * 不满足时语句是 no-op 但 COMMIT 仍成功，必须断言改动行数，否则并发双方都会自认
 * leader（§3.3 明文）。
 */
export function createControlPlaneLease(db: DatabaseSync): {
  tryClaim(input: LeaderClaimInput): LeaderClaimResult;
  heartbeat(input: LeaderClaimInput): boolean;
  /** 读当前租约行（测试/诊断用）；无行返回 undefined。 */
  read(workspaceIdentity: string):
    | { ownerId: string; role: string; expiresAt: number; heartbeatAt: number }
    | undefined;
} {
  return {
    tryClaim(input: LeaderClaimInput): LeaderClaimResult {
      const now = input.now ?? Date.now();
      const expiresAt = now + CONTROL_PLANE_LEASE_TTL_MS;
      db.exec("begin immediate");
      try {
        const result = db
          .prepare(
            `insert into control_plane_leases (workspace_identity, owner_id, role, expires_at, heartbeat_at)
              values (?, ?, 'control_plane', ?, ?)
              on conflict(workspace_identity) do update set
                owner_id = excluded.owner_id,
                expires_at = excluded.expires_at,
                heartbeat_at = excluded.heartbeat_at
              where control_plane_leases.expires_at < excluded.heartbeat_at
                 or control_plane_leases.owner_id = excluded.owner_id`,
          )
          .run(input.workspaceIdentity, input.ownerId, expiresAt, now);
        if (Number(result.changes) > 0) {
          db.exec("commit");
          return {
            kind: "leader",
            workspaceIdentity: input.workspaceIdentity,
            ownerId: input.ownerId,
            expiresAt,
          };
        }
        // 断言不过 = follower：本事务无改动，回滚后按纯转发 attachment 路径返回。
        db.exec("rollback");
        const held = db
          .prepare(
            "select owner_id, role, expires_at, heartbeat_at from control_plane_leases where workspace_identity = ?",
          )
          .get(input.workspaceIdentity) as Record<string, unknown> | undefined;
        return {
          kind: "follower",
          workspaceIdentity: input.workspaceIdentity,
          ownerId: input.ownerId,
          expiresAt: held ? Number(held.expires_at) : 0,
        };
      } catch (error) {
        try {
          db.exec("rollback");
        } catch {
          // 回滚失败不覆盖竞争失败/驱动错误的原始原因。
        }
        throw error;
      }
    },

    heartbeat(input: LeaderClaimInput): boolean {
      const now = input.now ?? Date.now();
      const expiresAt = now + CONTROL_PLANE_LEASE_TTL_MS;
      const result = db
        .prepare(
          `update control_plane_leases set heartbeat_at = ?, expires_at = ?
            where workspace_identity = ? and owner_id = ? and role = 'control_plane'`,
        )
        .run(now, expiresAt, input.workspaceIdentity, input.ownerId);
      return Number(result.changes) > 0;
    },

    read(workspaceIdentity: string) {
      const row = db
        .prepare(
          "select owner_id, role, expires_at, heartbeat_at from control_plane_leases where workspace_identity = ?",
        )
        .get(workspaceIdentity) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        ownerId: String(row.owner_id),
        role: String(row.role),
        expiresAt: Number(row.expires_at),
        heartbeatAt: Number(row.heartbeat_at),
      };
    },
  };
}
