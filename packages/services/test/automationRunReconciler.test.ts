import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeAutomationCreateParams } from "@zcode/shared";
import {
  AUTOMATION_RUN_STALE_MS,
  AutomationRepo,
  STALE_AUTOMATION_RUN_REASON,
} from "../src/session/automationRepo.js";
import { createAutomationRunProjectionSqlite } from "../src/session/automationRunProjection.js";
import { reconcileStaleAutomationRuns } from "../src/session/automationRunReconciler.js";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function makeParams(): ZCodeAutomationCreateParams {
  return {
    title: "stale reconcile",
    cronExpr: "0 9 * * *",
    prompt: "run",
    workspacePath: "/tmp/reconcile-ws",
    recurring: true,
  };
}

describe("automation run stale reconciler", () => {
  let tempDir = "";
  let tasksDbPath = "";
  let superAgentDbPath = "";
  let repo: AutomationRepo;
  let projection: ReturnType<typeof createAutomationRunProjectionSqlite>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-automation-reconcile-"));
    tasksDbPath = join(tempDir, "tasks-index.sqlite");
    superAgentDbPath = join(tempDir, "super-agent.sqlite");
    repo = new AutomationRepo(tasksDbPath);
    const registryDb = new DatabaseSync(superAgentDbPath);
    registryDb.exec(`
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
    registryDb.close();
    projection = createAutomationRunProjectionSqlite({
      databasePath: superAgentDbPath,
      now: () => NOW,
    });
  });

  afterEach(() => {
    projection.close();
    repo.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("fails stale claimed/dispatched runs without touching fresh or terminal rows", async () => {
    const automation = await repo.create(makeParams(), { nextRunAt: NOW });
    const automationId = automation.automationId;
    const workspaceKey = automation.workspaceKey;
    const staleScheduleRun = `${automationId}:${NOW}`;
    const staleManualRun = `${automationId}:manual:1`;
    const freshRun = `${automationId}:${NOW + 1}`;
    const terminalRun = `${automationId}:manual:2`;

    await repo.upsertRunClaimed({
      runId: staleScheduleRun,
      automationId,
      workspaceKey,
      scheduledAt: NOW,
      trigger: "schedule",
    });
    await repo.upsertRunClaimed({
      runId: staleManualRun,
      automationId,
      workspaceKey,
      scheduledAt: NOW,
      trigger: "manual",
    });
    await repo.upsertRunClaimed({
      runId: freshRun,
      automationId,
      workspaceKey,
      scheduledAt: NOW + 1,
      trigger: "schedule",
    });
    await repo.upsertRunClaimed({
      runId: terminalRun,
      automationId,
      workspaceKey,
      scheduledAt: NOW,
      trigger: "manual",
    });
    await repo.markRunDispatch({
      runId: staleManualRun,
      dispatchStatus: "dispatched",
    });
    await repo.markRunOutcome(terminalRun, "succeeded");

    const raw = new DatabaseSync(tasksDbPath);
    raw
      .prepare("update automation_runs set updated_at = ? where run_id = ?")
      .run(NOW - 11 * MINUTE, staleScheduleRun);
    raw
      .prepare("update automation_runs set updated_at = ? where run_id = ?")
      .run(NOW - 11 * MINUTE, staleManualRun);
    raw
      .prepare("update automation_runs set updated_at = ? where run_id = ?")
      .run(NOW - MINUTE, freshRun);
    raw
      .prepare("update automation_runs set updated_at = ? where run_id = ?")
      .run(NOW - 11 * MINUTE, terminalRun);
    raw.close();

    for (const runId of [staleScheduleRun, staleManualRun, freshRun, terminalRun]) {
      projection.register({ id: runId, kind: "automation", owner: "automation", workspaceKey });
    }
    projection.settle(terminalRun, "automation", "completed");

    const reconciled = await reconcileStaleAutomationRuns({
      repo,
      projection,
      now: NOW,
      staleAfterMs: AUTOMATION_RUN_STALE_MS,
    });

    expect(reconciled.map((run) => run.runId)).toEqual([staleScheduleRun, staleManualRun]);
    const ledger = new DatabaseSync(tasksDbPath);
    const rows = ledger
      .prepare("select run_id, dispatch_status, outcome, error from automation_runs")
      .all() as Array<{
      run_id: string;
      dispatch_status: string;
      outcome: string | null;
      error: string | null;
    }>;
    ledger.close();
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          run_id: staleScheduleRun,
          dispatch_status: "failed_to_dispatch",
          outcome: "failed",
          error: STALE_AUTOMATION_RUN_REASON,
        },
        {
          run_id: staleManualRun,
          dispatch_status: "failed_to_dispatch",
          outcome: "failed",
          error: STALE_AUTOMATION_RUN_REASON,
        },
        { run_id: freshRun, dispatch_status: "claimed", outcome: null, error: null },
        {
          run_id: terminalRun,
          dispatch_status: "claimed",
          outcome: "succeeded",
          error: null,
        },
      ]),
    );

    const registry = new DatabaseSync(superAgentDbPath);
    const states = registry
      .prepare("select id, state from background_run_registry")
      .all() as Array<{ id: string; state: string }>;
    registry.close();
    expect(states).toEqual(
      expect.arrayContaining([
        { id: staleScheduleRun, state: "failed" },
        { id: staleManualRun, state: "failed" },
        { id: freshRun, state: "running" },
        { id: terminalRun, state: "completed" },
      ]),
    );
  });

  it("is idempotent and never writes completed for a stale run", async () => {
    const automation = await repo.create(makeParams(), { nextRunAt: NOW });
    const runId = `${automation.automationId}:${NOW}`;
    await repo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey: automation.workspaceKey,
      scheduledAt: NOW,
      trigger: "schedule",
    });
    const raw = new DatabaseSync(tasksDbPath);
    raw
      .prepare("update automation_runs set updated_at = ? where run_id = ?")
      .run(NOW - 11 * MINUTE, runId);
    raw.close();
    projection.register({
      id: runId,
      kind: "automation",
      owner: "automation",
      workspaceKey: automation.workspaceKey,
    });

    const first = await reconcileStaleAutomationRuns({
      repo,
      projection,
      now: NOW,
      staleAfterMs: AUTOMATION_RUN_STALE_MS,
    });
    const second = await reconcileStaleAutomationRuns({
      repo,
      projection,
      now: NOW,
      staleAfterMs: AUTOMATION_RUN_STALE_MS,
    });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    const ledger = new DatabaseSync(tasksDbPath);
    const row = ledger
      .prepare("select outcome from automation_runs where run_id = ?")
      .get(runId) as { outcome: string };
    ledger.close();
    expect(row.outcome).toBe("failed");
  });
});
