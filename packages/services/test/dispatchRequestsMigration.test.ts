import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

/**
 * spec super-agent-trigger-subsystem-spec §1.6：dispatch_requests（tasks-index 库，
 * M7② exactly-once 派发桥）纯增量迁移。结构权威 = 0007_dispatch_requests；状态机写者
 * = super-agent-trigger 派发桥（跨进程 CAS），本迁移只建表。
 */
describe("0007_dispatch_requests 迁移（§1.6）", () => {
  const databases: DatabaseSync[] = [];
  let backupRoot: string;

  const open = () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    return db;
  };
  const migrate = (db: DatabaseSync) =>
    runTasksDatabaseMigrations(db, join(backupRoot, "tasks.sqlite"));

  beforeEach(async () => {
    backupRoot = await mkdtemp(join(tmpdir(), "zcode-dispatch-migration-"));
  });
  afterEach(async () => {
    for (const db of databases.splice(0)) db.close();
    await rm(backupRoot, { recursive: true, force: true });
  });

  it("首迁创建 dispatch_requests + 状态机/检索索引 + 双 UNIQUE 稳定幂等键", async () => {
    const db = open();
    await migrate(db);

    const columns = db.prepare("PRAGMA table_info(dispatch_requests)").all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "run_id",
      "command_id",
      "workspace_identity",
      "session_id",
      "payload",
      "status",
      "skip_reason",
      "dispatch_policy",
      "attempts",
      "claimed_at",
      "pushed_at",
      "acked_at",
      "settled_at",
      "created_at",
      "updated_at",
    ]);
    const byName = new Map(columns.map((column) => [column.name, column]));
    // run_id / command_id 双 UNIQUE 是 exactly-once 的持久层（claim 幂等 + 重投同键）；
    // 加 TEXT PK 共三个唯一 autoindex。
    expect(
      db
        .prepare("PRAGMA index_list(dispatch_requests)")
        .all()
        .filter((row) => Number(row.unique) === 1),
    ).toHaveLength(3);
    expect(byName.get("run_id")?.notnull).toBe(1);
    expect(byName.get("command_id")?.notnull).toBe(1);
    expect(byName.get("dispatch_policy")?.notnull).toBe(1);
    expect(byName.get("attempts")?.notnull).toBe(1);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dispatch_requests' AND name NOT LIKE 'sqlite_autoindex%'",
      )
      .all() as { name: string }[];
    expect(indexes.map((row) => row.name)).toEqual([
      "idx_dispatch_requests_status_updated",
      "idx_dispatch_requests_workspace_status",
    ]);
  });

  it("迁移幂等：账本重跑零变化，重复 migrate 不重建不抛错", async () => {
    const db = open();
    await migrate(db);
    const ledger = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    expect(ledger.map((row) => (row as { id: string }).id)).toContain("0007_dispatch_requests");
    await migrate(db);
    expect(db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all()).toEqual(ledger);
    const count = db.prepare("SELECT count(*) AS n FROM dispatch_requests").get() as { n: number };
    expect(Number(count.n)).toBe(0);
  });

  it("行面：claim 初始行可写入，双 UNIQUE 冲突即幂等短路面（与桥 claimDue 同语义）", async () => {
    const db = open();
    await migrate(db);
    const insert = db.prepare(
      `INSERT INTO dispatch_requests (
        id, run_id, command_id, workspace_identity, session_id, payload,
        status, skip_reason, dispatch_policy, attempts,
        claimed_at, pushed_at, acked_at, settled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, 'pending_dispatch', NULL, 'in_window', 0, ?, NULL, NULL, NULL, ?, ?)`,
    );
    insert.run("req-1", "run-1", "cmd-1", "ws-a", "prompt", 1, 1, 1);
    expect(() => insert.run("req-2", "run-1", "cmd-2", "ws-a", null, 2, 2, 2)).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(() => insert.run("req-3", "run-2", "cmd-1", "ws-a", null, 2, 2, 2)).toThrow(
      /UNIQUE constraint failed/,
    );
  });
});
