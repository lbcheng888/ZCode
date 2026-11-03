import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  RevokeTriggerSubscriptionSelector,
  TriggerSubscriptionLane,
  TriggerSubscriptionOwnerKind,
  TriggerSubscriptionRecord,
  TriggerSubscriptionStatus,
  UpsertTriggerSubscriptionInput,
} from "./contract.js";
import { TRIGGER_SUBSCRIPTION_LEASE_TTL_MS } from "./contract.js";

const SELECT_COLUMNS = `
  id, workspace_identity, thread_key, session_id, lane, filters, owner_kind, owner_ref,
  status, lease_expires_at, created_at, updated_at
`;

function toLane(value: unknown): TriggerSubscriptionLane {
  const lane = String(value);
  if (lane !== "followup" && lane !== "guide" && lane !== "inject") {
    // 车道列只允许 DDL 约定的三值；未知值原样抛出，不静默归入 followup（车道语义是 M1 裁定）。
    throw new Error(`trigger_subscriptions.lane 非法值: ${lane}`);
  }
  return lane;
}

function toOwnerKind(value: unknown): TriggerSubscriptionOwnerKind {
  const kind = String(value);
  if (kind !== "session" && kind !== "goal" && kind !== "workflow") {
    throw new Error(`trigger_subscriptions.owner_kind 非法值: ${kind}`);
  }
  return kind;
}

function toStatus(value: unknown): TriggerSubscriptionStatus {
  const status = String(value);
  if (status !== "active" && status !== "revoked") {
    throw new Error(`trigger_subscriptions.status 非法值: ${status}`);
  }
  return status;
}

