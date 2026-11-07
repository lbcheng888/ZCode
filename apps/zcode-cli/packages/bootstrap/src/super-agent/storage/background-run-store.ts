import type { DatabaseSync } from "node:sqlite";

import type {
  BackgroundRunKind,
  BackgroundRunOwner,
  BackgroundRunRow,
  BackgroundRunTerminalState,
} from "../watchdog/contract.js";
import type { BackgroundRunPersistence } from "../watchdog/registry.js";

const TERMINAL_STATES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "lost",
  "dropped",
]);

interface RegistryDbRow {
  id: string;
  kind: string;
  owner: string;
  owner_session: string | null;
  workspace_key: string | null;
  state: string;
  narrow_result_ref: string | null;
  stall_clock_ref: string | null;
  stalled_since: number | null;
  heartbeat: number | null;
  registered_at: number;
  updated_at: number;
  terminal_at: number | null;
  terminal_reason: string | null;
}

/**
 * `background_run_registry` 的 SQLite 投影（migration 0003）。registry 是唯一写者；
 * 本类只做行快照的读写，不做所有权判定。读出的非法 state 直接抛错（fail-closed）。
 */
export class SqliteBackgroundRunStore implements BackgroundRunPersistence {
  constructor(private readonly db: DatabaseSync) {}

  loadAll(): BackgroundRunRow[] {
    const rows = this.db
      .prepare("select * from background_run_registry order by updated_at asc")
      .all() as unknown as RegistryDbRow[];
    return rows.map((row) => decodeRow(row));
  }

  write(row: BackgroundRunRow): void {
    this.db
      .prepare(
        `insert into background_run_registry (
           id, kind, owner, owner_session, workspace_key, state, narrow_result_ref,
           stall_clock_ref, stalled_since, heartbeat, registered_at, updated_at, terminal_at,
           terminal_reason
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           kind = excluded.kind,
           owner = excluded.owner,
           owner_session = excluded.owner_session,
           workspace_key = excluded.workspace_key,
           state = excluded.state,
           narrow_result_ref = excluded.narrow_result_ref,
           stall_clock_ref = excluded.stall_clock_ref,
           stalled_since = excluded.stalled_since,
           heartbeat = excluded.heartbeat,
           registered_at = excluded.registered_at,
           updated_at = excluded.updated_at,
           terminal_at = excluded.terminal_at,
           terminal_reason = excluded.terminal_reason`,
      )
      .run(
        row.id,
        row.kind,
        row.owner,
        row.ownerSession ?? null,
        row.workspaceKey ?? null,
        row.state,
        row.narrowResultRef ?? null,
        row.stallClockRef ?? null,
        row.stalledSince ?? null,
        row.heartbeat === undefined ? null : row.heartbeat ? 1 : 0,
        row.registeredAt,
        row.updatedAt,
        row.terminalAt ?? null,
        row.terminalReason ?? null,
      );
  }

  delete(id: string): void {
    this.db.prepare("delete from background_run_registry where id = ?").run(id);
  }
}

export interface BackgroundRunListQuery {
  kind?: string;
  owner?: string;
  state?: string;
  workspaceKey?: string;
  limit?: number;
}

/** `runs.list` 的只读查询：与 registry 内存视图同形，直接读持久表以便跨进程可见。 */
export function listBackgroundRunRows(
  db: DatabaseSync,
  query: BackgroundRunListQuery = {},
): BackgroundRunRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (query.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(query.kind);
  }
  if (query.owner !== undefined) {
    clauses.push("owner = ?");
    params.push(query.owner);
  }
  if (query.state !== undefined) {
    clauses.push("state = ?");
    params.push(query.state);
  }
  if (query.workspaceKey !== undefined) {
    clauses.push("workspace_key = ?");
    params.push(query.workspaceKey);
  }
  const limit = Math.min(query.limit ?? 100, 500);
  const sql = `select * from background_run_registry${
    clauses.length === 0 ? "" : ` where ${clauses.join(" and ")}`
  } order by updated_at desc limit ?`;
  const rows = db.prepare(sql).all(...params, limit) as unknown as RegistryDbRow[];
  return rows.map((row) => decodeRow(row));
}

function decodeRow(row: RegistryDbRow): BackgroundRunRow {
  const state = row.state;
  if (state !== "running" && !TERMINAL_STATES.has(state)) {
    throw new Error(`background_run_registry row ${row.id} has invalid state: ${state}`);
  }
  return {
    id: row.id,
    kind: row.kind as BackgroundRunKind,
    owner: row.owner as BackgroundRunOwner,
    ...(row.owner_session === null ? {} : { ownerSession: row.owner_session }),
    ...(row.workspace_key === null ? {} : { workspaceKey: row.workspace_key }),
    state: state as "running" | BackgroundRunTerminalState,
    ...(row.narrow_result_ref === null ? {} : { narrowResultRef: row.narrow_result_ref }),
    ...(row.stall_clock_ref === null ? {} : { stallClockRef: row.stall_clock_ref }),
    ...(row.stalled_since === null ? {} : { stalledSince: row.stalled_since }),
    ...(row.heartbeat === null ? {} : { heartbeat: row.heartbeat === 1 }),
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
    ...(row.terminal_reason === null ? {} : { terminalReason: row.terminal_reason }),
  };
}
