/**
 * P6 OS 级 egress 围栏（spec §3）对外契约。
 *
 * 协作式 env 代理不是安全边界（spec-lane §0/§5/§8-6 的已知残留）；本模块提供
 * 内核/OS 层的第二道硬约束：围栏内子进程只允许到达本地 egress 代理，其余出站
 * 一律拒绝。平台能力缺席即关闭能力——准备失败抛 typed FenceStartupError，spec
 * run 拒绝启动，绝不静默回退到 env 代理。
 *
 * 每个平台只允许一个“主围栏实现”（spec §3.3）：
 *   linux  = rootless user+net namespace + AF_UNIX→TCP broker relay（无需 root/veth/nft）
 *   darwin = sandbox-exec profile（Apple 已标记 deprecated，探测失败即关闭）
 *   win32  = 尚未实现，typed unsupported（不得静默降级）
 */
import type { ExecutionRequest } from "@zcode/contracts";

export type FenceMechanism =
  | "linux-userns-netns-unix-relay"
  | "darwin-sandbox-exec"
  | "unsupported";

export type FenceErrorCode =
  | "fence.unsupported_platform"
  | "fence.permission_denied"
  | "fence.startup_failed"
  | "fence.residual_conflict";

/**
 * 围栏可承载的 egress 范围（机器可读，不靠 notes 文字免责）：
 * - "allowlist"：broker 可达，可有条件转发白名单 host（E5）；
 * - "zero-egress-only"：围栏内只能到达 broker 自身（若 broker 在围栏内可达），
 *   无法把宿主 loopback broker 跨 namespace 接进来；非空白名单必须拒绝启动。
 */
export type FenceEgressScope = "allowlist" | "zero-egress-only";

/**
 * 围栏内子进程实际可见的 broker 端点。
 * darwin：与宿主 egress 代理同址（localhost:<port>）；
 * linux：新 netns 只有 loopback，围栏内 relay 监听 127.0.0.1:<relayPort>（每次
 * 命令独立 netns），再经宿主 AF_UNIX socket 转发到 egress broker；子进程 env
 * 指向该端点。dispatcher 必须按 childBroker 重写 HTTP_PROXY/network，不能沿用
 * 宿主 loopback。
 */
export interface FenceChildBroker {
  host: string;
  port: number;
}

/** 平台矩阵：未实现平台必须显式登记为 unimplemented，不允许“能跑就降级”。 */
export interface FencePlatformMatrixEntry {
  platform: NodeJS.Platform;
  mechanism: FenceMechanism;
  status: "implemented" | "unimplemented";
  /** implemented 平台必须声明能力范围；unimplemented 可缺席。 */
  egressScope?: FenceEgressScope;
  /** sandbox-exec 已被 Apple 标记 deprecated；仅作为 CLI 形态唯一可用的按进程围栏。 */
  deprecated?: boolean;
  notes: string;
}

export const SPEC_FENCE_PLATFORM_MATRIX: readonly FencePlatformMatrixEntry[] = [
  {
    platform: "linux",
    mechanism: "linux-userns-netns-unix-relay",
    status: "implemented",
    egressScope: "allowlist",
    notes:
      "rootless：每条命令经 `unshare --user --map-root-user --net --fork` 进入独立 user+net namespace；新 netns 只有 loopback，无外部路由（外部 IP 结构性不可达）。围栏内 Node relay 监听 127.0.0.1:<relayPort>，经宿主 AF_UNIX socket（0700 目录内 0600）转发到宿主 loopback egress broker；env 代理是协作层，硬约束来自 netns。子进程在宿主 userns 无 CAP_SYS_ADMIN，`nsenter -t 1 -n` 无法进入宿主 netns。不依赖 root/veth/nftables；内核禁用 unprivileged user namespaces 或缺少 unshare/ip 时 probe 在真实 netns 内启动 relay 并验证一次转发，失败返回 typed unavailable，run 拒绝启动。AF_UNIX 文件系统 socket 不受 netns 约束：围栏内子进程与宿主同 uid，可访问该用户可访问的宿主 unix socket（docker.sock/ssh-agent 等）；同 uid 本机攻击者不在威胁模型，本围栏只约束 IP 网络，不宣称唯一可达外部 = broker。",
  },
  {
    platform: "darwin",
    mechanism: "darwin-sandbox-exec",
    status: "implemented",
    egressScope: "allowlist",
    deprecated: true,
    notes:
      "sandbox-exec profile：deny network-outbound，仅放行 localhost:<brokerPort>；broker 与围栏同在宿主 loopback，可承载白名单转发（E5）。probe 除可执行/编译外还验证语义（允许端口真可达、非允许端口真被拒）。系统已标记 deprecated（spec §3.3/§5-3），探测失败即关闭该平台 spec lane。",
  },
  {
    platform: "win32",
    mechanism: "unsupported",
    status: "unimplemented",
    notes:
      "WFP / AppContainer 围栏尚未实现；启用围栏时 Windows 的 spec run 必须 fail-closed（typed unsupported），不得自动改用协作式代理。",
  },
];

