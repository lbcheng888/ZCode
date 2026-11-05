/**
 * P6 OS 围栏命令构建器（纯函数，无 I/O）。
 *
 * 构建/执行分离：本文件只把「平台 + broker 端点 + 子命令」翻译成 argv / profile /
 * relay 脚本，便于三平台分支单测；executor 负责探测、落临时文件、启动宿主
 * AF_UNIX relay 并包装执行端口。
 *
 * 平台选型按 spec §3.3：
 *   linux  = per-command `unshare --user --map-root-user --net --fork`；
 *            新 netns 只有 loopback（无外部路由），围栏内 127.0.0.1 TCP relay
 *            经宿主 AF_UNIX socket 转发到 egress broker；
 *   darwin = sandbox-exec（deprecated，probe 门禁）；
 *   win32  = typed unsupported。
 *
 * Linux 机制不需要 root/veth/nftables：用户命名空间内建 netns 自带 CAP_NET_ADMIN，
 * 只能启用新 netns 的 lo；外部 IP 因无路由结构性不可达。子进程在宿主 user
 * namespace 无 CAP_SYS_ADMIN，`nsenter -t 1 -n` 无法进入宿主 netns。
 */
import { randomBytes } from "node:crypto";

import type { ExecutionCommand } from "@zcode/contracts";
import type { FenceErrorCode, FenceMechanism } from "./contract.js";

export const DEFAULT_POSIX_SHELL_PATH = "/bin/bash";
/**
 * 纯函数构建器的缺省值；生产执行器必须先按绝对候选路径解析（见
 * LINUX_IP_CANDIDATE_PATHS），不得依赖 PATH 里的 `ip`。
 */
export const DEFAULT_IP_PATH = "ip";
/** Linux `ip` 可执行文件候选绝对路径：桌面/服务进程 PATH 常不含 /usr/sbin。 */
export const LINUX_IP_CANDIDATE_PATHS = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip"] as const;
export const DEFAULT_UNSHARE_PATH = "/usr/bin/unshare";
/**
 * relay 由宿主 Node 可执行文件运行（与 CLI 同二进制，不猜 PATH 里的 node）。
 * desktop 宿主是 Electron 二进制：启动时显式注入 ELECTRON_RUN_AS_NODE=1，
 * 否则无 node 模式；纯 Node 忽略该变量。
 */
export const DEFAULT_NODE_PATH = process.execPath;
export const DEFAULT_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * 围栏内 TCP relay 监听端口范围。每次命令都新建独立 netns（只有 loopback），
 * 端口空间互相隔离，因此端口只用于生成 childBroker 与 proxy env；范围避开常见
 * 服务端口，同时保证有足够熵避免同一 run 内可观察冲突。
 */
export const LINUX_FENCE_RELAY_PORT_BASE = 20_000;
export const LINUX_FENCE_RELAY_PORT_SPAN = 40_000;
/** relay 端口熵下限：2 字节（16 bit 摊入 40000 端口）。 */
const LINUX_FENCE_RELAY_ENTROPY_BYTES = 2;

/** 由熵派生围栏内 relay 端口；测试注入固定熵保证可重现。 */
export function buildLinuxFenceRelayPort(entropy: Uint8Array): number {
  if (entropy.length < LINUX_FENCE_RELAY_ENTROPY_BYTES) {
    throw new Error(
      `Linux 围栏 relay 端口熵不足（需要 ≥${LINUX_FENCE_RELAY_ENTROPY_BYTES} 字节，收到 ${entropy.length}）`,
    );
  }
  const value = entropy[0]! * 256 + entropy[1]!;
  return LINUX_FENCE_RELAY_PORT_BASE + (value % LINUX_FENCE_RELAY_PORT_SPAN);
}

