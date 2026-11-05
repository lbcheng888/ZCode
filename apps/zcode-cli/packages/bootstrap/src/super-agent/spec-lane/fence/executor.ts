/**
 * P6 OS 围栏执行器：能力探测、临时产物落盘、per-run 句柄。
 *
 * fail-closed 纪律（spec §3.4）：
 *   - 探测不确定/失败 = 不可用；prepare 抛 typed FenceStartupError；
 *   - 调用方（dispatcher）据此拒绝启动 spec run，绝不回退到协作式 env 代理；
 *   - teardown 幂等；清理失败原样上浮（保留原始错误链）。
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
  DEFAULT_IP_PATH,
  DEFAULT_NFT_PATH,
  DEFAULT_POSIX_SHELL_PATH,
  DEFAULT_SANDBOX_EXEC_PATH,
  buildDarwinFenceProfile,
  buildFencedExecutionCommand,
  buildFenceCommandPlan,
  buildLinuxFenceNetworkSetupCommands,
  buildLinuxFenceRuleset,
  buildLinuxFenceRulesetCommand,
  type DarwinFenceCommandPlan,
  type FenceCommandPlan,
  type LinuxFenceCommandPlan,
} from "./command-plan.js";
import {
  cleanupLinuxNetwork,
  execNetworkCommand,
  execNetworkCommands,
  startBrokerRelay,
  type BrokerRelayHandle,
} from "./linux-network.js";
import {
  createFenceTempDir,
  forgetFenceTempDir,
  releaseFenceTempDir,
  sweepResidualFences,
} from "./residual.js";

const execFileAsync = promisify(execFile);

/** 探测用哨兵端口：只验证 ruleset 语法与权限，不指向真实 broker。 */
const PROBE_BROKER_PORT = 65535;
const PROBE_TIMEOUT_MS = 10_000;
/** 探测进程的临时目录 owner 标记（不是真实 run）。 */
const PROBE_RUN_ID = "__probe__";
/** sandbox-exec 语义探测：连接被拒绝时脚本的退出码。 */
const PROBE_CONNECT_DENIED_EXIT = 42;

