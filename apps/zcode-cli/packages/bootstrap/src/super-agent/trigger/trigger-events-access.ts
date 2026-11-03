import type { DatabaseSync } from "node:sqlite";

/**
 * trigger_events 的 trigger 模块侧窄访问面（§1.2）。
 * INSERT（intake 唯一写入点，M2）与 Fast Path 三态写入归 super-agent-intake；
 * 本文件只提供 EventRouter / 分派器 / verdict 解释执行需要的读与终态列更新
 * （final_disposition / adjudication_status），不旁路 intake 的准入写。
 */
export interface TriggerEventRow {
  id: string;
  workspaceIdentity: string;
  source: string;
  threadKey: string;
  payload: string;
  taint: boolean;
  fastPath: string | null;
  adjudicationStatus: string | null;
  finalDisposition: string | null;
}

const SELECT_COLUMNS = `
  id, workspace_identity, source, thread_key, payload, taint, fast_path,
  adjudication_status, final_disposition
`;

function toRow(row: Record<string, unknown>): TriggerEventRow {
  return {
    id: String(row.id),
    workspaceIdentity: String(row.workspace_identity),
    source: String(row.source),
    threadKey: String(row.thread_key),
    payload: String(row.payload),
    taint: Number(row.taint) !== 0,
    fastPath: row.fast_path === null || row.fast_path === undefined ? null : String(row.fast_path),
    adjudicationStatus:
      row.adjudication_status === null || row.adjudication_status === undefined
        ? null
        : String(row.adjudication_status),
    finalDisposition:
      row.final_disposition === null || row.final_disposition === undefined
        ? null
        : String(row.final_disposition),
  };
}

export function getTriggerEvent(db: DatabaseSync, triggerId: string): TriggerEventRow | undefined {
  const row = db
    .prepare(`select ${SELECT_COLUMNS} from trigger_events where id = ?`)
    .get(triggerId) as Record<string, unknown> | undefined;
  return row ? toRow(row) : undefined;
}

/** 路由/裁决收敛终态列（§1.2 final_disposition）；行不存在返回 false。 */
export function setTriggerEventFinalDisposition(
  db: DatabaseSync,
  triggerId: string,
  disposition: string,
  now?: number,
): boolean {
  const result = db
    .prepare(
      "update trigger_events set final_disposition = ?, updated_at = ? where id = ?",
    )
    .run(disposition, now ?? Date.now(), triggerId);
  return Number(result.changes) > 0;
}

/** 裁决收敛状态列（§1.2 adjudication_status：pending/accepted/rejected/record_only）。 */
export function setTriggerEventAdjudicationStatus(
  db: DatabaseSync,
  triggerId: string,
  status: "pending" | "accepted" | "rejected" | "record_only",
  now?: number,
): boolean {
  const result = db
    .prepare(
      "update trigger_events set adjudication_status = ?, updated_at = ? where id = ?",
    )
    .run(status, now ?? Date.now(), triggerId);
  return Number(result.changes) > 0;
}