/** Linux 围栏：rootless user+net namespace，命令执行时由 `unshare` 临时创建。 */
export interface LinuxFenceCommandPlan {
  platform: "linux";
  mechanism: "linux-userns-netns-unix-relay";
  unsharePath: string;
  ipPath: string;
  nodePath: string;
  shellPath: string;
  /** 围栏内 TCP relay 监听端口（新 netns 的 127.0.0.1）。 */
  relayPort: number;
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
  /** 宿主 egress 代理端点（linux 上仅作宿主 AF_UNIX relay 的 TCP 转发目标）。 */
  broker: FenceBrokerEndpoint;
  /** linux：relay 端口熵；缺省随机 2 字节（生产路径）。 */
  linuxEntropy?: Uint8Array;
  /** 围栏内执行 shell（POSIX）；缺省 /bin/bash。 */
  shellPath?: string;
  ipPath?: string;
  unsharePath?: string;
  nodePath?: string;
  sandboxExecPath?: string;
}

export interface FenceArtifactPaths {
  /** linux：围栏内 relay 脚本绝对路径（同一 mount namespace 可见）。 */
  relayScriptPath?: string;
  /** linux：宿主 AF_UNIX relay socket 绝对路径（同一 mount namespace 可见）。 */
  unixSocketPath?: string;
  /** linux：本次命令的 relay 就绪标记（每次 wrap 唯一，避免并发命令互相等待）。 */
  readyFilePath?: string;
  /** darwin：profile 临时文件绝对路径。 */
  profilePath?: string;
}

/**
 * 按绝对候选路径解析 Linux `ip`（探测与 bootstrap 共用同一解析结果）。
 * 显式配置优先；注入可执行性检查以保持本函数无 I/O（便于跨平台单测）。
 */
