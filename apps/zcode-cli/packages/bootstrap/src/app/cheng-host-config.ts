import { existsSync } from "node:fs";

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
  /** 宿主显式给的 host 入口（dist/main.js），优先于环境变量与 CLI 子命令。 */
  readonly hostEntry?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 测试缝：默认 `existsSync`。 */
  readonly pathExists?: (path: string) => boolean;
  /** 测试缝：CLI 运行时探测（SEA/argv/execPath）；默认读当前进程。 */
  readonly runtime?: ChengHostRuntimeProbe;
  /** S0：job 生命周期观察者；wired 时原样交给 host 端口。 */
  readonly observer?: ChengJobObserver;
}

export interface ChengHostRuntimeProbe {
  readonly isSea?: boolean;
  readonly execPath?: string;
  readonly argv?: readonly string[];
}

export type ChengHostPortResolution =
  | {
      readonly kind: "wired";
      readonly mode: "file" | "cli";
      readonly chengRoot: string;
      readonly dataBaseDir: string;
      readonly hostEntry?: string;
      readonly cliCommand?: readonly string[];
      readonly port: ChengHostPort;
    }
  | {
      readonly kind: "skipped";
      readonly reason: string;
    };

export function resolveChengHostPortForApp(
  input: ResolveChengHostPortInput,
): ChengHostPortResolution {
  const env = input.env ?? process.env;
  const pathExists = input.pathExists ?? existsSync;

  const chengRoot = env.ZCODE_CHENG_ROOT?.trim() ?? "";
  if (chengRoot.length === 0) {
    return skipped("ZCODE_CHENG_ROOT is unset");
  }
  if (!pathExists(chengRoot)) {
    return skipped(`ZCODE_CHENG_ROOT does not exist: ${chengRoot}`);
  }

  const dataBaseDir = input.dataBaseDir.trim();
  if (dataBaseDir.length === 0) {
    return skipped("data base dir is empty");
  }

  const explicitEntry = (input.hostEntry ?? env.ZCODE_CHENG_HOST_ENTRY ?? "").trim();
  if (explicitEntry.length > 0) {
    if (!pathExists(explicitEntry)) {
      return skipped(`cheng host entry does not exist: ${explicitEntry}`);
    }
    return {
      kind: "wired",
      mode: "file",
      chengRoot,
      dataBaseDir,
      hostEntry: explicitEntry,
      port: createChengHostPort({
        chengRoot,
        dataBaseDir,
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
    );
  }

  const cliCommand = resolveCliHostCommand(input.runtime, pathExists);
  if (cliCommand === undefined) {
    return skipped(
      "CLI re-exec is unavailable (run from a packaged CLI or set ZCODE_CHENG_HOST_ENTRY)",
    );
  }
  return {
    kind: "wired",
    mode: "cli",
    chengRoot,
    dataBaseDir,
    cliCommand,
    port: createChengHostPort({
      chengRoot,
      dataBaseDir,
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

function skipped(reason: string): ChengHostPortResolution {
  return { kind: "skipped", reason };
}
