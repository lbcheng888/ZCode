/**
 * trigger_events 只读访问（本模块对该表零写入；写入点 = super-agent-intake，
 * 终态列经 delivery 端口由 trigger.applyVerdicts 更新）。
 *
 * pending 行即事实队列：`fast_path='unowned_candidate' AND adjudication_status='pending'`
 * 是攒批的唯一事实源（无内存队列状态，崩溃/重启天然恢复；启动扫描重放由组合根
 * 调 notifyCandidate 重喂，spec §1.2 索引）。
 */
import type { AdjudicationDatabaseHandle } from "./contract.js";

export interface PendingCandidateRow {
  id: string;
  workspaceIdentity: string;
  source: string;
  threadKey: string;
  actorKind: string;
  actorId: string | null;
  payload: string;
}

export interface PendingStats {
  count: number;
  /** 最老 pending 行 created_at（count=0 时为 0）。 */
  oldest: number;
}

/** pending 候选谓词：只有 unowned_candidate 会进入裁决（schedule 行不进三边，§5.2）。 */
const PENDING_PREDICATE =
  "fast_path = 'unowned_candidate' and adjudication_status = 'pending'";

/** notifyCandidate 的行校验结果：workspace + 是否仍是待裁决 candidate。 */
export interface TriggerRowLookup {
  workspaceIdentity: string;
  pendingCandidate: boolean;
}

/** 按 id 读行（notifyCandidate 校验用）；行不存在返回 undefined。 */
export function readTriggerRow(
  db: AdjudicationDatabaseHandle,
  triggerId: string,
): TriggerRowLookup | undefined {
  const row = db
    .prepare(
      "select workspace_identity, fast_path, adjudication_status from trigger_events where id = ?",
    )
    .get(triggerId);
  if (!row) return undefined;
  return {
    workspaceIdentity: String(row.workspace_identity),
    pendingCandidate:
      row.fast_path === "unowned_candidate" && row.adjudication_status === "pending",
  };
}

/** 单 workspace 的 pending 计数与最老年龄（唤醒 N/T 条件的判据）。 */
export function readPendingStats(
  db: AdjudicationDatabaseHandle,
  workspaceIdentity: string,
): PendingStats {
  const row = db
    .prepare(
      `select count(*) as n, min(created_at) as oldest from trigger_events
        where workspace_identity = ? and ${PENDING_PREDICATE}`,
    )
    .get(workspaceIdentity) as { n: number; oldest: number | null } | undefined;
  return { count: Number(row?.n ?? 0), oldest: row?.oldest === null || row?.oldest === undefined ? 0 : Number(row.oldest) };
}

/** 取一批最老 pending 候选（单批上限由调用方 limit 传入；created_at 升序）。 */
export function listPendingBatch(
  db: AdjudicationDatabaseHandle,
  workspaceIdentity: string,
  limit: number,
): PendingCandidateRow[] {
  const rows = db
    .prepare(
      `select id, workspace_identity, source, thread_key, actor_kind, actor_id, payload
        from trigger_events
        where workspace_identity = ? and ${PENDING_PREDICATE}
        order by created_at asc
        limit ?`,
    )
    .all(workspaceIdentity, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    workspaceIdentity: String(row.workspace_identity),
    source: String(row.source),
    threadKey: String(row.thread_key),
    actorKind: String(row.actor_kind),
    actorId: row.actor_id === null || row.actor_id === undefined ? null : String(row.actor_id),
    payload: String(row.payload),
  }));
}

/** 全部仍有 pending 候选的 workspace（start() 补扫与评估点 flush 用）。 */
export function listPendingWorkspaces(db: AdjudicationDatabaseHandle): string[] {
  const rows = db
    .prepare(
      `select distinct workspace_identity from trigger_events where ${PENDING_PREDICATE}`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.workspace_identity));
}

/** 交付后结算校验：这批 triggerId 中仍是 pending 的行数（0 = delivery 已结算）。 */
export function countStillPending(
  db: AdjudicationDatabaseHandle,
  triggerIds: readonly string[],
): number {
  if (triggerIds.length === 0) return 0;
  const placeholders = triggerIds.map(() => "?").join(", ");
  const row = db
    .prepare(
      `select count(*) as n from trigger_events
        where adjudication_status = 'pending' and id in (${placeholders})`,
    )
    .get(...triggerIds) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}
