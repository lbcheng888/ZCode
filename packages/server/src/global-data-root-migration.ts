/**
 * Server 入口的全局数据根迁移接线。
 *
 * 默认 home 根承载 setting.json bootstrap，自定义 dataBaseDir 承载会话/DB。两者都必须
 * 迁移；只迁移当前 dataBaseDir 会在自定义目录生效时漏掉 ~/.zcode/v2/setting.json。
 * base 列表与具体复制算法只有一份，位于 @zcode/services 的 paths.ts。
 */
import { resolve } from "node:path";
import {
  ensureGlobalDataRootMigrated,
  getDataBaseDir,
  getGlobalDataRootMigrationBaseDirs,
  resolveUserHomeDir,
  type EnsureGlobalDataRootMigrationOptions,
  type EnsureGlobalDataRootMigrationResult,
} from "@zcode/services/node";

export type ServerGlobalDataRootMigrator = (
  options?: EnsureGlobalDataRootMigrationOptions,
) => Promise<EnsureGlobalDataRootMigrationResult>;

export interface MigrateServerGlobalDataRootsInput {
  homeDir?: string;
  dataBaseDir?: string;
  migrate?: ServerGlobalDataRootMigrator;
}

/** 迁移 home 根与当前 dataBaseDir；两者相同时只执行一次。失败原样上抛。 */
export async function migrateServerGlobalDataRoots(
  input: MigrateServerGlobalDataRootsInput = {},
): Promise<void> {
  const migrate = input.migrate ?? ensureGlobalDataRootMigrated;
  const baseDirs =
    input.homeDir !== undefined || input.dataBaseDir !== undefined
      ? dedupeBaseDirs([
          input.homeDir ?? resolveUserHomeDir(),
          input.dataBaseDir ?? getDataBaseDir(),
        ])
      : getGlobalDataRootMigrationBaseDirs();

  for (const baseDir of baseDirs) {
    await migrate({ baseDir });
  }
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
