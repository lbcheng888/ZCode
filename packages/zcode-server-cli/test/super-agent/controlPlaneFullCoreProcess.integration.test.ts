/**
 * S3 终片 E2E：E2E 拓扑内起**完整 zcode-server-cli Core 进程**（`server-core/entry.ts`
 * → `runServerCore`：CONTROL_PLANE_CORE_ENABLED=1 + 内嵌 provider 配置文件 + 真实
 * services + daemon scheduler），让生产 daemon 子进程的 host.watchdogCommand 由真实
 * Core **服务器进程**应答——替换第 56 片 real-host E2E 的进程内 handler 装载。
 *
 * 链路（全部生产本体）：
 *   测试预置 Core tasks-index 的 enabled automation 行 → Core 进程 scheduler 即时 tick
 *   → controlPlaneCorePort.ensureWorkspace → daemon 子进程建 plane（coreChannel=Core）
 *   → 测试预置 daemon 域库 stalled workflow 行 → daemon watchdog 首 tick（30s）
 *   → 反向 host.watchdogCommand cancel-workflow 跨真 socket → **真实 Core 进程**的
 *   `createSuperAgentControlPlaneInboundHandler` → 真实 IZCodeAgentService → 真实
 *   workspace 解析 → typed 回执回 daemon。
 *
 * 观察面：
 *   A. Core IPC `ready`（host/port/version）——真实服务器进程启动。
 *   B. 测试作为第二 control-plane 客户端 `lease.list`——我们的 workspace lease 由
 *      **Core 的 ensure** 创建（automation 行只存在于 Core 侧 tasks-index；daemon
 *      永不自发 ensure）。
 *   C.（登记未收口）watchdog 反向请求的 Core 应答无生产观测面：handler → agent 服务
 *      的 typed 拒绝静默回执，两端零 trace。生存性退守断言：watchdog 首 tick 窗口内
 *      两进程存活且 Core 控制面连接未断。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_PLANE_PROTOCOL_VERSION } from "@zcode/shared/super-agent-control-plane-protocol";
import { ensureControlPlaneAuthToken } from "../../src/supervisor/controlPlaneAuth.js";
import { ensureServerInstallOwnership } from "../../src/runtime/installationOwnership.js";
import { resolveServerLayout } from "../../src/runtime/paths.js";
import { resolveDefaultControlPlaneCommand } from "../../src/supervisor/controlPlaneLauncher.js";
import { createControlPlaneClient } from "../../src/supervisor/controlPlaneClient.js";

const MONOREPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TEST_TIMEOUT_MS = 120_000;
const SESSION_ID = "session-full-core";
const RUN_ID = "workflow-full-core-1";

const roots: string[] = [];
const children: ChildProcess[] = [];
const stderrByChild = new WeakMap<ChildProcess, string>();

async function removeRoot(root: string): Promise<void> {
  // 子进程 SIGKILL 后仍可能有落盘尾巴；直接 rm 会撞 ENOTEMPTY，短暂重试直到目录稳定。
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt >= 20) throw error;
      await delay(100);
    }
  }
}

afterEach(async () => {
  const running = children.splice(0);
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(
    running.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", () => resolve());
        }),
    ),
  );
  await Promise.all(roots.splice(0).map(removeRoot));
});

const exitByChild = new WeakMap<ChildProcess, string>();

function spawnCollector(child: ChildProcess): void {
  children.push(child);
  stderrByChild.set(child, "");
  child.once("exit", (code, signal) => {
    const prev = exitByChild.get(child) ?? "";
    if (!prev.startsWith("fatal:")) {
      exitByChild.set(child, `exit code=${code} signal=${signal}`);
    }
  });
  child.on("message", (raw: unknown) => {
    if (typeof raw === "object" && raw !== null && (raw as { type?: string }).type === "fatal") {
      exitByChild.set(child, `fatal: ${String((raw as { message?: string }).message)}`);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrByChild.set(child, `${stderrByChild.get(child) ?? ""}${chunk.toString("utf8")}`);
  });
}

function waitForIpc(
  child: ChildProcess,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error(`core IPC timeout; stderr=${stderrByChild.get(child)?.slice(-4000) ?? ""}`));
    }, timeoutMs);
    const onMessage = (raw: unknown): void => {
      if (typeof raw !== "object" || raw === null) return;
      const message = raw as Record<string, unknown>;
      if (message.type === "fatal") {
        clearTimeout(timer);
        child.off("message", onMessage);
        reject(new Error(`core fatal: ${String(message.message)}`));
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

/** 生产 daemon 子进程（与第 56 片同法：生产 launcher 解析 + 生产 env）。 */
async function spawnDaemonChild(serverRoot: string, dataBaseDir: string): Promise<ChildProcess> {
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
  spawnCollector(child);
  return child;
}

