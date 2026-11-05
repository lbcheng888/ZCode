/**
 * P6 OS 围栏命令构建器（纯函数，无 I/O）。
 *
 * 构建/执行分离：本文件只把「平台 + broker 端点 + 子命令」翻译成 argv / profile /
 * ruleset / netns 网络计划，便于三平台分支单测；executor 负责探测、落临时文件、
 * 创建 namespace/veth、启动 broker relay 并包装执行端口。
 *
 * 平台选型按 spec §3.3：linux = 持久 netns + veth + nftables（broker relay 监听
 * veth 宿主端，围栏内只放行该端点）；darwin = sandbox-exec（deprecated，probe
 * 门禁）；win32 = typed unsupported。
 */
import { randomBytes } from "node:crypto";

import type { ExecutionCommand } from "@zcode/contracts";
import type { FenceErrorCode, FenceMechanism } from "./contract.js";

export const DEFAULT_POSIX_SHELL_PATH = "/bin/bash";
export const DEFAULT_IP_PATH = "ip";
export const DEFAULT_NFT_PATH = "nft";
export const DEFAULT_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** Linux 围栏命名空间名前缀（审计/运维识别；进程崩溃残留需人工 `ip netns del`）。 */
export const LINUX_FENCE_NAMESPACE_PREFIX = "zcode-spec-";
/** veth 接口名上限 15 字符（IFNAMSIZ）；前缀 4 + 8 hex = 12。 */
export const LINUX_INTERFACE_PREFIX = "zch-";
export const LINUX_NAMESPACE_INTERFACE_PREFIX = "zcn-";
/** 随机熵长度下限：10 hex 名称 + 4 字节地址段。 */
const LINUX_NETWORK_ENTROPY_BYTES = 8;

/**
 * Linux netns 网络计划（纯数据）。
 *
 * 宿主端 veth 地址 = broker relay 监听地址；namespace 端地址 /30 与宿主端同子网，
 * 因此 namespace 内到宿主端的 TCP 走 veth，无需额外路由。broker relay 再把原始
 * TCP 转发到宿主 127.0.0.1 上的 egress 代理（loopback 在新建 netns 中不可达）。
 */
export interface LinuxFenceNetworkPlan {
  /** `ip netns add` 的命名空间名（含前缀，供审计识别）。 */
  namespaceName: string;
  /** 宿主 netns 内的 veth 端（broker relay 绑定地址所在接口）。 */
  hostInterface: string;
  /** 移入围栏 namespace 的 veth 端。 */
  namespaceInterface: string;
  /** 宿主端 IPv4（relay 监听地址），形如 10.x.y.(4n+1)。 */
  hostAddress: string;
  /** namespace 端 IPv4，形如 10.x.y.(4n+2)。 */
  namespaceAddress: string;
  prefixLength: 30;
}

export interface BuildLinuxFenceNetworkPlanInput {
  /** 本次 run 的稳定 id（审计归属；名称另带随机后缀避免 stale 冲突）。 */
  runId: string;
  /**
   * 随机熵（≥8 字节）。名称与地址由它派生；测试注入固定值以保证可重现，
   * 生产由 executor 使用 crypto.randomBytes(8)。
   */
  entropy: Uint8Array;
}

/**
 * 由熵派生唯一的 namespace / veth 接口 / 地址。
 * 地址段取 10.<1-254>.<1-254>.<0-252，末字节按 /30 对齐（host=base+1, ns=base+2）。
 * 不依赖 runId 哈希，避免同一 runId 在崩溃重启后撞上残留 namespace。
 */
export function buildLinuxFenceNetworkPlan(
  input: BuildLinuxFenceNetworkPlanInput,
): LinuxFenceNetworkPlan {
  if (input.runId.trim().length === 0) {
    throw new Error("Linux 围栏网络计划缺少 runId");
  }
  const entropy = input.entropy;
  if (entropy.length < LINUX_NETWORK_ENTROPY_BYTES) {
    throw new Error(
      `Linux 围栏网络熵不足（需要 ≥${LINUX_NETWORK_ENTROPY_BYTES} 字节，收到 ${entropy.length}）`,
    );
  }
  const suffix = Buffer.from(entropy.subarray(0, 5)).toString("hex");
  const secondOctet = (entropy[5]! % 254) + 1;
  const thirdOctet = (entropy[6]! % 254) + 1;
  const baseLastOctet = (entropy[7]! & 0x3f) << 2;
  return {
    namespaceName: `${LINUX_FENCE_NAMESPACE_PREFIX}${suffix}`,
    hostInterface: `${LINUX_INTERFACE_PREFIX}${suffix.slice(0, 8)}`,
    namespaceInterface: `${LINUX_NAMESPACE_INTERFACE_PREFIX}${suffix.slice(0, 8)}`,
    hostAddress: `10.${secondOctet}.${thirdOctet}.${baseLastOctet + 1}`,
    namespaceAddress: `10.${secondOctet}.${thirdOctet}.${baseLastOctet + 2}`,
    prefixLength: 30,
  };
}

