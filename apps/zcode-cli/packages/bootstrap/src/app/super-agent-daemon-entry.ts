/**
 * headless super-agent control-plane 入口（milestone-b-spec §2.1 / §2.2 / §2.3 / §3）。
 *
 * 由 `zcode control-plane` 子命令（daemon Supervisor spawn）装配：
 * 建 super-agent 域库 → bind `runDir/super-agent.sock`（Windows named pipe）→ IPC 发
 * ready → 等 Core 首个 `workspace.ensure` 后才建 plane/抢租约（§2.5）→ health 心跳 →
 * shutdown 命令/父进程断连优雅收口（释放租约、unlink socket）。
 *
 * 边界：本文件及 daemon/ 模块只 import bootstrap 侧模块与 @zcode/shared；**不 import
 * @zcode/services、不 import @zcode/server-cli**。host 能力（CommandInbox/worker/bots
 * 守卫）全部经 §3.3 RPC 反向调用 Core。
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CONTROL_PLANE_MAX_WORKSPACE_ERRORS,
  CONTROL_PLANE_PROTOCOL_VERSION,
  CONTROL_PLANE_RPC_TIMEOUTS_MS,
  controlPlaneMessageSchema,
  hostWatchdogCommandResultSchema,
  resolveControlPlaneAuthTokenPath,
  resolveControlPlaneSocketPath,
} from "@zcode/shared/super-agent-control-plane-protocol";

import { openSuperAgentDatabase } from "../super-agent/storage/index.js";
import {
  createEnvironmentAdjudicationSessionAssembly,
  createLazyAdjudicationSession,
  type AdjudicationSessionAssembly,
  type CreateAdjudicationSessionAssembly,
} from "../super-agent/daemon/adjudicationSession.js";
import {
  DaemonPlaneManager,
  resolveTasksIndexDatabasePath,
} from "../super-agent/daemon/planeManager.js";
import { createCoreTaskNotificationPort } from "../super-agent/daemon/coreWatchdogPorts.js";
import {
  createDaemonWatchdog,
  type DaemonWatchdogAssembly,
} from "../super-agent/daemon/watchdog.js";
import type { SuperAgentWatchdogConfig } from "../super-agent/watchdog/contract.js";
import {
  CONTROL_PLANE_TRUSTED_PIDS_ENV,
  PEER_CREDENTIALS_NATIVE_PATH_ENV,
  createControlPlanePeerGuard,
  createPlatformPeerIdentityResolver,
  loadNativePeerCredentials,
  parseTrustedPids,
  type ControlPlanePeerGuard,
} from "../super-agent/daemon/peerIdentity.js";
import { createControlPlaneRpcServer } from "../super-agent/daemon/rpcServer.js";
import { getSuperAgentDatabasePath } from "./paths.js";

/** Supervisor 注入的进程级 env（与 controlPlaneLauncher 逐键同源）。 */
export const CONTROL_PLANE_ENV = {
  generation: "ZCODE_CONTROL_PLANE_GENERATION",
  protocolVersion: "ZCODE_CONTROL_PLANE_PROTOCOL_VERSION",
  dataBaseDir: "ZCODE_DATA_BASE_DIR",
  serverRoot: "ZCODE_SERVER_ROOT",
  releaseId: "ZCODE_SERVER_RELEASE_ID",
  /** 启动方投影给 child 的 M4 flag（§2.3：child 只读 mandateGate）。 */
  mandateGate: "ZCODE_CONTROL_PLANE_MANDATE_GATE",
  /** 原生 peer credential addon 路径（launcher 注入；仅 peer 门模式使用）。 */
  peerCredentialsNativePath: PEER_CREDENTIALS_NATIVE_PATH_ENV,
  /**
   * 显式 peer 门模式开关（Supervisor/launcher 投影，`1`/`true` 开启）。缺省关闭，
   * 生产仍走 Supervisor 铸造的 0600 凭据文件；开启时必须同时提供原生 addon 路径，
   * addon 缺失即启动 fatal。
   */
  peerMode: "ZCODE_CONTROL_PLANE_PEER_MODE",
} as const;

