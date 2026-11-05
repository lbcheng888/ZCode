/**
 * RPC peer 身份解析（milestone-b-spec §3.8）。
 *
 * **生产认证走显式凭据握手**：Supervisor 在 daemon 启动期铸造 0600 凭据文件
 * （shared `resolveControlPlaneAuthTokenPath`），Core 连接首帧提交、child 校验前不接受
 * 业务帧（见 rpcServer `authToken`）。这是本节 3.8 允许的替代路径。
 *
 * 原生绑定由 `packages/native-peer-credentials` 提供（Node-API C addon）：
 * - Linux：`SO_PEERCRED`；macOS：`LOCAL_PEERPID` + `getpeereid()`。
 * - Windows **不支持**：Node 不把 named-pipe 连接句柄暴露为 fd，JS 侧拿不到内核
 *   HANDLE，客户端 SID 查询也未实现；原生不可用时 Windows 恒为 unavailable（fail-closed），
 *   不得声称 Windows peer 认证已落地。
 * - 原生 addon 仅在没有 `authToken` 的原生/测试模式参与认证；生产仍是凭据握手。
 * - 原生不可用时：Linux 退回 `/proc/<pid>/fd` 的 socket inode 反查（同 UID、同 socket），
 *   这**不是**内核级 peer credential 且存在 TOCTOU；macOS/Windows 无原生即 `unavailable`。
 *   不得用「同 UID 即可信」或客户端自报 PID 替代。
 *
 * 可信 PID 集合来源（原生模式）：Supervisor = `process.ppid`；其余候选由
 * {@link CONTROL_PLANE_TRUSTED_PIDS_ENV} 注入。生产凭据模式下该集合不参与认证。
 */
import { existsSync } from "node:fs";
import { readdir, readlink, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";

export const CONTROL_PLANE_TRUSTED_PIDS_ENV = "ZCODE_CONTROL_PLANE_TRUSTED_PIDS";
export const PEER_CREDENTIALS_NATIVE_PATH_ENV = "ZCODE_PEER_CREDENTIALS_NATIVE_PATH";

/** 原生 addon 导出的 peer credential 形状；无法解析时返回 null（fail-closed）。 */
export interface NativePeerCredentials {
  getPeerCredentials(fd: number): { pid: number; uid?: number; gid?: number } | null;
}

export type PeerIdentity =
  | { kind: "resolved"; pid: number; uid?: number; gid?: number }
  | { kind: "unavailable"; reason: string };

/**
 * 按路径加载原生 addon。路径不存在 → undefined（原生不可用）；文件存在但加载失败或
 * 不导出 `getPeerCredentials` → 原样抛出，不让坏产物静默退化。
 */
export function loadNativePeerCredentials(options: {
  addonPath?: string;
  requireModule?: (path: string) => unknown;
} = {}): NativePeerCredentials | undefined {
  const addonPath = options.addonPath?.trim();
  if (!addonPath || !existsSync(addonPath)) return undefined;
  // 用 process.execPath 作为 createRequire 的基准，而不是 import.meta.url：发布态入口
  // 可能被 esbuild 打成 CJS，`import.meta.url` 在那里是 undefined；addon 路径按绝对路径加载。
  const load =
    options.requireModule ??
    ((path: string) =>
      createRequire(process.execPath)(isAbsolute(path) ? path : resolve(path)));
  const loaded = load(addonPath) as Partial<NativePeerCredentials> | undefined;
  if (typeof loaded?.getPeerCredentials !== "function") {
    throw new Error(
      `native peer credentials addon ${addonPath} does not export getPeerCredentials`,
    );
  }
  return loaded as NativePeerCredentials;
}

export interface PeerIdentityResolver {
  resolve(socket: Socket): Promise<PeerIdentity>;
}

interface SocketWithHandle {
  _handle?: { fd?: number };
}

function socketFd(socket: Socket): number | undefined {
  const fd = (socket as unknown as SocketWithHandle)._handle?.fd;
  return typeof fd === "number" ? fd : undefined;
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

export interface PlatformPeerIdentityResolverOptions {
  /** 已加载的原生 addon；给出时优先使用。 */
  native?: NativePeerCredentials;
  /** 需要本模块按路径加载原生 addon 时使用（daemon entry 从 env 解析后传入）。 */
  nativeAddonPath?: string;
}

/**
 * 平台解析器：原生 addon 可用时优先走内核级身份；不可用时 Linux 退 `/proc`，其它平台
 * 显式 unavailable（调用方 fail-closed，绝不伪造 PID）。
 */
export function createPlatformPeerIdentityResolver(
  platform: NodeJS.Platform = process.platform,
  options: PlatformPeerIdentityResolverOptions = {},
): PeerIdentityResolver {
  const native =
    options.native ??
    (options.nativeAddonPath !== undefined
      ? loadNativePeerCredentials({ addonPath: options.nativeAddonPath })
      : undefined);
  return {
    async resolve(socket: Socket): Promise<PeerIdentity> {
      if (native) {
        const fd = socketFd(socket);
        if (fd === undefined) {
          return { kind: "unavailable", reason: `${platform}: accepted socket fd unavailable` };
        }
        const credentials = native.getPeerCredentials(fd);
        if (!credentials || !Number.isInteger(credentials.pid) || credentials.pid <= 0) {
          return {
            kind: "unavailable",
            reason: `${platform}: native peer credentials unavailable for fd ${fd}`,
          };
        }
        return {
          kind: "resolved",
          pid: credentials.pid,
          ...(Number.isInteger(credentials.uid) ? { uid: credentials.uid } : {}),
          ...(Number.isInteger(credentials.gid) ? { gid: credentials.gid } : {}),
        };
      }
      if (platform === "linux") return await resolveLinuxPeer(socket);
      return {
        kind: "unavailable",
        reason: `${platform}: native peer credentials addon unavailable (${platform === "win32" ? "Windows named-pipe HANDLE is not exposed to Node" : "LOCAL_PEERPID"})`,
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
