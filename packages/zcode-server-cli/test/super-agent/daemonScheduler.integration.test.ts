/**
 * daemon scheduler ↔ 真 child 接缝（B-SPEC §4.4 / §5.2「Core↔child 集成」）。
 *
 * 真 headless child（dev tsx 入口）+ 真 sqlite + 真 unix socket + §3.8 凭据：
 * - `workspace.ensure` 后 lease.list 可见，scheduler 才 claim；
 * - 审计经 `schedule.audit` RPC 由 child 写入 trigger_events（Core 不碰域库）；
 * - 租约过期后 daemon 不 claim（交回 Desktop 回退）；
 * - audit RPC 失败释放 claim，不写 pending；
 * - child 不可达时 fail-closed 不 claim。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AutomationRepo,
  OffPeakTaskRepo,
  createSuperAgentControlPlaneScheduleAuditor,
} from "@zcode/services/node";
import type { ZCodeAutomation } from "@zcode/shared";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  controlPlaneOwnerId,
  hostCommandParamsSchema,
} from "@zcode/shared/super-agent-control-plane-protocol";

import { ensureControlPlaneAuthToken } from "../../src/supervisor/controlPlaneAuth.js";
import { resolveDefaultControlPlaneCommand } from "../../src/supervisor/controlPlaneLauncher.js";
import { createControlPlaneClient } from "../../src/supervisor/controlPlaneClient.js";
import {
  createSuperAgentControlPlaneCorePort,
  handleSuperAgentControlPlaneInboundRequest,
  SuperAgentControlPlaneGenerationGate,
} from "../../src/server-core/superAgentControlPlanePort.js";
import {
  createDaemonScheduler,
  createPendingDispatchWriter,
} from "../../src/server-core/scheduler/index.js";

const MONOREPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TEST_TIMEOUT_MS = 60_000;
const WORKSPACE = "ws-scheduler-integration";
const roots: string[] = [];
const children: ChildProcess[] = [];
const childStderr = new WeakMap<ChildProcess, string>();

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function waitForChildMessage(
  child: ChildProcess,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(
        new Error(`timed out waiting for child IPC; stderr=${childStderr.get(child) ?? ""}`),
      );
    }, 30_000);
    const onMessage = (raw: unknown): void => {
      if (typeof raw !== "object" || raw === null) return;
      const message = raw as Record<string, unknown>;
      if (message.type === "fatal") {
        clearTimeout(timer);
        child.off("message", onMessage);
        reject(
          new Error(
            `child reported fatal: ${String(message.message)}; stderr=${childStderr.get(child) ?? ""}`,
          ),
        );
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
}

async function startRealChild(serverRoot: string, dataBaseDir: string): Promise<ChildProcess> {
  const resolution = resolveDefaultControlPlaneCommand(
    { serverRoot, release: null },
    { devSearchFrom: MONOREPO_ROOT, platform: process.platform },
  );
  if (!resolution.ok) throw new Error(resolution.reason);
  const child = spawn(resolution.command.executable, [...(resolution.command.args ?? [])], {
    cwd: resolution.command.cwd,
    env: {
      ...process.env,
      ZCODE_CONTROL_PLANE_GENERATION: "1",
      ZCODE_CONTROL_PLANE_PROTOCOL_VERSION: String(CONTROL_PLANE_PROTOCOL_VERSION),
      ZCODE_DATA_BASE_DIR: dataBaseDir,
      ZCODE_SERVER_ROOT: serverRoot,
      ZCODE_CONTROL_PLANE_MANDATE_GATE: "0",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  children.push(child);
  childStderr.set(child, "");
  child.stderr?.on("data", (chunk: Buffer) => {
    childStderr.set(child, `${childStderr.get(child) ?? ""}${chunk.toString("utf8")}`);
  });
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.send?.({ command: "shutdown" });
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

interface Harness {
  serverRoot: string;
  dataBaseDir: string;
  dbPath: string;
  superAgentDbPath: string;
  repo: AutomationRepo;
  gate: SuperAgentControlPlaneGenerationGate;
  client: ReturnType<typeof createControlPlaneClient>;
  port: ReturnType<typeof createSuperAgentControlPlaneCorePort>;
  child: ChildProcess;
  stop(): Promise<void>;
}

async function startHarness(options: {
  /** 覆盖 Core 侧 child→Core 回调处理（真实 child 的反向 RPC 仍走真 socket）。 */
  onInboundRequest?: (method: string, params: unknown) => Promise<unknown>;
} = {}): Promise<Harness> {
  // 短目录名：unix socket 路径上限约 104 字节。
  const root = await mkdtemp(join(tmpdir(), "zcsched-it-"));
  roots.push(root);
  const serverRoot = join(root, "server");
  const dataBaseDir = join(root, "data");
  const dbPath = join(dataBaseDir, ".zcode", "v2", "tasks-index.sqlite");
  const superAgentDbPath = join(dataBaseDir, ".zcode", "v2", "super-agent.sqlite");
  await ensureControlPlaneAuthToken(serverRoot);
  const child = await startRealChild(serverRoot, dataBaseDir);
  await waitForChildMessage(child, (message) => message.type === "ready");

  const repo = new AutomationRepo(dbPath);
  await repo.ensureReady();
  const gate = new SuperAgentControlPlaneGenerationGate();
  gate.update({
    type: "control-plane-state",
    state: "ready",
    generation: 1,
    firstReadyAt: 1,
    crashSignalObserved: false,
    crashBudgetExhausted: false,
  });
  const client = createControlPlaneClient({
    serverRoot,
    onInboundRequest: options.onInboundRequest ?? handleSuperAgentControlPlaneInboundRequest,
  });
  const port = createSuperAgentControlPlaneCorePort({
    client,
    gate,
    tasksIndexReady: true,
    tasksIndexDatabasePath: dbPath,
  });
  return {
    serverRoot,
    dataBaseDir,
    dbPath,
    superAgentDbPath,
    repo,
    gate,
    client,
    port,
    child,
    async stop() {
      await client.close().catch(() => undefined);
      await stopChild(child);
      repo.close();
    },
  };
}

