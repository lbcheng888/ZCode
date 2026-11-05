/**
 * daemon scheduler 门控/审计/释放语义（B-SPEC §4.4 B3）。
 *
 * 真 sqlite tasks-index（AutomationRepo 迁移 + 真行），租约/审计/派发端口用可注入替身
 * 精确控制失败面；真 child socket 的端到端接缝见
 * test/super-agent/daemonScheduler.integration.test.ts。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationRepo, CLAIM_STALE_MS, OffPeakTaskRepo } from "@zcode/services/node";
import type { ZCodeAutomation } from "@zcode/shared";
import type { LeaseListResult } from "@zcode/shared/super-agent-control-plane-protocol";

import {
  createDaemonScheduler,
  createPendingDispatchWriter,
  pendingDispatchCommandId,
  type DaemonSchedulerAuditPort,
  type DaemonSchedulerAutomationRepo,
  type DaemonSchedulerDispatchPort,
  type DaemonSchedulerLeasePort,
  type DaemonSchedulerOffPeakRepo,
  type DaemonSchedulerOptions,
} from "../src/server-core/scheduler/index.js";

const WORKSPACE = "ws-scheduler-unit";
const OWNER_ID = "control-plane:test";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRepo(): Promise<{ repo: AutomationRepo; dbPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "zcsched-"));
  roots.push(root);
  const dbPath = join(root, "tasks-index.sqlite");
  const repo = new AutomationRepo(dbPath);
  await repo.ensureReady();
  return { repo, dbPath };
}

async function createDueAutomation(
  repo: AutomationRepo,
  nextRunAt: number,
  targetTaskId?: string,
  workspace: { identity: string; path: string } = {
    identity: WORKSPACE,
    path: "/tmp/zcode-scheduler-unit-workspace",
  },
): Promise<ZCodeAutomation> {
  return await repo.create(
    {
      title: "scheduler unit",
      cronExpr: "* * * * *",
      prompt: "unit prompt",
      workspacePath: workspace.path,
      workspaceIdentity: workspace.identity,
      recurring: true,
      ...(targetTaskId ? { targetTaskId } : {}),
    },
    { nextRunAt },
  );
}

function readRunning(dbPath: string, automationId: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("select running from automations where automation_id = ?")
      .get(automationId) as { running?: number } | undefined;
    return Number(row?.running ?? 0);
  } finally {
    db.close();
  }
}

function readDispatchRows(dbPath: string): Array<{ run_id: string; session_id: string | null }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare("select run_id, session_id from dispatch_requests order by created_at")
      .all() as unknown as Array<{ run_id: string; session_id: string | null }>;
  } finally {
    db.close();
  }
}

interface AutomationSnapshot {
  running: number;
  enabled: number;
  next_run_at: number | null;
  dispatch_status: string;
  dispatch_attempts: number;
  retry_at: number | null;
  run_count: number;
  scheduled_run_count: number;
  last_run_at: number | null;
}

function readAutomation(dbPath: string, automationId: string): AutomationSnapshot {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        `select running, enabled, next_run_at, dispatch_status, dispatch_attempts,
                retry_at, run_count, scheduled_run_count, last_run_at
         from automations where automation_id = ?`,
      )
      .get(automationId) as AutomationSnapshot | undefined;
    if (!row) throw new Error(`automation not found: ${automationId}`);
    return row;
  } finally {
    db.close();
  }
}

interface RunSnapshot {
  dispatch_status: string;
  session_id: string | null;
  outcome: string | null;
  error: string | null;
  attempts: number;
}

function readRun(dbPath: string, runId: string): RunSnapshot {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        `select dispatch_status, session_id, outcome, error, attempts
         from automation_runs where run_id = ?`,
      )
      .get(runId) as RunSnapshot | undefined;
    if (!row) throw new Error(`run not found: ${runId}`);
    return row;
  } finally {
    db.close();
  }
}

interface OffPeakSnapshot {
  status: string;
  claim_running: number;
  attempt_count: number;
  schedulable: number;
  started_at: number | null;
  ended_at: number | null;
}

function readOffPeak(dbPath: string, offPeakTaskId: string): OffPeakSnapshot {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        `select status, claim_running, attempt_count, schedulable,
                started_at, ended_at
         from off_peak_tasks where off_peak_task_id = ?`,
      )
      .get(offPeakTaskId) as OffPeakSnapshot | undefined;
    if (!row) throw new Error(`off-peak task not found: ${offPeakTaskId}`);
    return row;
  } finally {
    db.close();
  }
}

function leaseList(
  workspaces: Array<{ workspaceIdentity: string; expiresAt: number; ownerId?: string }>,
): LeaseListResult {
  return {
    workspaces: workspaces.map((workspace) => ({
      workspaceIdentity: workspace.workspaceIdentity,
      ownerId: workspace.ownerId ?? OWNER_ID,
      expiresAt: workspace.expiresAt,
    })),
  };
}

function createHarness(overrides: {
  lease?: Partial<DaemonSchedulerLeasePort>;
  audit?: Partial<DaemonSchedulerAuditPort>;
  dispatch?: Partial<DaemonSchedulerDispatchPort>;
  ensure?: DaemonSchedulerOptions["ensureWorkspace"];
  offPeakRepo?: DaemonSchedulerOffPeakRepo;
}) {
  const audits: Array<Parameters<DaemonSchedulerAuditPort["audit"]>[0]> = [];
  const inserts: Array<Parameters<DaemonSchedulerDispatchPort["insert"]>[0]> = [];
  const leases = {
    list: vi.fn(async () => leaseList([{ workspaceIdentity: WORKSPACE, expiresAt: Date.now() + 30_000 }])),
    ...overrides.lease,
  } satisfies DaemonSchedulerLeasePort;
  const auditor = {
    audit: vi.fn(async (input: Parameters<DaemonSchedulerAuditPort["audit"]>[0]) => {
      audits.push(input);
      return { inserted: true };
    }),
    ...overrides.audit,
  } satisfies DaemonSchedulerAuditPort;
  const dispatch = {
    insert: vi.fn((input: Parameters<DaemonSchedulerDispatchPort["insert"]>[0]) => {
      inserts.push(input);
      return { requestId: "request-1", commandId: "command-1", created: true };
    }),
    close: vi.fn(),
    ...overrides.dispatch,
  } satisfies DaemonSchedulerDispatchPort;
  const ensureWorkspace = vi.fn(
    overrides.ensure ?? (async () => ({ state: "leader", leaseExpiresAt: Date.now() + 30_000 })),
  );
  return {
    leases,
    auditor,
    dispatch,
    ensureWorkspace,
    audits,
    inserts,
    ...(overrides.offPeakRepo ? { offPeakRepo: overrides.offPeakRepo } : {}),
  };
}

/** 用 harness 端口 + 真 sqlite repo 构造 scheduler（新用例共用）。 */
function buildScheduler(
  repo: DaemonSchedulerAutomationRepo,
  harness: ReturnType<typeof createHarness>,
  options: {
    now?: () => number;
    misfireGraceMs?: number;
    offPeakRepo?: DaemonSchedulerOffPeakRepo;
  } = {},
): ReturnType<typeof createDaemonScheduler> {
  return createDaemonScheduler({
    repo,
    leases: harness.leases,
    auditor: harness.auditor,
    dispatch: harness.dispatch,
    ensureWorkspace: harness.ensureWorkspace,
    ownerId: () => OWNER_ID,
    ...(options.now ? { now: options.now } : {}),
    ...(options.misfireGraceMs ? { misfireGraceMs: options.misfireGraceMs } : {}),
    ...(options.offPeakRepo ? { offPeakRepo: options.offPeakRepo } : {}),
  });
}