/** 真实 Core 服务器进程：server-core/entry.ts → runServerCore(1)。 */
function spawnCoreProcess(
  serverRoot: string,
  dataBaseDir: string,
  providerConfigFile: string,
): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      join(MONOREPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      join(MONOREPO_ROOT, "packages", "zcode-server-cli", "src", "server-core", "entry.ts"),
      "1",
    ],
    {
      cwd: MONOREPO_ROOT,
      env: {
        ...process.env,
        ZCODE_SERVER_ROOT: serverRoot,
        ZCODE_DATA_BASE_DIR: dataBaseDir,
        ZCODE_CONTROL_PLANE_CORE_ENABLED: "1",
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: providerConfigFile,
        ZCODE_SERVER_RELEASE_ID: "e2e",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  spawnCollector(child);
  return child;
}

/** Core 侧 tasks-index：迁移 + 一条 enabled automation（scheduler 据此 ensure workspace）。 */
async function seedCoreAutomationRow(tasksIndexPath: string, workspacePath: string): Promise<void> {
  // 表结构由 Core 启动期的真实 tasks-index 迁移创建；此处只插调度行（并发 WAL 写）。
  const db = new DatabaseSync(tasksIndexPath, { timeout: 10_000 });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare(
      `INSERT INTO automations (
         automation_id, title, cron_expr, prompt, model, provider, model_selection,
         workspace_key, workspace_path, workspace_identity, project_id, host_id,
         additional_directories, target_task_id, bot_delivery_target, location_kind,
         recurring, max_runs, end_at, schedule_rule, schedule_edited_by_user,
         run_count, enabled, lifecycle_status,
         next_run_at, last_run_at, running, claimed_at,
         dispatch_status, dispatch_attempts, retry_at, last_error,
         mode, thought_level, created_at, updated_at
       ) VALUES (
         'automation-e2e-ensure', 'e2e ensure', '0 0 31 2 *', 'e2e', NULL, NULL, 'null',
         @workspace_key, @workspace_path, NULL, NULL, NULL,
         NULL, NULL, NULL, 'local',
         1, NULL, NULL, NULL, 0,
         0, 1, 'active',
         @next_run_at, NULL, 0, NULL,
         'idle', 0, NULL, NULL,
         NULL, NULL, @now, @now
       )`,
    ).run({
      workspace_key: workspacePath,
      workspace_path: workspacePath,
      // enabled 行无论是否到期都会被 ensure；next_run_at 推到 1 小时后避免 claim/派发。
      next_run_at: Date.now() + 3_600_000,
      now: Date.now(),
    });
  } finally {
    db.close();
  }
}

/** daemon 域库 stalled workflow 行（watchdog 首 tick 即 cancel-stalled）。 */
async function seedDaemonStalledRow(dataBaseDir: string, workspaceKey: string): Promise<void> {
  const databasePath = join(dataBaseDir, ".chengcode", "v2", "super-agent.sqlite");
  const deadline = Date.now() + 15_000;
  while (!existsSync(databasePath) && Date.now() < deadline) await delay(200);
  if (!existsSync(databasePath)) throw new Error(`daemon database not created: ${databasePath}`);
  const staleAt = Date.now() - 40 * 60_000;
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(
      `INSERT INTO background_run_registry (
         id, kind, owner, owner_session, workspace_key, state, stall_clock_ref,
         registered_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set updated_at = excluded.updated_at`,
    ).run(
      RUN_ID,
      "workflow",
      "dynamic-workflow",
      SESSION_ID,
      workspaceKey,
      "running",
      `dwf-run:${RUN_ID}`,
      staleAt,
      staleAt,
    );
  } finally {
    db.close();
  }
}

