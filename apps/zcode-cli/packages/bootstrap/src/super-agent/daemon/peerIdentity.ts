/**
 * RPC peer 身份解析（milestone-b-spec §3.8）。
 *
 * **生产认证走显式凭据握手**：Supervisor 在 daemon 启动期铸造 0600 凭据文件
 * （shared `resolveControlPlaneAuthTokenPath`），Core 连接首帧提交、child 校验前不接受
 * 业务帧（见 rpcServer `authToken`）。这是本节 3.8 允许的替代路径。
 *
 * 本模块保留的是**可注入的 peer 门**，只用于测试替身与未来原生能力落地；节点公共 API
 * 没有 `SO_PEERCRED` / `LOCAL_PEERPID` / `GetNamedPipeClientProcessId` 绑定：
 * - Linux：用 `/proc/<pid>/fd` 的 socket inode 反查同 UID、同 socket 的进程；这**不是**
 *   内核级 peer credential（accepted socket 与客户端 socket 通常不是同一 inode），且
 *   存在 TOCTOU。
 * - macOS / Windows：当前运行时无可用的 peer PID 来源 → `unavailable`。若把它当生产
 *   认证，所有数据面连接都会被拒，因此生产必须使用凭据握手，不得用本 resolver 冒充
 *   §3.8 已实现。
 * - 真正的内核级实现需要原生绑定（`LOCAL_PEERPID` / `GetNamedPipeClientProcessId` +
 *   SID），是未来的加固项；不得用「同 UID 即可信」或客户端自报 PID 替代。
 *
 * 可信 PID 集合来源（仅测试/未来原生模式）：Supervisor = `process.ppid`；其余候选由
 * {@link CONTROL_PLANE_TRUSTED_PIDS_ENV} 注入。生产凭据模式下该集合不参与认证，
 * 当前也没有生产代码写入该 env。
 */
import { readdir, readlink, stat } from "node:fs/promises";
import type { Socket } from "node:net";

export const CONTROL_PLANE_TRUSTED_PIDS_ENV = "ZCODE_CONTROL_PLANE_TRUSTED_PIDS";

export type PeerIdentity =
  | { kind: "resolved"; pid: number; uid: number }
  | { kind: "unavailable"; reason: string };

export interface PeerIdentityResolver {
  resolve(socket: Socket): Promise<PeerIdentity>;
}

interface SocketWithHandle {
  _handle?: { fd?: number };
}

async function resolveLinuxPeer(socket: Socket): Promise<PeerIdentity> {
  const fd = (socket as unknown as SocketWithHandle)._handle?.fd;
  if (typeof fd !== "number") {
    return { kind: "unavailable", reason: "linux: accepted socket fd unavailable" };
  }
  let link: string;
  try {
    link = await readlink(`/proc/self/fd/${fd}`);
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `linux: cannot read own socket fd (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const match = /^socket:\[(\d+)\]$/.exec(link);
  if (!match) {
    return { kind: "unavailable", reason: `linux: fd ${fd} is not a socket (${link})` };
  }
  const inodeLink = match[0];
  const selfPid = process.pid;
  const selfUid = process.getuid?.();
  let pids: string[];
  try {
    pids = await readdir("/proc");
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `linux: cannot enumerate /proc (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      // 权限/进程已退出：不可读不是错误，继续找下一个。
      continue;
    }
    for (const fdEntry of fds) {
      try {
        const candidate = await readlink(`/proc/${pid}/fd/${fdEntry}`);
        if (candidate !== inodeLink) continue;
      } catch {
        continue;
      }
      let uid = -1;
      try {
        uid = (await stat(`/proc/${pid}`)).uid;
      } catch {
        uid = -1;
      }
      if (selfUid !== undefined && uid !== selfUid) {
        // 同 socket inode 但跨 UID：不是本进程族的合法 peer，继续找。
        continue;
      }
      return { kind: "resolved", pid, uid };
    }
  }
  return {
    kind: "unavailable",
    reason: `linux: no same-uid process holds socket inode ${inodeLink}`,
  };
}

/** 平台默认解析器；不支持的平台必须显式返回 unavailable（调用方 fail-closed）。 */
export function createPlatformPeerIdentityResolver(
  platform: NodeJS.Platform = process.platform,
): PeerIdentityResolver {
  return {
    async resolve(socket: Socket): Promise<PeerIdentity> {
      if (platform === "linux") return await resolveLinuxPeer(socket);
      return {
        kind: "unavailable",
        reason: `${platform}: no peer credential API exposed by Node; native binding required (LOCAL_PEERPID / GetNamedPipeClientProcessId)`,
      };
    },
  };
}

export interface PeerGuardDecision {
  trusted: boolean;
  identity: PeerIdentity;
  reason?: string;
}

export interface ControlPlanePeerGuard {
  /** 可信 PID 集合：Supervisor（ppid）+ Core（spawn env 传入）。 */
  trustedPids: ReadonlySet<number>;
  verify(socket: Socket): Promise<PeerGuardDecision>;
}

export function parseTrustedPids(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[,:;\s]+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/**
 * 默认 peer 门：解析 peer 身份 → 必须位于可信 PID 集合。解析不可用/不在集合一律拒绝。
 * 注意：Supervisor 自身不连数据面，但加入集合不改变语义（它也不发业务帧）。
 */
export function createControlPlanePeerGuard(options: {
  trustedPids: Iterable<number>;
  resolver?: PeerIdentityResolver;
}): ControlPlanePeerGuard {
  const trustedPids = new Set(options.trustedPids);
  const resolver = options.resolver ?? createPlatformPeerIdentityResolver();
  return {
    trustedPids,
    async verify(socket: Socket): Promise<PeerGuardDecision> {
      const identity = await resolver.resolve(socket);
      if (identity.kind === "unavailable") {
        return { trusted: false, identity, reason: identity.reason };
      }
      if (!trustedPids.has(identity.pid)) {
        return {
          trusted: false,
          identity,
          reason: `peer pid ${identity.pid} is not in trusted set`,
        };
      }
      return { trusted: true, identity };
    },
  };
}
