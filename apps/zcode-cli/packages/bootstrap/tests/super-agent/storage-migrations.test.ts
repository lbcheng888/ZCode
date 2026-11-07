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
  const rows = db.prepare("select name from sqlite_master where type = 'table'").all() as {
    name: string;
  }[];
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
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'trigger_events'",
        )
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
      // S1：同 workspace 单 active 写租约（第二写者 DB 级兜底）。
      const writeLeaseIndexes = first
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'write_leases'",
        )
        .all() as { name: string }[];
      expect(writeLeaseIndexes.map((row) => row.name)).toContain("write_leases_single_active_uidx");
    } finally {
      first.close();
    }

    // 幂等重开：迁移账本完整，六表仍在，不抛错。
    const second = await openSuperAgentDatabase({ databasePath });
    try {
      const applied = second.prepare("select id from schema_migration order by id").all() as {
        id: string;
      }[];
      expect(applied.map((row) => row.id)).toEqual([
        "0001_super_agent_base",
        "0002_decision_log_card_payload",
        "0003_background_run_registry",
        "0004_write_lease_single_active",
        "0005_decision_log_cheng_plan_id",
        "0006_trigger_events_cheng_plan_id",
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

  it("0004 restore：多条 active 只保留最新一条，unique index 拒绝第二写者", async () => {
    const dir = mkdtempSync(join(tmpdir(), "super-agent-db-"));
    tempDirs.push(dir);
    const databasePath = join(dir, "super-agent.sqlite");

    const first = await openSuperAgentDatabase({ databasePath });
    // 模拟历史/手工库：索引与迁移账本均缺失，且同 workspace 有三条 active。
    first.exec("drop index write_leases_single_active_uidx");
    const insert = first.prepare(
      `insert into write_leases (
        id, workspace_identity, owner_run_id, scope, status, lease_expires_at, created_at, updated_at
      ) values (?, 'ws-a', ?, '[]', 'active', ?, ?, ?)`,
    );
    insert.run("lease-old", "run-old", 9_999_999_999_999, 1, 1);
    insert.run("lease-mid", "run-mid", 9_999_999_999_999, 2, 2);
    insert.run("lease-new", "run-new", 9_999_999_999_999, 3, 3);
    first.exec("delete from schema_migration where id = '0004_write_lease_single_active'");
    first.close();

    const reopened = await openSuperAgentDatabase({ databasePath });
    try {
      const active = reopened
        .prepare("select id from write_leases where status = 'active' order by id")
        .all() as { id: string }[];
      // 迁移保留 (created_at,id) 最大的那条，其余置 released；旧库不再有多写者行。
      expect(active.map((row) => row.id)).toEqual(["lease-new"]);
      const indexes = reopened
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'write_leases'",
        )
        .all() as { name: string }[];
      expect(indexes.map((row) => row.name)).toContain("write_leases_single_active_uidx");
      // DB 级兜底：绕过仓储直插第二条 active 必被唯一索引拒绝。
      expect(() =>
        reopened
          .prepare(
            `insert into write_leases (
              id, workspace_identity, owner_run_id, scope, status, lease_expires_at, created_at, updated_at
            ) values ('lease-duplicate', 'ws-a', 'run-x', '[]', 'active', 9_999_999_999_999, 4, 4)`,
          )
          .run(),
      ).toThrow();
    } finally {
      reopened.close();
    }
  });

  it("0005 restore：删账本但保留 cheng_plan_id 列后重开不报 duplicate column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "super-agent-db-"));
    tempDirs.push(dir);
    const databasePath = join(dir, "super-agent.sqlite");

    const first = await openSuperAgentDatabase({ databasePath });
    first.close();

    const raw = new DatabaseSync(databasePath);
    raw.exec("delete from schema_migration where id = '0005_decision_log_cheng_plan_id'");
    raw.close();

    const reopened = await openSuperAgentDatabase({ databasePath });
    try {
      const journal = reopened.prepare("select id from schema_migration order by id").all() as {
        id: string;
      }[];
      expect(journal.map((row) => row.id)).toContain("0005_decision_log_cheng_plan_id");
      const hasColumn = reopened
        .prepare("PRAGMA table_info(decision_log)")
        .all()
        .some((entry) => (entry as { name?: string }).name === "cheng_plan_id");
      expect(hasColumn).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("0006 restore：删账本但保留 trigger_events.cheng_plan_id 列后重开不报 duplicate column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "super-agent-db-"));
    tempDirs.push(dir);
    const databasePath = join(dir, "super-agent.sqlite");

    const first = await openSuperAgentDatabase({ databasePath });
    first.close();

    const raw = new DatabaseSync(databasePath);
    raw.exec("delete from schema_migration where id = '0006_trigger_events_cheng_plan_id'");
    raw.close();

    const reopened = await openSuperAgentDatabase({ databasePath });
    try {
      const journal = reopened.prepare("select id from schema_migration order by id").all() as {
        id: string;
      }[];
      expect(journal.map((row) => row.id)).toContain("0006_trigger_events_cheng_plan_id");
      const hasColumn = reopened
        .prepare("PRAGMA table_info(trigger_events)")
        .all()
        .some((entry) => (entry as { name?: string }).name === "cheng_plan_id");
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
  it("按 ZCODE_DATA_BASE_DIR 解析到 .chengcode/v2/super-agent.sqlite", () => {
    const base = mkdtempSync(join(tmpdir(), "super-agent-data-"));
    tempDirs.push(base);
    process.env.ZCODE_DATA_BASE_DIR = base;
    expect(getSuperAgentDatabasePath()).toBe(join(base, ".chengcode", "v2", "super-agent.sqlite"));
  });

  it("未设 ZCODE_DATA_BASE_DIR 时回落 HOME/homedir", () => {
    delete process.env.ZCODE_DATA_BASE_DIR;
    const fallbackBase = process.env.HOME?.trim() || homedir();
    expect(getSuperAgentDatabasePath()).toBe(
      join(fallbackBase, ".chengcode", "v2", "super-agent.sqlite"),
    );
  });

  it("baseDir 入参优先于 env（setDataBaseDir 覆盖的宿主注入路径，spec §1.1 实施偏差）", () => {
    const envBase = mkdtempSync(join(tmpdir(), "super-agent-data-env-"));
    const overrideBase = mkdtempSync(join(tmpdir(), "super-agent-data-override-"));
    tempDirs.push(envBase, overrideBase);
    process.env.ZCODE_DATA_BASE_DIR = envBase;
    expect(getSuperAgentDatabasePath(overrideBase)).toBe(
      join(overrideBase, ".chengcode", "v2", "super-agent.sqlite"),
    );
  });
});
