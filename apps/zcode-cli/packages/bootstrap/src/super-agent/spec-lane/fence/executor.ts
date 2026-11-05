/**
 * P6 OS 围栏执行器：能力探测、临时产物落盘、per-run 句柄。
 *
 * fail-closed 纪律（spec §3.4）：
 *   - 探测不确定/失败 = 不可用；prepare 抛 typed FenceStartupError；
 *   - 调用方（dispatcher）据此拒绝启动 spec run，绝不回退到协作式 env 代理；
 *   - teardown 幂等；清理失败原样上浮（保留原始错误链）。
 *
 * Linux 机制（rootless）：prepare 时只启动宿主 AF_UNIX relay（socket 0600，位于
 * fence 临时目录）并写入围栏内 Node relay 脚本；每条命令由 command-plan 包装成
 * `unshare --user --map-root-user --net --fork`，新 netns 内启用 lo、启动 relay、
 * 用 childBroker(127.0.0.1:relayPort) 代理 env 执行命令。命名空间随命令进程退出
 * 由内核回收，不存在持久 netns/veth 残留。
 *
 * 残留对账：每个围栏/probe 临时目录写 owner.json（runId + pid）。prepare 启动时
 * 扫描同前缀目录：存活 pid 的其他 run 一律保留；同 runId 的存活围栏视为
 * fence.residual_conflict；死 pid / 无 owner 且超过乐观等待窗的目录回收计数。
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExecutionRequest } from "@zcode/contracts";

import {
  FenceStartupError,
  fencePlatformMatrixEntry,
  type FenceCapability,
  type FenceChildBroker,
  type FenceErrorCode,
  type FenceRunStatus,
  type PrepareFenceRequest,
  type SpecFenceContract,
  type SpecFenceHandle,
} from "./contract.js";
import {
  DEFAULT_POSIX_SHELL_PATH,
  DEFAULT_SANDBOX_EXEC_PATH,
  DEFAULT_UNSHARE_PATH,
  LINUX_IP_CANDIDATE_PATHS,
  buildDarwinFenceProfile,
  buildFencedExecutionCommand,
  buildFenceCommandPlan,
  buildLinuxFenceProbeScript,
  buildLinuxFenceRelayScript,
  resolveLinuxIpPath,
  type DarwinFenceCommandPlan,
  type FenceArtifactPaths,
  type FenceCommandPlan,
  type LinuxFenceCommandPlan,
} from "./command-plan.js";
import { startUnixBrokerRelay, type UnixBrokerRelayHandle } from "./linux-network.js";
import {
  createFenceTempDir,
  forgetFenceTempDir,
  releaseFenceTempDir,
  sweepResidualFences,
} from "./residual.js";

const execFileAsync = promisify(execFile);

/** 探测用哨兵端口：不指向真实 broker（Linux 探测自建 echo，不发外部请求）。 */
const PROBE_BROKER_PORT = 65535;
const PROBE_TIMEOUT_MS = 10_000;
/** Linux 语义探测预算：relay 就绪 ≤10s + 转发读回 ≤5s。 */
const LINUX_PROBE_TIMEOUT_MS = 20_000;
/** Linux 语义探测的 echo 招呼串（netns 内经 relay 读回后逐字比对）。 */
const LINUX_PROBE_GREETING = "spec-fence-probe-ok";
/** 探测进程的临时目录 owner 标记（不是真实 run）。 */
const PROBE_RUN_ID = "__probe__";
/** sandbox-exec 语义探测：连接被拒绝时脚本的退出码。 */
const PROBE_CONNECT_DENIED_EXIT = 42;

/** Linux 网络端口熵：2 字节（与 command-plan 的 relay 端口派生一致）。 */
function defaultLinuxEntropy(): Uint8Array {
  return randomBytes(2);
}

interface ActiveFenceRecord extends FenceRunStatus {
  dir: string;
}

/** 本进程内活跃的围栏（status 只读面）。 */
const activeFences = new Map<string, ActiveFenceRecord>();

export interface CreateSpecFenceOptions {
  /** 缺省 process.platform；测试可显式指定。 */
  platform?: NodeJS.Platform;
  shellPath?: string;
  ipPath?: string;
  unsharePath?: string;
  nodePath?: string;
  sandboxExecPath?: string;
  /** relay 端口熵（测试注入固定值）；缺省随机 2 字节。 */
  linuxNetworkEntropy?: () => Uint8Array;
  /** 启动对账回收残留后的可观测钩子（计数）；钩子抛错按启动失败处理（fail-loud）。 */
  onResidualSwept?: (result: { removed: number }) => void;
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: string }).stderr;
  const stdout = (error as Error & { stdout?: string }).stdout;
  const text = (stderr ?? "").trim() || (stdout ?? "").trim() || error.message;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function errorExitCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

