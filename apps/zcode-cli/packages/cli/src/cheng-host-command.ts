/**
 * 隐藏子命令 `__zcode-cheng-host`：cheng-host 的打包入口。
 *
 * 与 `__zcode-dwf-child` 同一条 SEA 论证：单文件二进制不解释 Node CLI 旗标，也不能
 * `node <dist/main.js>`。cheng-host 随 CLI bundle 发布，本子命令在 parseArgs **之前**分派，
 * 直接把剩余 argv 交给 `runHost`（stdio 协议帧走本进程 stdin/stdout）。
 *
 * 退出码：配置/运行时探针失败按 `cheng-host` 的口径（runtimeUnavailable / platformUnsupported
 * → 78），其余 1；协议/业务失败由 host 自己写 stderr，本层不吞。
 */

import { CHENG_HOST_COMMAND } from "@zcode/contracts";
import type { RunContext } from "@zcode/shared-types";

export function isChengHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === CHENG_HOST_COMMAND;
}

export async function runChengHostCommand(ctx: RunContext, argv: string[]): Promise<number> {
  try {
    // 动态 import：host 只在真正进入子命令时才加载，普通 CLI 启动不为它付模块初始化成本。
    const { runHost } = await import("@zcode/cheng-host");
    await runHost(argv);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;
    ctx.stderr.write(`Cheng host failed${code === null ? "" : ` (${code})`}: ${message}\n`);
    return code === "host.runtimeUnavailable" || code === "host.platformUnsupported" ? 78 : 1;
  }
}
