/* path 规则集中维护：旧 task 快照与 provider 配置路径仍在这里收口。 */
import { existsSync, lstatSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, join, resolve, win32 } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
  ZCODE_AGENT_RUNTIME,
} from "@zcode/shared";

/** 全局数据根目录名（用户家目录/自定义 dataBaseDir 下的应用数据）。 */
export const GLOBAL_DATA_DIR_NAME = ".chengcode";
/** 旧版全局数据根目录名；迁移后替换为指向新根的软链，绝不删除数据。 */
export const LEGACY_GLOBAL_DATA_DIR_NAME = ".zcode";

/** 迁移锁放在 base 目录下，不进入新旧任一数据根。 */
export const GLOBAL_DATA_ROOT_MIGRATION_LOCK_FILE_NAME = `${GLOBAL_DATA_DIR_NAME}.migration.lock`;
export const GLOBAL_DATA_ROOT_MIGRATION_MARKER_FILE_NAME = ".migrated-from-zcode.json";
const GLOBAL_DATA_ROOT_MIGRATION_LOCK_STALE_MS = 10 * 60 * 1000;
const GLOBAL_DATA_ROOT_MIGRATION_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const GLOBAL_DATA_ROOT_MIGRATION_RETRY_INTERVAL_MS = 250;

let _dataBaseDir: string | null = null;
export const ZCODE_WINDOWS_APP_INSTALL_DIR_ENV = "ZCODE_WINDOWS_APP_INSTALL_DIR";
const envDataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || null;
const defaultDataBaseDir = process.env.HOME?.trim() || homedir();

export interface DataBaseDirTargetValidationOptions {
  platform?: NodeJS.Platform | string;
  env?: Record<string, string | undefined>;
  appInstallDir?: string | null;
}

export type DataBaseDirTargetValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: typeof DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE;
      forbiddenDir: string;
    };

/** Set the base directory for app data (replaces homedir() prefix). */
export function setDataBaseDir(dir: string | null): void {
  _dataBaseDir = dir?.trim() || null;
}

/** Get the current base directory. Priority: setDataBaseDir() > env ZCODE_DATA_BASE_DIR > homedir(). */
export function getDataBaseDir(): string {
  if (_dataBaseDir) return _dataBaseDir;
  if (envDataBaseDir) return envDataBaseDir;
  // 服务实例会启动后台刷新任务；若每次调用都动态读取 HOME，
  // 测试或宿主切换环境变量后，旧实例可能把数据写到新实例目录。
  return defaultDataBaseDir;
}

/** 与 settingService 一致的 home 解析：ZCODE_DESKTOP_HOME_DIR > HOME > USERPROFILE > homedir()。 */
export function resolveUserHomeDir(): string {
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/**
 * 返回所有需要迁移的全局数据根所在 base：默认 home 根（setting.json 固定落点）
 * 与自定义 dataBaseDir。两者相同时只返回一次；各入口必须显式按本结果逐个迁移，
 * 禁止自行猜一个 baseDir 后只迁移其一。
 */
export function getGlobalDataRootMigrationBaseDirs(): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of [resolveUserHomeDir(), getDataBaseDir()]) {
    const resolved = resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(candidate);
  }
  return result;
}

/** {dataBaseDir}/.chengcode */
export function getZCodeDataRootDir(): string {
  return join(getDataBaseDir(), GLOBAL_DATA_DIR_NAME);
}

/** 非项目对话共享的真实工作目录；默认 ~/.chengcode/workspace/default。 */
export function getConversationWorkspaceDir(): string {
  return join(getZCodeDataRootDir(), "workspace", "default");
}

/** {dataBaseDir}/.chengcode/v2 */
export function getAppConfigDir(): string {
  return join(getZCodeDataRootDir(), "v2");
}

/**
 * Agent 侧用户级默认指令（个性化）文件的 home 解析。
 * 必须与 CLI adapter（apps/zcode-cli/packages/adapters/src/context/index.ts 的
 * resolveUserHomeDir）保持完全一致：只认 HOME/USERPROFILE。不能改用
 * ZCODE_DATA_BASE_DIR（CLI 读该文件时忽略它）或 ZCODE_DESKTOP_HOME_DIR
 * （agent 子进程不认），否则 App 写的文件和 Agent 读的文件会分叉。
 */
export function resolveAgentUserInstructionsHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/** `{home}/.zcode/AGENTS.md`：用户自定义指令（个性化）的唯一事实源文件。 */
export function getAgentUserInstructionsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAgentUserInstructionsHomeDir(env), ".zcode", "AGENTS.md");
}

function readEnvValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const direct = env[key]?.trim();
  if (direct) {
    return direct;
  }

  const lowerKey = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(env)) {
    if (candidateKey.toLowerCase() !== lowerKey) {
      continue;
    }
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function normalizeWindowsComparablePath(pathValue: string): string | null {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = win32.normalize(trimmed).replace(/[\\/]+$/, "");
  if (!normalized) {
    return null;
  }

  return win32
    .resolve(normalized)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isWindowsPathEqualOrInside(pathValue: string, rootValue: string): boolean {
  const normalizedPath = normalizeWindowsComparablePath(pathValue);
  const normalizedRoot = normalizeWindowsComparablePath(rootValue);
  if (!normalizedPath || !normalizedRoot) {
    return false;
  }

  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
}

function collectWindowsForbiddenAppInstallDirs(
  options: Required<Pick<DataBaseDirTargetValidationOptions, "env">> &
    Pick<DataBaseDirTargetValidationOptions, "appInstallDir">,
): string[] {
  const env = options.env;
  const programFiles = readEnvValue(env, "ProgramFiles");
  const programFilesX86 = readEnvValue(env, "ProgramFiles(x86)");
  const programW6432 = readEnvValue(env, "ProgramW6432");
  const localAppData = readEnvValue(env, "LOCALAPPDATA");
  const candidates = [
    options.appInstallDir,
    readEnvValue(env, ZCODE_WINDOWS_APP_INSTALL_DIR_ENV),
    programFiles ? win32.join(programFiles, "ZCode") : null,
    programFilesX86 ? win32.join(programFilesX86, "ZCode") : null,
    programW6432 ? win32.join(programW6432, "ZCode") : null,
    localAppData ? win32.join(localAppData, "Programs", "ZCode") : null,
  ];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const normalized =
      typeof candidate === "string" ? normalizeWindowsComparablePath(candidate) : null;
    if (!candidate || !normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(candidate);
  }

  return result;
}

export function validateDataBaseDirTarget(
  targetBaseDir: string,
  options: DataBaseDirTargetValidationOptions = {},
): DataBaseDirTargetValidationResult {
  if ((options.platform ?? process.platform) !== "win32") {
    return { ok: true };
  }

  for (const forbiddenDir of collectWindowsForbiddenAppInstallDirs({
    env: options.env ?? process.env,
    appInstallDir: options.appInstallDir ?? null,
  })) {
    if (isWindowsPathEqualOrInside(targetBaseDir, forbiddenDir)) {
      return {
        ok: false,
        code: DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
        forbiddenDir,
      };
    }
  }

  return { ok: true };
}

export function getExportLogStageDir(): string {
  return join(getZCodeDataRootDir(), "export-log-stage");
}

export function getExportLogDir(): string {
  return join(getZCodeDataRootDir(), "export-log");
}

export function getFeedbackRootDir(): string {
  return join(getZCodeDataRootDir(), "feedback");
}

export function getFeedbackAttachmentDir(): string {
  return join(getFeedbackRootDir(), "attachments");
}

export function getFeedbackLogArchiveDir(): string {
  return join(getFeedbackRootDir(), "logs");
}

export function getGitCheckpointIndexRootDir(): string {
  return join(getZCodeDataRootDir(), "git-checkpoint-index");
}

/** ~/.chengcode/v2/tasks-index.sqlite */
export function getTasksIndexDatabasePath(): string {
  return join(getAppConfigDir(), "tasks-index.sqlite");
}

/** workspace 级身份键：远程优先使用 workspaceIdentity，本地回退 workspacePath。 */
function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

/** 与 ZCode session 持久化一致：使用 workspaceKey 的 SHA-256 前 12 位 */
export function getWorkspaceHash(workspacePath: string, workspaceIdentity?: string): string {
  return createHash("sha256")
    .update(getWorkspaceKey(workspacePath, workspaceIdentity))
    .digest("hex")
    .slice(0, 12);
}

/** ~/.chengcode/v2/sessions/{workspaceHash} */
function getTaskSessionDir(workspacePath: string, workspaceIdentity?: string): string {
  return join(getAppConfigDir(), "sessions", getWorkspaceHash(workspacePath, workspaceIdentity));
}

/** ~/.chengcode/v2/sessions/{workspaceHash}/{taskId}.json */
export function getLegacyTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.json`);
}

/** ~/.chengcode/v2/sessions/{workspaceHash}/{taskId}.deleted.json */
export function getLegacyDeletedTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.deleted.json`);
}

