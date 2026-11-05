/**
 * 围栏临时目录与启动残留对账（spec §3.4/§3.5 E7）。
 *
 * 每个围栏/probe 临时目录写 owner.json（runId + pid）。prepare 启动时扫描同前缀
 * 目录：存活 pid 的其他 run 一律保留；同 runId 的存活围栏视为
 * fence.residual_conflict；死 pid / 无 owner 且超过乐观等待窗的目录回收计数。
 *
 * 当前 Linux 设计使用 per-command `unshare` 临时命名空间，进程退出即随内核回收，
 * 不需要 `ip netns del`/veth 清理。owner.json 里可能仍带旧版（已退役的
 * netns+veth 实现）留下的 `linuxNetwork`/`ipPath` 字段：仍按受信前缀与 /30 地址
 * 强校验，伪造/篡改一律 typed 拒绝且不执行任何外部命令；合法旧记录只删除目录。
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FenceStartupError } from "./contract.js";

const FENCE_DIR_PREFIX = "zcode-spec-fence-";
const FENCE_OWNER_FILE = "owner.json";
/**
 * 无 owner.json 的目录可能正处于 mkdtemp 与写 owner 之间的极窄窗口（跨进程），
 * 在此窗口内不回收，避免误删并发 run 的配置。
 */
const RESIDUAL_OWNERLESS_GRACE_MS = 60_000;

/** 旧版 owner.json 里登记过的受信默认 ip 路径。 */
const LEGACY_DEFAULT_IP_PATH = "ip";
const LEGACY_LINUX_FENCE_NAMESPACE_PREFIX = "zcode-spec-";
const LEGACY_LINUX_INTERFACE_PREFIX = "zch-";
const LEGACY_LINUX_NAMESPACE_INTERFACE_PREFIX = "zcn-";
const LINUX_FENCE_ADDRESS_MIN_OCTET = 1;
const LINUX_FENCE_ADDRESS_MAX_OCTET = 254;
/** 地址段按 /30 对齐：host = base+1（≡1 mod 4），namespace = host+1。 */
const LINUX_FENCE_HOST_LAST_OCTET_MOD = 4;
/** 名称后缀由随机熵生成的十六进制（namespace 10 位，接口 8 位）；收紧到字符集。 */
const LINUX_NAMESPACE_NAME_SUFFIX_PATTERN = /^[0-9a-f]{10}$/;
const LINUX_INTERFACE_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;

/** 旧版 owner.json 的 Linux 网络计划形状（仅用于校验，不再据此执行 ip 命令）。 */
interface LegacyLinuxFenceNetworkPlan {
  namespaceName: string;
  hostInterface: string;
  namespaceInterface: string;
  hostAddress: string;
  namespaceAddress: string;
  prefixLength: number;
}

interface FenceOwnerRecord {
  runId: string;
  pid: number;
  startedAt: number;
  linuxNetwork?: LegacyLinuxFenceNetworkPlan;
  ipPath?: string;
}

/** 本进程内活跃的临时目录（含并发 probe 目录）；sweep 不误删。 */
const activeFenceDirs = new Set<string>();

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: string }).stderr;
  const stdout = (error as Error & { stdout?: string }).stdout;
  const text = (stderr ?? "").trim() || (stdout ?? "").trim() || error.message;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权发信号；其余（ESRCH 等）= 已退出。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function matchesPrefixedName(
  value: string,
  prefix: string,
  suffixPattern: RegExp,
): boolean {
  if (!value.startsWith(prefix)) return false;
  return suffixPattern.test(value.slice(prefix.length));
}

function parseStrictIpv4(value: string): [number, number, number, number] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * owner.json 来自共享 tmpdir，可能由任意本地用户写入（或以 root 运行时被篡改）。
 * 旧版字段虽不再驱动外部命令，仍必须强校验名称前缀与 /30 地址段：任何不符合的
 * 字段都拒绝启动（fail-loud），不把不可信内容当配置。
 */
