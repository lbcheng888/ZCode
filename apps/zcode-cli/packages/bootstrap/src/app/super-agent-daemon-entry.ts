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
  controlPlaneMessageSchema,
  resolveControlPlaneAuthTokenPath,
  resolveControlPlaneSocketPath,
} from "@zcode/shared/super-agent-control-plane-protocol";

import { openSuperAgentDatabase } from "../super-agent/storage/index.js";
import type { AdjudicationModelSessionPort } from "../super-agent/adjudication/index.js";
import {
  DaemonPlaneManager,
  resolveTasksIndexDatabasePath,
} from "../super-agent/daemon/planeManager.js";
import type { ControlPlanePeerGuard } from "../super-agent/daemon/peerIdentity.js";
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
export function parseControlPlaneEntryConfig(input: ParseControlPlaneEntryInput): ControlPlaneEntryConfig {
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
    throw new Error(`control-plane generation must be a non-negative integer (${read("generation")})`);
  }
  const protocolVersion = Number(read("protocolVersion"));
  if (!Number.isInteger(protocolVersion)) {
    throw new Error(`control-plane protocol-version is missing or invalid (${read("protocolVersion")})`);
  }
  const dataBaseDir = read("dataBaseDir")?.trim();
  if (!dataBaseDir) throw new Error("control-plane data-base-dir is required");
  const serverRoot = read("serverRoot")?.trim();
  if (!serverRoot) throw new Error("control-plane server-root is required");
  const releaseId = read("releaseId")?.trim();
  const mandateGateRaw = read("mandateGate")?.trim();
  return {
    generation,
    protocolVersion,
    dataBaseDir,
    serverRoot,
    ...(releaseId ? { releaseId } : {}),
    mandateGate: mandateGateRaw === "1" || mandateGateRaw === "true",
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

/** 裁决模型会话：headless child 的 model-only 生成面尚未装配（§8-7 阻塞项）。 */
const UNIMPLEMENTED_ADJUDICATION_SESSION: AdjudicationModelSessionPort = {
  async run() {
    throw new Error(
      "super-agent daemon 裁决模型会话未装配：headless child 的 model-only 生成面（spec §8-7）待定；事件保持未决，不伪造裁决结论",
    );
  },
  destroySession() {
    // 无会话可销毁。
  },
};

export interface StartControlPlaneDaemonOptions {
  config: ControlPlaneEntryConfig;
  /**
   * §3.8 显式凭据握手：Supervisor 在 daemon 启动期写入的 0600 文件。生产入口必须提供；
   * 只有测试/进程内场景才允许改用 peerGuard 注入的测试替身。
   */
  authTokenFile?: string;
  peerGuard?: ControlPlanePeerGuard;
  send: (message: unknown) => void;
  subscribeShutdownCommand: (listener: () => void) => void;
  subscribeParentDisconnect: (listener: () => void) => void;
  onError?: (error: unknown, context: string) => void;
  now?: () => number;
  /** 测试可缩短 health 心跳；生产缺省 {@link CONTROL_PLANE_HEALTH_INTERVAL_MS}。 */
  healthIntervalMs?: number;
  /** 测试可在临时目录绑定端点；缺省按 serverRoot 推导。 */
  endpoint?: string;
  platform?: NodeJS.Platform;
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
  let rpc: Awaited<ReturnType<typeof createControlPlaneRpcServer>> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let manager: DaemonPlaneManager | undefined;
  /** 曾建立过 Core 数据面连接后断开的降级证据（§2.4 degraded）。 */
  let hadCoreChannel = false;
  let degraded: { reason: string; since: number } | undefined;

  const recordError = (workspaceIdentity: string | undefined, error: unknown, context: string): void => {
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

    manager = new DaemonPlaneManager({
      dataBaseDir: options.config.dataBaseDir,
      serverRoot: options.config.serverRoot,
      database,
      adjudicationSession: UNIMPLEMENTED_ADJUDICATION_SESSION,
      mandateGate: options.config.mandateGate,
      now,
      onPlaneError: (workspaceIdentity, error, context) =>
        recordError(workspaceIdentity, error, context),
      lastErrorFor: (workspaceIdentity) => lastErrors.get(workspaceIdentity),
      onFatal: (message) => {
        void failFatal(message);
      },
    });
    manager.enumerateKnownWorkspaces();

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
    if (!authToken && !options.peerGuard) {
      throw new Error(
        "control-plane daemon requires an auth token or a peer guard; refusing to bind an unauthenticated endpoint",
      );
    }
    rpc = await createControlPlaneRpcServer({
      endpoint,
      ...(authToken ? { authToken } : {}),
      ...(options.peerGuard ? { peerGuard: options.peerGuard } : {}),
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
      await rpc?.close();
    } catch {
      // 启动收口失败不覆盖 fatal 原因。
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

  // §3.8：生产只走 Supervisor 铸造的凭据；只有显式注入 peerGuard 的测试才绕过凭据。
  const authTokenFile = options.peerGuard
    ? undefined
    : (options.authTokenFile ?? resolveControlPlaneAuthTokenPath(config.serverRoot));

  const daemon = await startControlPlaneDaemon({
    config,
    ...(options.peerGuard ? { peerGuard: options.peerGuard } : {}),
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