async function createDueAutomation(
  repo: AutomationRepo,
  now: number,
  workspaceIdentity = WORKSPACE,
  targetTaskId?: string,
): Promise<ZCodeAutomation> {
  return await repo.create(
    {
      title: "scheduler integration",
      cronExpr: "* * * * *",
      prompt: "integration prompt",
      workspacePath: `/tmp/zcode-${workspaceIdentity}-workspace`,
      workspaceIdentity,
      recurring: true,
      ...(targetTaskId ? { targetTaskId } : {}),
    },
    { nextRunAt: now - 30_000 },
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

function readAuditRows(superAgentDbPath: string): Array<{ provider_message_id: string }> {
  const db = new DatabaseSync(superAgentDbPath);
  try {
    return db
      .prepare(
        "select provider_message_id from trigger_events where source = 'schedule' order by created_at",
      )
      .all() as unknown as Array<{ provider_message_id: string }>;
  } finally {
    db.close();
  }
}

function readPendingRows(dbPath: string): Array<{ run_id: string; status: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare("select run_id, status from dispatch_requests order by created_at")
      .all() as unknown as Array<{ run_id: string; status: string }>;
  } finally {
    db.close();
  }
}

function readRun(dbPath: string, runId: string): { dispatch_status: string; session_id: string | null } {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("select dispatch_status, session_id from automation_runs where run_id = ?")
      .get(runId) as { dispatch_status?: string; session_id?: string | null } | undefined;
    if (!row) throw new Error(`run not found: ${runId}`);
    return {
      dispatch_status: String(row.dispatch_status),
      session_id: row.session_id ?? null,
    };
  } finally {
    db.close();
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
  details?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `timed out waiting for ${label}${details ? `; ${details()}` : ""}`,
  );
}

function expireLeases(superAgentDbPath: string, now: number): void {
  const db = new DatabaseSync(superAgentDbPath);
  try {
    db.prepare("update control_plane_leases set expires_at = ?").run(now - 1);
  } finally {
    db.close();
  }
}