/** Linux 网络计划默认熵（每次调用独立随机，避免 namespace/地址冲突）。 */
function defaultLinuxEntropy(): Uint8Array {
  return randomBytes(8);
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
  nftPath?: string;
  sandboxExecPath?: string;
  /** 网络计划熵（测试注入固定值）；缺省随机 8 字节。 */
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
 * Linux 围栏在子进程降权隔离落地前一律不可用（平台矩阵 status=unimplemented）。
 *
 * 只验证「netns/veth/nftables 能建」不构成安全证据：建网需要 init user namespace 的
 * CAP_SYS_ADMIN/CAP_NET_ADMIN，被围栏子进程与父进程同 UID/同 capabilities，可直接
 * `nft flush ruleset` 或 `nsenter -t 1 -n` 进入宿主 netns 出网（E1/E3 不成立）。
 * 因此这里绝不返回 available；命令脚手架保留供后续实现降权 + 逃逸负向验证。
 */
async function probeLinux(plan: LinuxFenceCommandPlan): Promise<FenceCapability> {
  return {
    available: false,
    platform: "linux",
    mechanism: plan.mechanism,
    code: "fence.unsupported_platform",
    detail:
      "Linux netns 围栏未启用：子进程与特权父进程同 UID/同 capabilities，可 nft flush 或进入宿主 netns；降权隔离与逃逸负向验证未实现（spec §3.3）",
  };
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
  // status 而非仅 mechanism 决定可用性：已有脚手架但语义不成立的平台（Linux）也必须
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
    ipPath: options.ipPath ?? DEFAULT_IP_PATH,
    nftPath: options.nftPath ?? DEFAULT_NFT_PATH,
    runId: PROBE_RUN_ID,
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
  return plan.platform === "linux" ? probeLinux(plan) : probeDarwin(plan);
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
    // broker 校验（loopback/端口）由构建器负责，错误在此收敛为 typed 启动失败。
    plan = buildFenceCommandPlan({
      platform,
      broker: request.broker,
      shellPath: options.shellPath ?? DEFAULT_POSIX_SHELL_PATH,
      ipPath: options.ipPath ?? DEFAULT_IP_PATH,
      nftPath: options.nftPath ?? DEFAULT_NFT_PATH,
      runId: request.runId,
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
    const swept = await sweepResidualFences(platform, request.runId, async (owner) => {
      if (!owner.linuxNetwork) return;
      const detail = await cleanupLinuxNetwork(
        owner.linuxNetwork,
        owner.ipPath ?? DEFAULT_IP_PATH,
      );
      if (detail) throw new Error(`残留 netns/veth 清理失败: ${detail}`);
    });
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
    dir = await createFenceTempDir(
      request.runId,
      plan.platform === "linux"
        ? { linuxNetwork: plan.network, ipPath: plan.ipPath }
        : undefined,
    );
  } catch (error) {
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `围栏临时目录创建失败: ${errorDetail(error)}`,
      { cause: error },
    );
  }

  let relay: BrokerRelayHandle | undefined;
  let linuxPlan: LinuxFenceCommandPlan | undefined;
  let linuxNetworkCreated = false;
  try {
    if (plan.platform === "linux") {
      linuxPlan = plan;
      const network = plan.network;
      await execNetworkCommands(
        buildLinuxFenceNetworkSetupCommands(network, { ipPath: plan.ipPath }),
      );
      linuxNetworkCreated = true;
      // relay 监听 veth 宿主地址，原始 TCP 转发到宿主 loopback egress 代理。
      relay = await startBrokerRelay({
        listenHost: network.hostAddress,
        target: request.broker,
        platform,
      });
      const childBroker: FenceChildBroker = {
        host: network.hostAddress,
        port: relay.port,
      };
      const rulesetPath = join(dir, "ruleset.nft");
      await writeFile(
        rulesetPath,
        buildLinuxFenceRuleset({ network, broker: childBroker }),
        "utf8",
      );
      await execNetworkCommand(
        buildLinuxFenceRulesetCommand(network, rulesetPath, {
          ipPath: plan.ipPath,
          nftPath: plan.nftPath,
        }),
      );
      const relayHandle = relay;
      const handle = makeHandle(request, plan, dir, { rulesetPath }, childBroker, async () => {
        await relayHandle.close();
        const cleanupFailure = await cleanupLinuxNetwork(network, plan.ipPath);
        if (cleanupFailure) throw new Error(`Linux 围栏网络清理失败: ${cleanupFailure}`);
      });
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
    // 失败原样上抛前先回收本 prepare 自己创建的资源（relay/netns/veth/目录）；
    // 清理失败追加到消息里，不掩盖主错误。
    let cleanupDetail: string | undefined;
    if (relay) {
      try {
        await relay.close();
      } catch (closeError) {
        cleanupDetail = `broker relay 清理失败: ${errorDetail(closeError)}`;
      }
    }
    if (linuxNetworkCreated && linuxPlan) {
      const networkCleanup = await cleanupLinuxNetwork(linuxPlan.network, linuxPlan.ipPath);
      if (networkCleanup) {
        cleanupDetail = `${cleanupDetail ? `${cleanupDetail}；` : ""}netns/veth 清理失败: ${networkCleanup}`;
      }
    }
    await releaseFenceTempDir(dir);
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
  artifacts: { rulesetPath?: string; profilePath?: string },
  childBroker: FenceChildBroker,
  teardownExtra?: () => Promise<void>,
): SpecFenceHandle {
  return {
    runId: request.runId,
    mechanism: plan.mechanism,
    broker: request.broker,
    childBroker,
    wrapExecutionRequest(execution: ExecutionRequest): ExecutionRequest {
      return {
        ...execution,
        // 执行适配器据此禁止围栏外的 login-shell snapshot / prelude（P6 §3.2）。
        internalFence: { mechanism: plan.mechanism },
        command: buildFencedExecutionCommand({
          plan,
          command: execution.command,
          artifacts,
        }),
      };
    },
    // 幂等：rm force 对已清理目录是 no-op；Linux 的 netns/veth 删除遇已消失视为成功。
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