function classifyFailure(error: unknown): { code: FenceErrorCode; detail: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = errorDetail(error);
  if (code === "ENOENT") {
    return { code: "fence.startup_failed", detail: `缺少围栏依赖可执行文件: ${detail}` };
  }
  if (
    code === "EPERM" ||
    code === "EACCES" ||
    /Operation not permitted|Permission denied|permission denied/i.test(detail)
  ) {
    return { code: "fence.permission_denied", detail };
  }
  return { code: "fence.startup_failed", detail };
}

async function fileExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface ProbeServer {
  server: NetServer;
  port: number;
  connections: number;
}

async function startProbeServer(): Promise<ProbeServer> {
  const state: ProbeServer = { server: createNetServer(), port: 0, connections: 0 };
  state.server.on("connection", (socket) => {
    state.connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      state.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      state.server.off("error", onError);
      resolve();
    };
    state.server.once("error", onError);
    state.server.once("listening", onListening);
    state.server.listen(0, "127.0.0.1");
  });
  const address = state.server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("围栏探测服务器端口解析失败");
  }
  state.port = address.port;
  return state;
}

async function closeProbeServer(server: NetServer | undefined): Promise<string | undefined> {
  if (!server) return undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return undefined;
  } catch (error) {
    return errorDetail(error);
  }
}

/**
 * Linux 语义探测的本端 TCP echo：连接建立后回写招呼串。围栏内 relay 经宿主
 * loopback TCP 转发到这里，读回同一串即证明字节链路完整。
 */
