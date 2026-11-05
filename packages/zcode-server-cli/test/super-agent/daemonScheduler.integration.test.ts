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
  createSuperAgentControlPlaneScheduleAuditor,
} from "@zcode/services/node";
import type { ZCodeAutomation } from "@zcode/shared";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  controlPlaneOwnerId,
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

async function startHarness(): Promise<Harness> {
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
    onInboundRequest: handleSuperAgentControlPlaneInboundRequest,
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
): Promise<ZCodeAutomation> {
  return await repo.create(
    {
      title: "scheduler integration",
      cronExpr: "* * * * *",
      prompt: "integration prompt",
      workspacePath: `/tmp/zcode-${workspaceIdentity}-workspace`,
      workspaceIdentity,
      recurring: true,
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
        const automation = await createDueAutomation(harness.repo, now);

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
        const second = await createDueAutomation(harness.repo, now);
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
        const automation = await createDueAutomation(harness.repo, now);

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
        const automation = await createDueAutomation(harness.repo, now);

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
});
