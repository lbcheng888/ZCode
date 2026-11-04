import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { getSuperAgentDatabasePath } from "../../src/app/paths.js";

/** spec §1.1–§1.8 daemon 域库全部表（dispatch_requests 属 tasks-index 库，不在本库）。 */
const DOMAIN_TABLES = [
  "trigger_events",
  "trigger_subscriptions",
  "mandate",
  "write_leases",
  "decision_log",
  "control_plane_leases",
] as const;

const tempDirs: string[] = [];
const originalDataBaseDir = process.env.ZCODE_DATA_BASE_DIR;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalDataBaseDir === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
  else process.env.ZCODE_DATA_BASE_DIR = originalDataBaseDir;
});

function listTables(db: { prepare(sql: string): { all(): unknown[] } }): Set<string> {
  const rows = db
    .prepare("select name from sqlite_master where type = 'table'")
    .all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

describe("super-agent-storage 域库迁移", () => {
  it("首迁创建全部六表 + 关键索引 + WAL；重复打开幂等", async () => {
    const dir = mkdtempSync(join(tmpdir(), "super-agent-db-"));
    tempDirs.push(dir);
    const databasePath = join(dir, "nested", "super-agent.sqlite");

    const first = await openSuperAgentDatabase({ databasePath });
    try {
      const journalMode = first.prepare("pragma journal_mode").get() as { journal_mode: string };
      expect(String(journalMode.journal_mode).toLowerCase()).toBe("wal");

      const tables = listTables(first);
      for (const table of DOMAIN_TABLES) expect(tables.has(table)).toBe(true);

      // §1.2/§1.3 partial unique index（幂等持久层）必须真实存在。
      const triggerEventIndexes = first
        .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'trigger_events'")
        .all() as { name: string }[];
      expect(triggerEventIndexes.map((row) => row.name)).toContain(
        "trigger_events_provider_message_uidx",
      );
      const subscriptionIndexes = first
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'trigger_subscriptions'",
        )
        .all() as { name: string }[];
      expect(subscriptionIndexes.map((row) => row.name)).toContain(
        "trigger_subscriptions_active_uidx",
      );
    } finally {
      first.close();
    }

    // 幂等重开：迁移账本恰好一条，六表仍在，不抛错。
    const second = await openSuperAgentDatabase({ databasePath });
    try {
      const applied = second.prepare("select id from schema_migration order by id").all() as {
        id: string;
      }[];
      expect(applied.map((row) => row.id)).toEqual([
        "0001_super_agent_base",
        "0002_decision_log_card_payload",
      ]);
      const tables = listTables(second);
      for (const table of DOMAIN_TABLES) expect(tables.has(table)).toBe(true);
    } finally {
      second.close();
    }
  });

  it("restore 删 0002 账本行但保留列后重开不报 duplicate column（回滚闭环回归）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "super-agent-db-"));
    tempDirs.push(dir);
    const databasePath = join(dir, "super-agent.sqlite");

    const first = await openSuperAgentDatabase({ databasePath });
    first.close();

    // 模拟 restore-sqlite-migration：账本回到 0001-only，但 card_payload 列留在 schema 里。
    // 修复前此处重开会因非幂等 ALTER 报 duplicate column name，库直接打不开。
    const raw = new DatabaseSync(databasePath);
    raw.exec("delete from schema_migration where id = '0002_decision_log_card_payload'");
    raw.close();

    const reopened = await openSuperAgentDatabase({ databasePath });
    try {
      const journal = reopened.prepare("select id from schema_migration order by id").all() as {
        id: string;
      }[];
      expect(journal.map((row) => row.id)).toContain("0002_decision_log_card_payload");
      const hasColumn = reopened
        .prepare("PRAGMA table_info(decision_log)")
        .all()
        .some((entry) => (entry as { name?: string }).name === "card_payload");
      expect(hasColumn).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it(":memory: 打开同样跑迁移（测试/短命进程路径）", async () => {
    const db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    try {
      const tables = listTables(db);
      for (const table of DOMAIN_TABLES) expect(tables.has(table)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("getSuperAgentDatabasePath（spec §1.1）", () => {
  it("按 ZCODE_DATA_BASE_DIR 解析到 .zcode/v2/super-agent.sqlite", () => {
    const base = mkdtempSync(join(tmpdir(), "super-agent-data-"));
    tempDirs.push(base);
    process.env.ZCODE_DATA_BASE_DIR = base;
    expect(getSuperAgentDatabasePath()).toBe(join(base, ".zcode", "v2", "super-agent.sqlite"));
  });

  it("未设 ZCODE_DATA_BASE_DIR 时回落 HOME/homedir", () => {
    delete process.env.ZCODE_DATA_BASE_DIR;
    const fallbackBase = process.env.HOME?.trim() || homedir();
    expect(getSuperAgentDatabasePath()).toBe(
      join(fallbackBase, ".zcode", "v2", "super-agent.sqlite"),
    );
  });

  it("baseDir 入参优先于 env（setDataBaseDir 覆盖的宿主注入路径，spec §1.1 实施偏差）", () => {
    const envBase = mkdtempSync(join(tmpdir(), "super-agent-data-env-"));
    const overrideBase = mkdtempSync(join(tmpdir(), "super-agent-data-override-"));
    tempDirs.push(envBase, overrideBase);
    process.env.ZCODE_DATA_BASE_DIR = envBase;
    expect(getSuperAgentDatabasePath(overrideBase)).toBe(
      join(overrideBase, ".zcode", "v2", "super-agent.sqlite"),
    );
  });
});