/** Linux 围栏：持久 netns + veth 的宿主 broker relay。 */
export interface LinuxFenceCommandPlan {
  platform: "linux";
  mechanism: "linux-netns-nftables";
  ipPath: string;
  nftPath: string;
  shellPath: string;
  network: LinuxFenceNetworkPlan;
}

/** macOS 围栏：sandbox-exec profile（deprecated），deny network-outbound 仅放行 broker。 */
export interface DarwinFenceCommandPlan {
  platform: "darwin";
  mechanism: "darwin-sandbox-exec";
  sandboxExecPath: string;
  shellPath: string;
  profileText: string;
}

/** 未实现平台：typed unsupported，禁止调用方降级。 */
export interface UnsupportedFenceCommandPlan {
  platform: NodeJS.Platform;
  mechanism: "unsupported";
  reason: FenceErrorCode;
  detail: string;
}

export type FenceCommandPlan =
  | LinuxFenceCommandPlan
  | DarwinFenceCommandPlan
  | UnsupportedFenceCommandPlan;

export interface FenceBrokerEndpoint {
  host: string;
  port: number;
}

export interface BuildFenceCommandPlanInput {
  platform: NodeJS.Platform;
  /** 宿主 egress 代理端点（linux 上仅作 relay 转发目标，必须 loopback）。 */
  broker: FenceBrokerEndpoint;
  /** linux：显式网络计划（测试/executor 复用）；缺省按 runId+entropy 派生。 */
  linuxNetwork?: LinuxFenceNetworkPlan;
  /** linux：runId（派生网络计划时必填）。 */
  runId?: string;
  /** linux：网络计划熵；缺省随机 8 字节（生产路径）。 */
  linuxEntropy?: Uint8Array;
  /** 围栏内执行 shell（POSIX）；缺省 /bin/bash。 */
  shellPath?: string;
  ipPath?: string;
  nftPath?: string;
  sandboxExecPath?: string;
}

export interface FenceArtifactPaths {
  /** Linux：ruleset 临时文件绝对路径。 */
  rulesetPath?: string;
  /** darwin：profile 临时文件绝对路径。 */
  profilePath?: string;
}

/** loopback 判定：宿主 egress 代理只允许 loopback，relay 由围栏自己建。 */
export function isLoopbackBrokerHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function assertBrokerEndpoint(broker: FenceBrokerEndpoint): void {
  if (!isLoopbackBrokerHost(broker.host)) {
    throw new Error(`egress 围栏 broker 必须是 loopback（收到 ${broker.host}）`);
  }
  if (!Number.isInteger(broker.port) || broker.port < 1 || broker.port > 65535) {
    throw new Error(`egress 围栏 broker 端口非法: ${broker.port}`);
  }
}

