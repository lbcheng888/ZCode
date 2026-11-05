/**
 * CLI 启动阶段是否跳过全局数据根迁移和 SEA 运行时工具解包。
 *
 * 这些入口既不读全局 config / session DB，也绝不能创建 ~/.chengcode。
 * SEA 工具缓存默认落在全局数据根内（~/.chengcode/cache/runtime_tools）。若在迁移前解包
 * 工具，目标根会提前出现，迁移随后会把“目录已存在”当成已完成，静默跳过旧数据复制。
 * 因此 help/version/plugin-host/__internal-search 必须同时跳过迁移和工具解包。
 */
import { ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts/plugins";

export function skipsCliGlobalDataRootStartup(argv: readonly string[]): boolean {
  return (
    argv[0] === ZCODE_PLUGIN_HOST_COMMAND ||
    argv[0] === "__internal-search" ||
    argv.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")
  );
}
