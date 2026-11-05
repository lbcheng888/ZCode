/**
 * P6 OS 围栏命令构建器（纯函数，无 I/O）。
 *
 * 构建/执行分离：本文件只把「平台 + broker 端点 + 子命令」翻译成 argv / profile /
 * ruleset 文本，便于三平台分支单测；executor 负责探测、落临时文件、包装执行端口。
 *
 * 平台选型按 spec §3.3：linux = unshare --net + nftables；darwin = sandbox-exec
 * （deprecated，probe 门禁）；win32 = typed unsupported。
 */
import type { ExecutionCommand } from "@zcode/contracts";
import type { FenceErrorCode, FenceMechanism } from "./contract.js";

export const DEFAULT_POSIX_SHELL_PATH = "/bin/bash";
export const DEFAULT_UNSHARE_PATH = "unshare";
export const DEFAULT_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** Linux 围栏：unshare --net 内只放行 loopback 到 broker 端口的 nftables 规则。 */
export interface LinuxFenceCommandPlan {
  platform: "linux";
  mechanism: "linux-netns-nftables";
  unsharePath: string;
  shellPath: string;
  /** `nft -f <rulesetPath>` 读取的默认拒绝规则集。 */
  rulesetText: string;
  /** 在 netns 内执行的 setup 脚本：lo up → nft 载入 → exec 子命令。 */
  setupScript: string;
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
  broker: FenceBrokerEndpoint;
  /** 围栏内执行 shell（POSIX）；缺省 /bin/bash。 */
  shellPath?: string;
  unsharePath?: string;
  sandboxExecPath?: string;
}

export interface FenceArtifactPaths {
  /** Linux：ruleset 临时文件绝对路径。 */
  rulesetPath?: string;
  /** darwin：profile 临时文件绝对路径。 */
  profilePath?: string;
}

/** loopback 判定：围栏只放行本地 egress 代理， broker 不允许是外部地址。 */
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
 * Linux 规则集：默认拒绝，仅允许 loopback 到 broker 端口。
 * input 放行 iif lo（broker 回包），output 只放行 oif lo tcp dport brokerPort。
 *
 * 注意：unshare --net 会创建独立 netns，宿主机 127.0.0.1 上的 egress 代理
 * 默认不可达；spec §3.4 要求 broker 跨围栏经 veth/命名空间内 broker，该 broker
 * 侧接线不在本 lane。因此本机制只支持零 egress 硬隔离（egressScope =
 * "zero-egress-only"）；非空 allowHosts 由 executor prepare 直接 typed 拒绝。
 * 规则集仍保留放行 broker 端口，为将来 veth/围栏内 broker 铺路。
 */
export function buildLinuxFenceRuleset(brokerPort: number): string {
  return [
    "table inet zcode_spec_fence {",
    "  chain input {",
    "    type filter hook input priority 0; policy drop;",
    '    iif "lo" accept;',
    "  }",
    "  chain output {",
    "    type filter hook output priority 0; policy drop;",
    `    oif "lo" tcp dport ${brokerPort} accept;`,
    "  }",
    "}",
    "",
  ].join("\n");
}

const LINUX_FENCE_SETUP_SCRIPT = [
  "set -eu",
  'ip link set lo up',
  'nft -f "$1"',
  "shift",
  'exec "$@"',
].join("\n");

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
    case "linux":
      return {
        platform: "linux",
        mechanism: "linux-netns-nftables",
        unsharePath: input.unsharePath ?? DEFAULT_UNSHARE_PATH,
        shellPath,
        rulesetText: buildLinuxFenceRuleset(input.broker.port),
        setupScript: LINUX_FENCE_SETUP_SCRIPT,
      };
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
 * - argv：直接加围栏前缀可执行文件；
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

  const rulesetPath = artifacts.rulesetPath;
  if (!rulesetPath) throw new Error("linux 围栏缺少 rulesetPath");
  if (command.mode === "argv") {
    return {
      mode: "argv",
      file: plan.unsharePath,
      args: [
        "--net",
        "--map-root-user",
        "--fork",
        "--",
        plan.shellPath,
        "-c",
        plan.setupScript,
        "zcode-spec-fence",
        rulesetPath,
        command.file,
        ...(command.args ?? []),
      ],
    };
  }
  const innerShell = resolveInnerShellPath(plan, command);
  // 不用 `exec`：保留外层 shell，使退出码/后置处理（以及将来可行的内层状态回收）
  // 仍由外层执行；`exec` 会把外层 shell 整体替换成 unshare，后置语句永不执行。
  const wrapped = [
    quotePosixShellArg(plan.unsharePath),
    "--net",
    "--map-root-user",
    "--fork",
    "--",
    quotePosixShellArg(plan.shellPath),
    "-c",
    quotePosixShellArg(plan.setupScript),
    "zcode-spec-fence",
    quotePosixShellArg(rulesetPath),
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