/** health 心跳周期（与 leader 心跳同量级；Supervisor 只把它当只读快照）。 */
export const CONTROL_PLANE_HEALTH_INTERVAL_MS = 15_000;

/** 启动期单 workspace 错误摘要上限（health/status 展示面，与 shared schema 同源）。 */
const MAX_WORKSPACE_ERRORS = CONTROL_PLANE_MAX_WORKSPACE_ERRORS;

export interface ControlPlaneEntryConfig {
  generation: number;
  protocolVersion: number;
  dataBaseDir: string;
  serverRoot: string;
  releaseId?: string;
  mandateGate: boolean;
  /** §3.8 显式 peer 门模式；开启时凭据文件被禁用，认证只走内核 peer 身份。 */
  peerMode: boolean;
}

export interface ParseControlPlaneEntryInput {
  /** 子命令名之后的参数（`--data-base-dir=<dir>` 等；env 为同义缺省）。 */
  argv: readonly string[];
  env: Record<string, string | undefined>;
}

const ARG_TO_ENV: Record<string, keyof typeof CONTROL_PLANE_ENV> = {
  "--data-base-dir": "dataBaseDir",
  "--server-root": "serverRoot",
  "--protocol-version": "protocolVersion",
  "--generation": "generation",
  "--release-id": "releaseId",
  "--mandate-gate": "mandateGate",
};

function readArgValue(argv: readonly string[], index: number): string | undefined {
  const current = argv[index];
  if (!current) return undefined;
  const eq = current.indexOf("=");
  if (eq >= 0) return current.slice(eq + 1);
  return argv[index + 1];
}

/**
 * 解析入口参数：argv 覆盖 env；未知参数响亮失败（不忽略拼错的 flag）。
 */
export function parseControlPlaneEntryConfig(
  input: ParseControlPlaneEntryInput,
): ControlPlaneEntryConfig {
  const overrides: Partial<Record<keyof typeof CONTROL_PLANE_ENV, string>> = {};
  for (let index = 0; index < input.argv.length; index += 1) {
    const token = input.argv[index];
    if (!token) continue;
    const key = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    const envKey = ARG_TO_ENV[key];
    if (!envKey) {
      throw new Error(`unknown control-plane argument: ${token}`);
    }
    const value = readArgValue(input.argv, index);
    if (value === undefined) {
      throw new Error(`control-plane argument ${key} requires a value`);
    }
    overrides[envKey] = value;
    if (!token.includes("=")) index += 1;
  }
  const read = (key: keyof typeof CONTROL_PLANE_ENV): string | undefined =>
    overrides[key] ?? input.env[CONTROL_PLANE_ENV[key]];

  const generation = Number(read("generation"));
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error(
      `control-plane generation must be a non-negative integer (${read("generation")})`,
    );
  }
  const protocolVersion = Number(read("protocolVersion"));
  if (!Number.isInteger(protocolVersion)) {
    throw new Error(
      `control-plane protocol-version is missing or invalid (${read("protocolVersion")})`,
    );
  }
  const dataBaseDir = read("dataBaseDir")?.trim();
  if (!dataBaseDir) throw new Error("control-plane data-base-dir is required");
  const serverRoot = read("serverRoot")?.trim();
  if (!serverRoot) throw new Error("control-plane server-root is required");
  const releaseId = read("releaseId")?.trim();
  const mandateGateRaw = read("mandateGate")?.trim();
  const peerModeRaw = read("peerMode")?.trim();
  return {
    generation,
    protocolVersion,
    dataBaseDir,
    serverRoot,
    ...(releaseId ? { releaseId } : {}),
    mandateGate: mandateGateRaw === "1" || mandateGateRaw === "true",
    peerMode: peerModeRaw === "1" || peerModeRaw === "true",
  };
}