function isLegacyLinuxNetworkPlan(value: unknown): value is LegacyLinuxFenceNetworkPlan {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Partial<LegacyLinuxFenceNetworkPlan>;
  if (
    typeof plan.namespaceName !== "string" ||
    typeof plan.hostInterface !== "string" ||
    typeof plan.namespaceInterface !== "string" ||
    typeof plan.hostAddress !== "string" ||
    typeof plan.namespaceAddress !== "string"
  ) {
    return false;
  }
  if (
    !matchesPrefixedName(
      plan.namespaceName,
      LEGACY_LINUX_FENCE_NAMESPACE_PREFIX,
      LINUX_NAMESPACE_NAME_SUFFIX_PATTERN,
    )
  ) {
    return false;
  }
  if (
    !matchesPrefixedName(
      plan.hostInterface,
      LEGACY_LINUX_INTERFACE_PREFIX,
      LINUX_INTERFACE_SUFFIX_PATTERN,
    )
  ) {
    return false;
  }
  if (
    !matchesPrefixedName(
      plan.namespaceInterface,
      LEGACY_LINUX_NAMESPACE_INTERFACE_PREFIX,
      LINUX_INTERFACE_SUFFIX_PATTERN,
    )
  ) {
    return false;
  }
  if (plan.prefixLength !== 30) return false;
  const host = parseStrictIpv4(plan.hostAddress);
  const namespace = parseStrictIpv4(plan.namespaceAddress);
  if (!host || !namespace) return false;
  if (host[0] !== 10 || namespace[0] !== 10) return false;
  if (host[1] !== namespace[1] || host[2] !== namespace[2]) return false;
  if (
    host[1] < LINUX_FENCE_ADDRESS_MIN_OCTET ||
    host[1] > LINUX_FENCE_ADDRESS_MAX_OCTET ||
    host[2] < LINUX_FENCE_ADDRESS_MIN_OCTET ||
    host[2] > LINUX_FENCE_ADDRESS_MAX_OCTET
  ) {
    return false;
  }
  if (host[3] % LINUX_FENCE_HOST_LAST_OCTET_MOD !== 1) return false;
  return namespace[3] === host[3] + 1;
}

async function readFenceOwner(
  dir: string,
  platform: NodeJS.Platform,
): Promise<FenceOwnerRecord | undefined> {
  let parsed: Partial<FenceOwnerRecord>;
  try {
    parsed = JSON.parse(
      await readFile(join(dir, FENCE_OWNER_FILE), "utf8"),
    ) as Partial<FenceOwnerRecord>;
  } catch {
    return undefined;
  }
  if (
    typeof parsed.runId !== "string" ||
    typeof parsed.pid !== "number" ||
    !Number.isFinite(parsed.pid)
  ) {
    return undefined;
  }
  if (parsed.linuxNetwork !== undefined && !isLegacyLinuxNetworkPlan(parsed.linuxNetwork)) {
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `围栏 owner.json 的 Linux 网络计划未通过前缀/地址校验（${dir}）；拒绝处理不可信残留`,
    );
  }
  if (parsed.ipPath !== undefined && parsed.ipPath !== LEGACY_DEFAULT_IP_PATH) {
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `围栏 owner.json 的 ipPath 不是受信默认值（${dir}）；拒绝处理不可信残留`,
    );
  }
  return {
    runId: parsed.runId,
    pid: parsed.pid,
    startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    ...(parsed.linuxNetwork !== undefined ? { linuxNetwork: parsed.linuxNetwork } : {}),
    ...(parsed.ipPath !== undefined ? { ipPath: parsed.ipPath } : {}),
  };
}