async function startProbeEchoServer(
  greeting: string,
): Promise<{ server: NetServer; port: number }> {
  const server = createNetServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.end(`${greeting}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("围栏探测 echo 服务器端口解析失败");
  }
  return { server, port: address.port };
}

function buildConnectProbeScript(port: number): string {
  return [
    `if exec 3<>/dev/tcp/127.0.0.1/${port}; then`,
    "  exec 3<&-",
    "  exit 0",
    "else",
    `  exit ${PROBE_CONNECT_DENIED_EXIT}`,
    "fi",
  ].join("\n");
}

/**
 * macOS 围栏语义自检（spec §3.4「探测不确定 = 拒绝」）。
 *
 * sandbox-exec 已 deprecated；只验证「能执行/能编译 profile」不足以证明
 * (deny network-outbound) 真的生效（规则可能被忽略成 no-op）。这里做正/负控制：
 *   1) 围栏外同一脚本必须能连上两个端口（证明探测手段本身可靠）；
 *   2) 围栏内放行端口必须真能连上；
 *   3) 围栏内未放行端口必须被拒（退出码 42 且没有建立连接）。
 * 任一步不符合 → 返回失败细节（调用方转 typed unavailable）。
 */
async function verifyDarwinFenceSemantics(input: {
  shellPath: string;
  sandboxExecPath: string;
  profilePath: string;
}): Promise<string | undefined> {
  let allowed: ProbeServer | undefined;
  let denied: ProbeServer | undefined;
  try {
    allowed = await startProbeServer();
    denied = await startProbeServer();
    await writeFile(input.profilePath, buildDarwinFenceProfile(allowed.port), "utf8");

    // 正控制：围栏外必须两个端口都可连接（否则 /dev/tcp 或环境本身不可用）。
    try {
      await execFileAsync(input.shellPath, ["-c", buildConnectProbeScript(allowed.port)], {
        timeout: PROBE_TIMEOUT_MS,
        encoding: "utf8",
      });
      await execFileAsync(input.shellPath, ["-c", buildConnectProbeScript(denied.port)], {
        timeout: PROBE_TIMEOUT_MS,
        encoding: "utf8",
      });
    } catch (error) {
      return `探测正控制失败（围栏外无法建立连接，无法判定围栏语义）: ${errorDetail(error)}`;
    }

    const allowedBefore = allowed.connections;
    const deniedBefore = denied.connections;

    // 负控制 1：profile 放行的端口在围栏内必须可达。
    try {
      await execFileAsync(
        input.sandboxExecPath,
        ["-f", input.profilePath, "--", input.shellPath, "-c", buildConnectProbeScript(allowed.port)],
        { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
      );
    } catch (error) {
      return `围栏内放行端口不可达（profile 语义异常）: ${errorDetail(error)}`;
    }
    if (allowed.connections <= allowedBefore) {
      return "围栏内放行端口报告成功但未真正建立连接";
    }

    // 负控制 2：未放行端口必须被内核/围栏拒绝。
    try {
      await execFileAsync(
        input.sandboxExecPath,
        ["-f", input.profilePath, "--", input.shellPath, "-c", buildConnectProbeScript(denied.port)],
        { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
      );
      return "非放行端口在围栏内连接成功：sandbox-exec 网络规则未生效（不许降级为可用）";
    } catch (error) {
      if (errorExitCode(error) !== PROBE_CONNECT_DENIED_EXIT) {
        return `非放行端口探测未得到预期拒绝（exit=${String(errorExitCode(error))}）: ${errorDetail(error)}`;
      }
    }
    if (denied.connections > deniedBefore) {
      return "非放行端口在围栏内建立了连接：sandbox-exec 网络规则未生效（不许降级为可用）";
    }
    return undefined;
  } finally {
    // 探测服务器关闭失败不改变语义结论（端口已释放或随进程退出回收）。
    await closeProbeServer(allowed?.server);
    await closeProbeServer(denied?.server);
  }
}

/**
 * Linux 围栏能力探测（spec §3.4「探测不确定 = 拒绝」）。
 *
 * 不仅查 X_OK：在真实 netns 内跑生产同款 relay 启动脚本，并经 relay 读回宿主
 * echo 的招呼串，证明「unshare + lo + relay + AF_UNIX 转发」整条链路可用
 * （Electron 宿主缺 ELECTRON_RUN_AS_NODE、relay 起不来等情况在探测期暴露，
 * 不会推迟到每条命令 2s 超时）。探测失败 = typed unavailable，调用方拒绝启动，
 * 绝不回退 env 代理。
 */
async function probeLinux(
  plan: LinuxFenceCommandPlan,
  options: CreateSpecFenceOptions,
): Promise<FenceCapability> {
  const platform: NodeJS.Platform = "linux";
  const unavailable = (code: FenceErrorCode, detail: string): FenceCapability => ({
    available: false,
    platform,
    mechanism: plan.mechanism,
    code,
    detail,
  });
  if (!(await fileExecutable(plan.unsharePath))) {
    return unavailable("fence.startup_failed", `unshare 不可执行: ${plan.unsharePath}`);
  }
  if (!(await fileExecutable(plan.shellPath))) {
    return unavailable("fence.startup_failed", `围栏内 shell 不可执行: ${plan.shellPath}`);
  }
  if (!(await fileExecutable(plan.nodePath))) {
    return unavailable("fence.startup_failed", `relay Node 可执行文件不可用: ${plan.nodePath}`);
  }
  // PATH 不可靠（桌面/服务进程常缺 /usr/sbin）：解析绝对候选并让探测与 bootstrap
  // 共用同一 ip 路径。
  const ipPath = await resolveLinuxIpPath(options.ipPath, fileExecutable);
  if (ipPath === undefined) {
    return unavailable(
      "fence.startup_failed",
      `未找到可执行的 ip（候选绝对路径 ${LINUX_IP_CANDIDATE_PATHS.join(", ")}）；请显式配置 ipPath`,
    );
  }
  const effectivePlan: LinuxFenceCommandPlan = { ...plan, ipPath };
  let dir: string | undefined;
  let echo: { server: NetServer; port: number } | undefined;
  let relay: UnixBrokerRelayHandle | undefined;
  // fail-closed 缺省：探测完成前一律按不可用。
  let capability: FenceCapability = unavailable(
    "fence.startup_failed",
    "Linux 围栏语义探测未完成",
  );
  try {
    dir = await createFenceTempDir(PROBE_RUN_ID);
    const relayScriptPath = join(dir, "relay.mjs");
    const unixSocketPath = join(dir, "relay.sock");
    const readyFilePath = join(dir, "relay-ready-probe");
    await writeFile(relayScriptPath, buildLinuxFenceRelayScript(), {
      encoding: "utf8",
      mode: 0o600,
    });
    echo = await startProbeEchoServer(LINUX_PROBE_GREETING);
    relay = await startUnixBrokerRelay({
      socketPath: unixSocketPath,
      target: { host: "127.0.0.1", port: echo.port },
      platform,
    });
    await execFileAsync(
      effectivePlan.unsharePath,
      [
        "--user",
        "--map-root-user",
        "--net",
        "--fork",
        "--",
        effectivePlan.shellPath,
        "-c",
        buildLinuxFenceProbeScript({
          plan: effectivePlan,
          artifacts: { relayScriptPath, unixSocketPath, readyFilePath },
          expectation: LINUX_PROBE_GREETING,
        }),
      ],
      { timeout: LINUX_PROBE_TIMEOUT_MS, encoding: "utf8" },
    );
    capability = {
      available: true,
      platform,
      mechanism: plan.mechanism,
      detail: `unshare --user --map-root-user --net 可用（ip=${ipPath}）；netns 内 relay 就绪并经宿主 AF_UNIX 转发成功；外部 IP 无路由，出站仅经宿主 AF_UNIX relay`,
    };
  } catch (error) {
    const failure = classifyFailure(error);
    capability = unavailable(
      failure.code,
      `Linux 围栏语义探测失败（需要内核允许 unprivileged user namespace，且 netns 内 ip/relay/AF_UNIX 转发可用）: ${failure.detail}`,
    );
  } finally {
    let cleanupFailure: string | undefined;
    if (relay) {
      try {
        await relay.close();
      } catch (error) {
        cleanupFailure = `AF_UNIX relay 清理失败: ${errorDetail(error)}`;
      }
    }
    if (echo) {
      const failure = await closeProbeServer(echo.server);
      if (failure) cleanupFailure = `${cleanupFailure ? `${cleanupFailure}；` : ""}探测 echo 关闭失败: ${failure}`;
    }
    if (dir) {
      const failure = await releaseFenceTempDir(dir);
      if (failure) cleanupFailure = `${cleanupFailure ? `${cleanupFailure}；` : ""}探测临时目录清理失败: ${failure}`;
    }
    if (cleanupFailure) {
      capability.detail = `${capability.detail}；探测残留清理失败: ${cleanupFailure}`;
    }
  }
  return capability;
}

async function probeDarwin(plan: DarwinFenceCommandPlan): Promise<FenceCapability> {
  const platform: NodeJS.Platform = "darwin";
  if (!(await fileExecutable(plan.sandboxExecPath))) {
    return {
      available: false,
      platform,
      mechanism: plan.mechanism,
      code: "fence.startup_failed",
      detail: `sandbox-exec 不可执行（Apple 可能已移除该已弃用工具）: ${plan.sandboxExecPath}`,
    };
  }
  if (!(await fileExecutable(plan.shellPath))) {
    return {
      available: false,
      platform,
      mechanism: plan.mechanism,
      code: "fence.startup_failed",
      detail: `围栏内 shell 不可执行: ${plan.shellPath}`,
    };
  }
  let dir: string | undefined;
  // fail-closed 缺省：探测未完成前一律按不可用。
  let capability: FenceCapability = {
    available: false,
    platform,
    mechanism: plan.mechanism,
    code: "fence.startup_failed",
    detail: "sandbox-exec 围栏探测未完成",
  };
  try {
    dir = await createFenceTempDir(PROBE_RUN_ID);
    const profilePath = join(dir, "profile.sb");
    const semanticFailure = await verifyDarwinFenceSemantics({
      shellPath: plan.shellPath,
      sandboxExecPath: plan.sandboxExecPath,
      profilePath,
    });
    capability = semanticFailure
      ? {
          available: false,
          platform,
          mechanism: plan.mechanism,
          code: "fence.startup_failed",
          detail: `sandbox-exec 围栏语义探测失败: ${semanticFailure}`,
        }
      : {
          available: true,
          platform,
          mechanism: plan.mechanism,
          deprecated: true,
          detail:
            "sandbox-exec profile 探测通过：放行端口在围栏内可达、非放行端口被拒（系统已标记 deprecated）",
        };
  } catch (error) {
    const failure = classifyFailure(error);
    capability = {
      available: false,
      platform,
      mechanism: plan.mechanism,
      code: failure.code,
      detail: `sandbox-exec 探测失败: ${failure.detail}`,
    };
  } finally {
    if (dir) {
      const cleanupFailure = await releaseFenceTempDir(dir);
      if (cleanupFailure) {
        capability.detail = `${capability.detail}；探测残留清理失败: ${cleanupFailure}`;
      }
    }
  }
  return capability;
}

async function probeCapability(
  platform: NodeJS.Platform,
  options: CreateSpecFenceOptions,
): Promise<FenceCapability> {
  const entry = fencePlatformMatrixEntry(platform);
  // status 而非仅 mechanism 决定可用性：矩阵登记为 unimplemented 的平台必须
  // 在矩阵层 fail-closed，避免仅改 mechanism 字段就意外启用。
  if (entry.status !== "implemented" || entry.mechanism === "unsupported") {
    return {
      available: false,
      platform,
      mechanism: entry.mechanism,
      code: "fence.unsupported_platform",
      detail: entry.notes,
    };
  }
  const plan = buildFenceCommandPlan({
    platform,
    broker: { host: "localhost", port: PROBE_BROKER_PORT },
    shellPath: options.shellPath ?? DEFAULT_POSIX_SHELL_PATH,
    // linux 由 probeLinux 解析绝对路径后覆盖；纯函数构建器缺省值不用于生产命令。
    ...(options.ipPath !== undefined ? { ipPath: options.ipPath } : {}),
    unsharePath: options.unsharePath ?? DEFAULT_UNSHARE_PATH,
    nodePath: options.nodePath,
    linuxEntropy: (options.linuxNetworkEntropy ?? defaultLinuxEntropy)(),
    sandboxExecPath: options.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC_PATH,
  });
  if (plan.mechanism === "unsupported") {
    return {
      available: false,
      platform,
      mechanism: "unsupported",
      code: plan.reason,
      detail: plan.detail,
    };
  }
  return plan.platform === "linux" ? probeLinux(plan, options) : probeDarwin(plan);
}

async function prepareFence(
  platform: NodeJS.Platform,
  options: CreateSpecFenceOptions,
  request: PrepareFenceRequest,
): Promise<SpecFenceHandle> {
  const capability = await probeCapability(platform, options);
  if (!capability.available) {
    throw new FenceStartupError(capability.code, platform, capability.detail);
  }

  let plan: FenceCommandPlan;
  try {
    // 生产命令与探测共用同一绝对 ip 路径；PATH 里的 `ip` 不作为缺省。
    const ipPath =
      platform === "linux" ? await resolveLinuxIpPath(options.ipPath, fileExecutable) : undefined;
    if (platform === "linux" && ipPath === undefined) {
      throw new Error(
        `未找到可执行的 ip（候选绝对路径 ${LINUX_IP_CANDIDATE_PATHS.join(", ")}）；请显式配置 ipPath`,
      );
    }
    // broker 校验（loopback/端口）由构建器负责，错误在此收敛为 typed 启动失败。
    plan = buildFenceCommandPlan({
      platform,
      broker: request.broker,
      shellPath: options.shellPath ?? DEFAULT_POSIX_SHELL_PATH,
      ...(ipPath !== undefined ? { ipPath } : {}),
      unsharePath: options.unsharePath ?? DEFAULT_UNSHARE_PATH,
      nodePath: options.nodePath,
      linuxEntropy: (options.linuxNetworkEntropy ?? defaultLinuxEntropy)(),
      sandboxExecPath: options.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC_PATH,
    });
  } catch (error) {
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (plan.mechanism === "unsupported") {
    throw new FenceStartupError(plan.reason, platform, plan.detail);
  }

  if (activeFences.has(request.runId)) {
    throw new FenceStartupError(
      "fence.residual_conflict",
      platform,
      `runId ${request.runId} 在本进程已有活跃围栏`,
    );
  }
  try {
    const swept = await sweepResidualFences(platform, request.runId);
    options.onResidualSwept?.({ removed: swept.removed });
  } catch (error) {
    if (error instanceof FenceStartupError) throw error;
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `围栏残留对账失败: ${errorDetail(error)}`,
      { cause: error },
    );
  }

  let dir: string;
  try {
    dir = await createFenceTempDir(request.runId);
  } catch (error) {
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `围栏临时目录创建失败: ${errorDetail(error)}`,
      { cause: error },
    );
  }

  let relayServer: UnixBrokerRelayHandle | undefined;
  try {
    if (plan.platform === "linux") {
      const relayScriptPath = join(dir, "relay.mjs");
      const unixSocketPath = join(dir, "relay.sock");
      await writeFile(relayScriptPath, buildLinuxFenceRelayScript(), {
        encoding: "utf8",
        mode: 0o600,
      });
      relayServer = await startUnixBrokerRelay({
        socketPath: unixSocketPath,
        target: request.broker,
        platform,
      });
      // 新 netns 只有 loopback：childBroker 是围栏内 relay 端点，不是宿主 broker。
      const childBroker: FenceChildBroker = { host: "127.0.0.1", port: plan.relayPort };
      const relayHandle = relayServer;
      const handle = makeHandle(
        request,
        plan,
        dir,
        { relayScriptPath, unixSocketPath },
        childBroker,
        async () => {
          await relayHandle.close();
        },
      );
      activeFences.set(request.runId, {
        runId: request.runId,
        mechanism: plan.mechanism,
        broker: request.broker,
        childBroker,
        pid: process.pid,
        startedAt: new Date(),
        dir,
      });
      return handle;
    }
    const profilePath = join(dir, "profile.sb");
    await writeFile(profilePath, plan.profileText, "utf8");
    const childBroker: FenceChildBroker = {
      host: request.broker.host,
      port: request.broker.port,
    };
    const handle = makeHandle(request, plan, dir, { profilePath }, childBroker);
    activeFences.set(request.runId, {
      runId: request.runId,
      mechanism: plan.mechanism,
      broker: request.broker,
      childBroker,
      pid: process.pid,
      startedAt: new Date(),
      dir,
    });
    return handle;
  } catch (error) {
    // 失败原样上抛前先回收本 prepare 自己创建的资源（relay/目录）；
    // 清理失败追加到消息里，不掩盖主错误。
    let cleanupDetail: string | undefined;
    if (relayServer) {
      try {
        await relayServer.close();
      } catch (closeError) {
        cleanupDetail = `AF_UNIX relay 清理失败: ${errorDetail(closeError)}`;
      }
    }
    const dirCleanup = await releaseFenceTempDir(dir);
    if (dirCleanup) {
      cleanupDetail = `${cleanupDetail ? `${cleanupDetail}；` : ""}临时目录清理失败: ${dirCleanup}`;
    }
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `围栏准备失败: ${errorDetail(error)}${cleanupDetail ? `；清理: ${cleanupDetail}` : ""}`,
      { cause: error },
    );
  }
}

function makeHandle(
  request: PrepareFenceRequest,
  plan: LinuxFenceCommandPlan | DarwinFenceCommandPlan,
  dir: string,
  artifacts: FenceArtifactPaths,
  childBroker: FenceChildBroker,
  teardownExtra?: () => Promise<void>,
): SpecFenceHandle {
  return {
    runId: request.runId,
    mechanism: plan.mechanism,
    broker: request.broker,
    childBroker,
    wrapExecutionRequest(execution: ExecutionRequest): ExecutionRequest {
      // Linux 的就绪标记必须每次 wrap 唯一：同一 run 内并发命令各有独立 netns/relay，
      // 共享旧标记会让后发命令在 relay 就绪前提前执行。
      const perCommandArtifacts: FenceArtifactPaths =
        plan.platform === "linux"
          ? {
              ...artifacts,
              readyFilePath: join(dir, `relay-ready-${randomBytes(8).toString("hex")}`),
            }
          : artifacts;
      return {
        ...execution,
        // 执行适配器据此禁止围栏外的 login-shell snapshot / prelude（P6 §3.2）。
        internalFence: { mechanism: plan.mechanism },
        command: buildFencedExecutionCommand({
          plan,
          command: execution.command,
          artifacts: perCommandArtifacts,
        }),
      };
    },
    // 幂等：rm force 对已清理目录是 no-op；AF_UNIX relay close 对已关闭/已删除 socket 是 no-op。
    // 清理失败原样上浮（保留原始错误链）；finally 从活跃表移除，后续 sweep 仍能回收残留。
    async teardown(): Promise<void> {
      try {
        if (teardownExtra) await teardownExtra();
      } finally {
        try {
          await rm(dir, { force: true, recursive: true });
        } finally {
          forgetFenceTempDir(dir);
          activeFences.delete(request.runId);
        }
      }
    },
  };
}

/**
 * 创建围栏契约实现。platform 缺省 process.platform；探测/准备均在调用时执行，
 * 不做跨 run 缓存（避免把一次成功探测当成永久授权）。
 */
export function createSpecFence(options: CreateSpecFenceOptions = {}): SpecFenceContract {
  const platform = options.platform ?? process.platform;
  return {
    probeCapability: () => probeCapability(platform, options),
    prepare: (request) => prepareFence(platform, options, request),
    status: (runId: string): FenceRunStatus | undefined => {
      const active = activeFences.get(runId);
      if (!active) return undefined;
      return {
        runId: active.runId,
        mechanism: active.mechanism,
        broker: active.broker,
        childBroker: active.childBroker,
        pid: active.pid,
        startedAt: active.startedAt,
      };
    },
  };
}
