/**
 * CLI 在读取 config / 打开 session DB 之前迁移全局数据根（~/.zcode → ~/.chengcode）。
 *
 * 迁移实现只有一份，位于 @zcode/services 的 paths.ts；但 CLI 不能把整个 @zcode/services
 * 作为运行时依赖内联进单文件 bundle（node.ts 会拖入 node-pty 等原生模块）。这里直接引用
 * 该源文件，打包时只内联 paths.ts 及其 shared 依赖，保证 CLI、Desktop、Server 共用同一套
 * 锁与 staging/rename 算法，避免多进程各写一份导致数据根不一致。
 *
 * 用动态 import 而不是静态 import：plugin-host 等极简入口在 bundle 求值时不能触发
 * @zcode/shared 根入口求值（该入口会拉起 Agent 依赖），只有真正需要迁移的入口才加载。
 */
import { resolve } from "node:path";
import type {
  EnsureGlobalDataRootMigrationOptions,
  EnsureGlobalDataRootMigrationResult,
} from "../../../../../packages/services/src/paths.js";

export type CliGlobalDataRootMigrator = (
  options?: EnsureGlobalDataRootMigrationOptions,
) => Promise<EnsureGlobalDataRootMigrationResult>;

export async function ensureCliGlobalDataRootMigrated(
  options?: EnsureGlobalDataRootMigrationOptions,
  migrate?: CliGlobalDataRootMigrator,
): Promise<EnsureGlobalDataRootMigrationResult> {
  const runner =
    migrate ??
    (await import("../../../../../packages/services/src/paths.js")).ensureGlobalDataRootMigrated;
  return await runner(options);
}

export interface CliGlobalDataRootMigrationTargets {
  /** 默认 home 根；setting.json 的固定落点。默认 homedir()。 */
  homeDir?: string;
  /** 当前生效的自定义 dataBaseDir；默认 getDataBaseDir()。 */
  dataBaseDir?: string;
}

/**
 * 迁移两个全局数据根：默认 home 根（setting.json bootstrap 固定落点）与当前
 * dataBaseDir。自定义 dataBaseDir 不能替代 home 根迁移，否则旧
 * ~/.zcode/v2/setting.json 永远不会进入 ~/.chengcode/v2，升级后设置丢失。
 * 两个根相同时只执行一次。
 */
export async function ensureCliGlobalDataRootsMigrated(
  migrate?: CliGlobalDataRootMigrator,
  targets: CliGlobalDataRootMigrationTargets = {},
): Promise<EnsureGlobalDataRootMigrationResult[]> {
  const pathsModule =
    migrate && targets.homeDir !== undefined && targets.dataBaseDir !== undefined
      ? undefined
      : await import("../../../../../packages/services/src/paths.js");
  const baseDirs =
    targets.homeDir !== undefined || targets.dataBaseDir !== undefined
      ? dedupeBaseDirs([
          targets.homeDir ?? pathsModule!.resolveUserHomeDir(),
          targets.dataBaseDir ?? pathsModule!.getDataBaseDir(),
        ])
      : pathsModule!.getGlobalDataRootMigrationBaseDirs();
  const runner = migrate ?? pathsModule!.ensureGlobalDataRootMigrated;
  const results: EnsureGlobalDataRootMigrationResult[] = [];
  for (const baseDir of baseDirs) {
    results.push(await runner({ baseDir }));
  }
  return results;
}

function dedupeBaseDirs(candidates: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(candidate);
  }
  return result;
}
