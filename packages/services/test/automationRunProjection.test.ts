import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createAutomationRunProjectionSqlite } from "../src/session/automationRunProjection.js";

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "automation-run-projection-"));
  ROOTS.push(dir);
  return dir;
}

function createRegistryDb(dir: string): string {
  const path = join(dir, "super-agent.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    create table background_run_registry (
      id text primary key,
      kind text not null,
      owner text not null,
      owner_session text,
      workspace_key text,
      state text not null,
      narrow_result_ref text,
      stall_clock_ref text,
      stalled_since integer,
      heartbeat integer,
      registered_at integer not null,
      updated_at integer not null,
      terminal_at integer,
      terminal_reason text
    );
  `);
  db.close();
  return path;
}

function readRow(path: string, id: string): Record<string, unknown> | undefined {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("select * from background_run_registry where id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  } finally {
    db.close();
  }
}

describe("automation run projection sqlite", () => {
  it("registers a running automation run and settles/touches the same row", () => {
    const dir = root();
    const path = createRegistryDb(dir);
    const projection = createAutomationRunProjectionSqlite({
      databasePath: path,
      now: () => 1_000,
    });
    try {
      projection.register({
        id: "auto-1:manual:run-1",
        kind: "automation",
        owner: "automation",
        ownerSession: "session-1",
        workspaceKey: "/ws/a",
      });
      expect(readRow(path, "auto-1:manual:run-1")).toMatchObject({
        kind: "automation",
        owner: "automation",
        owner_session: "session-1",
        workspace_key: "/ws/a",
        state: "running",
        registered_at: 1_000,
        updated_at: 1_000,
      });

      projection.touch("auto-1:manual:run-1", "automation", { ownerSession: "session-2" });
      projection.settle("auto-1:manual:run-1", "automation", "completed");
      expect(readRow(path, "auto-1:manual:run-1")).toMatchObject({
        owner_session: "session-2",
        state: "completed",
        terminal_at: 1_000,
        updated_at: 1_000,
      });
    } finally {
      projection.close();
    }
  });

  it("is a no-op when the super-agent database or registry table does not exist", () => {
    const dir = root();
    const missingDb = join(dir, "super-agent.sqlite");
    const projection = createAutomationRunProjectionSqlite({
      databasePath: missingDb,
      now: () => 1_000,
    });
    projection.register({
      id: "auto-1:manual:run-1",
      kind: "automation",
      owner: "automation",
    });
    expect(existsSync(missingDb)).toBe(false);
    projection.close();

    const emptyDb = join(dir, "empty.sqlite");
    new DatabaseSync(emptyDb).close();
    const noTable = createAutomationRunProjectionSqlite({
      databasePath: emptyDb,
      now: () => 1_000,
    });
    noTable.register({
      id: "auto-1:manual:run-1",
      kind: "automation",
      owner: "automation",
    });
    const probe = new DatabaseSync(emptyDb);
    expect(
      probe
        .prepare(
          "select 1 from sqlite_master where type = 'table' and name = 'background_run_registry'",
        )
        .get(),
    ).toBeUndefined();
    probe.close();
    noTable.close();
  });

  it("reports write failures without pretending the row landed", () => {
    const dir = root();
    const path = join(dir, "broken.sqlite");
    const db = new DatabaseSync(path);
    // 有表但列不匹配：写入必须失败并经 onError 上报。
    db.exec("create table background_run_registry (id text primary key);");
    db.close();
    const errors: unknown[] = [];
    const projection = createAutomationRunProjectionSqlite({
      databasePath: path,
      now: () => 1_000,
      onError: (error) => errors.push(error),
    });
    projection.register({
      id: "auto-1:manual:run-1",
      kind: "automation",
      owner: "automation",
    });
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("background_run_registry");
    projection.close();
  });
});