/**
 * 库路径一致性（§2.3 fail-closed）：super-agent.sqlite 与 tasks-index.sqlite 必须同根。
 * 两者都由同一个 dataBaseDir 推导；仅断言「本进程两条推导公式同目录」是同义反复，
 * 无法发现 Core 侧 `setDataBaseDir()` 覆盖造成的跨进程不同根。因此 Core 必须在
 * `workspace.ensure` 上报它解析出的 tasks-index 绝对路径，由 child 精确比对（见
 * planeManager）；本函数只负责 child 侧单进程自检与路径暴露。
 */
export function assertControlPlaneStorageRoot(dataBaseDir: string): {
  superAgentDatabasePath: string;
  tasksIndexDatabasePath: string;
} {
  const superAgentDatabasePath = getSuperAgentDatabasePath(dataBaseDir);
  const tasksIndexDatabasePath = resolveTasksIndexDatabasePath(dataBaseDir);
  const expectedDir = dirname(tasksIndexDatabasePath);
  if (dirname(superAgentDatabasePath) !== expectedDir) {
    throw new Error(
      `super-agent 域库与 tasks-index 不同根：${superAgentDatabasePath} / ${tasksIndexDatabasePath}（dataBaseDir=${dataBaseDir}）`,
    );
  }
  return { superAgentDatabasePath, tasksIndexDatabasePath };
}

export interface StartControlPlaneDaemonOptions {
  config: ControlPlaneEntryConfig;
  /**
   * §3.8 显式凭据握手：Supervisor 在 daemon 启动期写入的 0600 文件。生产入口必须提供；
   * 只有显式 peer 门模式（`config.peerMode`）或测试注入 peerGuard 时才允许缺席。
   */
  authTokenFile?: string;
  peerGuard?: ControlPlanePeerGuard;
  /**
   * 原生 peer credential addon 路径（daemon entry 从 launcher env 解析后传入）。
   * 仅在 `config.peerMode === true` 且未注入 peerGuard 时使用；缺失即启动 fatal。
   * 非 peer 模式一律忽略，防止出现「配置了 addon 但永不可达」的死接线。
   */
  nativeAddonPath?: string;
  send: (message: unknown) => void;
  subscribeShutdownCommand: (listener: () => void) => void;
  subscribeParentDisconnect: (listener: () => void) => void;
  onError?: (error: unknown, context: string) => void;
  now?: () => number;
  /** 测试可缩短 health 心跳；生产缺省 {@link CONTROL_PLANE_HEALTH_INTERVAL_MS}。 */
  healthIntervalMs?: number;
  /** 测试可缩短派发桥周期；生产缺省控制面常量（20s）。 */
  dispatchIntervalMs?: number;
  /** 测试可缩短 in_window 宽限；生产缺省控制面常量（5 分钟）。 */
  dispatchGraceMs?: number;
  /**
   * daemon watchdog 配置覆盖（与 health/dispatch 间隔同为组合根注入口）；生产缺省
   * DEFAULT_WATCHDOG_CONFIG。E2E 用它缩短 tick/熔断阈值驱动真实跨进程 repair。
   */
  watchdogConfig?: Partial<SuperAgentWatchdogConfig>;
  /** 测试可在临时目录绑定端点；缺省按 serverRoot 推导。 */
  endpoint?: string;
  platform?: NodeJS.Platform;
  /**
   * 裁决会话装配钩子（惰性：首个裁决批才调用）。生产缺省
   * {@link createEnvironmentAdjudicationSessionAssembly}；测试可注入真实 provider
   * Registry 替身或 hang 端口，仍用入口自己的 abortSignal 验证 shutdown 取消在途调用。
   */
  adjudicationSessionAssembly?: CreateAdjudicationSessionAssembly;
  /** provider Registry 读取的 env；缺省 process.env（生产 CLI 传 process.env）。 */
  env?: Record<string, string | undefined>;
}

export interface RunningControlPlaneDaemon {
  /** 优雅收口完成（0）或启动失败（1）。 */
  done: Promise<number>;
  shutdown(reason: string): Promise<void>;
}

/**
 * 启动 daemon。任何启动级错误都走 fatal（§2.4 一等上报），返回 done=1，不半启。
 */
