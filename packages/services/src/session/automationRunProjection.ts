import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { AutomationRunProjectionPort } from "./automationService.js";

/**
 * 跨进程 automation run projection：把 manual run 的 lifecycle 写进 CLI/app 同源的
 * `super-agent.sqlite` registry 表。CLI app watchdog tick 从同一表增量刷新后即可看到
 * automation 行并执行 pause-automation（命令仍走 app 的 AutomationPort）。
 *
 * 表不存在/库不存在 = 控制面从未运行：本投影 no-op，不凭空建库建表。写入失败经
 * onError 上报，不阻断 automationService 的业务路径（投影不是状态权威）。
 */
export interface AutomationRunProjectionSqliteOptions {
  databasePath: string;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface AutomationRunProjectionSqlite extends AutomationRunProjectionPort {
  close(): void;
}

export function createAutomationRunProjectionSqlite(
  options: AutomationRunProjectionSqliteOptions,
): AutomationRunProjectionSqlite {
  const now = options.now ?? Date.now;
  let db: DatabaseSync | undefined;

  const store = (): DatabaseSync | undefined => {
    if (db !== undefined) return db;
    if (!existsSync(options.databasePath)) return undefined;
    const candidate = new DatabaseSync(options.databasePath);
    try {
      const table = candidate
        .prepare(
          "select 1 from sqlite_master where type = 'table' and name = 'background_run_registry'",
        )
        .get();
      if (!table) {
        candidate.close();
        return undefined;
      }
      candidate.exec("pragma busy_timeout = 5000");
      db = candidate;
      return db;
    } catch (error) {
      candidate.close();
      throw error;
    }
  };

  const write = (operation: (database: DatabaseSync) => void): void => {
    try {
      const database = store();
      if (database === undefined) return;
      operation(database);
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    register(row) {
      write((database) => {
        const at = now();
        database
          .prepare(
            `
            insert into background_run_registry (
              id, kind, owner, owner_session, workspace_key, state,
              registered_at, updated_at
            ) values (?, 'automation', 'automation', ?, ?, 'running', ?, ?)
            on conflict(id) do update set
              owner_session = coalesce(excluded.owner_session, background_run_registry.owner_session),
              workspace_key = coalesce(excluded.workspace_key, background_run_registry.workspace_key),
              state = 'running',
              terminal_at = null,
              terminal_reason = null,
              updated_at = excluded.updated_at
            `,
          )
          .run(row.id, row.ownerSession ?? null, row.workspaceKey ?? null, at, at);
      });
    },
    settle(id, owner, state, opts) {
      if (owner !== "automation") return;
      write((database) => {
        const at = now();
        database
          .prepare(
            `
            update background_run_registry
            set state = ?, terminal_at = ?, updated_at = ?,
                narrow_result_ref = coalesce(?, narrow_result_ref)
            where id = ? and owner = 'automation'
            `,
          )
          .run(state, at, at, opts?.narrowResultRef ?? null, id);
      });
    },
    touch(id, owner, patch) {
      if (owner !== "automation") return;
      write((database) => {
        const at = now();
        database
          .prepare(
            `
            update background_run_registry
            set owner_session = coalesce(?, owner_session), updated_at = ?
            where id = ? and owner = 'automation' and state = 'running'
            `,
          )
          .run(patch.ownerSession ?? null, at, id);
      });
    },
    close() {
      db?.close();
      db = undefined;
    },
  };
}