export async function resolveLinuxIpPath(
  configured: string | undefined,
  isExecutable: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (configured !== undefined) {
    return (await isExecutable(configured)) ? configured : undefined;
  }
  for (const candidate of LINUX_IP_CANDIDATE_PATHS) {
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
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
 * 围栏内 relay 脚本（Node ESM，写入 fence 临时目录，同一 mount namespace）。
 *
 * 参数：argv[2] = 宿主 AF_UNIX socket 路径，argv[3] = 就绪标记路径，
 * argv[4] = 监听端口（生产 = plan.relayPort；测试可用 0 由内核分配）。
 * 在围栏 netns 的 127.0.0.1:<port> 监听，把每条 TCP 连接逐字节转发到宿主
 * AF_UNIX socket（宿主 relay 再转发到 egress broker）。只搬字节，不解释协议；
 * allowlist 仍由 broker 裁决。listen 成功后写就绪标记（含实际端口），父 shell
 * 据此才开始执行用户命令。
 */
export function buildLinuxFenceRelayScript(): string {
  return [
    'import { connect as connectUnix, createServer } from "node:net";',
    'import { writeFileSync } from "node:fs";',
    "",
    "const [socketPath, readyPath, portValue] = process.argv.slice(2);",
    "const port = Number(portValue);",
    "if (!socketPath || !readyPath || !Number.isInteger(port) || port < 0 || port > 65535) {",
    '  console.error("spec fence relay: 缺少/非法 AF_UNIX、ready 或端口参数");',
    "  process.exit(2);",
    "}",
    "const sockets = new Set();",
    "const server = createServer((client) => {",
    "  const upstream = connectUnix(socketPath);",
    "  const track = (socket) => {",
    "    sockets.add(socket);",
    '    socket.on("close", () => sockets.delete(socket));',
    "  };",
    "  track(client);",
    "  track(upstream);",
    "  const destroyBoth = () => {",
    "    client.destroy();",
    "    upstream.destroy();",
    "  };",
    '  client.on("error", destroyBoth);',
    '  upstream.on("error", destroyBoth);',
    '  client.on("end", () => upstream.end());',
    '  upstream.on("end", () => client.end());',
    "  client.pipe(upstream);",
    "  upstream.pipe(client);",
    "});",
    'server.on("error", (error) => {',
    "  console.error(`spec fence relay: ${error.message}`);",
    "  process.exit(1);",
    "});",
    'server.listen(port, "127.0.0.1", () => {',
    "  const address = server.address();",
    "  const actualPort =",
    '    typeof address === "object" && address !== null ? address.port : port;',
    "  writeFileSync(readyPath, `${JSON.stringify({ port: actualPort })}\\n`, {",
    '    encoding: "utf8",',
    "    mode: 0o600,",
    "  });",
    "});",
    "const stop = () => {",
    "  for (const socket of sockets) socket.destroy();",
    "  server.close(() => process.exit(0));",
    "};",
    'process.on("SIGTERM", stop);',
    'process.on("SIGINT", stop);',
    "// 父 shell 被 kill（trap 未执行）后避免孤儿 relay 占住 netns。",
    "const parentPid = process.ppid;",
    "setInterval(() => {",
    "  if (process.ppid !== parentPid) stop();",
    "}, 500).unref();",
    "",
  ].join("\n");
}

function resolveInnerShellPath(
  plan: LinuxFenceCommandPlan | DarwinFenceCommandPlan,
  command: ExecutionCommand,
): string {
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

/** relay 就绪等待：整数秒粒度（不依赖 fractional sleep，BusyBox 同样可用）。 */
const LINUX_RELAY_READY_MAX_TRIES = 10;
const LINUX_RELAY_READY_SLEEP_SECONDS = 1;
/** Electron 二进制需此变量才按 Node 运行；纯 Node 忽略。 */
const LINUX_RELAY_NODE_ENV = "ELECTRON_RUN_AS_NODE=1";

type LinuxRelayArtifacts = Required<
  Pick<FenceArtifactPaths, "relayScriptPath" | "unixSocketPath" | "readyFilePath">
>;

/**
 * 围栏内 relay 启动 + 就绪等待（bootstrap 与语义探测共用，保证探测验证的就是
 * 生产启动路径）。就绪标记叠加 shell PID，并发/重试命令互不串台；relay 在就绪
 * 前退出立即 125，不等满预算。
 */
function buildLinuxRelayStartupLines(input: {
  plan: LinuxFenceCommandPlan;
  artifacts: LinuxRelayArtifacts;
}): string[] {
  const { plan, artifacts } = input;
  return [
    `ready=${quotePosixShellArg(artifacts.readyFilePath)}.$$`,
    `rm -f "$ready"`,
    `${LINUX_RELAY_NODE_ENV} ${quotePosixShellArg(plan.nodePath)} ${quotePosixShellArg(artifacts.relayScriptPath)} ${quotePosixShellArg(artifacts.unixSocketPath)} "$ready" ${plan.relayPort} &`,
    "relay_pid=$!",
    `trap 'kill "$relay_pid" 2>/dev/null' EXIT`,
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    "tries=0",
    `while [ ! -s "$ready" ]; do`,
    "  tries=$((tries + 1))",
    `  if [ "$tries" -ge ${LINUX_RELAY_READY_MAX_TRIES} ]; then`,
    `    echo "spec fence: relay 未能在 127.0.0.1:${plan.relayPort} 就绪" >&2`,
    "    exit 125",
    "  fi",
    `  if ! kill -0 "$relay_pid" 2>/dev/null; then`,
    `    echo "spec fence: relay 进程在就绪前退出" >&2`,
    "    exit 125",
    "  fi",
    `  sleep ${LINUX_RELAY_READY_SLEEP_SECONDS}`,
    "done",
  ];
}

/**
 * Linux 围栏语义探测脚本（bash；/dev/tcp 是 bash 特性，缺省 shell 即 /bin/bash）。
 * 在真实 netns 内启动生产 relay，等就绪后经 relay 读回宿主 echo 的招呼串，
 * 证明「netns 内 TCP → AF_UNIX → 宿主」整条转发链路可用，而不是只查 X_OK。
 */
export function buildLinuxFenceProbeScript(input: {
  plan: LinuxFenceCommandPlan;
  artifacts: LinuxRelayArtifacts;
  expectation: string;
}): string {
  const { plan, artifacts, expectation } = input;
  return [
    `${quotePosixShellArg(plan.ipPath)} link set lo up || exit 125`,
    ...buildLinuxRelayStartupLines({ plan, artifacts }),
    `exec 3<>/dev/tcp/127.0.0.1/${plan.relayPort} || exit 125`,
    "IFS= read -r -t 5 greeting <&3 || exit 125",
    "exec 3<&-",
    `[ "$greeting" = ${quotePosixShellArg(expectation)} ] || { echo "spec fence: relay 转发结果与期望不符" >&2; exit 125; }`,
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Linux 围栏 bootstrap 脚本：在 unshare 创建的 user+net namespace 内执行。
 *
 * 顺序严格为：启用 lo → 启动 netns 内 relay → 等就绪 → 用 childBroker 代理 env
 * 执行用户命令 → 结束（EXIT trap 杀 relay）→ 透传命令退出码。relay 启动失败或
 * 就绪超时 = 125（run 失败），绝不静默直连。
 */
export function buildLinuxFenceBootstrapScript(input: {
  plan: LinuxFenceCommandPlan;
  command: ExecutionCommand;
  artifacts: LinuxRelayArtifacts;
}): string {
  const { plan, command, artifacts } = input;
  const proxyUrl = `http://127.0.0.1:${plan.relayPort}`;
  const innerCommand =
    command.mode === "argv"
      ? [quotePosixShellArg(command.file), ...(command.args ?? []).map(quotePosixShellArg)].join(
          " ",
        )
      : [
          quotePosixShellArg(resolveInnerShellPath(plan, command)),
          "-c",
          quotePosixShellArg(command.command),
        ].join(" ");
  return [
    `${quotePosixShellArg(plan.ipPath)} link set lo up || exit 125`,
    ...buildLinuxRelayStartupLines({ plan, artifacts }),
    `HTTP_PROXY=${quotePosixShellArg(proxyUrl)} HTTPS_PROXY=${quotePosixShellArg(proxyUrl)} ALL_PROXY=${quotePosixShellArg(proxyUrl)}`,
    `http_proxy=${quotePosixShellArg(proxyUrl)} https_proxy=${quotePosixShellArg(proxyUrl)} all_proxy=${quotePosixShellArg(proxyUrl)}`,
    "NO_PROXY='' no_proxy=''",
    "export HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy",
    innerCommand,
    "status=$?",
    'exit "$status"',
    "",
  ].join("\n");
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
    case "linux":
      return {
        platform: "linux",
        mechanism: "linux-userns-netns-unix-relay",
        unsharePath: input.unsharePath ?? DEFAULT_UNSHARE_PATH,
        ipPath: input.ipPath ?? DEFAULT_IP_PATH,
        nodePath: input.nodePath ?? DEFAULT_NODE_PATH,
        shellPath,
        relayPort: buildLinuxFenceRelayPort(
          input.linuxEntropy ?? randomBytes(LINUX_FENCE_RELAY_ENTROPY_BYTES),
        ),
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

function requireLinuxArtifacts(
  artifacts: FenceArtifactPaths,
): Required<Pick<FenceArtifactPaths, "relayScriptPath" | "unixSocketPath" | "readyFilePath">> {
  const { relayScriptPath, unixSocketPath, readyFilePath } = artifacts;
  if (!relayScriptPath || !unixSocketPath || !readyFilePath) {
    throw new Error("Linux 围栏缺少 relay 脚本 / AF_UNIX socket / 就绪标记路径");
  }
  return { relayScriptPath, unixSocketPath, readyFilePath };
}

/**
 * 把一条执行命令改写成围栏内执行。
 * - linux：argv = `unshare --user --map-root-user --net --fork -- <shell> -c <bootstrap>`；
 *   shell 风格的原始命令也走 argv（用户命令由 bootstrap 内层 shell 执行），
 *   避免外层 shell/rc 在围栏外参与；
 * - darwin：argv = sandbox-exec 前缀；shell 保留外层 shell 选择。
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

  const relayArtifacts = requireLinuxArtifacts(artifacts);
  const script = buildLinuxFenceBootstrapScript({
    plan,
    command,
    artifacts: relayArtifacts,
  });
  return {
    mode: "argv",
    file: plan.unsharePath,
    args: [
      "--user",
      "--map-root-user",
      "--net",
      "--fork",
      "--",
      plan.shellPath,
      "-c",
      script,
    ],
  };
}

/** 供测试/诊断：一次围栏计划选用的机制。 */
export function fencePlanMechanism(plan: FenceCommandPlan): FenceMechanism {
  return plan.mechanism;
}
