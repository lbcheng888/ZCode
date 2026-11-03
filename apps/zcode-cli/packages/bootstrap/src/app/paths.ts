import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createProjectId, type ProjectId } from "@zcode/contracts";
import { resolveProjectMemoryRoot } from "@zcode/core";

export function getCliStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

export function getPluginStorageRoot(cliStorageRoot: string): string {
  return join(cliStorageRoot, "plugins");
}

export function getModelIoDir(cliStorageRoot: string, isDevelopment: boolean): string {
  return join(cliStorageRoot, isDevelopment ? "debug" : "rollout");
}

export function getProjectMemoryRoot(
  cliStorageRoot: string,
  workingDirectory: string,
  workspaceIdentity?: string,
): string {
  return resolveProjectMemoryRoot({
    cliStorageRoot,
    workspaceIdentity,
    workspacePath: workingDirectory,
  });
}

/**
 * daemon 域库路径：{dataBaseDir}/.zcode/v2/super-agent.sqlite（spec
 * super-agent-trigger-subsystem-spec §1.1/§7-6）。@zcode/bootstrap 不依赖
 * @zcode/services，读不到 services 的 setDataBaseDir() 进程内覆盖——凡调用过
 * setDataBaseDir() 的宿主（Desktop 生产启动必经）必须把 getDataBaseDir() 结果作
 * baseDir 传入，否则本库与 tasks-index.sqlite 分根（spec §1.1 实施偏差）。
 * 未传 baseDir 时按 ZCODE_DATA_BASE_DIR → HOME → homedir() 现读解析：打开数据库是
 * 一次性动作，现读才能让测试与宿主在导入后切换目录生效。
 */
export function getSuperAgentDatabasePath(baseDir?: string): string {
  const dataBaseDir =
    baseDir?.trim() ||
    process.env.ZCODE_DATA_BASE_DIR?.trim() ||
    process.env.HOME?.trim() ||
    homedir();
  return join(dataBaseDir, ".zcode", "v2", "super-agent.sqlite");
}

export function projectIdFromDirectory(directory: string): ProjectId {
  return createProjectId(
    directory
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "default",
  );
}
