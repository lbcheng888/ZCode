import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlPlaneLaunchParams, ReleaseManifest } from "../contracts.js";

/**
 * 受管 control-plane 子进程的唯一启动接口（裁决 7：daemon spawn bootstrap 组合根）。
 * Supervisor 不关心入口形态；launcher 决定命令、env 与 IPC 通道。
 */
export interface ControlPlaneLauncher {
  launch(params: ControlPlaneLaunchParams): ChildProcess;
}

export const CONTROL_PLANE_PEER_CREDENTIALS_NATIVE_PATH_ENV = "ZCODE_PEER_CREDENTIALS_NATIVE_PATH";
export const CONTROL_PLANE_TRUSTED_PIDS_ENV = "ZCODE_CONTROL_PLANE_TRUSTED_PIDS";

export interface HeadlessControlPlaneCommand {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * 原生 peer credential addon 的绝对路径。给出时 launcher 注入
   * `ZCODE_PEER_CREDENTIALS_NATIVE_PATH`；缺省时不注入，child 保持 authToken 路径。
   */
  peerCredentialsNativePath?: string;
}

/**
 * 默认 launcher：按调用方给出的 headless bootstrap 命令 spawn，并把 launch 参数经 env 传入
 * 子进程。**不猜入口路径**——headless bootstrap 入口随里程碑 B 实现；入口不存在/未注入
 * command 时调用方不得启用本 launcher，禁止向不存在的二进制假 spawn。
 *
 * 协议约定：子进程从 ipc 通道接收 `{command:"shutdown"}`，发出 ready/health/stopped
 * （见 contracts.controlPlaneMessageSchema）；generation / protocolVersion 经 env 回传。
 */
