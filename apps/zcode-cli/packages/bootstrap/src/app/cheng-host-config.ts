import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CHENG_HOST_COMMAND, CHENG_HOST_VIA_CLI_ENV } from "@zcode/contracts";

import { createChengHostPort } from "./workflow-cheng-host-port.js";
import type { ChengHostPort } from "./workflow-cheng-world-read.js";
import type { ChengJobObserver } from "../super-agent/cheng-job-observer.js";

/**
 * 生产装配的 Cheng 端口解析。入口按以下顺序落定：
 *   1. 显式 `options.chengHostEntry` / `ZCODE_CHENG_HOST_ENTRY`（文件入口，测试与自定义分发）；
 *   2. 否则若 CLI 已置位 `ZCODE_CHENG_HOST_VIA_CLI=1`（`run.ts` 在普通 CLI 启动时设置），
 *      使用安装产物自带的 `__zcode-cheng-host` 隐藏子命令：SEA 下 `[execPath, command]`，
 *      普通 CJS 安装下 `[execPath, cliScript, command]`；
 *   3. 都不成立则跳过端口，`cheng.*` 节点以 `ChengHostUnavailable` 大声失败。
 *
 * `ZCODE_CHENG_ROOT` 与全局 data base dir（`ZCODE_DATA_BASE_DIR → HOME`）始终必填；宿主在真正
 * 启动时还会对 checkout/runner/driver 做全量探针。
 */
export interface ResolveChengHostPortInput {
  /** 全局数据根（不是 storageRoot；host 自己会拼 `.chengcode/v2/cheng/...`）。 */
  readonly dataBaseDir: string;
  /** 当前工作区根目录，用于本地 cheng-lang 自动发现与 per-workspace socket 身份。 */
  readonly workspaceRoot?: string;
  /** 测试缝：覆盖 os.homedir()。 */
  readonly homeDir?: string;
  /** 宿主显式给的 host 入口（dist/main.js），优先于环境变量与 CLI 子命令。 */
  readonly hostEntry?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 测试缝：默认 `existsSync`。 */
  readonly pathExists?: (path: string) => boolean;
  /** 测试缝：CLI 运行时探测（SEA/argv/execPath）；默认读当前进程。 */
  readonly runtime?: ChengHostRuntimeProbe;
  /** 连接作用域：默认 macOS/Linux 用 `"workspace"`，Windows/Spec Lane/隔离测试可传 `"stdio"`。 */
  readonly scope?: "workspace" | "stdio";
  /** S0：job 生命周期观察者；wired 时原样交给 host 端口。 */
  readonly observer?: ChengJobObserver;
}

export interface ChengHostRuntimeProbe {
  readonly isSea?: boolean;
  readonly execPath?: string;
  readonly argv?: readonly string[];
}

export interface ChengToolchainHealthSummary {
  readonly configured: boolean;
  readonly chengRoot: string | null;
  readonly readyModes: readonly ("diagnostic" | "production")[];
  readonly driverSha256: string | null;
  readonly donorCount: number;
  readonly reason?: string;
}

export type ChengHostPortResolution =
  | {
      readonly kind: "wired";
      readonly mode: "file" | "cli";
      readonly chengRoot: string;
      readonly dataBaseDir: string;
      readonly hostEntry?: string;
      readonly cliCommand?: readonly string[];
      readonly health: ChengToolchainHealthSummary;
      readonly port: ChengHostPort;
    }
  | {
      readonly kind: "skipped";
      readonly reason: string;
      readonly health: ChengToolchainHealthSummary;
    };

export function resolveChengRoot(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly workspaceRoot?: string;
  readonly homeDir?: string;
  readonly pathExists?: (path: string) => boolean;
}): { readonly chengRoot?: string; readonly reason?: string } {
  const env = input.env ?? process.env;
  const pathExists = input.pathExists ?? existsSync;

  if (env.ZCODE_CHENG_DISABLE === "1") {
    return { reason: "ZCODE_CHENG_DISABLE=1" };
  }

  const explicitRoot =
    env.ZCODE_CHENG_ROOT?.trim() || env.CHENGCODE_CHENG_ROOT?.trim() || "";
  if (explicitRoot.length > 0) {
    if (!pathExists(explicitRoot)) {
      const envName =
        env.ZCODE_CHENG_ROOT?.trim() ? "ZCODE_CHENG_ROOT" : "CHENGCODE_CHENG_ROOT";
      return { reason: `${envName} does not exist: ${explicitRoot}` };
    }
    return { chengRoot: explicitRoot };
  }

  if (
    input.workspaceRoot !== undefined &&
    input.workspaceRoot.trim().length > 0 &&
    pathExists(join(input.workspaceRoot, "tools", "csg_spec_v2_cli_run"))
  ) {
    return { chengRoot: input.workspaceRoot };
  }

  const homeChengRoot = join(input.homeDir ?? homedir(), "cheng-lang");
  if (pathExists(join(homeChengRoot, "tools", "csg_spec_v2_cli_run"))) {
    return { chengRoot: homeChengRoot };
  }

  return {
    reason:
      "ZCODE_CHENG_ROOT / CHENGCODE_CHENG_ROOT is unset and local cheng-lang was not discovered",
  };
}

