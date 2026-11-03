import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteMigrations } from "@zcode/shared/sqlite-migrations";

import type {
  OpenSuperAgentDatabaseOptions,
  SuperAgentDatabaseHandle,
} from "./contract.js";
import { SUPER_AGENT_MIGRATIONS } from "./migrations.js";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const MEMORY_DATABASE_PATH = ":memory:";
// :memory: 库无文件目录，迁移备份无恢复价值；仍给 runner 非空备份目录（机制要求），投 OS 临时目录。
const MEMORY_MIGRATION_BACKUP_DIRNAME = "zcode-super-agent-migration-backup";

function readJournalMode(db: DatabaseSync, enableWal: boolean): string {
  const row = db
    .prepare(enableWal ? "pragma journal_mode = wal" : "pragma journal_mode")
    .get() as Record<string, unknown> | undefined;
  const mode = row?.journal_mode;
  return typeof mode === "string" ? mode.toLowerCase() : "unknown";
}

/**
 * 打开 daemon 域库：建父目录 → WAL → 全量迁移（§1.1）。
 * 幂等：重复打开已迁移库不重复执行迁移。失败原样抛出：文件库拒绝 WAL、迁移校验不过都直接
 * 上浮，不降级、不回退 journal 模式。返回的句柄由组合根注入兄弟模块仓储；本模块不提供
 * 任何业务表读写。
 */
export async function openSuperAgentDatabase(
  options: OpenSuperAgentDatabaseOptions,
): Promise<SuperAgentDatabaseHandle> {
  const databasePath = options.databasePath;
  if (databasePath !== MEMORY_DATABASE_PATH) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`pragma busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.exec("pragma foreign_keys = on");
    const journalMode = readJournalMode(db, true);
    // 内存库无法落 WAL，保持 memory；文件库拿不到 WAL 说明挂载/驱动异常，响亮失败。
    if (journalMode !== "wal" && !(databasePath === MEMORY_DATABASE_PATH && journalMode === "memory")) {
      throw new Error(
        `SQLite refused WAL journal mode for ${databasePath}; received ${journalMode}`,
      );
    }
    const backupDirectories = [
      databasePath === MEMORY_DATABASE_PATH
        ? join(tmpdir(), MEMORY_MIGRATION_BACKUP_DIRNAME)
        : join(dirname(databasePath), "backup"),
    ];
    await sqliteMigrations.migrate(db, SUPER_AGENT_MIGRATIONS, {
      database: "super_agent",
      backupDirectories,
    });
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // 关闭失败不覆盖打开/迁移的原始错误。
    }
    throw error;
  }
}
