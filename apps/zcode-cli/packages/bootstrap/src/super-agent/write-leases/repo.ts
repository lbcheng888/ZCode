import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  WriteLeaseConflictError,
  type AcquireWriteLeaseInput,
  type SuperAgentWriteLeasesContract,
  type WriteLeaseRow,
  type WriteLeaseStatus,
} from "./contract.js";

const SELECT_COLUMNS = `
  id, workspace_identity, owner_run_id, scope, status, lease_expires_at, created_at, updated_at
`;

function toRow(row: Record<string, unknown>): WriteLeaseRow {
  const status = String(row.status);
  if (status !== "active" && status !== "released") {
    // 状态列只允许 DDL 约定的两个枚举值；未知值原样抛出，不静默归入 active。
    throw new Error(`write_leases.status 非法值: ${status}`);
  }
  return {
    id: String(row.id),
    workspaceIdentity: String(row.workspace_identity),
    ownerRunId: String(row.owner_run_id),
    scope: String(row.scope),
    status: status as WriteLeaseStatus,
    leaseExpiresAt: Number(row.lease_expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * write_leases 仓储：表写入只允许出现在本文件；句柄由组合根经 super-agent-storage
 * open 后注入（结构类型 = node:sqlite DatabaseSync）。S1 起同 workspace 单 active 租约。
 */
export function createWriteLeases(db: DatabaseSync): SuperAgentWriteLeasesContract {
  const getActive = (workspaceIdentity: string): WriteLeaseRow[] => {
    const rows = db
      .prepare(
        `select ${SELECT_COLUMNS} from write_leases
          where workspace_identity = ? and status = 'active'
          order by created_at`,
      )
      .all(workspaceIdentity) as Record<string, unknown>[];
    return rows.map(toRow);
  };

  const sweepExpired = (now: number): number => {
    const result = db
      .prepare(
        "update write_leases set status = 'released', updated_at = ? where status = 'active' and lease_expires_at < ?",
      )
      .run(now, now);
    return Number(result.changes);
  };

  const release = (id: string, now?: number): boolean => {
    const result = db
      .prepare("update write_leases set status = 'released', updated_at = ? where id = ? and status = 'active'")
      .run(now ?? Date.now(), id);
    return Number(result.changes) > 0;
  };

  return {
    acquire(input: AcquireWriteLeaseInput): WriteLeaseRow {
      const id = randomUUID();
      const now = input.now ?? Date.now();
      // 过期租约先回收：僵尸写权不得挡住新写者；回收后仍有 active = 真正第二写者。
      sweepExpired(now);
      const active = getActive(input.workspaceIdentity);
      if (active.length > 0) {
        throw new WriteLeaseConflictError(input.workspaceIdentity, active[0]!.ownerRunId);
      }
      try {
        db.prepare(
          `insert into write_leases (
            id, workspace_identity, owner_run_id, scope, status, lease_expires_at, created_at, updated_at
          ) values (?, ?, ?, ?, 'active', ?, ?, ?)`,
        ).run(
          id,
          input.workspaceIdentity,
          input.ownerRunId,
          input.scope,
          input.leaseExpiresAt,
          now,
          now,
        );
      } catch (error) {
        // 并发竞态：另一写者在 sweep 与 insert 之间落行，唯一索引拒绝。转 typed conflict；
        // 非冲突错误（磁盘/句柄）原样上抛，不伪装成业务拒绝。
        const raced = getActive(input.workspaceIdentity);
        if (raced.length > 0) {
          throw new WriteLeaseConflictError(
            input.workspaceIdentity,
            raced[0]!.ownerRunId,
          );
        }
        throw error;
      }
      return {
        id,
        workspaceIdentity: input.workspaceIdentity,
        ownerRunId: input.ownerRunId,
        scope: input.scope,
        status: "active",
        leaseExpiresAt: input.leaseExpiresAt,
        createdAt: now,
        updatedAt: now,
      };
    },
    getActive,
    release,
    sweepExpired,
  };
}