/** POSIX shell 单引号转义；空串与含特殊字符的参数安全拼接。 */
export function quotePosixShellArg(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Linux 规则集：默认拒绝，只允许 namespace 端到宿主 veth 地址上的 broker relay。
 * input 放行 lo（命名空间内本机通信）与 namespace veth（relay 回包）；
 * output 只放行经 namespace veth 到 broker 宿主机地址/端口的 TCP。
 * 其它出站（含 DNS、直连 IP/任意端口）一律 drop。
 */
export function buildLinuxFenceRuleset(input: {
  network: LinuxFenceNetworkPlan;
  broker: FenceBrokerEndpoint;
}): string {
  const { network, broker } = input;
  if (broker.host !== network.hostAddress) {
    throw new Error(
      `Linux 围栏 relay 必须监听 veth 宿主地址 ${network.hostAddress}（收到 ${broker.host}）`,
    );
  }
  if (!Number.isInteger(broker.port) || broker.port < 1 || broker.port > 65535) {
    throw new Error(`Linux 围栏 relay 端口非法: ${broker.port}`);
  }
  return [
    "table inet zcode_spec_fence {",
    "  chain input {",
    "    type filter hook input priority 0; policy drop;",
    '    iif "lo" accept;',
    `    iif "${network.namespaceInterface}" accept;`,
    "  }",
    "  chain output {",
    "    type filter hook output priority 0; policy drop;",
    `    oif "${network.namespaceInterface}" ip daddr ${network.hostAddress} tcp dport ${broker.port} accept;`,
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * 建 namespace 与 veth 的 argv 序列。executor 按顺序执行；nft 载入依赖 relay
 * 端口，因此在 relay 启动后由 buildLinuxFenceRulesetCommand 单独执行。
 */
export function buildLinuxFenceNetworkSetupCommands(
  network: LinuxFenceNetworkPlan,
  options: { ipPath?: string } = {},
): readonly (readonly string[])[] {
  const ip = options.ipPath ?? DEFAULT_IP_PATH;
  return [
    [ip, "netns", "add", network.namespaceName],
    [
      ip,
      "link",
      "add",
      network.hostInterface,
      "type",
      "veth",
      "peer",
      "name",
      network.namespaceInterface,
    ],
    [ip, "link", "set", network.namespaceInterface, "netns", network.namespaceName],
    [ip, "link", "set", network.hostInterface, "up"],
    [
      ip,
      "addr",
      "add",
      `${network.hostAddress}/${network.prefixLength}`,
      "dev",
      network.hostInterface,
    ],
    [ip, "netns", "exec", network.namespaceName, ip, "link", "set", "lo", "up"],
    [
      ip,
      "netns",
      "exec",
      network.namespaceName,
      ip,
      "link",
      "set",
      network.namespaceInterface,
      "up",
    ],
    [
      ip,
      "netns",
      "exec",
      network.namespaceName,
      ip,
      "addr",
      "add",
      `${network.namespaceAddress}/${network.prefixLength}`,
      "dev",
      network.namespaceInterface,
    ],
  ];
}

/** 在 namespace 内载入 nft 规则集（relay 端口已知后才执行）。 */
export function buildLinuxFenceRulesetCommand(
  network: LinuxFenceNetworkPlan,
  rulesetPath: string,
  options: { ipPath?: string; nftPath?: string } = {},
): readonly string[] {
  const ip = options.ipPath ?? DEFAULT_IP_PATH;
  const nft = options.nftPath ?? DEFAULT_NFT_PATH;
  return [ip, "netns", "exec", network.namespaceName, nft, "-f", rulesetPath];
}

/**
 * teardown 的 argv 序列（幂等由 executor 层处理：已消失视为成功）。
 * 先删 namespace（随其回收 namespace 端 veth），再删宿主端（部分内核会残留）。
 */
export function buildLinuxFenceTeardownCommands(
  network: LinuxFenceNetworkPlan,
  options: { ipPath?: string } = {},
): readonly (readonly string[])[] {
  const ip = options.ipPath ?? DEFAULT_IP_PATH;
  return [
    [ip, "netns", "del", network.namespaceName],
    [ip, "link", "del", network.hostInterface],
  ];
}

/**
 * macOS profile：默认放行（文件系统等由结构隔离负责），出站全拒，仅
 * localhost:brokerPort 可达。sandbox-exec 的 `remote ip` 只接受 `localhost` 或
 * `*`（实测 `127.0.0.1:port` 编译期报 "host must be * or localhost"）。
 */
export function buildDarwinFenceProfile(brokerPort: number): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound)",
    `(allow network-outbound (remote ip "localhost:${brokerPort}"))`,
    "",
  ].join("\n");
}