async function directoryAgeMs(dir: string): Promise<number | undefined> {
  try {
    const stats = await stat(dir);
    return Date.now() - stats.mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * 共享 tmpdir 中的同前缀目录可能由其他本地用户创建。只处理当前 euid 拥有的目录，
 * 避免跨用户删除/读取（win32 无 getuid 时不做该检查，但仍受 owner.json 字段校验约束）。
 */
async function directoryOwnedByCurrentUser(dir: string): Promise<boolean> {
  if (typeof process.getuid !== "function") return true;
  try {
    const stats = await stat(dir);
    return stats.uid === process.getuid();
  } catch {
    return false;
  }
}

/**
 * 创建受管临时目录并写入 owner.json。任何一步失败都向调用方上抛原始错误，
 * 由 prepare/probe 边界收敛成 typed FenceStartupError / unavailable。
 */
export async function createFenceTempDir(runId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), FENCE_DIR_PREFIX));
  activeFenceDirs.add(dir);
  try {
    const owner: FenceOwnerRecord = {
      runId,
      pid: process.pid,
      startedAt: Date.now(),
    };
    await writeFile(join(dir, FENCE_OWNER_FILE), JSON.stringify(owner), "utf8");
    return dir;
  } catch (error) {
    activeFenceDirs.delete(dir);
    await rm(dir, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

/** 释放临时目录；返回清理失败细节（不把清理失败变成未捕获的 raw Error）。 */
export async function releaseFenceTempDir(dir: string): Promise<string | undefined> {
  activeFenceDirs.delete(dir);
  try {
    await rm(dir, { force: true, recursive: true });
    return undefined;
  } catch (error) {
    return errorDetail(error);
  }
}

/** 从本进程活跃表移除（teardown 已自行删除目录时调用，避免 sweep 误判）。 */
export function forgetFenceTempDir(dir: string): void {
  activeFenceDirs.delete(dir);
}

/**
 * 启动期残留对账：回收死进程留下的围栏目录。
 * 存活的其他 run 不误删；同 runId 存活 = 冲突，直接拒绝启动。
 */
export async function sweepResidualFences(
  platform: NodeJS.Platform,
  currentRunId: string,
): Promise<{ removed: number }> {
  let entries;
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch (error) {
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `无法枚举围栏临时目录，残留状态不确定: ${errorDetail(error)}`,
      { cause: error },
    );
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(FENCE_DIR_PREFIX)) continue;
    const dir = join(tmpdir(), entry.name);
    if (activeFenceDirs.has(dir)) continue;
    // 非本 euid 拥有的同前缀目录：不读、不删（共享 tmpdir 伪造面）。
    if (!(await directoryOwnedByCurrentUser(dir))) continue;

    const owner = await readFenceOwner(dir, platform);
    if (owner) {
      if (owner.pid === process.pid) {
        // 同进程（可能另一 worker/模块实例）无法安全判定是否活跃：保留。
        // 进程被 kill -9 后重启时 pid 不同，死进程残留由下面的存活检查回收。
        continue;
      }
      if (isProcessAlive(owner.pid)) {
        if (owner.runId === currentRunId) {
          throw new FenceStartupError(
            "fence.residual_conflict",
            platform,
            `runId ${currentRunId} 仍被存活进程 ${owner.pid} 持有围栏`,
          );
        }
        // 其他 run 正在使用，保留。
        continue;
      }
    }
    if (!owner) {
      const age = await directoryAgeMs(dir);
      if (age !== undefined && age < RESIDUAL_OWNERLESS_GRACE_MS) {
        // 可能是并发进程刚 mkdtemp 还没写 owner，先不回收。
        continue;
      }
    }
    try {
      // 新设计没有持久 netns/veth，死进程只留文件残留；直接删目录。
      await rm(dir, { force: true, recursive: true });
      removed += 1;
    } catch (error) {
      throw new FenceStartupError(
        "fence.startup_failed",
        platform,
        `残留围栏目录清理失败（${dir}）: ${errorDetail(error)}`,
        { cause: error },
      );
    }
  }
  return { removed };
}