describe("daemon scheduler", () => {
  let repo: AutomationRepo;
  let dbPath: string;
  let scheduler: ReturnType<typeof createDaemonScheduler> | undefined;

  beforeEach(async () => {
    ({ repo, dbPath } = await createRepo());
    scheduler = undefined;
  });

  afterEach(async () => {
    await scheduler?.stop();
    scheduler = undefined;
    repo.close();
  });

  it("claims and audits only workspaces where the child holds an unexpired lease", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000, "session-target-1");
    const harness = createHarness({});
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: harness.dispatch,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });

    await scheduler.tick(now);

    expect(harness.ensureWorkspace).toHaveBeenCalledWith(WORKSPACE, "/tmp/zcode-scheduler-unit-workspace");
    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0]).toMatchObject({
      workspaceIdentity: WORKSPACE,
      domainKey: automation.automationId,
      providerMessageId: `${automation.automationId}:${automation.nextRunAt}`,
    });
    expect(harness.inserts).toHaveLength(1);
    expect(harness.inserts[0]).toMatchObject({
      workspaceIdentity: WORKSPACE,
      sessionId: "session-target-1",
      payload: "unit prompt",
    });
    expect(readRunning(dbPath, automation.automationId)).toBe(1);
  });

  it("does not claim when the lease is expired (fail-closed; Desktop fallback owns it)", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000);
    const harness = createHarness({
      lease: {
        list: async () => leaseList([{ workspaceIdentity: WORKSPACE, expiresAt: now - 1 }]),
      },
    });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: harness.dispatch,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });

    await scheduler.tick(now);

    expect(harness.audits).toHaveLength(0);
    expect(harness.inserts).toHaveLength(0);
    expect(readRunning(dbPath, automation.automationId)).toBe(0);
    expect(readDispatchRows(dbPath)).toHaveLength(0);
  });

  it("does not claim when no lease is visible (child not leader)", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000);
    const harness = createHarness({ lease: { list: async () => leaseList([]) } });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: harness.dispatch,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });

    await scheduler.tick(now);

    expect(readRunning(dbPath, automation.automationId)).toBe(0);
    expect(readDispatchRows(dbPath)).toHaveLength(0);
  });

  it("does not claim when lease.list is unreachable (daemon fail-closed)", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000);
    const harness = createHarness({
      lease: {
        list: async () => {
          throw new Error("rpc.unreachable");
        },
      },
    });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: harness.dispatch,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });

    await scheduler.tick(now);

    expect(readRunning(dbPath, automation.automationId)).toBe(0);
    expect(harness.audits).toHaveLength(0);
  });

  it("does not claim when workspace.ensure fails (child starting/unreachable)", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000);
    const harness = createHarness({
      ensure: async () => {
        throw new Error("workspace.ensure: control plane is still starting");
      },
    });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: harness.dispatch,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });

    await scheduler.tick(now);

    expect(readRunning(dbPath, automation.automationId)).toBe(0);
    expect(harness.audits).toHaveLength(0);
    expect(harness.inserts).toHaveLength(0);
    // per-plane 隔离后本 tick 继续读租约（ensure 只跳过该 workspace），但 leader 集为空 =
    // 认领被释放，绝无审计/派发。
    expect(harness.leases.list).toHaveBeenCalled();
  });

  it("releases the claim when schedule.audit fails (no unaudited dispatch)", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000);
    const harness = createHarness({
      audit: {
        audit: async () => {
          throw new Error("rpc.timeout");
        },
      },
    });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: harness.dispatch,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });

    await scheduler.tick(now);

    expect(harness.inserts).toHaveLength(0);
    expect(readRunning(dbPath, automation.automationId)).toBe(0);
    expect(readDispatchRows(dbPath)).toHaveLength(0);
  });

  it("releases the claim when pending dispatch insert fails", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000);
    const harness = createHarness({
      dispatch: {
        insert: () => {
          throw new Error("tasks-index write failed");
        },
      },
    });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: harness.dispatch,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });

    await scheduler.tick(now);

    expect(harness.audits).toHaveLength(1);
    expect(readRunning(dbPath, automation.automationId)).toBe(0);
  });

  it("skips misfired windows instead of dispatching late", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 10 * 60_000);
    const harness = createHarness({});
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: harness.dispatch,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
      misfireGraceMs: 5 * 60_000,
    });

    await scheduler.tick(now);

    expect(harness.audits).toHaveLength(1);
    expect(harness.inserts).toHaveLength(0);
    expect(readRunning(dbPath, automation.automationId)).toBe(0);
    const after = await repo.get(automation.automationId);
    expect(after?.nextRunAt ?? null).not.toBe(automation.nextRunAt ?? null);
  });

  it("does not claim a lease owned by another plane even if it is unexpired", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000);
    const harness = createHarness({
      lease: {
        list: async () =>
          leaseList([
            { workspaceIdentity: WORKSPACE, expiresAt: now + 30_000, ownerId: "control-plane:other" },
          ]),
      },
    });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: harness.dispatch,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });

    await scheduler.tick(now);

    expect(harness.audits).toHaveLength(0);
    expect(harness.inserts).toHaveLength(0);
    expect(readRunning(dbPath, automation.automationId)).toBe(0);
  });

  it("isolates one workspace's ensure failure and still claims healthy workspaces", async () => {
    const now = Date.now();
    const bad = await createDueAutomation(repo, now - 30_000, "session-bad", {
      identity: "ws-scheduler-bad",
      path: "/tmp/zcode-scheduler-bad",
    });
    const good = await createDueAutomation(repo, now - 30_000, "session-good", {
      identity: "ws-scheduler-good",
      path: "/tmp/zcode-scheduler-good",
    });
    const harness = createHarness({
      lease: {
        list: async () =>
          leaseList([
            { workspaceIdentity: "ws-scheduler-bad", expiresAt: now + 30_000 },
            { workspaceIdentity: "ws-scheduler-good", expiresAt: now + 30_000 },
          ]),
      },
      ensure: async (workspaceIdentity) => {
        if (workspaceIdentity === "ws-scheduler-bad") throw new Error("plane open failed");
        return { state: "leader", leaseExpiresAt: now + 30_000 };
      },
    });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: harness.dispatch,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });

    await scheduler.tick(now);

    expect(readRunning(dbPath, bad.automationId)).toBe(0);
    expect(readRunning(dbPath, good.automationId)).toBe(1);
    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0]).toMatchObject({ workspaceIdentity: "ws-scheduler-good" });
  });

  it("start() fails loudly when tasks-index lacks the dispatch_requests table", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcsched-"));
    roots.push(root);
    const rawPath = join(root, "tasks-index.sqlite");
    const raw = new DatabaseSync(rawPath);
    raw.exec("create table placeholder (id text primary key)");
    raw.close();

    // repo 端只负责 ensureReady（此处已就绪），写面校验由真实 writer 对缺表库执行。
    const repoStub: DaemonSchedulerAutomationRepo = {
      ensureReady: async () => undefined,
      list: async () => [],
      claimDue: async () => [],
      claimManualRuns: async () => [],
      get: async () => null,
      getRun: async () => null,
      releaseClaim: async () => undefined,
      releaseManualClaim: async () => undefined,
      touchManualClaim: async () => undefined,
      skipAndReschedule: async () => undefined,
      upsertRunClaimed: async () => undefined,
      markRunDispatch: async () => undefined,
      markDispatched: async () => undefined,
      markDispatchFailed: async () => undefined,
      markManualRunDispatched: async () => false,
      markRunOutcome: async () => undefined,
      close: () => undefined,
    };
    const scheduler = createDaemonScheduler({
      repo: repoStub,
      leases: { list: async () => leaseList([]) },
      auditor: { audit: async () => ({ inserted: true }) },
      dispatch: createPendingDispatchWriter({ databasePath: rawPath }),
      ensureWorkspace: async () => ({ state: "leader", leaseExpiresAt: Date.now() + 30_000 }),
      ownerId: () => OWNER_ID,
    });

    await expect(scheduler.start()).rejects.toThrow(/dispatch_requests/);
    await scheduler.stop();
  });
});