describe("daemon scheduler ↔ real child", () => {
  it(
    "claims only with a visible lease, audits via RPC, and stops claiming after lease expiry",
    async () => {
      const harness = await startHarness();
      const writer = createPendingDispatchWriter({ databasePath: harness.dbPath });
      const scheduler = createDaemonScheduler({
        repo: harness.repo,
        leases: { list: () => harness.port.listLeases() },
        auditor: createSuperAgentControlPlaneScheduleAuditor(harness.port.port),
        dispatch: writer,
        ensureWorkspace: (workspaceIdentity, workspacePath) =>
          harness.port.ensureWorkspace(workspaceIdentity, workspacePath),
        ownerId: (workspaceIdentity) =>
          controlPlaneOwnerId(harness.serverRoot, workspaceIdentity),
        now: () => Date.now(),
      });
      try {
        const now = Date.now();
        const automation = await createDueAutomation(harness.repo, now, WORKSPACE, "session-integration-target");

        await scheduler.tick(now);

        const leases = await harness.port.listLeases();
        expect(
          leases.workspaces.find((lease) => lease.workspaceIdentity === WORKSPACE)?.expiresAt,
        ).toBeGreaterThan(now);
        expect(readRunning(harness.dbPath, automation.automationId)).toBe(1);
        expect(readAuditRows(harness.superAgentDbPath)).toEqual([
          { provider_message_id: `${automation.automationId}:${automation.nextRunAt}` },
        ]);
        expect(readPendingRows(harness.dbPath)).toMatchObject([
          { run_id: `${automation.automationId}:${automation.nextRunAt}`, status: "pending_dispatch" },
        ]);

        // 租约过期：daemon 不再 claim（交回 Desktop Main fork 回退语义）。
        // 用一条新 automation 验证门控（上一条仍持有 running=1 的 claim，不再参与本轮
        // claimDue）。tick 取一个明显晚于 child 心跳续租窗口的时间，避免心跳把
        // expires_at 又推回未来造成测试竞态（真实语义仍是「未过期才 claim」）。
        const second = await createDueAutomation(harness.repo, now, WORKSPACE, "session-integration-target");
        const expiredAt = Date.now() + 60_000;
        expireLeases(harness.superAgentDbPath, expiredAt);
        await scheduler.tick(expiredAt);
        expect(readRunning(harness.dbPath, second.automationId)).toBe(0);
        expect(readPendingRows(harness.dbPath)).toHaveLength(1);
      } finally {
        await scheduler.stop();
        await harness.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "claims off-peak, writes only the schedule.audit row via real child, and defers (顺延) without a bridge row",
    async () => {
      const harness = await startHarness();
      const offPeakRepo = new OffPeakTaskRepo(harness.dbPath);
      await offPeakRepo.ensureReady();
      const writer = createPendingDispatchWriter({ databasePath: harness.dbPath });
      const scheduler = createDaemonScheduler({
        repo: harness.repo,
        offPeakRepo,
        leases: { list: () => harness.port.listLeases() },
        auditor: createSuperAgentControlPlaneScheduleAuditor(harness.port.port),
        dispatch: writer,
        ensureWorkspace: (workspaceIdentity, workspacePath) =>
          harness.port.ensureWorkspace(workspaceIdentity, workspacePath),
        ownerId: (workspaceIdentity) =>
          controlPlaneOwnerId(harness.serverRoot, workspaceIdentity),
        now: () => Date.now(),
      });
      try {
        const now = Date.now();
        const task = await offPeakRepo.create(
          {
            title: "off-peak integration",
            prompt: "integration prompt",
            permissionMode: "default",
            modelSelection: { providerId: "zai", modelId: "glm-5" },
            workspacePath: `/tmp/zcode-${WORKSPACE}-workspace`,
            workspaceIdentity: WORKSPACE,
          },
          { now, schedulable: true },
        );

        await scheduler.tick(now);

        // child 写入审计行：provider_message_id = 任务稳定键（非 runId）。
        expect(readAuditRows(harness.superAgentDbPath)).toEqual([
          { provider_message_id: task.offPeakTaskId },
        ]);
        // off-peak 不进桥。
        expect(readPendingRows(harness.dbPath)).toHaveLength(0);
        // 顺延：仍 queued，认领 release，未标记 running/terminal。
        const db = new DatabaseSync(harness.dbPath);
        try {
          const row = db
            .prepare(
              "select status, claim_running, attempt_count, started_at, ended_at from off_peak_tasks where off_peak_task_id = ?",
            )
            .get(task.offPeakTaskId) as {
            status: string;
            claim_running: number;
            attempt_count: number;
            started_at: number | null;
            ended_at: number | null;
          };
          expect(row).toMatchObject({
            status: "queued",
            claim_running: 0,
            attempt_count: 0,
            started_at: null,
            ended_at: null,
          });
        } finally {
          db.close();
        }
      } finally {
        await scheduler.stop();
        offPeakRepo.close();
        await harness.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "releases the claim and writes no pending row when schedule.audit RPC fails",
    async () => {
      const harness = await startHarness();
      const writer = createPendingDispatchWriter({ databasePath: harness.dbPath });
      const scheduler = createDaemonScheduler({
        repo: harness.repo,
        leases: { list: () => harness.port.listLeases() },
        auditor: {
          audit: async () => {
            throw new Error("schedule.audit rpc failure (test injection)");
          },
        },
        dispatch: writer,
        ensureWorkspace: (workspaceIdentity, workspacePath) =>
          harness.port.ensureWorkspace(workspaceIdentity, workspacePath),
        ownerId: (workspaceIdentity) =>
          controlPlaneOwnerId(harness.serverRoot, workspaceIdentity),
        now: () => Date.now(),
      });
      try {
        const now = Date.now();
        const automation = await createDueAutomation(harness.repo, now, WORKSPACE, "session-integration-target");

        await scheduler.tick(now);

        expect(readRunning(harness.dbPath, automation.automationId)).toBe(0);
        expect(readPendingRows(harness.dbPath)).toHaveLength(0);
        expect(readAuditRows(harness.superAgentDbPath)).toHaveLength(0);
      } finally {
        await scheduler.stop();
        await harness.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not claim when the child socket is unreachable (fail-closed)",
    async () => {
      const harness = await startHarness();
      const writer = createPendingDispatchWriter({ databasePath: harness.dbPath });
      const scheduler = createDaemonScheduler({
        repo: harness.repo,
        leases: { list: () => harness.port.listLeases() },
        auditor: createSuperAgentControlPlaneScheduleAuditor(harness.port.port),
        dispatch: writer,
        ensureWorkspace: (workspaceIdentity, workspacePath) =>
          harness.port.ensureWorkspace(workspaceIdentity, workspacePath),
        ownerId: (workspaceIdentity) =>
          controlPlaneOwnerId(harness.serverRoot, workspaceIdentity),
        now: () => Date.now(),
      });
      try {
        const now = Date.now();
        const automation = await createDueAutomation(harness.repo, now, WORKSPACE, "session-integration-target");

        // 先观察成功 claim，再停 child，证明不可达时不会 claim。
        await scheduler.tick(now);
        expect(readRunning(harness.dbPath, automation.automationId)).toBe(1);

        // 新 workspace + 同代际：ensure 无 leader 缓存，真实走到 child 不可达的 RPC 失败路径。
        const second = await createDueAutomation(
          harness.repo,
          Date.now(),
          "ws-scheduler-integration-unreachable",
        );
        await harness.stop();
        await scheduler.tick(Date.now());
        expect(readRunning(harness.dbPath, second.automationId)).toBe(0);
      } finally {
        await scheduler.stop();
        await harness.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "pushes a real pending row through the child bridge and settles the run on a real host.command ACK",
    async () => {
      let scheduler: ReturnType<typeof createDaemonScheduler> | undefined;
      const harness = await startHarness({
        onInboundRequest: async (method, params) => {
          if (method !== "host.command") {
            return handleSuperAgentControlPlaneInboundRequest(method, params);
          }
          const parsed = hostCommandParamsSchema.parse(params);
          if (!scheduler) throw new Error("scheduler not initialized");
          // Core 生产装配（core.ts）在 host.command 回执处回灌 scheduler：
          // Core host.command 处理 → settleHostCommand → 返回 ACK 给 child。
          await scheduler.settleHostCommand({
            commandId: parsed.commandId,
            status: "accepted",
            sessionId: parsed.sessionId ?? "",
          });
          return {
            commandId: parsed.commandId,
            status: "accepted",
            revisionAtDecision: 0,
            result: {
              type: "inputAccepted",
              inputId: "input-integration-1",
              delivery: "queue",
            },
          };
        },
      });
      const writer = createPendingDispatchWriter({ databasePath: harness.dbPath });
      const daemon = createDaemonScheduler({
        repo: harness.repo,
        leases: { list: () => harness.port.listLeases() },
        auditor: createSuperAgentControlPlaneScheduleAuditor(harness.port.port),
        dispatch: writer,
        ensureWorkspace: (workspaceIdentity, workspacePath) =>
          harness.port.ensureWorkspace(workspaceIdentity, workspacePath),
        ownerId: (workspaceIdentity) =>
          controlPlaneOwnerId(harness.serverRoot, workspaceIdentity),
        now: () => Date.now(),
      });
      scheduler = daemon;
      try {
        const now = Date.now();
        const automation = await createDueAutomation(
          harness.repo,
          now,
          WORKSPACE,
          "session-integration-target",
        );
        await daemon.tick(now);
        const runId = `${automation.automationId}:${automation.nextRunAt}`;
        expect(readPendingRows(harness.dbPath)).toMatchObject([
          { run_id: runId, status: "pending_dispatch" },
        ]);

        // 真 child 的派发桥每 20s 一轮：等 pushed→ACK→dispatched 收敛。
        // 之后再断言 run 台账（Core 侧）已被 ACK 结算、single-flight 释放。
        await waitFor(
          () => {
            const rows = readPendingRows(harness.dbPath);
            return rows.length === 1 && rows[0]?.status === "dispatched";
          },
          40_000,
          "child bridge dispatch ACK",
          () =>
            `rows=${JSON.stringify(readPendingRows(harness.dbPath))}; run=${JSON.stringify(
              readRun(harness.dbPath, runId),
            )}; childStderr=${childStderr.get(harness.child) ?? ""}`,
        );
        expect(readRun(harness.dbPath, runId)).toMatchObject({
          dispatch_status: "dispatched",
          session_id: "session-integration-target",
        });
        expect(readRunning(harness.dbPath, automation.automationId)).toBe(0);
      } finally {
        await daemon.stop();
        await harness.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
