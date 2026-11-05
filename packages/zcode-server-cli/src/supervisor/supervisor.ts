import type { SourceServerRunningTask } from "@zcode/shared";
/* oxlint-disable eslint(max-lines) -- Supervisor 集中维护生命周期、Core 代际和更新回滚状态机，启动恢复锁边界修复不应拆散其原子流程。 */

import { type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServiceLogger } from "@zcode/services/node";
import { SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE } from "@zcode/shared";
import {
  CONTROL_PLANE_KILL_TIMEOUT_MS,
  CONTROL_PLANE_PROTOCOL_VERSION,
  CONTROL_PLANE_READY_TIMEOUT_MS,
  CONTROL_PLANE_STOP_GRACE_TIMEOUT_MS,
  CORE_KILL_TIMEOUT_MS,
  CORE_READY_TIMEOUT_MS,
  CORE_STOP_GRACE_TIMEOUT_MS,
  controlPlaneHealthFieldsSchema,
  controlPlaneMessageSchema,
  controlPlaneStatusSchema,
  coreMessageSchema,
  SERVER_CLI_PROTOCOL_VERSION,
  type ControlPlaneState,
  type ControlPlaneStatus,
  type ControlRequest,
  type LifecycleState,
  type ReleaseManifest,
  type RuntimeIdentity,
  type ServerStatus,
} from "../contracts.js";
import type { ControlPlaneLauncher } from "./controlPlaneLauncher.js";
import { createControlServer, type ControlHandler } from "../ipc/controlServer.js";
import { ControlRequestError } from "../ipc/controlError.js";
import { DataRootLock } from "../runtime/lock.js";
import { resolveServerLayout, type ServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { createStatusPersister } from "../runtime/statusSnapshot.js";
import { recoverSupervisorStartup } from "../runtime/startupRecovery.js";
import { waitForUpdateReady } from "../runtime/updateReadiness.js";
import { createRollbackFailure, updateErrorMessage } from "../runtime/updateErrors.js";
import { CrashBudget } from "./crashBudget.js";
import { ensureControlPlaneAuthToken, removeControlPlaneAuthToken } from "./controlPlaneAuth.js";

// 生命周期事件按运维排障判据用 info/warn/error（出问题时运维要能在日志里看到）；
// 高频 heartbeat/task-activity 明细走 debug，避免生产日志膨胀。
const log = createServiceLogger("server-supervisor");

export interface CoreLauncher {
  launch(generation: number, release?: ReleaseManifest | null): ChildProcess;
}

/**
 * 受管 control-plane 子进程配置。缺省（undefined）= feature flag 关闭，不创建任何子进程。
 * launcher、崩溃预算与 ready/停止预算都与 Core 独立，control-plane 崩溃不得拖垮 Core。
 */
export interface ControlPlaneOptions {
  launcher: ControlPlaneLauncher;
  readyTimeoutMs?: number;
  stopGraceTimeoutMs?: number;
  killTimeoutMs?: number;
  /** 独立崩溃预算；测试注入短退避，生产缺省沿用 Server CLI 预算。 */
  crashBackoffMs?: readonly number[];
  crashWindowMs?: number;
  /** §2.3 启动方投影给 child 的 flag（child 只读 mandateGate，缺省 false）。 */
  mandateGate?: boolean;
  now?: () => number;
}

export interface SupervisorOptions {
  layout?: ServerLayout;
  launcher: CoreLauncher;
  controlPlane?: ControlPlaneOptions;
  version: string;
  /** 当前 Supervisor bundle 所属 immutable release；开发态入口允许缺失。 */
  supervisorReleaseId?: string;
  serviceRegistered?: boolean;
  /** 测试和诊断可缩短 ready 等待；生产默认使用 CORE_READY_TIMEOUT_MS。 */
  coreReadyTimeoutMs?: number;
  /** 测试可缩短 Core 优雅退出和强杀后的终态等待；生产默认使用 contracts 中的停止预算。 */
  coreStopGraceTimeoutMs?: number;
  coreKillTimeoutMs?: number;
  now?: () => number;
  onStopped?: () => void;
}

type LifecycleOperationKind = "stop" | "restart" | "update" | "uninstall";

export class Supervisor {
  private readonly layout: ServerLayout;
  private readonly lock: DataRootLock;
  private readonly crashBudget: CrashBudget;
  private readonly releaseManager: ReleaseManager;
  private core: ChildProcess | undefined;
  private readonly controlPlaneCrashBudget: CrashBudget | undefined;
  private controlPlane: ChildProcess | undefined;
  private controlPlaneState: ControlPlaneState = "stopped";
  private controlPlaneGeneration = 0;
  private controlPlaneStartedAt: number | null = null;
  // 本 Supervisor 生命周期（= daemon 代际）内首次 ready；child 重启只是新 generation，
  // 不会清零。它是「本代际曾 ready」的持久证据，供 §3.6 状态判断与排障。
  private controlPlaneFirstReadyAt: number | null = null;
  private controlPlaneLastExitReason: string | null = null;
  private controlPlaneHealth: ControlPlaneStatus["health"] = null;
  private controlPlaneReadyTimer: NodeJS.Timeout | undefined;
  private controlPlaneKillTimer: NodeJS.Timeout | undefined;
  private controlPlaneRestartTimer: NodeJS.Timeout | undefined;
  private control: Awaited<ReturnType<typeof createControlServer>> | undefined;
  private state: LifecycleState = "stopped";
  private generation = 0;
  private host: string | null = null;
  private port: number | null = null;
  private startedAt: number | null = null;
  private runningTaskCount = 0;
  private runningTasks: SourceServerRunningTask[] | undefined;
  private lastExitReason: string | null = null;
  private readonly persistStatusSnapshot: () => Promise<void>;
  private lifecycleOperation:
    | { kind: LifecycleOperationKind; promise: Promise<unknown> }
    | undefined;
  private activeRelease: ReleaseManifest | null = null;
  private coreVersion: string | undefined;
  private coreReleaseId: string | undefined;

  public constructor(private readonly options: SupervisorOptions) {
    this.layout = options.layout ?? resolveServerLayout();
    this.lock = new DataRootLock(this.layout.lockFile);
    this.crashBudget = new CrashBudget({ now: options.now });
    this.controlPlaneCrashBudget = options.controlPlane
      ? new CrashBudget({
          now: options.controlPlane.now ?? options.now,
          ...(options.controlPlane.crashBackoffMs
            ? { backoffMs: options.controlPlane.crashBackoffMs }
            : {}),
          ...(options.controlPlane.crashWindowMs !== undefined
            ? { windowMs: options.controlPlane.crashWindowMs }
            : {}),
        })
      : undefined;
    this.releaseManager = new ReleaseManager(this.layout);
    this.persistStatusSnapshot = createStatusPersister(
      this.layout.statusFile,
      () => this.status(),
      (error) => log.warn("failed to persist status snapshot", error),
    );
  }

  public async start(): Promise<ServerStatus> {
    if (this.state === "ready" || this.state === "starting") return this.status();
    await this.releaseManager.ensure();
    await this.lock.acquire();
    try {
      // 启动恢复会回写 current.json 并删除 update-transaction.json，必须先取得
      // data-root 单实例锁；否则存活 Supervisor 的 apply-update 会与第二个启动者竞态，
      // 造成内存继续运行新 release、磁盘 current pointer 却被回滚到旧 release。
      await recoverSupervisorStartup(
        this.releaseManager,
        this.layout.uninstalledFile,
        this.layout.serverRoot,
        async (error) => {
          this.state = "stop-failed";
          this.lastExitReason = `update rollback recovery failed: ${updateErrorMessage(error)}`;
          await this.persistStatusSnapshot();
        },
      );
      // recovery 可能已经恢复 current pointer；必须在恢复后读取，避免启动已回滚的 candidate。
      this.activeRelease = await this.releaseManager.readCurrentForExecution();
      await mkdir(this.layout.runDir, { recursive: true, mode: 0o700 });
      if (this.options.controlPlane) {
        // §3.8 显式凭据握手：Core 与 child 都需要在 spawn 前读到同一份 0600 凭据。
        await ensureControlPlaneAuthToken(this.layout.serverRoot);
      }
      const handler: ControlHandler = (request) => this.handleControl(request);
      this.control = await createControlServer(this.layout.controlEndpoint, handler);
      this.state = "starting";
      log.info("supervisor started", {
        serverRoot: this.layout.serverRoot,
        version: this.options.version,
      });
      this.launchCore();
      try {
        this.launchControlPlane();
      } catch (error) {
        // B-A14：门禁开但入口不可解析时启动必须响亮失败；先落 lastExitReason，
        // 让 detached `serve --daemon`（stdio=ignore）也能从持久化快照看到根因。
        this.recordControlPlaneLaunchFailure(error);
        await this.persistStatusSnapshot();
        throw error;
      }
      await this.persistStatusSnapshot();
      return this.status();
    } catch (error) {
      // 只在 recovery 失败时释放锁是不够的：mkdir、control server、Core 启动或
      // 初始状态落盘失败会留下锁（以及可能已启动的 Core），同一 Supervisor 重试会把
      // 自己识别成另一个实例。启动临界区必须在确认 Core/control 都收口后才释放锁。
      const recoveryFailed = this.state === "stop-failed";
      // control-plane launcher 同步抛错时，stopCore 会用 "startup-failed" 覆盖
      // lastExitReason；先保存在内存，收口后再恢复成真正根因（B-A14）。
      const controlPlaneLaunchFailure =
        this.controlPlaneState === "crashed" || this.controlPlaneState === "crash-loop-stopped"
          ? (this.controlPlaneLastExitReason ?? this.lastExitReason)
          : undefined;
      let coreStopped = this.core === undefined;
      if (this.core) {
        try {
          await this.stopCore("startup-failed");
          coreStopped = true;
        } catch (stopError) {
          log.error("failed to stop Core after supervisor startup failure", stopError);
        }
      }

      let controlClosed = this.control === undefined;
      if (this.control) {
        try {
          await this.control.close();
          this.control = undefined;
          controlClosed = true;
        } catch (closeError) {
          log.error("failed to close control server after supervisor startup failure", closeError);
        }
      }

      let controlPlaneStopped = true;
      if (this.options.controlPlane) {
        try {
          await this.stopControlPlane("startup-failed");
        } catch (controlPlaneError) {
          controlPlaneStopped = false;
          log.error(
            "failed to stop control plane after supervisor startup failure",
            controlPlaneError,
          );
        }
      }

      if (controlPlaneLaunchFailure) this.lastExitReason = controlPlaneLaunchFailure;
      if (coreStopped && controlClosed && controlPlaneStopped) {
        // 恢复失败本身已经写入 stop-failed；即使没有 Core/control 需要收口，也保留该
        // 状态，让 status 继续暴露待人工处理的事务，同时释放锁允许同实例稍后重试。
        this.state = recoveryFailed ? "stop-failed" : "stopped";
        await this.persistStatusSnapshot().catch((snapshotError) => {
          log.warn(
            "failed to persist stopped state after supervisor startup failure",
            snapshotError,
          );
        });
        await this.lock.release();
      } else {
        this.state = "stop-failed";
        await this.persistStatusSnapshot().catch((snapshotError) => {
          log.warn(
            "failed to persist stop-failed state after supervisor startup failure",
            snapshotError,
          );
        });
      }
      throw error;
    }
  }

  public async stop(reason = "requested"): Promise<ServerStatus> {
    return await this.runLifecycleOperation("stop", () => this.stopInternal(reason));
  }

  private async stopInternal(reason: string): Promise<ServerStatus> {
    // Core 与 control-plane 是两个独立受管子进程：任一停止失败都必须保留锁并进入
    // stop-failed，但不能因此跳过另一个子进程的收口。
    let stopError: unknown;
    if (this.core) {
      try {
        await this.stopCore(reason);
      } catch (error) {
        stopError = error;
      }
    }
    if (this.options.controlPlane) {
      try {
        await this.stopControlPlane(reason);
      } catch (error) {
        stopError ??= error;
        if (this.state !== "stop-failed") {
          this.state = "stop-failed";
          this.lastExitReason = error instanceof Error ? error.message : String(error);
          await this.persistStatusSnapshot();
        }
      }
    }
    if (stopError) throw stopError;
    this.state = "stopped";
    await this.persistStatusSnapshot();
    await this.control?.close();
    this.control = undefined;
    if (this.options.controlPlane) {
      // 凭据文件是 daemon 代际资产；收口后删除，下一 daemon 启动重新铸造。
      await removeControlPlaneAuthToken(this.layout.serverRoot).catch((error: unknown) => {
        log.warn("failed to remove control plane auth token", error);
      });
    }
    await this.lock.release();
    log.info("supervisor stopped", { reason });
    if (reason !== "restart") this.options.onStopped?.();
    return this.status();
  }

  public async restart(): Promise<ServerStatus> {
    return await this.runLifecycleOperation("restart", async () => {
      await this.stopInternal("restart");
      return await this.start();
    });
  }

  private async stopCore(reason: string): Promise<void> {
    if (!this.core) return;
    this.state = "stopping";
    this.lastExitReason = reason;
    log.info("stopping server core", { reason, pid: this.core.pid });
    const core = this.core;
    try {
      await new Promise<void>((resolve, reject) => {
        // 发出 SIGKILL 后不能最多等两秒便无条件返回：未观察到子进程终态
        // 也会释放 data-root lock，随后可启动第二个 Core。只有 exit/close 能证明进程
        // 已收口；强杀后仍无终态必须失败并保留 Core 引用和锁。
        let killTimer: NodeJS.Timeout | undefined;
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(graceTimer);
          if (killTimer) clearTimeout(killTimer);
          core.off("exit", finish);
          core.off("close", finish);
          core.off("error", handleError);
        };
        const finish = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new Error(`Server Core pid ${core.pid ?? "unknown"} did not terminate after SIGKILL`),
          );
        };
        const handleError = (error: Error): void => {
          log.warn("server core emitted an error while stopping; awaiting exit or close", error);
        };
        const forceKill = (): void => {
          log.warn("server core did not exit within grace period, sending SIGKILL", {
            pid: core.pid,
          });
          core.kill("SIGKILL");
          if (!settled) {
            killTimer = setTimeout(fail, this.options.coreKillTimeoutMs ?? CORE_KILL_TIMEOUT_MS);
          }
        };
        const graceTimer = setTimeout(() => {
          forceKill();
        }, this.options.coreStopGraceTimeoutMs ?? CORE_STOP_GRACE_TIMEOUT_MS);
        core.once("exit", finish);
        core.once("close", finish);
        core.once("error", handleError);
        try {
          core.send({ command: "shutdown" });
        } catch {
          // IPC 已关闭不代表 OS 进程已退出，直接强杀后仍等待 exit/close 终态。
          clearTimeout(graceTimer);
          forceKill();
        }
      });
    } catch (error) {
      if (this.core === core) {
        this.state = "stop-failed";
        this.lastExitReason = error instanceof Error ? error.message : String(error);
        await this.persistStatusSnapshot();
      }
      throw error;
    }
    if (this.core === core) {
      this.core = undefined;
      this.clearCoreScopedStatus();
    }
  }

  private async stopControlPlane(reason: string): Promise<void> {
    this.clearControlPlaneRestartTimer();
    this.clearControlPlaneKillTimer();
    if (!this.controlPlane) {
      this.controlPlaneState = "stopped";
      this.clearControlPlaneScopedStatus();
      return;
    }
    this.controlPlaneState = "stopping";
    this.controlPlaneLastExitReason = reason;
    log.info("stopping super-agent control plane", { reason, pid: this.controlPlane.pid });
    const controlPlane = this.controlPlane;
    try {
      await new Promise<void>((resolve, reject) => {
        let killTimer: NodeJS.Timeout | undefined;
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(graceTimer);
          if (killTimer) clearTimeout(killTimer);
          controlPlane.off("exit", finish);
          controlPlane.off("close", finish);
          controlPlane.off("error", handleError);
        };
        const finish = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new Error(
              `Super-agent control plane pid ${controlPlane.pid ?? "unknown"} did not terminate after SIGKILL`,
            ),
          );
        };
        const handleError = (error: Error): void => {
          log.warn(
            "super-agent control plane emitted an error while stopping; awaiting exit or close",
            error,
          );
        };
        const forceKill = (): void => {
          log.warn("super-agent control plane did not exit within grace period, sending SIGKILL", {
            pid: controlPlane.pid,
          });
          controlPlane.kill("SIGKILL");
          if (!settled) {
            killTimer = setTimeout(
              fail,
              this.options.controlPlane?.killTimeoutMs ?? CONTROL_PLANE_KILL_TIMEOUT_MS,
            );
          }
        };
        const graceTimer = setTimeout(
          () => forceKill(),
          this.options.controlPlane?.stopGraceTimeoutMs ?? CONTROL_PLANE_STOP_GRACE_TIMEOUT_MS,
        );
        controlPlane.once("exit", finish);
        controlPlane.once("close", finish);
        controlPlane.once("error", handleError);
        try {
          controlPlane.send({ command: "shutdown" } satisfies { command: "shutdown" });
        } catch {
          // IPC 已关闭不代表 OS 进程已退出；直接强杀后仍等待 exit/close 终态。
          clearTimeout(graceTimer);
          forceKill();
        }
      });
    } catch (error) {
      if (this.controlPlane === controlPlane) {
        this.controlPlaneState = "stop-failed";
        this.controlPlaneLastExitReason = error instanceof Error ? error.message : String(error);
        this.state = "stop-failed";
        this.lastExitReason = this.controlPlaneLastExitReason;
        await this.persistStatusSnapshot();
      }
      throw error;
    }
    this.clearControlPlaneReadyTimer();
    if (this.controlPlane === controlPlane) {
      this.controlPlane = undefined;
      this.controlPlaneState = "stopped";
      this.clearControlPlaneScopedStatus();
    }
  }

  private async applyUpdate(force: boolean): Promise<unknown> {
    const pending = await this.releaseManager.readPending();
    if (!pending) throw new Error("No pending release is prepared");
    if (this.runningTaskCount > 0 && !force) {
      throw new ControlRequestError(
        SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
        "Running tasks require --force for update",
        false,
      );
    }
    const previous = await this.releaseManager.readCurrent();
    log.info("applying pending release", { version: pending.version, force });
    await this.stopCore("update");
    await this.stopControlPlane("update");
    this.state = "updating";
    await this.persistStatusSnapshot();
    try {
      await this.releaseManager.applyPendingWithTransaction(previous);
      this.activeRelease = pending;
      this.state = "starting";
      this.launchCore();
      try {
        this.launchControlPlane();
      } catch (error) {
        this.recordControlPlaneLaunchFailure(error);
        await this.persistStatusSnapshot();
        throw error;
      }
      await waitForUpdateReady(
        () => this.state,
        this.options.coreReadyTimeoutMs ?? CORE_READY_TIMEOUT_MS,
      );
      await this.releaseManager.completeUpdate();
      log.info("release applied", { version: pending.version });
      return { applied: true, version: pending.version };
    } catch (error) {
      this.enterUpdateRollback();
      // 更新后的 Core 未 ready 时必须先停止仍存活的子进程，再恢复 current 指针。
      // 否则 timeout 路径会覆盖 this.core 引用后遗留新 Core，与回滚后的旧 Core 并存。
      if (this.core) {
        try {
          await this.stopCore("update-rollback");
        } catch (stopError) {
          log.error("failed to stop unhealthy release during rollback", stopError);
          await this.persistStatusSnapshot();
          throw stopError;
        }
      }
      // candidate control-plane 也属于坏 release：回滚前必须收口，否则随后拉起旧 release
      // control-plane 会与仍在运行的新 release 子进程并存（双 leader 租约竞争）。
      try {
        await this.stopControlPlane("update-rollback");
      } catch (stopError) {
        log.error("failed to stop unhealthy control plane during rollback", stopError);
        await this.persistStatusSnapshot();
        throw stopError;
      }
      // 恢复 current 指针，避免下一次启动继续使用坏 release。
      log.error("release apply failed, restoring previous current pointer", error);
      try {
        await this.releaseManager.restoreCurrent(previous);
        await this.releaseManager.completeUpdate();
      } catch (rollbackError: unknown) {
        this.state = "stop-failed";
        this.lastExitReason = `rollback pointer restore failed: ${updateErrorMessage(rollbackError)}`;
        await this.persistStatusSnapshot();
        throw createRollbackFailure(error, rollbackError);
      }
      this.activeRelease = previous;
      // 回滚不仅恢复 pointer，还要立即拉起旧 release；否则 daemon 会以 stopped 留在
      // 不可用状态，用户必须手工 restart 才能恢复服务。
      this.state = "stopped";
      if (previous) {
        this.state = "starting";
        this.launchCore();
        try {
          this.launchControlPlane();
        } catch (error) {
          this.recordControlPlaneLaunchFailure(error);
          await this.persistStatusSnapshot();
          throw error;
        }
        try {
          await waitForUpdateReady(
            () => this.state,
            this.options.coreReadyTimeoutMs ?? CORE_READY_TIMEOUT_MS,
          );
        } catch (rollbackError) {
          log.error("previous release rollback failed", rollbackError);
          // 旧 release ready 超时只改状态会让仍存活的 Core、PID 和 lock 与 stopped 脱节；复用 stopCore 等待 exit/close，失败则保持 stop-failed。
          if (this.core) await this.stopCore("update-rollback");
          await this.stopControlPlane("update-rollback").catch((stopError: unknown) => {
            log.error("failed to stop control plane after rollback ready timeout", stopError);
          });
          // stopControlPlane 失败已置 stop-failed；不能被 stopped 覆盖掉锁保护。
          if ((this.state as LifecycleState) !== "stop-failed") this.state = "stopped";
        }
      }
      await this.persistStatusSnapshot();
      throw error;
    }
  }

  public status(): ServerStatus {
    return {
      protocolVersion: SERVER_CLI_PROTOCOL_VERSION,
      state: this.state,
      pid: this.core?.pid ?? null,
      port: this.port,
      host: this.host,
      // status.version 保持 Core/current release 的兼容语义；Supervisor 自身版本与 release
      // 由独立 runtime-identity control 返回，避免向严格持久化 schema 增加字段击穿旧版回滚。
      version: this.activeRelease?.version ?? this.options.version,
      generation: this.generation,
      startedAt: this.startedAt,
      lastExitReason: this.lastExitReason,
      serviceRegistered: this.options.serviceRegistered ?? false,
      runningTaskCount: this.runningTaskCount,
      crashBudget: this.crashBudget.snapshot(),
      updatedAt: Date.now(),
    };
  }

  /**
   * control-plane 状态独立于 ServerStatus：ServerStatus 是已持久化的严格契约，
   * 向其中加字段会让旧版 Supervisor 回滚时解析新快照失败。flag 关闭时返回 null。
   */
  public controlPlaneStatus(): ControlPlaneStatus | null {
    if (!this.options.controlPlane) return null;
    return controlPlaneStatusSchema.parse({
      state: this.controlPlaneState,
      pid: this.controlPlane?.pid ?? null,
      generation: this.controlPlaneGeneration,
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      startedAt: this.controlPlaneStartedAt,
      firstReadyAt: this.controlPlaneFirstReadyAt,
      lastExitReason: this.controlPlaneLastExitReason,
      health: this.controlPlaneHealth,
      crashBudget:
        this.controlPlaneCrashBudget?.snapshot() ?? {
          crashCount: 0,
          nextRestartDelayMs: 0,
          exhausted: false,
        },
    });
  }

  private runtimeIdentity(): RuntimeIdentity {
    return {
      supervisorVersion: this.options.version,
      ...(this.options.supervisorReleaseId
        ? { supervisorReleaseId: this.options.supervisorReleaseId }
        : {}),
      ...(this.activeRelease?.version ? { activeReleaseVersion: this.activeRelease.version } : {}),
      ...(this.activeRelease?.releaseId ? { activeReleaseId: this.activeRelease.releaseId } : {}),
      ...(this.coreVersion ? { coreVersion: this.coreVersion } : {}),
      ...(this.coreReleaseId ? { coreReleaseId: this.coreReleaseId } : {}),
    };
  }

  private launchCore(): void {
    const generation = ++this.generation;
    const child = this.options.launcher.launch(generation, this.activeRelease);
    this.core = child;
    this.clearCoreScopedStatus();
    log.info("launching server core", { generation, pid: child.pid });
    child.on("message", (raw: unknown) => this.handleCoreMessage(child, generation, raw));
    let terminalObserved = false;
    let spawnErrorReason: string | undefined;
    const handleTerminal = (reason: string): void => {
      if (terminalObserved) return;
      terminalObserved = true;
      if (this.core !== child || this.state === "stopping" || this.state === "stopped") return;
      if (this.state === "stop-failed") {
        // stop 已失败时继续保留锁；迟到的终态只清除已死亡 child，不得计入 crash budget
        // 或启动替代 Core。用户重试 stop 后再释放 control socket 与 data-root lock。
        this.core = undefined;
        this.clearCoreScopedStatus();
        this.lastExitReason = reason;
        void this.persistStatusSnapshot();
        return;
      }
      this.core = undefined;
      this.clearCoreScopedStatus();
      this.state = "crashed";
      this.lastExitReason = reason;
      const decision = this.crashBudget.recordCrash();
      if (!decision.shouldRestart) {
        this.state = "crash-loop-stopped";
        log.error("server core crash budget exhausted, entering crash-loop-stopped", {
          lastExitReason: this.lastExitReason,
        });
        void this.persistStatusSnapshot();
        return;
      }
      log.warn("server core crashed, scheduling restart", {
        lastExitReason: this.lastExitReason,
        delayMs: decision.delayMs,
      });
      void this.persistStatusSnapshot();
      setTimeout(() => {
        if (this.state !== "crashed") return;
        this.state = "starting";
        this.launchCore();
      }, decision.delayMs).unref();
    };
    // fork 的 execPath 不存在/不可执行时 Node 只发 error + close，不发 exit。
    // error 与 exit 必须共用一次性终态，否则未处理的 error 会杀死 Supervisor，并让更新
    // 已写入的新 current pointer 绕过 catch/rollback。
    child.once("error", (error: Error & { code?: string }) => {
      spawnErrorReason = `core spawn error code=${error.code ?? "unknown"}: ${error.message}`;
      this.lastExitReason = spawnErrorReason;
      log.error("server core process error", error);
      void this.persistStatusSnapshot();
    });
    child.once("exit", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core exited code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
    child.once("close", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core closed code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
  }

  private handleCoreMessage(child: ChildProcess, expectedGeneration: number, raw: unknown): void {
    // 旧 child 的 message listener 会跨 generation 存活，延迟 heartbeat/ready
    // 可覆盖当前 Core 的状态。消息必须同时绑定当前 child；ready 还需匹配启动 generation。
    if (this.core !== child) return;
    const parsed = coreMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.type === "ready") {
      // ready 只对当前 starting 的 Core 有效；stopping/stopped/stop-failed 阶段的迟到消息
      // 不能复活已经收口或进入不确定终态的 Supervisor。
      if (message.generation !== expectedGeneration || this.state !== "starting") return;
      this.state = "ready";
      this.host = message.host;
      this.port = message.port;
      this.generation = message.generation;
      this.startedAt = Date.now();
      this.coreVersion = message.version;
      this.coreReleaseId = message.releaseId;
      log.info("server core ready", {
        host: this.host,
        port: this.port,
        generation: this.generation,
      });
    } else if (message.type === "heartbeat" || message.type === "task-activity") {
      this.runningTaskCount = message.runningTaskCount;
      this.runningTasks = message.runningTasks;
      log.debug("core activity snapshot", {
        type: message.type,
        runningTaskCount: message.runningTaskCount,
      });
    } else if (message.type === "fatal") {
      this.lastExitReason = message.message;
      log.error("server core reported fatal error", { message: message.message });
    } else if (message.type === "exit") {
      this.lastExitReason = message.reason;
      log.info("server core reported exit", { reason: message.reason });
    }
    void this.persistStatusSnapshot();
  }

  /**
   * 记录 launcher 同步抛错（入口不可解析/可执行文件消失）。launcher 抛错时没有 child，
   * 但状态必须进入 crashed 并写入一等原因，不能把根因丢成 unhandled exception。
   */
  private recordControlPlaneLaunchFailure(error: unknown): void {
    const reason = `control plane launch failed: ${error instanceof Error ? error.message : String(error)}`;
    this.controlPlaneState = "crashed";
    this.controlPlaneLastExitReason = reason;
    this.lastExitReason = reason;
    log.error("super-agent control plane launch failed", { reason });
  }

  /**
   * 崩溃后的重启定时器直接调用 launcher；默认 launcher 在入口不可解析时会同步抛错，
   * 异常发生在 setTimeout 回调里会变成 Supervisor 的 uncaughtException。这里把同步
   * 抛错收口成 crashed/crash-loop-stopped，并继续计入崩溃预算。
   */
  private scheduleControlPlaneRestart(delayMs: number): void {
    const restartTimer = setTimeout(() => {
      this.controlPlaneRestartTimer = undefined;
      if (this.controlPlaneState !== "crashed") return;
      this.controlPlaneState = "starting";
      try {
        this.launchControlPlane();
      } catch (error) {
        this.recordControlPlaneLaunchFailure(error);
        const decision = this.controlPlaneCrashBudget?.recordCrash() ?? {
          shouldRestart: false,
          delayMs: 0,
          exhausted: true,
        };
        if (!decision.shouldRestart) {
          this.controlPlaneState = "crash-loop-stopped";
          log.error("super-agent control plane crash budget exhausted after launch failure", {
            lastExitReason: this.controlPlaneLastExitReason,
          });
          void this.persistStatusSnapshot();
          return;
        }
        log.warn("super-agent control plane launch failed, scheduling restart", {
          lastExitReason: this.controlPlaneLastExitReason,
          delayMs: decision.delayMs,
        });
        void this.persistStatusSnapshot();
        this.scheduleControlPlaneRestart(decision.delayMs);
      }
    }, delayMs);
    restartTimer.unref();
    this.controlPlaneRestartTimer = restartTimer;
  }

  private launchControlPlane(): void {
    const options = this.options.controlPlane;
    if (!options) return;
    this.clearControlPlaneRestartTimer();
    this.clearControlPlaneReadyTimer();
    this.clearControlPlaneKillTimer();
    const generation = ++this.controlPlaneGeneration;
    const child = options.launcher.launch({
      generation,
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      dataBaseDir: this.layout.dataBaseDir,
      serverRoot: this.layout.serverRoot,
      release: this.activeRelease,
      mandateGate: options.mandateGate === true,
    });
    this.controlPlane = child;
    this.controlPlaneState = "starting";
    this.controlPlaneStartedAt = null;
    this.controlPlaneHealth = null;
    this.controlPlaneLastExitReason = null;
    log.info("launching super-agent control plane", { generation, pid: child.pid });

    // ready 门：只接受当前 child + 当前 generation + 同源协议的 ready；超时则强杀，
    // 由统一崩溃路径计数/重启，避免一个永远不 ready 的子进程被当成健康。
    const readyTimer = setTimeout(() => {
      if (this.controlPlane !== child || this.controlPlaneState !== "starting") return;
      log.error("super-agent control plane ready timeout", {
        pid: child.pid,
        generation,
      });
      this.killControlPlaneWithoutTerminal(
        child,
        `control plane pid ${child.pid ?? "unknown"} did not report ready within ${options.readyTimeoutMs ?? CONTROL_PLANE_READY_TIMEOUT_MS}ms`,
        generation,
      );
    }, options.readyTimeoutMs ?? CONTROL_PLANE_READY_TIMEOUT_MS);
    readyTimer.unref();
    this.controlPlaneReadyTimer = readyTimer;

    child.on("message", (raw: unknown) =>
      this.handleControlPlaneMessage(child, generation, raw),
    );
    let terminalObserved = false;
    let spawnErrorReason: string | undefined;
    const handleTerminal = (reason: string): void => {
      if (terminalObserved) return;
      terminalObserved = true;
      if (this.controlPlane !== child || this.controlPlaneState === "stopping") return;
      this.clearControlPlaneReadyTimer();
      this.clearControlPlaneKillTimer();
      this.controlPlane = undefined;
      this.clearControlPlaneScopedStatus();
      if (this.controlPlaneState === "stop-failed") {
        // SIGKILL 后 kill 预算内仍未观察到终态时已显式失败；迟到的 exit/close 只证明进程
        // 确实收口并清除引用，不得据此拉起替代进程（未观察终态前禁止重启）。
        this.controlPlaneLastExitReason = reason;
        return;
      }
      if (this.state === "stopping" || this.state === "stopped" || this.state === "stop-failed") {
        // Supervisor 正在收口/已处于不可恢复终态时不得再拉起替代进程；用户重试 stop 后再收口。
        this.controlPlaneState = "stopped";
        this.controlPlaneLastExitReason = reason;
        return;
      }
      this.controlPlaneState = "crashed";
      this.controlPlaneLastExitReason = reason;
      const decision = this.controlPlaneCrashBudget?.recordCrash() ?? {
        shouldRestart: false,
        delayMs: 0,
        exhausted: true,
      };
      if (!decision.shouldRestart) {
        this.controlPlaneState = "crash-loop-stopped";
        log.error("super-agent control plane crash budget exhausted", {
          lastExitReason: reason,
        });
        return;
      }
      log.warn("super-agent control plane crashed, scheduling restart", {
        lastExitReason: reason,
        delayMs: decision.delayMs,
      });
      this.scheduleControlPlaneRestart(decision.delayMs);
    };
    child.once("error", (error: Error & { code?: string }) => {
      spawnErrorReason = `control plane spawn error code=${error.code ?? "unknown"}: ${error.message}`;
      this.controlPlaneLastExitReason = spawnErrorReason;
      log.error("super-agent control plane process error", error);
    });
    // 终态原因优先级：spawn error > 本代际已记录的描述性原因（ready 超时 / 协议不匹配 /
    // fatal / stopped 上报）> 通用 exit/close 串。否则描述性原因会被退出串覆盖，
    // control-plane-status 只剩 code=… signal=…，与 §2.4「stopped 记录退出原因」不符。
    child.once("exit", (code, signal) => {
      handleTerminal(
        spawnErrorReason ??
          this.controlPlaneLastExitReason ??
          `control plane exited code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
    child.once("close", (code, signal) => {
      handleTerminal(
        spawnErrorReason ??
          this.controlPlaneLastExitReason ??
          `control plane closed code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
  }

  private handleControlPlaneMessage(
    child: ChildProcess,
    expectedGeneration: number,
    raw: unknown,
  ): void {
    if (this.controlPlane !== child) return;
    const parsed = controlPlaneMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "ready") {
      if (message.generation !== expectedGeneration) return;
      if (message.protocolVersion !== CONTROL_PLANE_PROTOCOL_VERSION) {
        log.error("super-agent control plane protocol mismatch", {
          expected: CONTROL_PLANE_PROTOCOL_VERSION,
          received: message.protocolVersion,
        });
        // 不兼容的子进程不能作为 ready 使用；强杀后走统一崩溃/重启预算。
        this.killControlPlaneWithoutTerminal(
          child,
          `control plane protocol mismatch: expected ${CONTROL_PLANE_PROTOCOL_VERSION}, got ${message.protocolVersion}`,
          expectedGeneration,
        );
        return;
      }
      if (this.controlPlaneState !== "starting") return;
      this.controlPlaneState = "ready";
      this.controlPlaneStartedAt = Date.now();
      this.controlPlaneFirstReadyAt ??= this.controlPlaneStartedAt;
      this.clearControlPlaneReadyTimer();
      log.info("super-agent control plane ready", {
        generation: message.generation,
        ...(message.version ? { version: message.version } : {}),
      });
    } else if (message.type === "health") {
      // 严格 schema 已在 shared 统一：B 期扩展字段（leader/pending/degraded/
      // workspaceErrors/peer/protocol 计数）原样进入 control-plane-status，不丢字段。
      const { type: _healthType, ...healthFields } = message;
      this.controlPlaneHealth = controlPlaneHealthFieldsSchema.parse(healthFields);
      log.debug("super-agent control plane health", healthFields);
    } else if (message.type === "fatal") {
      // child 已明确不可恢复（路径不一致 / 门禁开但 eventRouter 关 / socket bind 冲突）：
      // 先记录一等失败原因，再确保进程收口，由统一崩溃预算决定是否重启。
      log.error("super-agent control plane reported fatal error", {
        message: message.message,
        generation: expectedGeneration,
      });
      this.killControlPlaneWithoutTerminal(
        child,
        `control plane reported fatal: ${message.message}`,
        expectedGeneration,
      );
    } else {
      this.controlPlaneLastExitReason = message.reason;
      log.info("super-agent control plane reported stopped", { reason: message.reason });
    }
  }

  private clearControlPlaneReadyTimer(): void {
    if (this.controlPlaneReadyTimer) clearTimeout(this.controlPlaneReadyTimer);
    this.controlPlaneReadyTimer = undefined;
  }

  private clearControlPlaneKillTimer(): void {
    if (this.controlPlaneKillTimer) clearTimeout(this.controlPlaneKillTimer);
    this.controlPlaneKillTimer = undefined;
  }

  /**
   * 对不再接受的 child 发 SIGKILL，并挂 kill 预算。SIGKILL 只可能被不可中断等待推迟；
   * 若预算内仍无 exit/close，置显式 stop-failed 并保留 child 引用，未观察终态前不得拉起替代进程。
   */
  private killControlPlaneWithoutTerminal(
    child: ChildProcess,
    reason: string,
    generation: number,
  ): void {
    if (this.controlPlane !== child) return;
    this.controlPlaneLastExitReason = reason;
    this.clearControlPlaneReadyTimer();
    this.clearControlPlaneKillTimer();
    child.kill("SIGKILL");
    const killTimer = setTimeout(() => {
      this.controlPlaneKillTimer = undefined;
      if (this.controlPlane !== child) return;
      this.controlPlaneState = "stop-failed";
      this.controlPlaneLastExitReason = `${reason}; still no exit/close within ${this.options.controlPlane?.killTimeoutMs ?? CONTROL_PLANE_KILL_TIMEOUT_MS}ms after SIGKILL`;
      log.error("super-agent control plane did not terminate after SIGKILL", {
        generation,
        pid: child.pid,
      });
    }, this.options.controlPlane?.killTimeoutMs ?? CONTROL_PLANE_KILL_TIMEOUT_MS);
    killTimer.unref();
    this.controlPlaneKillTimer = killTimer;
  }

  private clearControlPlaneRestartTimer(): void {
    if (this.controlPlaneRestartTimer) clearTimeout(this.controlPlaneRestartTimer);
    this.controlPlaneRestartTimer = undefined;
  }

  private clearControlPlaneScopedStatus(): void {
    this.controlPlaneStartedAt = null;
    this.controlPlaneHealth = null;
  }

  private enterUpdateRollback(): void {
    // 候选 Core 崩溃后 handleTerminal 会将状态置为 crashed 并安排自动重启；
    // 回滚文件操作期间必须先离开 crashed，否则定时器会用坏的 activeRelease 再次拉起 Core。
    if (this.state === "crashed") this.state = "updating";
  }

  private clearCoreScopedStatus(): void {
    this.host = null;
    this.port = null;
    this.startedAt = null;
    this.runningTaskCount = 0;
    this.runningTasks = undefined;
    this.coreVersion = undefined;
    this.coreReleaseId = undefined;
  }

  private async handleControl(request: ControlRequest): Promise<unknown> {
    switch (request.command) {
      case "ping":
        return { protocolVersion: SERVER_CLI_PROTOCOL_VERSION };
      case "status":
        return this.status();
      case "running-tasks":
        return this.runningTasks ?? null;
      case "runtime-identity":
        return this.runtimeIdentity();
      case "control-plane-status":
        return this.controlPlaneStatus();
      case "stop":
        this.startAcknowledgedLifecycleOperation("stop", () =>
          this.stopInternal("control request"),
        );
        return { stopping: true };
      case "restart":
        this.startAcknowledgedLifecycleOperation("restart", async () => {
          await this.stopInternal("restart");
          await this.start();
        });
        return { restarting: true };
      case "prepare-update":
        return {
          status: this.runningTaskCount ? "blocked" : "ready",
          runningTaskCount: this.runningTaskCount,
        };
      case "apply-update":
        return await this.runLifecycleOperation("update", () =>
          this.applyUpdate(request.force === true),
        );
      case "prepare-uninstall":
        return {
          status: this.runningTaskCount ? "blocked" : "ready",
          runningTaskCount: this.runningTaskCount,
        };
      case "confirm-uninstall":
        if (request.confirmation !== "DELETE")
          throw new Error("Uninstall confirmation must be DELETE");
        // Bug 修复：spec 要求 uninstall 前检查运行任务（R2-CLI-10）。旧实现只有
        // prepare-uninstall 会返回 blocked 却没有任何调用方消费它，confirm-uninstall
        // 直接停 Core 删数据，运行中的任务会被无提示中断。这里在最后防线上强制 guard，
        // 有运行任务时返回结构化错误并保持原状态。
        if (this.runningTaskCount > 0) {
          throw new Error(
            `Cannot uninstall while ${this.runningTaskCount} task(s) are running; stop the server first`,
          );
        }
        log.info("uninstall confirmed, stopping server");
        this.startAcknowledgedLifecycleOperation("uninstall", () => this.stopInternal("uninstall"));
        return { uninstalled: true };
    }
  }

  private runLifecycleOperation<T>(
    kind: LifecycleOperationKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertLifecycleOperationCanStart(kind);
    const active = this.lifecycleOperation;
    if (active) {
      return active.promise as Promise<T>;
    }
    const promise = Promise.resolve().then(operation);
    this.lifecycleOperation = { kind, promise };
    void promise.then(
      () => {
        if (this.lifecycleOperation?.promise === promise) this.lifecycleOperation = undefined;
      },
      () => {
        if (this.lifecycleOperation?.promise === promise) this.lifecycleOperation = undefined;
      },
    );
    return promise;
  }

  private startAcknowledgedLifecycleOperation(
    kind: LifecycleOperationKind,
    operation: () => Promise<unknown>,
  ): void {
    // ack 型请求也必须在回包前检查 gate；后台 Promise 再 reject 会让客户端误以为
    // restart/uninstall 已受理，实际却只在 Supervisor 日志里留下冲突。
    this.assertLifecycleOperationCanStart(kind);
    const started = this.runLifecycleOperation(kind, async () => {
      // control response 必须先写回原 socket；直接关闭 control server 会与 dispatch 互等。
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await operation();
    });
    void started.catch((error: unknown) => {
      log.error(`lifecycle operation ${kind} failed`, error);
    });
  }

  private assertLifecycleOperationCanStart(kind: LifecycleOperationKind): void {
    const active = this.lifecycleOperation;
    if (!active || (kind === "stop" && active.kind === "stop")) return;
    throw new ControlRequestError(
      "operation-in-progress",
      `Lifecycle operation ${active.kind} is already in progress`,
      true,
    );
  }
}