export function buildFenceCommandPlan(input: BuildFenceCommandPlanInput): FenceCommandPlan {
  assertBrokerEndpoint(input.broker);
  const shellPath = input.shellPath ?? DEFAULT_POSIX_SHELL_PATH;

  switch (input.platform) {
    case "linux": {
      const network =
        input.linuxNetwork ??
        buildLinuxFenceNetworkPlan({
          runId: input.runId ?? "linux-fence",
          entropy: input.linuxEntropy ?? randomBytes(LINUX_NETWORK_ENTROPY_BYTES),
        });
      return {
        platform: "linux",
        mechanism: "linux-netns-nftables",
        ipPath: input.ipPath ?? DEFAULT_IP_PATH,
        nftPath: input.nftPath ?? DEFAULT_NFT_PATH,
        shellPath,
        network,
      };
    }
    case "darwin":
      return {
        platform: "darwin",
        mechanism: "darwin-sandbox-exec",
        sandboxExecPath: input.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC_PATH,
        shellPath,
        profileText: buildDarwinFenceProfile(input.broker.port),
      };
    case "win32":
      return {
        platform: "win32",
        mechanism: "unsupported",
        reason: "fence.unsupported_platform",
        detail:
          "Windows WFP/AppContainer 围栏未实现（spec §3.3/§3.6）；启用围栏时 Windows spec run 必须拒绝启动。",
      };
    default:
      return {
        platform: input.platform,
        mechanism: "unsupported",
        reason: "fence.unsupported_platform",
        detail: `平台 ${input.platform} 未登记 OS 围栏实现；按能力缺席 fail-closed。`,
      };
  }
}

function resolveInnerShellPath(plan: LinuxFenceCommandPlan | DarwinFenceCommandPlan, command: ExecutionCommand): string {
  if (command.mode === "shell") {
    return command.shellOverride?.path ?? plan.shellPath;
  }
  return plan.shellPath;
}

function buildShellCommand(
  original: Extract<ExecutionCommand, { mode: "shell" }>,
  commandText: string,
): ExecutionCommand {
  return {
    mode: "shell",
    command: commandText,
    ...(original.shell !== undefined ? { shell: original.shell } : {}),
    ...(original.shellProfile !== undefined ? { shellProfile: original.shellProfile } : {}),
    ...(original.shellOverride !== undefined ? { shellOverride: original.shellOverride } : {}),
  };
}

/**
 * 把一条执行命令改写成围栏内执行。
 * - argv：linux = `ip netns exec <ns> <file> <args>`；darwin = sandbox-exec 前缀；
 * - shell：保留外层 shell 选择（shell/shellProfile/shellOverride），命令字符串
 *   前缀围栏调用，原始命令作为内层 `-c` 载荷，外层 cwd/捕获语义不变。
 */
export function buildFencedExecutionCommand(input: {
  plan: FenceCommandPlan;
  command: ExecutionCommand;
  artifacts: FenceArtifactPaths;
}): ExecutionCommand {
  const { plan, command, artifacts } = input;
  if (plan.mechanism === "unsupported") {
    throw new Error(`${plan.reason}: ${plan.detail}`);
  }

  if (plan.platform === "darwin") {
    const profilePath = artifacts.profilePath;
    if (!profilePath) throw new Error("darwin 围栏缺少 profilePath");
    if (command.mode === "argv") {
      return {
        mode: "argv",
        file: plan.sandboxExecPath,
        args: ["-f", profilePath, "--", command.file, ...(command.args ?? [])],
      };
    }
    const innerShell = resolveInnerShellPath(plan, command);
    const wrapped = [
      quotePosixShellArg(plan.sandboxExecPath),
      "-f",
      quotePosixShellArg(profilePath),
      "--",
      quotePosixShellArg(innerShell),
      "-c",
      quotePosixShellArg(command.command),
    ].join(" ");
    return buildShellCommand(command, wrapped);
  }

  const network = plan.network;
  if (command.mode === "argv") {
    return {
      mode: "argv",
      file: plan.ipPath,
      args: [
        "netns",
        "exec",
        network.namespaceName,
        command.file,
        ...(command.args ?? []),
      ],
    };
  }
  const innerShell = resolveInnerShellPath(plan, command);
  // 不用 `exec`：保留外层 shell，使退出码/后置处理仍由外层执行。
  const wrapped = [
    quotePosixShellArg(plan.ipPath),
    "netns",
    "exec",
    quotePosixShellArg(network.namespaceName),
    quotePosixShellArg(innerShell),
    "-c",
    quotePosixShellArg(command.command),
  ].join(" ");
  return buildShellCommand(command, wrapped);
}

/** 供测试/诊断：一次围栏计划选用的机制。 */
export function fencePlanMechanism(plan: FenceCommandPlan): FenceMechanism {
  return plan.mechanism;
}