export function inspectChengToolchainHealth(input: {
  readonly chengRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly workspaceRoot?: string;
  readonly homeDir?: string;
  readonly pathExists?: (path: string) => boolean;
  readonly readText?: (path: string) => string;
}): ChengToolchainHealthSummary {
  const pathExists = input.pathExists ?? existsSync;
  const readText = input.readText ?? ((p: string) => readFileSync(p, "utf8"));
  const resolved =
    input.chengRoot !== undefined
      ? pathExists(input.chengRoot)
        ? { chengRoot: input.chengRoot }
        : { reason: `chengRoot does not exist: ${input.chengRoot}` }
      : resolveChengRoot(input);

  if (resolved.chengRoot === undefined) {
    return {
      configured: false,
      chengRoot: null,
      readyModes: [],
      driverSha256: null,
      donorCount: 0,
      ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
    };
  }

  const root = resolved.chengRoot;
  const readyModes: ("diagnostic" | "production")[] = [];
  if (pathExists(join(root, "tools", "csg_spec_v2_cli_run"))) {
    readyModes.push("diagnostic");
  }

  let driverSha256: string | null = null;
  let donorCount = 0;
  const provenancePath = join(root, "artifacts", "bootstrap", "cheng.stage3.provenance.txt");
  const donorsListPath = join(root, "artifacts", "csg_donors", "donors.list");
  if (pathExists(provenancePath)) {
    try {
      const content = readText(provenancePath);
      const match = /^compiler_executable_sha256=([a-f0-9]{64})$/m.exec(content);
      if (match?.[1]) {
        driverSha256 = match[1];
      }
    } catch {
      driverSha256 = null;
    }
  }
  if (pathExists(donorsListPath)) {
    try {
      const lines = readText(donorsListPath)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
      donorCount = lines.length;
    } catch {
      donorCount = 0;
    }
  }

  const productionSlotReady =
    pathExists(join(root, "artifacts", "bootstrap", "cheng.stage3")) &&
    pathExists(join(root, "artifacts", "bootstrap", "cheng.linker")) &&
    pathExists(join(root, "artifacts", "csg_donors", "donor_provenance.tsv")) &&
    driverSha256 !== null &&
    donorCount > 0;
  if (productionSlotReady) {
    readyModes.push("production");
  }

  return {
    configured: true,
    chengRoot: root,
    readyModes,
    driverSha256,
    donorCount,
  };
}

export function resolveChengHostPortForApp(
  input: ResolveChengHostPortInput,
): ChengHostPortResolution {
  const env = input.env ?? process.env;
  const pathExists = input.pathExists ?? existsSync;

  const rootResolution = resolveChengRoot({
    env,
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
    pathExists,
  });
  const health = inspectChengToolchainHealth({
    ...(rootResolution.chengRoot === undefined ? {} : { chengRoot: rootResolution.chengRoot }),
    env,
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
    pathExists,
  });

  if (rootResolution.chengRoot === undefined) {
    return skipped(rootResolution.reason ?? "Cheng root unavailable", health);
  }
  const chengRoot = rootResolution.chengRoot;

  const dataBaseDir = input.dataBaseDir.trim();
  if (dataBaseDir.length === 0) {
    return skipped("data base dir is empty", health);
  }

  const explicitEntry = (input.hostEntry ?? env.ZCODE_CHENG_HOST_ENTRY ?? "").trim();
  if (explicitEntry.length > 0) {
    if (!pathExists(explicitEntry)) {
      return skipped(`cheng host entry does not exist: ${explicitEntry}`, health);
    }
    return {
      kind: "wired",
      mode: "file",
      chengRoot,
      dataBaseDir,
      hostEntry: explicitEntry,
      health,
      port: createChengHostPort({
        chengRoot,
        dataBaseDir,
        ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        hostEntry: explicitEntry,
        env,
        ...(input.observer === undefined ? {} : { observer: input.observer }),
      }),
    };
  }

  // env 隔离：只认调用方传入的 env（生产宿主传 process.env，语义不变）。混读全局
  // process.env 会让注入定制 env 的调用方（测试/嵌入宿主）被开发机全局
  // ZCODE_CHENG_HOST_VIA_CLI 污染，resolve 结果随环境漂移。
  if (env[CHENG_HOST_VIA_CLI_ENV] !== "1") {
    return skipped(
      "cheng host entry is unset (options.chengHostEntry / ZCODE_CHENG_HOST_ENTRY) and CLI re-exec is not advertised",
      health,
    );
  }

  const cliCommand = resolveCliHostCommand(input.runtime, pathExists);
  if (cliCommand === undefined) {
    return skipped(
      "CLI re-exec is unavailable (run from a packaged CLI or set ZCODE_CHENG_HOST_ENTRY)",
      health,
    );
  }
  return {
    kind: "wired",
    mode: "cli",
    chengRoot,
    dataBaseDir,
    cliCommand,
    health,
    port: createChengHostPort({
      chengRoot,
      dataBaseDir,
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      cliCommand,
      env,
      ...(input.observer === undefined ? {} : { observer: input.observer }),
    }),
  };
}

function resolveCliHostCommand(
  runtime: ChengHostRuntimeProbe | undefined,
  pathExists: (path: string) => boolean,
): string[] | undefined {
  if ((runtime?.isSea ?? detectSeaRuntime()) === true) {
    return [CHENG_HOST_COMMAND];
  }
  const argv = runtime?.argv ?? process.argv;
  const script = argv[1];
  if (script === undefined || !/\.(?:cjs|mjs|js)$/.test(script) || !pathExists(script)) {
    return undefined;
  }
  return [script, CHENG_HOST_COMMAND];
}

/** SEA 探针（与 bootstrap 的 dwf child spawn 同款 `node:sea` 读取）。 */
function detectSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => { isSea(): boolean })
    | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

function skipped(reason: string, health: ChengToolchainHealthSummary): ChengHostPortResolution {
  return { kind: "skipped", reason, health: { ...health, reason } };
}