/** 平台矩阵查询：未登记平台一律按 unimplemented / unsupported 处理（fail-closed）。 */
export function fencePlatformMatrixEntry(platform: NodeJS.Platform): FencePlatformMatrixEntry {
  const registered = SPEC_FENCE_PLATFORM_MATRIX.find((entry) => entry.platform === platform);
  if (registered) return registered;
  return {
    platform,
    mechanism: "unsupported",
    status: "unimplemented",
    notes: `平台 ${platform} 未登记围栏实现；按能力缺席处理（spec run 拒绝启动）。`,
  };
}

/** 围栏能力探测结果；available=false 时携带 typed 原因。 */
export type FenceCapability =
  | {
      available: true;
      platform: NodeJS.Platform;
      mechanism: FenceMechanism;
      deprecated?: boolean;
      detail: string;
    }
  | {
      available: false;
      platform: NodeJS.Platform;
      mechanism: FenceMechanism;
      code: FenceErrorCode;
      detail: string;
    };

/** 围栏准备失败：spec run 拒绝启动（与 SpecEgressStartupError 同一纪律）。 */
export class FenceStartupError extends Error {
  constructor(
    readonly code: FenceErrorCode,
    readonly platform: NodeJS.Platform,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`spec egress 围栏不可用（run 拒绝启动）[${code}/${platform}]: ${message}`, options);
    this.name = "FenceStartupError";
  }
}

export interface PrepareFenceRequest {
  /** 本次 spec run 的稳定 id（审计/临时产物命名）。 */
  runId: string;
  workspaceRoot: string;
  /**
   * 本地 egress 代理的 loopback 端点。围栏只放行这一个目的地；非 loopback
   * 一律拒绝准备（fail-closed），因为围栏本身不承担 allowlist 转发。
   */
  broker: { host: string; port: number };
  /**
   * 本次 run 生效的 egress 白名单（已归一化，空数组 = 零 egress）；转发由宿主
   * egress 代理负责，围栏只保证子进程只能到达 childBroker 端点（Linux netns）
   * 或 broker 本身（darwin）。两个已实现平台都支持非空 allowlist。
   */
  allowHosts?: readonly string[];
}

/** 只读运行状态（运维/审计用；不含凭据与配置内容）。 */
export interface FenceRunStatus {
  runId: string;
  mechanism: FenceMechanism;
  /** 宿主侧 egress 代理端点（请求入参）。 */
  broker: { host: string; port: number };
  /** 围栏内子进程实际使用的 broker 端点（linux = netns 内 relay；darwin = broker 本身）。 */
  childBroker: FenceChildBroker;
  pid: number;
  startedAt: Date;
}

/**
 * 一次 run 的围栏句柄。
 * wrapExecutionRequest 把单条执行请求改写成“在围栏内运行”的等价请求；
 * teardown 幂等清理本次 run 的临时配置（namespace 随进程退出回收）。
 */
export interface SpecFenceHandle {
  readonly runId: string;
  readonly mechanism: FenceMechanism;
  readonly broker: { host: string; port: number };
  /** 围栏内子进程必须使用的 broker 端点（dispatcher 据此重写代理 env/network）。 */
  readonly childBroker: FenceChildBroker;
  /** 包装一次执行请求；不改 env（env 代理保留为纵深防御的协作层）。 */
  wrapExecutionRequest(request: ExecutionRequest): ExecutionRequest;
  /** 幂等清理；失败原样上浮，不静默吞掉。 */
  teardown(): Promise<void>;
}

export interface SpecFenceContract {
  /**
   * 探测本平台围栏可用性（权限、二进制、内核特性）。
   * 不确定 = 不可用（spec §3.4 平台门禁）。
   */
  probeCapability(): Promise<FenceCapability>;
  /**
   * 建立 per-run 围栏。
   * 前置：broker 是 loopback 端点；allowHosts 的转发由 egress 代理负责。
   * 后置：返回句柄，run 内每条命令经 wrapExecutionRequest 进入围栏；
   * 启动时对残留 fence 目录做对账清理，存活的其他 run 不误删，同 runId 存活
   * 视为冲突（fence.residual_conflict）。
   * 失败抛 FenceStartupError；调用方必须拒绝启动 run，不回落协作式代理。
   */
  prepare(request: PrepareFenceRequest): Promise<SpecFenceHandle>;

  /** 只读查询本进程内活跃的围栏状态；未知 runId 返回 undefined。 */
  status?(runId: string): FenceRunStatus | undefined;
}