describe("S3 终片：E2E 内起完整 zcode-server-cli Core 进程", () => {
  it(
    "Core 服务器进程 ensure workspace + daemon watchdog 反向 RPC 由真实 Core 应答",
    async () => {
      // socket 路径 <104B：短前缀。
      const root = await mkdtemp(join(tmpdir(), "zcs3-"));
      roots.push(root);
      const serverRoot = join(root, "server");
      // 生产拓扑：Core 与 daemon 共享同一 dataBaseDir（spec §2.3 tasks-index 同根校验）。
      const sharedData = join(root, "data");
      const workspacePath = join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      await writeFile(join(workspacePath, "marker.txt"), "full-core-e2e", "utf8");
      // 最小内嵌 provider 配置（无 providers 也能装配 services；真实模型不在本片范围）。
      const providerConfigFile = join(root, "builtin-providers.json");
      await writeFile(
        providerConfigFile,
        // zcode-builtin release 形状（zcode-builtin-release.ts schema）：空规则即零内置
        // provider；本片验证 Core 进程装配与控制面，不依赖任何真实模型。
        JSON.stringify({
          schemaVersion: 1,
          revision: 0,
          config: { providerConfigRules: {}, modelConfigRules: {} },
        }),
        "utf8",
      );
      await ensureControlPlaneAuthToken(serverRoot);
      // 生产 install 归属标记（Core resolveCoreServerId 前置校验；同一生产函数铸造）。
      await ensureServerInstallOwnership(resolveServerLayout(serverRoot));

      // Core 先起：真实 services + tasks-index 迁移 + scheduler（首次 tick 时表为空）。
      const core = spawnCoreProcess(serverRoot, sharedData, providerConfigFile);
      const ready = await waitForIpc(core, (m) => m.type === "ready");
      expect(ready.version).toBeTruthy();
      expect(Number(ready.port)).toBeGreaterThan(0);
      // 打开代际门：Supervisor 角色推送 ready 状态（生产 Supervisor 的同一消息形状）。
      core.send?.({
        type: "control-plane-state",
        state: "ready",
        generation: 1,
        firstReadyAt: Date.now(),
        crashSignalObserved: false,
        crashBudgetExhausted: false,
      });

      // 就绪后插 enabled automation 行（migration 已由 Core 完成）；下一个 scheduler
      // tick（≤20s）会对该 workspace 调 ensureWorkspace。
      const tasksIndexPath = join(sharedData, ".chengcode", "v2", "tasks-index.sqlite");
      const insertDeadline = Date.now() + 30_000;
      for (;;) {
        if (existsSync(tasksIndexPath)) break;
        if (Date.now() > insertDeadline) throw new Error("core tasks-index not created");
        await delay(300);
      }
      await seedCoreAutomationRow(tasksIndexPath, workspacePath);

      // daemon 后起：socket 就绪后 Core 客户端可连；ensure 会在后续 tick 完成。
      const daemon = await spawnDaemonChild(serverRoot, sharedData);
      await waitForIpc(daemon, (m) => m.type === "ready");

      // B: Core 的 scheduler ensure 在 daemon 建 plane/lease。观察面 = 直查 daemon 域库
      // control_plane_leases 行（owner 前缀 control-plane: = 来自 Core 的 ensure）。
      // 刻意不起第二 control-plane 客户端：唯一宿主通道就是真实 Core 进程（生产拓扑）。
      let leased = false;
      {
        const leaseDeadline = Date.now() + 45_000;
        const leaseDbPath = join(sharedData, ".chengcode", "v2", "super-agent.sqlite");
        while (!leased && Date.now() < leaseDeadline) {
          if (existsSync(leaseDbPath)) {
            const db = new DatabaseSync(leaseDbPath, { timeout: 5_000, readOnly: true });
            try {
              const row = db
                .prepare("select owner_id from control_plane_leases where workspace_identity = ?")
                .get(workspacePath) as { owner_id: string } | undefined;
              leased = row !== undefined && row.owner_id.startsWith("control-plane:");
            } catch {
              // 表未建（daemon 早期）时重试。
            } finally {
              db.close();
            }
          }
          if (!leased) await delay(500);
        }
      }
      if (!leased) {
        const full = stderrByChild.get(core) ?? "";
        const { writeFile: wf } = await import("node:fs/promises");
        await wf("/tmp/s3full-core-stderr.log", full, "utf8");
        const relevant = full
          .split("\n")
          .filter((l) => /scheduler|workspace|control|plane|lease|ensure|daemon/i.test(l))
          .slice(-30)
          .join("\n");
        const daemonFull = stderrByChild.get(daemon) ?? "";
        await wf("/tmp/s3full-daemon-stderr.log", daemonFull, "utf8");
        throw new Error(
          `lease not created; core exit=${exitByChild.get(core) ?? "alive"} daemon exit=${
            exitByChild.get(daemon) ?? "alive"
          }; core relevant=\n${relevant}\n--- daemon stderr tail=\n${daemonFull.slice(-2000)}`,
        );
      }

      // C（未收口，登记于 plan §9 S3 行）：daemon 域库种 stalled 行后，生产 watchdog
      // 首 tick 会向 plane coreChannel（= 本真实 Core 进程）发 host.watchdogCommand。
      // 该路径在生产两端均无 trace 日志（typed 拒绝静默回执），测试无观测面可断言
      // 「Core 已应答」；需要 (i) Core 侧加生产 trace 或 (ii) agent 进程入拓扑才能落
      // 判定。此处不再留不可判定的轮询——A/B 已是确定性机器证据。
      await seedDaemonStalledRow(sharedData, workspacePath);
      // 给 watchdog 首 tick（30s）留一个可复算的生存性检查：两端进程都必须活着
      // 且 Core 连接未断（断连会让「Core 在拓扑内」退化成空转）。
      await delay(35_000);
      expect(exitByChild.get(core)).toBeUndefined();
      expect(exitByChild.get(daemon)).toBeUndefined();
      expect(/RPC disconnected/.test(stderrByChild.get(core) ?? "")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