export function createControlPlaneLauncher(
  command: HeadlessControlPlaneCommand,
  baseEnv: Record<string, string | undefined> = process.env,
): ControlPlaneLauncher {
  if (!command.executable.trim()) {
    throw new Error("Control plane launcher requires a non-empty executable");
  }
  return {
    launch(params: ControlPlaneLaunchParams): ChildProcess {
      // 只投影合法 PID；空集合不注入，避免 child 把空串当可信集合。
      const trustedPids = (params.trustedPids ?? []).filter(
        (pid) => Number.isInteger(pid) && pid > 0,
      );
      return spawn(command.executable, [...(command.args ?? [])], {
        cwd: command.cwd,
        env: {
          ...baseEnv,
          ...command.env,
          ZCODE_CONTROL_PLANE_GENERATION: String(params.generation),
          ZCODE_CONTROL_PLANE_PROTOCOL_VERSION: String(params.protocolVersion),
          ZCODE_DATA_BASE_DIR: params.dataBaseDir,
          ZCODE_SERVER_ROOT: params.serverRoot,
          // §2.3 单一投影源：child 只读 mandateGate，launcher 不读 RuntimeConfig。
          ZCODE_CONTROL_PLANE_MANDATE_GATE: params.mandateGate === true ? "1" : "0",
          ...(command.peerCredentialsNativePath
            ? {
                [CONTROL_PLANE_PEER_CREDENTIALS_NATIVE_PATH_ENV]: command.peerCredentialsNativePath,
              }
            : {}),
          ...(trustedPids.length > 0
            ? { [CONTROL_PLANE_TRUSTED_PIDS_ENV]: trustedPids.join(",") }
            : {}),
          ...(params.release?.releaseId
            ? { ZCODE_SERVER_RELEASE_ID: params.release.releaseId }
            : {}),
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
    },
  };
}

/** 与 `app-server` 同级的内部子命令（milestone-b-spec §2.2）。 */
export const CONTROL_PLANE_SUBCOMMAND = "super-agent-control-plane";

/** 开发态入口与 tsx 解析（B-SPEC §2.2：`tsx apps/zcode-cli/packages/cli/src/main.ts`）。 */
const DEV_CLI_ENTRY_PATH = join("apps", "zcode-cli", "packages", "cli", "src", "main.ts");
const DEV_TSX_CLI_PATH = join("node_modules", "tsx", "dist", "cli.mjs");

export interface ControlPlaneEntryResolutionOptions {
  platform?: NodeJS.Platform;
  /** 子进程基础 env；缺省 process.env。 */
  env?: Record<string, string | undefined>;
  /** 开发态 monorepo 搜索起点；缺省本模块所在目录。测试可注入。 */
  devSearchFrom?: string;
  /** 文件存在判定；缺省 fs.statSync。测试可注入以隔离真实文件系统。 */
  isFile?: (path: string) => boolean;
  /**
   * 显式指定原生 peer credential addon 路径；缺省按 release/开发树布局探测。
   * 探测不到时不注入 env，child 保持 authToken 路径（§3.8 生产握手不变）。
   */
  peerCredentialsNativePath?: string;
}

export type ControlPlaneCommandResolution =
  | { ok: true; source: "release" | "development"; command: HeadlessControlPlaneCommand }
  | { ok: false; reason: string };

/**
 * 从 release 布局（打包态）或 monorepo 开发树解析 headless 入口。
 *
 * 与 Core 的 `createReleaseAgentWiring()` / `resolveBundledAgentWiring()` 同源：只认
 * release 目录内 `runtime/zcode.cjs` + `runtime/<node>`，或开发树内的 `apps/zcode-cli`
 * 入口 + 仓库内 tsx；绝不从 PATH 猜 `zcode`（B-SPEC §2.2）。
 * release 目录文件缺失/开发树都不可用时返回 `ok:false`，由调用方启动期响亮失败，
 * 不允许向不存在的命令 spawn（§0.3 禁止假 spawn）。
 */
export function resolveDefaultControlPlaneCommand(
  params: Pick<ControlPlaneLaunchParams, "serverRoot" | "release">,
  options: ControlPlaneEntryResolutionOptions = {},
): ControlPlaneCommandResolution {
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const release: ReleaseManifest | null = params.release;
  if (release) {
    const runtimeRoot = join(release.releaseDir, "runtime");
    const bundle = join(runtimeRoot, "zcode.cjs");
    const nodeExecutable = join(runtimeRoot, platform === "win32" ? "node.exe" : "node");
    if (!isFile(bundle)) {
      return { ok: false, reason: `release runtime/zcode.cjs 不存在：${bundle}` };
    }
    if (!isFile(nodeExecutable)) {
      return { ok: false, reason: `release runtime node 可执行文件不存在：${nodeExecutable}` };
    }
    // 打包态 addon 由 scripts/build-native-peer-credentials.mjs 产出后随 release
    // 放到 runtime/peercred.node；缺失时不注入 env，生产 authToken 路径不受影响。
    const nativePeerCredentialsPath = resolveNativePeerCredentialsPath({
      options,
      platform,
      isFile,
      releaseRuntimeRoot: runtimeRoot,
    });
    return {
      ok: true,
      source: "release",
      command: {
        executable: nodeExecutable,
        args: [bundle, CONTROL_PLANE_SUBCOMMAND],
        cwd: release.releaseDir,
        ...(nativePeerCredentialsPath
          ? { peerCredentialsNativePath: nativePeerCredentialsPath }
          : {}),
      },
    };
  }

  const searchFrom = options.devSearchFrom ?? dirname(fileURLToPath(import.meta.url));
  const monorepoRoot = findMonorepoRoot(searchFrom, isFile);
  if (!monorepoRoot) {
    return {
      ok: false,
      reason: `未解析到 headless 入口：无 release runtime，且开发树 ${searchFrom} 下找不到 ${DEV_CLI_ENTRY_PATH} 与 ${DEV_TSX_CLI_PATH}`,
    };
  }
  const nativePeerCredentialsPath = resolveNativePeerCredentialsPath({
    options,
    platform,
    isFile,
    monorepoRoot,
  });
  return {
    ok: true,
    source: "development",
    command: {
      // 用 node 直跑仓库内 tsx cli，避免 Windows 上 .cmd 经 shell 解析的差异。
      executable: process.execPath,
      args: [
        join(monorepoRoot, DEV_TSX_CLI_PATH),
        join(monorepoRoot, DEV_CLI_ENTRY_PATH),
        CONTROL_PLANE_SUBCOMMAND,
      ],
      cwd: monorepoRoot,
      ...(nativePeerCredentialsPath
        ? { peerCredentialsNativePath: nativePeerCredentialsPath }
        : {}),
    },
  };
}

function resolveNativePeerCredentialsPath(input: {
  options: ControlPlaneEntryResolutionOptions;
  platform: NodeJS.Platform;
  isFile: (path: string) => boolean;
  releaseRuntimeRoot?: string;
  monorepoRoot?: string;
}): string | undefined {
  const explicit = input.options.peerCredentialsNativePath?.trim();
  if (explicit) return explicit;
  if (input.releaseRuntimeRoot) {
    const candidate = join(input.releaseRuntimeRoot, "peercred.node");
    if (input.isFile(candidate)) return candidate;
  }
  if (input.monorepoRoot) {
    const candidate = join(
      input.monorepoRoot,
      "packages",
      "native-peer-credentials",
      "prebuilds",
      `${input.platform}-${process.arch}`,
      "peercred.node",
    );
    if (input.isFile(candidate)) return candidate;
  }
  return undefined;
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findMonorepoRoot(
  searchFrom: string,
  isFile: (path: string) => boolean,
): string | undefined {
  let current = searchFrom;
  while (true) {
    if (isFile(join(current, DEV_CLI_ENTRY_PATH)) && isFile(join(current, DEV_TSX_CLI_PATH))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * 生产默认 launcher：每次 launch 按当前 release（代际可能切换 release）解析入口，
 * 并把 launch 参数映射为子进程 env（§2.1）。入口不可解析时同步抛错——Supervisor 的
 * 启动临界区据此收口并响亮失败，绝不 spawn 假进程。
 */
export function createDefaultControlPlaneLauncher(
  options: ControlPlaneEntryResolutionOptions = {},
): ControlPlaneLauncher {
  return {
    launch(params: ControlPlaneLaunchParams): ChildProcess {
      const resolution = resolveDefaultControlPlaneCommand(params, options);
      if (!resolution.ok) {
        throw new Error(`super-agent control-plane headless 入口不可解析：${resolution.reason}`);
      }
      return createControlPlaneLauncher(resolution.command, options.env ?? process.env).launch(
        params,
      );
    },
  };
}
