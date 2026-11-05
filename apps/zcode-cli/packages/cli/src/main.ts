import { STORAGE_MIGRATION_COMMAND } from "@zcode/shared/sqlite-migrations";
import { interceptTuiStderr, isTuiInvocation } from "./tui-stderr.js";
import { interceptKnownRuntimeWarnings } from "./runtime-warnings.js";
import { installStderrConsoleBoundary } from "./protocol-console.js";
import { setCliProcessTitle } from "./process-name.js";
import { applyCliRuntimeEnvSanitization } from "./env.js";
import { ensureSeaRuntimeTools } from "./sea-runtime-tools.js";
import { isPluginHostInvocation, runPluginHostCommand } from "./plugin-host-command.js";
import { scheduleCliExitWatchdog } from "./shutdown.js";
import { installCliProcessErrorBoundary } from "./process-errors.js";
import { installProtocolStderrBoundary } from "./protocol-stderr.js";
import { createProtocolProcessLifecycle } from "./protocol-lifecycle.js";
import { isControlPlaneInvocation, isProtocolServerInvocation } from "./arguments.js";
import { ensureCliGlobalDataRootsMigrated } from "./global-data-root-migration.js";
import { skipsCliGlobalDataRootStartup } from "./cli-global-data-root-startup.js";

void main();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // 存储模式也可运行在 Host Worker 中，不能修改整个 Host 的进程名称。
  if (argv[0] !== STORAGE_MIGRATION_COMMAND && !argv.includes("--prepare-storage")) setCliProcessTitle();
  // 真实 zcode CLI 进程里仍可能有少量路径直接读取 process.env。
  // 入口先清洗用户 shell 注入的 NODE_ENV、代理和证书变量；网络变量只封存给后续 Bash/tool 子进程恢复。
  applyCliRuntimeEnvSanitization(process.env);
  const isProtocol = argv[0] === STORAGE_MIGRATION_COMMAND || isProtocolServerInvocation(argv);
  const isTui = isTuiInvocation(argv);
  if (isProtocol) installProtocolStderrBoundary(process.stderr);
  const lifecycle =
    isProtocol && argv[0] !== STORAGE_MIGRATION_COMMAND && !argv.includes("--prepare-storage")
      ? createProtocolProcessLifecycle()
      : undefined;
  // app-server/agent-server 的 stdout 是严格的 ZCode Protocol 帧通道，三方 SDK 的
  // console.debug 等普通输出不能直接写入 stdout。必须在加载 run/bootstrap 之前将
  // 进程级 console 统一引导到 stderr，否则任意依赖的一行普通日志都会触发传输层 JSON 解析崩溃。
  // TUI 同样独占 stdout；AI SDK 的首条提示使用 console.info，不能绕过 stderr 捕获。
  const restoreConsole =
    isProtocol || isTui ? installStderrConsoleBoundary(process.stderr) : undefined;
  const runtimeWarnings = interceptKnownRuntimeWarnings(process.stderr);
  const tuiStderr = isTui ? interceptTuiStderr(process.stderr) : undefined;
  const stderr = tuiStderr?.passthrough ?? process.stderr;
  const disposeProcessErrorBoundary = isProtocol
    ? installCliProcessErrorBoundary({
        stderr,
        onFatal: (reason) => {
          if (lifecycle)
            lifecycle.requestShutdown(new Error("Uncaught process error", { cause: reason }));
          else process.exit(1);
        },
      })
    : undefined;

  try {
    // 必须早于任何 config / provider config / session DB 读取，也早于 SEA 运行时工具解包：
    // SEA 工具缓存默认写在 ~/.chengcode/cache/runtime_tools，先解包会把目标根提前创建出来，
    // 迁移随后会误判“已迁移”并静默跳过旧数据复制。失败直接抛到下方 catch，禁止用空的新
    // 目录继续启动。plugin-host / __internal-search 只加载插件或做纯文件搜索，help/version
    // 不读数据根：这些入口连工具解包一起跳过，避免测试进程或 help 触发任何数据根创建。
    const skipsDataRootStartup = skipsCliGlobalDataRootStartup(argv);
    // 默认 home 根（setting.json 固定落点）与自定义 dataBaseDir 都要迁移：只迁移当前
    // dataBaseDir 会在自定义目录生效时漏掉 ~/.zcode/v2/setting.json，升级后设置丢失。
    if (!skipsDataRootStartup) await ensureCliGlobalDataRootsMigrated();
    lifecycle?.signal.throwIfAborted();
    if (
      !skipsDataRootStartup &&
      argv[0] !== STORAGE_MIGRATION_COMMAND &&
      !argv.includes("--prepare-storage")
    )
      Object.assign(process.env, await ensureSeaRuntimeTools());
    const context = {
      argv,
      stderr,
      stdin: process.stdin,
      stdout: process.stdout,
    };
    // plugin-host 只承载插件；先导入 run 会求值 Agent、工具注册表和工作流模块，
    // 即使最终没有创建 AgentRuntime，也会让每个 MCP 子进程持有整套业务依赖。
    if (isPluginHostInvocation(argv)) {
      process.exitCode = await runPluginHostCommand(context, argv.slice(1));
      return;
    }
    // daemon 受管 headless child（milestone-b-spec §2.2）：只装配 bootstrap 侧控制面，
    // 不加载 provider/run 路径；必须在 provider-runtime-env 之前分流，避免为子进程
    // 读取用户配置与网络变量。
    if (isControlPlaneInvocation(argv)) {
      const { runSuperAgentControlPlaneCommand } = await import("@zcode/bootstrap");
      process.exitCode = await runSuperAgentControlPlaneCommand({
        argv: argv.slice(1),
        env: process.env,
      });
      return;
    }
    if (argv[0] !== STORAGE_MIGRATION_COMMAND && !argv.includes("--prepare-storage")) {
      const { prepareCliProviderRuntimeEnv } = await import("./provider-runtime-env.js");
      Object.assign(
        process.env,
        await prepareCliProviderRuntimeEnv({
          argv,
          env: process.env,
        }),
      );
    }
    lifecycle?.signal.throwIfAborted();
    const { run } = await import("./run.js");
    lifecycle?.signal.throwIfAborted();
    const exitCode = await run(context, {
      protocolLifecycle: lifecycle,
      protocolInput: lifecycle?.input,
    });

    process.exitCode = exitCode;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await waitForPendingWarnings();
    // 生命周期和 stderr guard 一直保留到实际退出，迟到的错误不能恢复递归写坏流。
    if (lifecycle) {
      await lifecycle.complete(normalizeProcessExitCode(process.exitCode));
    } else {
      if (tuiStderr) {
        tuiStderr.restore();
      }
      runtimeWarnings.restore();
      disposeProcessErrorBoundary?.();
      // plugin-host 的 main() 在 MCP server.connect() 完成后会返回，但此时
      // stdio handle 正是服务的存活条件。一次性 CLI watchdog 不能把它误判为泄漏并强退。
      const exitCode = normalizeProcessExitCode(process.exitCode);
      if (!isPluginHostInvocation(argv) || exitCode !== 0) {
        scheduleCliExitWatchdog({ exitCode });
      }
      restoreConsole?.();
    }
  }
}

function normalizeProcessExitCode(exitCode: string | number | null | undefined): number {
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) return exitCode;
  if (typeof exitCode === "string") {
    const parsed = Number(exitCode);
    if (Number.isInteger(parsed)) return parsed;
  }
  return 0;
}

function waitForPendingWarnings(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