/**
 * 结算 / manual / off-peak（B-SPEC §4.4.3–§4.4.5）：真 sqlite tasks-index（AutomationRepo +
 * OffPeakTaskRepo 真实迁移），租约/审计端口用可注入替身精确控制失败面。
 */
describe("daemon scheduler settlement, manual and off-peak", () => {
  let repo: AutomationRepo;
  let offPeakRepo: OffPeakTaskRepo;
  let dbPath: string;
  let scheduler: ReturnType<typeof createDaemonScheduler> | undefined;

  beforeEach(async () => {
    ({ repo, dbPath } = await createRepo());
    offPeakRepo = new OffPeakTaskRepo(dbPath);
    await offPeakRepo.ensureReady();
    scheduler = undefined;
  });

  afterEach(async () => {
    await scheduler?.stop();
    scheduler = undefined;
    offPeakRepo.close();
    repo.close();
  });

  it("settles a scheduled run on ACK: dispatched ledger, next_run_at advanced, duplicate ACK idempotent", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000, "session-target-1");
    const harness = createHarness({});
    scheduler = buildScheduler(repo, harness, { now: () => now });

    await scheduler.tick(now);
    const runId = `${automation.automationId}:${automation.nextRunAt}`;
    expect(readAutomation(dbPath, automation.automationId).running).toBe(1);
    expect(readRun(dbPath, runId).dispatch_status).toBe("claimed");

    // 桥 ACK（admission admitted|duplicate）= settled。
    await scheduler.settleDispatchResult({
      runId,
      ok: true,
      sessionId: "session-target-1",
    });

    expect(readRun(dbPath, runId)).toMatchObject({
      dispatch_status: "dispatched",
      session_id: "session-target-1",
    });
    const settled = readAutomation(dbPath, automation.automationId);
    expect(settled).toMatchObject({
      running: 0,
      dispatch_status: "dispatched",
      run_count: 1,
      scheduled_run_count: 1,
    });
    expect(settled.next_run_at).not.toBe(automation.nextRunAt);
    expect(settled.next_run_at ?? 0).toBeGreaterThan(now);
    expect(settled.last_run_at).toBe(now);

    // 重复 ACK（回执丢失后重推）：run 已 dispatched，不得再推进 next_run_at/计数。
    await scheduler.settleDispatchResult({ runId, ok: true, sessionId: null });
    const duplicate = readAutomation(dbPath, automation.automationId);
    expect(duplicate.next_run_at).toBe(settled.next_run_at);
    expect(duplicate.run_count).toBe(1);
    expect(readRun(dbPath, runId).session_id).toBe("session-target-1");
  });

  it("settles a failed ACK: failed_to_dispatch, claim released, transient retry armed", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000, "session-target-1");
    const harness = createHarness({});
    scheduler = buildScheduler(repo, harness, { now: () => now });

    await scheduler.tick(now);
    const runId = `${automation.automationId}:${automation.nextRunAt}`;

    await scheduler.settleDispatchResult({
      runId,
      ok: false,
      failureKind: "transient",
      error: "no local host available",
    });

    expect(readRun(dbPath, runId)).toMatchObject({
      dispatch_status: "failed_to_dispatch",
      error: "no local host available",
    });
    const after = readAutomation(dbPath, automation.automationId);
    expect(after.running).toBe(0);
    expect(after.dispatch_status).toBe("failed_to_dispatch");
    expect(after.dispatch_attempts).toBe(1);
    expect(after.retry_at ?? 0).toBeGreaterThan(now);
    expect(after.next_run_at).toBe(automation.nextRunAt); // 退避不推进计划时刻

    // worker 终态回写：outcome 台账（与派发结算分属两个写入点）。
    await scheduler.settleRunTerminal({ runId, outcome: "failed", error: "run failed" });
    expect(readRun(dbPath, runId).outcome).toBe("failed");
  });

  it("claims a stale manual run, dispatches it through the bridge, retains the claim on ACK and releases it on terminal", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now + 60 * 60_000, "session-target-manual");
    // runNow 是 UI 直派路径：先占 single-flight、写 manual run（attempts=1）。
    // 用陈旧时钟创建，模拟「派发方崩溃、scheduler 重启后 recovery 认领」。
    const claimed = await repo.runNow(automation.automationId, {
      now: now - CLAIM_STALE_MS - 60_000,
    });
    expect(claimed).not.toBeNull();
    const runId = claimed!.run.runId;

    const harness = createHarness({});
    // 真 pending_dispatch 写入器：manual 与定时 run 共用同一条 exactly-once 桥行。
    const writer = createPendingDispatchWriter({ databasePath: dbPath });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: writer,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });
    await scheduler.tick(now);

    expect(readDispatchRows(dbPath)).toMatchObject([
      { run_id: runId, session_id: "session-target-manual" },
    ]);

    await scheduler.settleDispatchResult({
      runId,
      ok: true,
      sessionId: "session-manual-accepted",
    });
    expect(readRun(dbPath, runId)).toMatchObject({
      dispatch_status: "dispatched",
      session_id: "session-manual-accepted",
    });
    const accepted = readAutomation(dbPath, automation.automationId);
    // manual ACK 只表示 accepted/queued：claim 保留到 turn 终态，且不改 cron 计划。
    expect(accepted.running).toBe(1);
    expect(accepted.next_run_at).toBe(automation.nextRunAt);
    expect(accepted.run_count).toBe(1);
    expect(accepted.scheduled_run_count).toBe(0);

    // 重复 ACK（回执丢失后重推）：run 已 dispatched，不得重复计数或释放 claim。
    await scheduler.settleDispatchResult({ runId, ok: true, sessionId: null });
    const duplicate = readAutomation(dbPath, automation.automationId);
    expect(duplicate.running).toBe(1);
    expect(duplicate.run_count).toBe(1);

    await scheduler.settleRunTerminal({ runId, outcome: "succeeded" });
    expect(readRun(dbPath, runId).outcome).toBe("succeeded");
    expect(readAutomation(dbPath, automation.automationId).running).toBe(0);
  });

  it("releases the manual claim when dispatch fails (no usable turn to wait for)", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now + 60 * 60_000, "session-target-manual");
    const claimed = await repo.runNow(automation.automationId, {
      now: now - CLAIM_STALE_MS - 60_000,
    });
    expect(claimed).not.toBeNull();
    const runId = claimed!.run.runId;

    const harness = createHarness({});
    scheduler = buildScheduler(repo, harness, { now: () => now });
    await scheduler.tick(now);

    await scheduler.settleDispatchResult({ runId, ok: false, error: "bridge rejected" });
    expect(readRun(dbPath, runId)).toMatchObject({
      dispatch_status: "failed_to_dispatch",
      error: "bridge rejected",
    });
    expect(readAutomation(dbPath, automation.automationId).running).toBe(0);
    expect(readAutomation(dbPath, automation.automationId).run_count).toBe(0);
  });

  it("claims off-peak, audits once and defers (顺延): queued, claim released, attempt unchanged, no bridge row", async () => {
    const now = Date.now();
    const task = await offPeakRepo.create(
      {
        title: "off-peak unit",
        prompt: "off-peak prompt",
        permissionMode: "default",
        modelSelection: { providerId: "zai", modelId: "glm-5" },
        workspacePath: "/tmp/zcode-scheduler-unit-workspace",
        workspaceIdentity: WORKSPACE,
      },
      { now, schedulable: true },
    );
    const harness = createHarness({ offPeakRepo });
    scheduler = buildScheduler(repo, harness, {
      now: () => now,
      offPeakRepo,
    });

    await scheduler.tick(now);

    expect(harness.ensureWorkspace).toHaveBeenCalledWith(
      WORKSPACE,
      "/tmp/zcode-scheduler-unit-workspace",
    );
    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0]).toMatchObject({
      workspaceIdentity: WORKSPACE,
      domainKey: task.offPeakTaskId,
      providerMessageId: task.offPeakTaskId,
    });
    // 不进 dispatch_requests 桥（§7-5）。
    expect(harness.inserts).toHaveLength(0);
    expect(readDispatchRows(dbPath)).toHaveLength(0);
    // ticket 顺延：任务仍 queued，认领已释放，失败计数不动。
    expect(readOffPeak(dbPath, task.offPeakTaskId)).toMatchObject({
      status: "queued",
      claim_running: 0,
      attempt_count: 0,
      started_at: null,
      ended_at: null,
    });
  });

  it("does not claim off-peak when the child lease is not visible (Desktop fallback owns it)", async () => {
    const now = Date.now();
    const task = await offPeakRepo.create(
      {
        title: "off-peak gated",
        prompt: "off-peak prompt",
        permissionMode: "default",
        modelSelection: { providerId: "zai", modelId: "glm-5" },
        workspacePath: "/tmp/zcode-scheduler-unit-workspace",
        workspaceIdentity: WORKSPACE,
      },
      { now, schedulable: true },
    );
    const harness = createHarness({
      offPeakRepo,
      lease: { list: async () => leaseList([{ workspaceIdentity: WORKSPACE, expiresAt: now - 1 }]) },
    });
    scheduler = buildScheduler(repo, harness, { now: () => now, offPeakRepo });

    await scheduler.tick(now);

    expect(harness.audits).toHaveLength(0);
    expect(readOffPeak(dbPath, task.offPeakTaskId).claim_running).toBe(0);
    expect(readDispatchRows(dbPath)).toHaveLength(0);
  });

  it("releases the off-peak claim when schedule.audit fails (no unaudited claim path)", async () => {
    const now = Date.now();
    const task = await offPeakRepo.create(
      {
        title: "off-peak audit failure",
        prompt: "off-peak prompt",
        permissionMode: "default",
        modelSelection: { providerId: "zai", modelId: "glm-5" },
        workspacePath: "/tmp/zcode-scheduler-unit-workspace",
        workspaceIdentity: WORKSPACE,
      },
      { now, schedulable: true },
    );
    const harness = createHarness({
      offPeakRepo,
      audit: {
        audit: async () => {
          throw new Error("schedule.audit rpc failure (test injection)");
        },
      },
    });
    scheduler = buildScheduler(repo, harness, { now: () => now, offPeakRepo });

    await scheduler.tick(now);

    expect(readOffPeak(dbPath, task.offPeakTaskId)).toMatchObject({
      status: "queued",
      claim_running: 0,
      attempt_count: 0,
    });
    expect(readDispatchRows(dbPath)).toHaveLength(0);
  });

  it("keeps daemon and a Desktop-style Main fork from both claiming the same automation (real sqlite single-flight)", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000, "session-target-1");
    const harness = createHarness({});
    scheduler = buildScheduler(repo, harness, { now: () => now });

    await scheduler.tick(now);
    expect(readAutomation(dbPath, automation.automationId).running).toBe(1);

    // Desktop Main fork 等价：第二个 AutomationRepo 连接同一 tasks-index，BEGIN IMMEDIATE
    // 单飞认领必须看不到 running=1 的行（同 run 不得双派）。
    const desktopRepo = new AutomationRepo(dbPath);
    await desktopRepo.ensureReady();
    try {
      const desktopClaims = await desktopRepo.claimDue(now);
      expect(desktopClaims).toHaveLength(0);
    } finally {
      desktopRepo.close();
    }
  });

  it("keeps a daemon-claimed manual run out of a Desktop-style claim until it is released", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now + 60 * 60_000, "session-target-manual");
    const claimed = await repo.runNow(automation.automationId, {
      now: now - CLAIM_STALE_MS - 60_000,
    });
    expect(claimed).not.toBeNull();

    const harness = createHarness({});
    scheduler = buildScheduler(repo, harness, { now: () => now });
    await scheduler.tick(now);
    expect(readAutomation(dbPath, automation.automationId).running).toBe(1);

    const desktopRepo = new AutomationRepo(dbPath);
    await desktopRepo.ensureReady();
    try {
      const desktopClaims = await desktopRepo.claimManualRuns(now);
      expect(desktopClaims).toHaveLength(0);
    } finally {
      desktopRepo.close();
    }
  });

  it("releases a stale manual claim for a non-leader workspace so the Desktop fallback can own it", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now + 60 * 60_000, "session-target-manual");
    const claimed = await repo.runNow(automation.automationId, {
      now: now - CLAIM_STALE_MS - 60_000,
    });
    expect(claimed).not.toBeNull();

    const harness = createHarness({
      lease: { list: async () => leaseList([{ workspaceIdentity: WORKSPACE, expiresAt: now - 1 }]) },
    });
    scheduler = buildScheduler(repo, harness, { now: () => now });
    await scheduler.tick(now);

    expect(readAutomation(dbPath, automation.automationId).running).toBe(0);
    expect(harness.inserts).toHaveLength(0);
    expect(readDispatchRows(dbPath)).toHaveLength(0);
  });

  it("settles a rejected host.command ACK: failed_to_dispatch, claim released, retry armed, non-bridge command ignored", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000, "session-target-1");
    const harness = createHarness({});
    const writer = createPendingDispatchWriter({ databasePath: dbPath });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: writer,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });
    await scheduler.tick(now);
    const runId = `${automation.automationId}:${automation.nextRunAt}`;
    expect(readRun(dbPath, runId).dispatch_status).toBe("claimed");

    // rejected 不是桥 ACK（行保持 pushed），但 run 台账必须可见失败并进入退避；
    // 否则 failed_to_dispatch/retry_at 这一整套只有测试可达。
    const settled = await scheduler.settleHostCommand({
      commandId: pendingDispatchCommandId(runId),
      status: "rejected",
      sessionId: "session-target-1",
      reasonCode: "superagent.sessionNotHosted",
    });
    expect(settled).toEqual({ runId });
    expect(readRun(dbPath, runId)).toMatchObject({
      dispatch_status: "failed_to_dispatch",
      error: "host.command rejected: superagent.sessionNotHosted",
    });
    const after = readAutomation(dbPath, automation.automationId);
    expect(after.running).toBe(0);
    expect(after.dispatch_status).toBe("failed_to_dispatch");
    expect(after.dispatch_attempts).toBe(1);
    expect(after.retry_at ?? 0).toBeGreaterThan(now);

    // 放弃投递守卫：同一 commandId 的迟到 pushed 行不得再执行。
    expect(scheduler.isHostCommandDeliverable(pendingDispatchCommandId(runId))).toBe(false);

    // 重复失败回执幂等：不退避两次。
    await scheduler.settleHostCommand({
      commandId: pendingDispatchCommandId(runId),
      status: "rejected",
      sessionId: "session-target-1",
    });
    expect(readAutomation(dbPath, automation.automationId).dispatch_attempts).toBe(1);

    // trigger 直通的 commandId 不在桥表：零写入、恒可投递。
    expect(
      await scheduler.settleHostCommand({
        commandId: "trigger-1:session-x",
        status: "rejected",
        sessionId: "session-x",
      }),
    ).toBeNull();
    expect(scheduler.isHostCommandDeliverable("trigger-1:session-x")).toBe(true);
  });

  it("reconciles a bridge-skipped row: run skipped, next_run_at advanced, no permanent claimed stall", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000, "session-target-1");
    const harness = createHarness({});
    const writer = createPendingDispatchWriter({ databasePath: dbPath });
    scheduler = createDaemonScheduler({
      repo,
      leases: harness.leases,
      auditor: harness.auditor,
      dispatch: writer,
      ensureWorkspace: harness.ensureWorkspace,
      ownerId: () => OWNER_ID,
      now: () => now,
    });
    await scheduler.tick(now);
    const runId = `${automation.automationId}:${automation.nextRunAt}`;

    // child 桥的宽限 sweep CAS：pending_dispatch → skipped(no_dispatcher)。
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        `update dispatch_requests
            set status = 'skipped', skip_reason = 'no_dispatcher', settled_at = ?, updated_at = ?
          where run_id = ?`,
      ).run(now, now, runId);
    } finally {
      db.close();
    }

    await scheduler.tick(now);

    expect(readRun(dbPath, runId)).toMatchObject({
      dispatch_status: "skipped",
      error: "dispatch_skipped:no_dispatcher",
    });
    const after = readAutomation(dbPath, automation.automationId);
    expect(after.running).toBe(0);
    expect(after.dispatch_status).toBe("idle");
    expect(after.next_run_at ?? 0).toBeGreaterThan(automation.nextRunAt ?? 0);

    // 对账幂等：run 已不再 claimed，后续 tick 不再推进。
    await scheduler.tick(now);
    expect(readAutomation(dbPath, automation.automationId).next_run_at).toBe(after.next_run_at);
  });

  it("does not write a pending row for an automation without a target session; permanent failure surfaced", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now - 30_000);
    const harness = createHarness({});
    scheduler = buildScheduler(repo, harness, { now: () => now });

    await scheduler.tick(now);

    const runId = `${automation.automationId}:${automation.nextRunAt}`;
    expect(harness.inserts).toHaveLength(0);
    expect(readDispatchRows(dbPath)).toHaveLength(0);
    expect(readRun(dbPath, runId).dispatch_status).toBe("failed_to_dispatch");
    const after = readAutomation(dbPath, automation.automationId);
    expect(after).toMatchObject({
      running: 0,
      enabled: 0,
      dispatch_status: "failed_to_dispatch",
    });
    expect(after.last_run_at ?? null).toBeNull();
  });

  it("does not write a pending row for a manual run without a target session; failed and claim released", async () => {
    const now = Date.now();
    const automation = await createDueAutomation(repo, now + 60 * 60_000);
    const claimed = await repo.runNow(automation.automationId, {
      now: now - CLAIM_STALE_MS - 60_000,
    });
    expect(claimed).not.toBeNull();
    const runId = claimed!.run.runId;
    const harness = createHarness({});
    scheduler = buildScheduler(repo, harness, { now: () => now });

    await scheduler.tick(now);

    expect(harness.inserts).toHaveLength(0);
    expect(readDispatchRows(dbPath)).toHaveLength(0);
    expect(readRun(dbPath, runId).dispatch_status).toBe("failed_to_dispatch");
    expect(readAutomation(dbPath, automation.automationId).running).toBe(0);
  });

  it("renews the manual claim heartbeat past CLAIM_STALE_MS so a long turn is not reclaimed", async () => {
    vi.useFakeTimers();
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    vi.setSystemTime(base);
    try {
      const automation = await createDueAutomation(repo, base + 60 * 60_000, "session-target-manual");
      const claimed = await repo.runNow(automation.automationId, {
        // 模拟派发方崩溃后 scheduler 重启：原 claim 已陈旧。
        now: base - CLAIM_STALE_MS - 60_000,
      });
      expect(claimed).not.toBeNull();
      const runId = claimed!.run.runId;
      const touchSpy = vi.spyOn(repo, "touchManualClaim");
      const harness = createHarness({});
      scheduler = createDaemonScheduler({
        repo,
        leases: harness.leases,
        auditor: harness.auditor,
        dispatch: createPendingDispatchWriter({ databasePath: dbPath }),
        ensureWorkspace: harness.ensureWorkspace,
        ownerId: () => OWNER_ID,
        now: () => Date.now(),
      });

      await scheduler.tick(base);
      await scheduler.settleDispatchResult({
        runId,
        ok: true,
        sessionId: "session-manual-accepted",
      });
      expect(readAutomation(dbPath, automation.automationId).running).toBe(1);

      // 跨过一个完整的 CLAIM_STALE_MS 窗口；心跳每 60s 续租 claimed_at。
      const advanceMs = CLAIM_STALE_MS + 2 * 60_000;
      await vi.advanceTimersByTimeAsync(advanceMs);
      expect(touchSpy.mock.calls.length).toBeGreaterThan(0);

      // 同库第二个连接（Desktop Main fork 等价）按陈旧窗口看：automation 仍 running=1，
      // 不得被僵尸回收，也不得把同一 manual run 再认领一次。
      const desktopRepo = new AutomationRepo(dbPath);
      await desktopRepo.ensureReady();
      try {
        expect(await desktopRepo.claimManualRuns(Date.now())).toHaveLength(0);
      } finally {
        desktopRepo.close();
      }
      expect(readAutomation(dbPath, automation.automationId).running).toBe(1);
    } finally {
      await scheduler?.stop();
      scheduler = undefined;
      vi.useRealTimers();
    }
  });
});