export async function startControlPlaneDaemon(
  options: StartControlPlaneDaemonOptions,
): Promise<RunningControlPlaneDaemon> {
  const now = options.now ?? Date.now;
  const onError =
    options.onError ??
    ((error: unknown, context: string) => {
      // Supervisor 的 child stdio 默认 ignore；开发直跑与已接日志的可观测路径仍应有一等证据。
      console.error(`[super-agent-control-plane] ${context}:`, error);
    });
  let finished = false;
  let finishDone: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    finishDone = resolve;
  });

  if (options.config.protocolVersion !== CONTROL_PLANE_PROTOCOL_VERSION) {
    // 协议不匹配属于启动期不可恢复错误：显式 fatal，Supervisor 计数并按崩溃预算处理。
    try {
      options.send({
        type: "fatal",
        message: `control-plane protocol mismatch: child=${options.config.protocolVersion} supervisor=${CONTROL_PLANE_PROTOCOL_VERSION}`,
      });
    } catch (error) {
      onError(error, "daemon.ipc.send");
    }
    finishDone(1);
    return { done, shutdown: async () => undefined };
  }

  const sendMessage = (message: unknown): void => {
    // 发送前按严格 schema 校验：child 不能发出 Supervisor 不认识的形状（§2.4）。
    const parsed = controlPlaneMessageSchema.parse(message);
    try {
      options.send(parsed);
    } catch (error) {
      // 父 IPC 已断开时 stopped/fatal 无法送达：收口不能因此悬挂或卡住。
      onError(error, "daemon.ipc.send");
    }
  };
  const lastErrors = new Map<string, string>();

  let database: DatabaseSync | undefined;
  let daemonWatchdog: DaemonWatchdogAssembly | undefined;
  let rpc: Awaited<ReturnType<typeof createControlPlaneRpcServer>> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let manager: DaemonPlaneManager | undefined;
  let adjudication: AdjudicationSessionAssembly | undefined;
  /** shutdown/父断连先 abort：在途裁决模型请求随信号取消，再收口 plane/库。 */
  const abortController = new AbortController();
  /** 曾建立过 Core 数据面连接后断开的降级证据（§2.4 degraded）。 */
  let hadCoreChannel = false;
  let degraded: { reason: string; since: number } | undefined;

  const recordError = (
    workspaceIdentity: string | undefined,
    error: unknown,
    context: string,
  ): void => {
    const message = error instanceof Error ? error.message : String(error);
    onError(error, context);
    if (!workspaceIdentity) return;
    if (lastErrors.size >= MAX_WORKSPACE_ERRORS && !lastErrors.has(workspaceIdentity)) return;
    lastErrors.set(workspaceIdentity, `${context}: ${message}`.slice(0, 500));
  };

  /** 对称收口资源（shutdown 与 fatal 共用；半初始化资源全部 optional）。 */
  const closeResources = async (): Promise<void> => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    // 先 abort 再收口：daemon 退出时在途裁决模型请求必须随信号取消，不能在关库后
    // 继续写 decision_log（否则产生关库后的错误噪音或半结算）。
    try {
      abortController.abort(new Error("control-plane daemon shutting down"));
    } catch (error) {
      recordError(undefined, error, "daemon.abort");
    }
    try {
      await rpc?.close();
    } catch (error) {
      recordError(undefined, error, "daemon.rpc.close");
    }
    try {
      await manager?.shutdown();
    } catch (error) {
      recordError(undefined, error, "daemon.planes.shutdown");
    }
    try {
      // 惰性装配：未装 provider Registry 时 dispose 立即返回。
      await adjudication?.dispose();
    } catch (error) {
      recordError(undefined, error, "daemon.adjudication.dispose");
    }
    try {
      await daemonWatchdog?.stop();
    } catch (error) {
      recordError(undefined, error, "daemon.watchdog.stop");
    }
    try {
      database?.close();
    } catch (error) {
      recordError(undefined, error, "daemon.database.close");
    }
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (finished) return;
    finished = true;
    await closeResources();
    sendMessage({ type: "stopped", reason: reason.slice(0, 500) });
    finishDone(0);
  };

  /**
   * 运行期启动级不可恢复错误（§2.3 库路径跨进程不一致）：发 fatal 并收口退出 1，
   * 不发 stopped（那是正常收口，会把 fatal 原因覆盖成「正常停止」）。
   */
  const failFatal = async (message: string): Promise<void> => {
    if (finished) return;
    finished = true;
    await closeResources();
    sendMessage({ type: "fatal", message: message.slice(0, 500) });
    finishDone(1);
  };

  // 生命周期监听必须在任何 await 之前挂上：父进程在启动窗口内崩溃时不能错过 disconnect
  // 而留下孤儿（§2.5）。listener 只调用 shutdown，内部对半初始化资源全部 optional。
  options.subscribeShutdownCommand(() => {
    void shutdown("shutdown command");
  });
  options.subscribeParentDisconnect(() => {
    void shutdown("parent disconnected");
  });

  try {
    const paths = assertControlPlaneStorageRoot(options.config.dataBaseDir);
    database = await openSuperAgentDatabase({ databasePath: paths.superAgentDatabasePath });

    // S3 daemon watchdog：共享生产 registry 只 hydrate 本进程有命令面的 kind。
    // workflow/automation 经 Core RPC（host.watchdogCommand）转既有
    // cancelBackgroundWork / automationService.pause；notify-user 经同一 RPC 转
    // V4 notifyUser，由 owner session 的 runtime task-notification 队列投递。cheng-job
    // 不在此列：daemon 的 stdio cheng host 看不到前台 app 的 job.json，跨进程 cancel 恒
    // jobNotFound，由拥有该 job 的会话 app watchdog 处理。
    daemonWatchdog = createDaemonWatchdog({
      database,
      workflowCancel: {
        cancel: async (
          runId: string,
          context?: { workspaceKey?: string; ownerSession?: string },
        ) => {
          if (!context?.workspaceKey || !context.ownerSession) {
            throw new Error(
              `workflow cancel 缺少 ownerSession/workspaceKey: run=${runId} workspace=${context?.workspaceKey ?? "<missing>"} session=${context?.ownerSession ?? "<missing>"}`,
            );
          }
          const planeManager = manager;
          if (!planeManager) throw new Error("daemon plane manager not ready");
          const result = hostWatchdogCommandResultSchema.parse(
            await planeManager.requestHost(
              context.workspaceKey,
              "host.watchdogCommand",
              {
                action: "cancel-workflow",
                workspaceIdentity: context.workspaceKey,
                runId,
                sessionId: context.ownerSession,
              },
              CONTROL_PLANE_RPC_TIMEOUTS_MS["host.watchdogCommand"],
            ),
          );
          if (!result.ok) throw new Error(result.error ?? "workflow cancel failed");
          return true;
        },
      },
      automationPause: {
        pause: async (input: { id: string }, context?: { workspaceKey?: string }) => {
          if (!context?.workspaceKey) {
            throw new Error(`pause-automation 缺少 workspaceKey: automation=${input.id}`);
          }
          const planeManager = manager;
          if (!planeManager) throw new Error("daemon plane manager not ready");
          const result = hostWatchdogCommandResultSchema.parse(
            await planeManager.requestHost(
              context.workspaceKey,
              "host.watchdogCommand",
              {
                action: "pause-automation",
                workspaceIdentity: context.workspaceKey,
                automationId: input.id,
              },
              CONTROL_PLANE_RPC_TIMEOUTS_MS["host.watchdogCommand"],
            ),
          );
          if (!result.ok) throw new Error(result.error ?? "automation pause failed");
          return true;
        },
      },
      taskNotification: createCoreTaskNotificationPort(
        (workspaceKey, method, params, timeoutMs) => {
          const planeManager = manager;
          if (!planeManager) throw new Error("daemon plane manager not ready");
          return planeManager.requestHost(workspaceKey, method, params, timeoutMs);
        },
      ),
      notify: (message: string) => {
        onError(new Error(message), "daemon.watchdog.notify");
      },
      ...(options.watchdogConfig === undefined ? {} : { config: options.watchdogConfig }),
    });

    // 裁决会话惰性装配：首个裁决批才启动 provider Registry（Core 物化 Built-in
    // Config 存在启动顺序竞态，spec §8-7）；不可用即 typed 失败端口，候选留 pending。
    adjudication = createLazyAdjudicationSession({
      abortSignal: abortController.signal,
      createAssembly:
        options.adjudicationSessionAssembly ??
        ((assemblyInput) =>
          createEnvironmentAdjudicationSessionAssembly({
            env: options.env ?? process.env,
            dataBaseDir: options.config.dataBaseDir,
            abortSignal: assemblyInput.abortSignal,
            onUnavailable: (error) => {
              recordError(undefined, error, "daemon.adjudication.unavailable");
            },
          })),
    });
    manager = new DaemonPlaneManager({
      dataBaseDir: options.config.dataBaseDir,
      serverRoot: options.config.serverRoot,
      database,
      adjudicationSession: adjudication.session,
      mandateGate: options.config.mandateGate,
      ...(options.dispatchIntervalMs !== undefined
        ? { dispatchIntervalMs: options.dispatchIntervalMs }
        : {}),
      ...(options.dispatchGraceMs !== undefined
        ? { dispatchGraceMs: options.dispatchGraceMs }
        : {}),
      now,
      onPlaneError: (workspaceIdentity, error, context) =>
        recordError(workspaceIdentity, error, context),
      lastErrorFor: (workspaceIdentity) => lastErrors.get(workspaceIdentity),
      // §3.5：可达性 = RPC server 任一未关闭的已认证 Core 通道，而非某 plane 的旧连接。
      activeHostChannel: () => rpc?.channels().find((channel) => !channel.closed),
      onFatal: (message) => {
        void failFatal(message);
      },
    });
    manager.enumerateKnownWorkspaces();
    // watchdog 的 workflow/automation 端口依赖 manager 的 Core channel；等 manager
    // 就绪后再启动，避免启动早期 tick 以“manager not ready”误报 repair 失败。
    daemonWatchdog?.start();

    const endpoint =
      options.endpoint ??
      resolveControlPlaneSocketPath(options.config.serverRoot, options.platform);
    let authToken: string | undefined;
    if (options.authTokenFile) {
      // 生产路径：凭据必须可读且非空；缺失即启动级 fatal，绝不静默降级为无认证端点。
      let raw: string;
      try {
        raw = await readFile(options.authTokenFile, "utf8");
      } catch (error) {
        throw new Error(
          `control-plane auth token file unreadable (${options.authTokenFile}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      authToken = raw.trim();
      if (!authToken) {
        throw new Error(`control-plane auth token file is empty (${options.authTokenFile})`);
      }
    }
    // §3.8 两种认证模式必须由显式开关选择，不能靠「凭据文件恰好缺席」隐式进入：
    // peerMode 由 launcher/env 投影，开启时禁止同时提供凭据文件，避免两套语义静默混用。
    if (options.config.peerMode && options.authTokenFile) {
      throw new Error("control-plane peer mode must not be combined with an auth token file");
    }
    let peerGuard = options.peerGuard;
    if (!peerGuard && options.config.peerMode) {
      // 显式 peer 门模式：必须拿到内核级原生 resolver，信任集合 = spawn 父进程
      // （Supervisor）+ launcher 投影的 Core PID。addon 缺失/加载失败即启动 fatal，
      // 绝不回退到 /proc 启发式或未认证端点。生产默认不开此模式，仍走 authToken。
      if (!options.nativeAddonPath) {
        throw new Error("control-plane peer mode requires a native peer credentials addon path");
      }
      const native = loadNativePeerCredentials({ addonPath: options.nativeAddonPath });
      if (!native) {
        throw new Error(
          `control-plane native peer credentials addon unavailable (${options.nativeAddonPath})`,
        );
      }
      peerGuard = createControlPlanePeerGuard({
        trustedPids: [
          ...new Set([
            process.ppid,
            ...parseTrustedPids(options.env?.[CONTROL_PLANE_TRUSTED_PIDS_ENV]),
          ]),
        ],
        resolver: createPlatformPeerIdentityResolver(options.platform, { native }),
      });
    }
    if (!authToken && !peerGuard) {
      throw new Error(
        "control-plane daemon requires an auth token or a peer guard; refusing to bind an unauthenticated endpoint",
      );
    }
    rpc = await createControlPlaneRpcServer({
      endpoint,
      ...(authToken ? { authToken } : {}),
      ...(peerGuard ? { peerGuard } : {}),
      handler: async (method, params, context) => {
        if (!manager) throw new Error("control-plane daemon is not initialized");
        return await manager.handle(method, params, context.channel, context.deadlineAt);
      },
      onPeerRejected: (reason) => recordError(undefined, new Error(reason), "daemon.peer.rejected"),
      onProtocolError: (reason) => recordError(undefined, new Error(reason), "daemon.rpc.protocol"),
      ...(options.platform ? { platform: options.platform } : {}),
    });

    if (finished) {
      // 启动窗口内已收到 shutdown/disconnect：不再 ready，收口已创建的 socket/db。
      await rpc.close();
      abortController.abort(new Error("control-plane daemon shutting down"));
      await adjudication.dispose();
      database.close();
      return { done, shutdown };
    }

    // ready 只表示 child 装配完成；租约/循环仍等 Core 首个 workspace.ensure（§2.5）。
    sendMessage({
      type: "ready",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      generation: options.config.generation,
      ...(options.config.releaseId ? { releaseId: options.config.releaseId } : {}),
    });

    heartbeat = setInterval(() => {
      if (finished) return;
      let pendingEventCount: number | undefined;
      let pendingDispatchCount: number | undefined;
      let workspaceErrors: Array<{ workspaceIdentity: string; error: string }> | undefined;
      try {
        pendingEventCount = manager?.pendingEventCount();
        pendingDispatchCount = manager?.pendingDispatchCount();
        workspaceErrors = manager?.workspaceErrors();
        if (workspaceErrors?.length === 0) workspaceErrors = undefined;
      } catch (error) {
        // health 读面失败不能把进程打崩；按 workspace 错误上浮，字段本轮缺席。
        recordError(undefined, error, "daemon.health");
      }
      // §2.4 degraded 只在「曾 ready 后降级」出现：跟踪 Core 通道是否曾经在场、
      // 现在是否消失（心跳粒度只用于状态展示，不参与 §3.6 的 legacy/失败判据）。
      if (rpc !== undefined) {
        if (rpc.channelCount > 0) {
          hadCoreChannel = true;
          degraded = undefined;
        } else if (hadCoreChannel && degraded === undefined) {
          degraded = { reason: "control-plane Core channel closed", since: now() };
        }
      }
      sendMessage({
        type: "health",
        at: now(),
        ...(manager
          ? {
              ...(pendingEventCount !== undefined ? { pendingEventCount } : {}),
              leaderWorkspaceCount: manager.leaderWorkspaceCount(),
              followerIngestCount: manager.followerIngestCount(),
              notEnsuredIngestCount: manager.notEnsuredIngestCount(),
              ...(workspaceErrors ? { workspaceErrors } : {}),
            }
          : {}),
        ...(pendingDispatchCount !== undefined ? { pendingDispatchCount } : {}),
        ...(degraded ? { degraded } : {}),
        ...(rpc
          ? {
              rejectedPeerCount: rpc.rejectedPeerCount,
              protocolErrorCount: rpc.protocolErrorCount,
            }
          : {}),
      });
    }, options.healthIntervalMs ?? CONTROL_PLANE_HEALTH_INTERVAL_MS);
    heartbeat.unref?.();
  } catch (error) {
    // 启动失败已发 fatal：置终态防止随后的 process.disconnect 触发第二段 stopped 收口。
    finished = true;
    recordError(undefined, error, "daemon.startup");
    sendMessage({
      type: "fatal",
      message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    try {
      abortController.abort(new Error("control-plane daemon startup failed"));
    } catch {
      // abort 不覆盖 fatal 原因。
    }
    try {
      await rpc?.close();
    } catch {
      // 启动收口失败不覆盖 fatal 原因。
    }
    try {
      await adjudication?.dispose();
    } catch {
      // 同上。
    }
    try {
      database?.close();
    } catch {
      // 同上。
    }
    finishDone(1);
  }

  return { done, shutdown };
}

export interface RunSuperAgentControlPlaneCommandOptions {
  /** 子命令名之后的参数（不含 `control-plane`）。 */
  argv: readonly string[];
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** 测试注入 peer 门；生产缺省读 Supervisor 铸造的 0600 凭据文件（§3.8）。 */
  peerGuard?: ControlPlanePeerGuard;
  /** 测试可覆盖凭据文件路径；缺省按 serverRoot 推导。 */
  authTokenFile?: string;
  /** 原生 peer credential addon 路径；缺省读 launcher 注入的 env。 */
  nativeAddonPath?: string;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

/**
 * CLI 入口：解析 env/argv → 起 daemon → 等收口。启动失败返回 1 并已发 fatal。
 */
export async function runSuperAgentControlPlaneCommand(
  options: RunSuperAgentControlPlaneCommandOptions,
): Promise<number> {
  let config: ControlPlaneEntryConfig;
  try {
    config = parseControlPlaneEntryConfig({ argv: options.argv, env: options.env });
  } catch (error) {
    process.send?.({
      type: "fatal",
      message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // §3.8：默认只走 Supervisor 铸造的凭据；显式 peer 门模式（config.peerMode）或测试
  // 注入 peerGuard 时才绕过凭据。peer 模式下只认原生 addon 路径，不走任何隐式回退。
  const peerMode = config.peerMode || options.peerGuard !== undefined;
  if (peerMode && options.authTokenFile) {
    // 两套认证语义同时给出属于配置错误，静默丢弃 token 会让「peer 模式」掩盖真实意图。
    const message = "control-plane peer mode must not be combined with an auth token file";
    process.send?.({ type: "fatal", message });
    process.stderr.write(`${message}\n`);
    return 1;
  }
  const authTokenFile = peerMode
    ? undefined
    : (options.authTokenFile ?? resolveControlPlaneAuthTokenPath(config.serverRoot));
  const nativeAddonPath = config.peerMode
    ? options.nativeAddonPath?.trim() || options.env[PEER_CREDENTIALS_NATIVE_PATH_ENV]?.trim()
    : undefined;

  const daemon = await startControlPlaneDaemon({
    config,
    env: options.env,
    ...(options.peerGuard ? { peerGuard: options.peerGuard } : {}),
    ...(nativeAddonPath ? { nativeAddonPath } : {}),
    ...(authTokenFile ? { authTokenFile } : {}),
    send: (message) => {
      // 没有 IPC 的本地直跑（dev 调试）只保留 fatal/stopped 的 stderr 证据。
      if (typeof process.send === "function") process.send(message);
      else if ((message as { type?: string }).type === "fatal") {
        process.stderr.write(`${(message as { message?: string }).message ?? "fatal"}\n`);
      }
    },
    subscribeShutdownCommand: (listener) => {
      process.on("message", (raw: unknown) => {
        if (
          typeof raw === "object" &&
          raw !== null &&
          (raw as { command?: unknown }).command === "shutdown"
        ) {
          listener();
        }
      });
    },
    subscribeParentDisconnect: (listener) => {
      // Supervisor 崩溃/被杀：自行停循环、释放租约、关库并退出，不做孤儿（§2.5）。
      process.once("disconnect", listener);
    },
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const exitCode = await daemon.done;
  // 主动断开 IPC：Supervisor 侧通道若仍打开会让子进程在收口后继续存活，直到父进程
  // 超时强杀——那会把优雅 stopped 误报成崩溃。disconnect 触发的 listener 已幂等。
  try {
    process.disconnect?.();
  } catch {
    // 父通道可能已断；disconnect 失败不影响退出码。
  }
  return exitCode;
}