/**
 * GLM（唯一 agent provider）的配置目录：~/.chengcode/cli。
 * Bugfix：GLM 配置改为直接读写新版 zcode-cli 的全局配置目录，不做 workspace 隔离，
 * 避免同机不同工作区配置漂移。
 */
export function getProviderWorkspaceConfigDir(): string {
  return ZCODE_AGENT_RUNTIME.nativeConfigDir
    ? join(getDataBaseDir(), ZCODE_AGENT_RUNTIME.nativeConfigDir)
    : join(getDataBaseDir(), GLOBAL_DATA_DIR_NAME, "cli");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function isTransientMigrationEntry(sourceName: string): boolean {
  return sourceName.endsWith(".lock") || sourceName.endsWith(".tmp");
}

/**
 * target 已存在时必须能证明它来自迁移：marker 与数据在同一次迁移中写入。
 * 若 legacy 同时存在却没有 marker，说明有新入口在迁移前抢先创建了 target，
 * 此时静默返回 existing 会让应用读空新根、旧数据永远不被搬入；必须 fail-loud。
 * legacy 不存在时 target 是应用自行创建的（如首次安装），允许继续。
 */
async function assertExistingTargetWasMigrated(targetDir: string, legacyDir: string): Promise<void> {
  const markerPath = join(targetDir, GLOBAL_DATA_ROOT_MIGRATION_MARKER_FILE_NAME);
  if (await pathExists(markerPath)) {
    return;
  }
  if (!(await pathExists(legacyDir))) {
    return;
  }
  // 崩溃恢复：rename 已完成、软链已建、marker 尚未写入时，legacy 已指向 target。
  // 这是同一个迁移的中间态，补写 marker 即可，不能当成“新入口提前建目录”而拒绝启动。
  try {
    if ((await lstat(legacyDir)).isSymbolicLink()) {
      const resolved = await realpath(legacyDir);
      if (resolve(resolved) === resolve(targetDir)) {
        await writeFile(
          markerPath,
          `${JSON.stringify(
            {
              formatVersion: 1,
              mode: "move-symlink",
              migratedAt: new Date().toISOString(),
              sourceDirName: basename(legacyDir),
              targetDirName: basename(targetDir),
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        return;
      }
    }
  } catch {
    // 继续走 fail-loud；读不到 legacy 软链不能作为迁移完成的证据。
  }
  throw new Error(
    `[GlobalDataRootMigration] target ${targetDir} exists without ` +
      `${GLOBAL_DATA_ROOT_MIGRATION_MARKER_FILE_NAME} while legacy ${legacyDir} still exists. ` +
      "This means the target was created before migration ran; refusing to continue with an " +
      "unmigrated data root. Ensure every entry migrates before writing to the new root.",
  );
}

export interface EnsureGlobalDataRootMigrationOptions {
  /** 数据根所在的 base 目录；默认 getDataBaseDir()。 */
  baseDir?: string;
  /** 旧全局根名；默认 LEGACY_GLOBAL_DATA_DIR_NAME。 */
  legacyDirName?: string;
  /** 测试注入：等锁上限，默认 10 分钟。 */
  lockWaitTimeoutMs?: number;
  /** 测试注入：等锁轮询间隔，默认 250ms。 */
  lockRetryIntervalMs?: number;
  /** 测试注入：锁超过该时长视为 stale，默认 10 分钟。 */
  lockStaleMs?: number;
}

export type EnsureGlobalDataRootMigrationResult =
  | { status: "existing"; targetDir: string }
  | { status: "fresh"; targetDir: string }
  | { status: "migrated"; targetDir: string; legacyDir: string };

/**
 * 把旧全局数据根（默认 ~/.zcode）迁移到新根 ~/.chengcode。
 *
 * 并发安全：O_EXCL 锁 + 同父目录原子 rename。旧路径随后变成指向新根的软链，
 * 数据只有一份（不做 40GB 级复制）；迁移前请自行备份。
 * target 已存在且带迁移 marker 时返回 existing；target 存在但无 marker 而旧根仍在时
 * fail-loud（说明有新入口在迁移前抢先创建了 target）。旧根不存在时返回 fresh 且不创建
 * 任何目录（按需创建）。绝不在锁存在时复制；拿不到锁且 target 仍不存在时等待有上限后 fail-loud。
 *
 * 调用方应在读取 setting.json 等 bootstrap 状态之前调用：对默认 home 根（setting.json
 * 固定落点）和自定义 dataBaseDir 各调用一次；本函数只迁移传入 baseDir，不做猜测。
 */
export async function ensureGlobalDataRootMigrated(
  options: EnsureGlobalDataRootMigrationOptions = {},
): Promise<EnsureGlobalDataRootMigrationResult> {
  const baseDir = options.baseDir ?? getDataBaseDir();
  const legacyDirName = options.legacyDirName?.trim() || LEGACY_GLOBAL_DATA_DIR_NAME;
  const targetDir = join(baseDir, GLOBAL_DATA_DIR_NAME);
  const legacyDir = join(baseDir, legacyDirName);
  if (resolve(targetDir) === resolve(legacyDir)) {
    throw new Error(
      `[GlobalDataRootMigration] legacyDirName must not equal ${GLOBAL_DATA_DIR_NAME}: ${legacyDir}`,
    );
  }

  if (await pathExists(targetDir)) {
    await assertExistingTargetWasMigrated(targetDir, legacyDir);
    return { status: "existing", targetDir };
  }
  if (!(await pathExists(legacyDir))) {
    return { status: "fresh", targetDir };
  }

  const lockPath = join(baseDir, GLOBAL_DATA_ROOT_MIGRATION_LOCK_FILE_NAME);
  const staleMs = options.lockStaleMs ?? GLOBAL_DATA_ROOT_MIGRATION_LOCK_STALE_MS;
  const waitTimeoutMs = options.lockWaitTimeoutMs ?? GLOBAL_DATA_ROOT_MIGRATION_WAIT_TIMEOUT_MS;
  const retryIntervalMs =
    options.lockRetryIntervalMs ?? GLOBAL_DATA_ROOT_MIGRATION_RETRY_INTERVAL_MS;
  const waitDeadline = Date.now() + waitTimeoutMs;
  // 锁令牌用于释放时确认锁仍是自己创建的：超过 stale 阈值被别的进程接管后，
  // 原持锁进程绝不能删掉新持有者的锁。
  const lockToken = randomBytes(16).toString("hex");

  const releaseLock = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(lockPath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    let token: unknown;
    try {
      token = (JSON.parse(raw) as { token?: unknown }).token;
    } catch {
      // 锁内容损坏时无法证明归属，保守不删。
      return;
    }
    if (token !== lockToken) return;
    await unlink(lockPath).catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    });
  };

  const acquireLock = async (): Promise<boolean> => {
    while (true) {
      if (await pathExists(targetDir)) return false;
      let handle:
        | Awaited<ReturnType<typeof open>>
        | null = null;
      try {
        handle = await open(lockPath, "wx");
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw cause;
        let lockStat: Awaited<ReturnType<typeof stat>>;
        try {
          lockStat = await stat(lockPath);
        } catch (statCause) {
          if ((statCause as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statCause;
        }
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          // stale 锁：删掉后重试 O_EXCL。unlink 与 open 之间仍由 O_EXCL 保证唯一持有者。
          await unlink(lockPath).catch((unlinkCause) => {
            if ((unlinkCause as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkCause;
          });
          continue;
        }
        if (await pathExists(targetDir)) return false;
        if (Date.now() >= waitDeadline) {
          throw new Error(
            `[GlobalDataRootMigration] timed out waiting for migration lock ${lockPath}; ` +
              `target ${targetDir} still missing. Refusing to copy while the lock exists.`,
          );
        }
        await delay(retryIntervalMs);
        continue;
      }

      try {
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            token: lockToken,
            acquiredAt: new Date().toISOString(),
          }),
          "utf8",
        );
        await handle.close();
      } catch (cause) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw cause;
      }
      return true;
    }
  };

  const acquired = await acquireLock();
  if (!acquired) {
    await assertExistingTargetWasMigrated(targetDir, legacyDir);
    return { status: "existing", targetDir };
  }

  const markerPath = join(targetDir, GLOBAL_DATA_ROOT_MIGRATION_MARKER_FILE_NAME);
  const migrationMarker = `${JSON.stringify(
    {
      formatVersion: 1,
      mode: "move-symlink",
      migratedAt: new Date().toISOString(),
      sourceDirName: legacyDirName,
      targetDirName: GLOBAL_DATA_DIR_NAME,
    },
    null,
    2,
  )}\n`;

  const performMigration = async (): Promise<EnsureGlobalDataRootMigrationResult> => {
    // 锁内再确认：前一个持锁进程可能已刚完成 rename 并释放锁。
    if (await pathExists(targetDir)) {
      await assertExistingTargetWasMigrated(targetDir, legacyDir);
      return { status: "existing", targetDir };
    }

    const legacyStat = await lstat(legacyDir);
    if (!legacyStat.isDirectory()) {
      throw new Error(
        `[GlobalDataRootMigration] legacy data root is not a directory: ${legacyDir}`,
      );
    }

    await mkdir(baseDir, { recursive: true });
    // 原子移动：同父目录 rename，不复制数据（40GB 级根目录不能承受双份拷贝）。
    // 旧路径随后变成指向新根的软链，旧工具/脚本仍可访问同一份数据。
    await rename(legacyDir, targetDir);
    try {
      await symlink(
        targetDir,
        legacyDir,
        process.platform === "win32" ? "junction" : undefined,
      );
      await writeFile(markerPath, migrationMarker, "utf8");
    } catch (cause) {
      // 回滚：删掉可能已创建的软链，把数据搬回旧路径；任何回滚失败都不能掩盖主错误。
      await rm(legacyDir, { force: true }).catch(() => {});
      await rename(targetDir, legacyDir).catch(() => {});
      throw cause;
    }
    return { status: "migrated", targetDir, legacyDir };
  };

  let result: EnsureGlobalDataRootMigrationResult | null = null;
  let migrationError: unknown = null;
  try {
    result = await performMigration();
  } catch (cause) {
    migrationError = cause;
  }
  try {
    await releaseLock();
  } catch (releaseCause) {
    // 已有主错误时不掩盖它；成功路径上的释放失败必须上抛，避免留下无人认领的锁。
    if (!migrationError) throw releaseCause;
  }
  if (migrationError) throw migrationError;
  if (!result) {
    throw new Error("[GlobalDataRootMigration] internal error: missing migration result");
  }
  return result;
}

/**
 * Copy the global app data directory (v2) from one base dir to another.
 * Source prefers the current root `.chengcode/v2`, falling back to the legacy
 * `.zcode/v2`; target always lands at `.chengcode/v2`.
 * Excludes setting.json and its transient atomic-write siblings — bootstrap
 * state must only live at the default homedir location.
 */
export async function copyDataDirectory(oldBaseDir: string, newBaseDir: string): Promise<void> {
  const currentOldDir = join(oldBaseDir, GLOBAL_DATA_DIR_NAME, "v2");
  const legacyOldDir = join(oldBaseDir, LEGACY_GLOBAL_DATA_DIR_NAME, "v2");
  const oldDir = existsSync(currentOldDir) ? currentOldDir : legacyOldDir;
  const newDir = join(newBaseDir, GLOBAL_DATA_DIR_NAME, "v2");
  await cp(oldDir, newDir, {
    recursive: true,
    force: false,
    filter: (source) => {
      const sourceName = basename(source);
      if (sourceName === "setting.json" || sourceName.startsWith("setting.json.")) {
        // setting.json.lock 和 setting.json.*.tmp 由原子写入短暂创建/删除，
        // 复制过程中扫描到已消失的 lock 会触发 ENOENT，并让数据目录迁移失败。
        // 这些文件都属于 bootstrap 写入中间态，不能迁移到新数据根。
        return false;
      }
      // 与 ensureGlobalDataRootMigrated 保持同一语义：瞬时文件不复制。
      if (isTransientMigrationEntry(sourceName)) return false;
      try {
        const entryStat = lstatSync(source);
        // 与全局迁移一致：POSIX 保留 skills 软链，Windows 非提权环境只能跳过。
        if (entryStat.isSymbolicLink()) return process.platform !== "win32";
        if (!entryStat.isDirectory() && !entryStat.isFile()) return false;
      } catch {
        // lstat 失败时放行，让 cp 自行处理
      }
      return true;
    },
  });
}
