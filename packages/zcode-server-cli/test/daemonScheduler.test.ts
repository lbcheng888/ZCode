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
import { AutomationRepo } from "@zcode/services/node";
import type { ZCodeAutomation } from "@zcode/shared";
import type { LeaseListResult } from "@zcode/shared/super-agent-control-plane-protocol";

import {
  createDaemonScheduler,
  createPendingDispatchWriter,
  type DaemonSchedulerAuditPort,
  type DaemonSchedulerAutomationRepo,
  type DaemonSchedulerDispatchPort,
  type DaemonSchedulerLeasePort,
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
  return { leases, auditor, dispatch, ensureWorkspace, audits, inserts };
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
    const bad = await createDueAutomation(repo, now - 30_000, undefined, {
      identity: "ws-scheduler-bad",
      path: "/tmp/zcode-scheduler-bad",
    });
    const good = await createDueAutomation(repo, now - 30_000, undefined, {
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
      releaseClaim: async () => undefined,
      skipAndReschedule: async () => undefined,
      upsertRunClaimed: async () => undefined,
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
