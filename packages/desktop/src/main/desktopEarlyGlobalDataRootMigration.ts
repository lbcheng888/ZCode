import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  ensureGlobalDataRootMigrated,
  getDataBaseDir,
} from "@zcode/services/node";
import { applyEarlyDataBaseDirBootstrap } from "./desktopDataBaseDirBootstrap.js";

// 必须是 main 的第一条 import：任何 logger/crash/DB 写入之前完成 ~/.zcode → ~/.chengcode
// 的备份迁移。迁移失败会让 main 加载失败（fail-loud），绝不带着空新根继续启动。
//
// 顺序：
// 1. 先迁移默认 home 根（setting.json 的固定落点在这里）。
// 2. 读取迁移后的 setting.json 并把自定义 dataBaseDir 注入 paths。
// 3. 自定义根与 home 不同时再迁移一次。
await ensureGlobalDataRootMigrated({ baseDir: homedir() });
applyEarlyDataBaseDirBootstrap();
const customDataBaseDir = getDataBaseDir();
if (resolve(customDataBaseDir) !== resolve(homedir())) {
  await ensureGlobalDataRootMigrated({ baseDir: customDataBaseDir });
}