function toRow(row: Record<string, unknown>): TriggerSubscriptionRecord {
  return {
    id: String(row.id),
    workspaceIdentity: String(row.workspace_identity),
    threadKey: String(row.thread_key),
    sessionId: String(row.session_id),
    lane: toLane(row.lane),
    filters: row.filters === null || row.filters === undefined ? null : String(row.filters),
    ownerKind: toOwnerKind(row.owner_kind),
    ownerRef: row.owner_ref === null || row.owner_ref === undefined ? null : String(row.owner_ref),
    status: toStatus(row.status),
    leaseExpiresAt: Number(row.lease_expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * trigger_subscriptions 仓储（§1.3）：表写入只允许出现在本文件；句柄由组合根经
 * super-agent-storage open 后注入。唯一 active 约束（partial unique）与两个查询索引
 * 均在迁移 DDL 内，本文件不建索引。
 *
 * 幂等键：UNIQUE(workspace_identity, thread_key, session_id) WHERE status='active'——
 * upsert 走 INSERT OR IGNORE（§1.3 明文「回填与写入幂等」= 首写者胜、冲突零更新）：
 * 不覆盖既有 lane/owner（否则 followup 写入会把 guide/inject 车道降级，watch 事件
 * 从「不唤醒」变成 autoDrain 唤醒），lease 续期走 renewActiveLeases；revoke/sweep
 * 保留审计行。
 */
export function createTriggerSubscriptions(db: DatabaseSync): {
  upsert(input: UpsertTriggerSubscriptionInput): TriggerSubscriptionRecord;
  revoke(selector: RevokeTriggerSubscriptionSelector): number;
  listActive(
    workspaceIdentity: string,
    threadKey: string,
    now?: number,
  ): TriggerSubscriptionRecord[];
  sweepExpiredLeases(now: number): number;
  renewActiveLeases(now: number, workspaceIdentity?: string): number;
} {
  return {
    upsert(input: UpsertTriggerSubscriptionInput): TriggerSubscriptionRecord {
      const id = randomUUID();
      const now = input.now ?? Date.now();
      const leaseExpiresAt = input.leaseExpiresAt ?? now + TRIGGER_SUBSCRIPTION_LEASE_TTL_MS;
      const filters = input.filters ?? null;
      const ownerRef = input.ownerRef ?? null;
      // INSERT OR IGNORE = 首写者胜（§1.3 明文语义）：partial unique 冲突时零更新，
      // RETURNING 不返回被忽略的行，回读既有行原样返回——不覆盖 lane/owner/lease。
      const inserted = db
        .prepare(
          `insert or ignore into trigger_subscriptions (
            id, workspace_identity, thread_key, session_id, lane, filters, owner_kind, owner_ref,
            status, lease_expires_at, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
          returning ${SELECT_COLUMNS}`,
        )
        .get(
          id,
          input.workspaceIdentity,
          input.threadKey,
          input.sessionId,
          input.lane,
          filters,
          input.ownerKind,
          ownerRef,
          leaseExpiresAt,
          now,
          now,
        ) as Record<string, unknown> | undefined;
      if (inserted) return toRow(inserted);
      // 冲突 = 同键已有 active 行：回读返回（冲突谓词保证行存在；查不到即状态被并发改写，响亮暴露）。
      const existing = db
        .prepare(
          `select ${SELECT_COLUMNS} from trigger_subscriptions
            where workspace_identity = ? and thread_key = ? and session_id = ? and status = 'active'`,
        )
        .get(input.workspaceIdentity, input.threadKey, input.sessionId) as
        | Record<string, unknown>
        | undefined;
      if (!existing) {
        throw new Error("trigger_subscriptions upsert 冲突后回读不到 active 行");
      }
      return toRow(existing);
    },

    revoke(selector: RevokeTriggerSubscriptionSelector): number {
      const now = Date.now();
      if (selector.id !== undefined) {
        const result = db
          .prepare(
            "update trigger_subscriptions set status = 'revoked', updated_at = ? where id = ? and status = 'active'",
          )
          .run(now, selector.id);
        return Number(result.changes);
      }
      if (
        selector.workspaceIdentity === undefined ||
        selector.ownerKind === undefined ||
        selector.ownerRef === undefined
      ) {
        // 两种选择器之外的形状是调用方编程错误：响亮拒绝，不做宽松全表撤销。
        throw new Error("revokeSubscription 需要 id 或 (workspaceIdentity, ownerKind, ownerRef)");
      }
      const result = db
        .prepare(
          `update trigger_subscriptions set status = 'revoked', updated_at = ?
            where workspace_identity = ? and owner_kind = ? and owner_ref = ? and status = 'active'`,
        )
        .run(now, selector.workspaceIdentity, selector.ownerKind, selector.ownerRef);
      return Number(result.changes);
    },

    listActive(
      workspaceIdentity: string,
      threadKey: string,
      now?: number,
    ): TriggerSubscriptionRecord[] {
      const cutoff = now ?? Date.now();
      const rows = db
        .prepare(
          `select ${SELECT_COLUMNS} from trigger_subscriptions
            where workspace_identity = ? and thread_key = ? and status = 'active'
              and lease_expires_at >= ?
            order by created_at, id`,
        )
        .all(workspaceIdentity, threadKey, cutoff) as Record<string, unknown>[];
      return rows.map(toRow);
    },

    sweepExpiredLeases(now: number): number {
      const result = db
        .prepare(
          `update trigger_subscriptions set status = 'revoked', updated_at = ?
            where status = 'active' and lease_expires_at < ?`,
        )
        .run(now, now);
      return Number(result.changes);
    },

    renewActiveLeases(now: number, workspaceIdentity?: string): number {
      const expiresAt = now + TRIGGER_SUBSCRIPTION_LEASE_TTL_MS;
      const statement =
        workspaceIdentity === undefined
          ? db.prepare(
              `update trigger_subscriptions set lease_expires_at = ?, updated_at = ?
                where status = 'active'`,
            )
          : db.prepare(
              `update trigger_subscriptions set lease_expires_at = ?, updated_at = ?
                where status = 'active' and workspace_identity = ?`,
            );
      const result =
        workspaceIdentity === undefined
          ? statement.run(expiresAt, now)
          : statement.run(expiresAt, now, workspaceIdentity);
      return Number(result.changes);
    },
  };
}
