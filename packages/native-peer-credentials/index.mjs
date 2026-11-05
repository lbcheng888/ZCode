/**
 * 原生 peer credential addon loader（milestone-b-spec §3.8）。
 *
 * 解析规则：
 * - 显式给出路径（`options.addonPath` 或 `ZCODE_PEER_CREDENTIALS_NATIVE_PATH`）时只认该
 *   路径：不存在就返回 `undefined`，绝不回退到 prebuilds/build 掩盖配置错误。
 * - 未显式给出时才按 `prebuilds/<platform>-<arch>/peercred.node` → `build/Release/peercred.node`
 *   探测。都找不到返回 `undefined`，绝不退化为伪造身份；找到但加载失败（损坏/架构不符/
 *   缺导出）原样抛出，不让坏产物被静默忽略。
 *
 * 本模块没有任何运行时依赖；消费者可以按路径加载，不需要在 package.json 里声明依赖。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));

export const PEER_CREDENTIALS_NATIVE_PATH_ENV = "ZCODE_PEER_CREDENTIALS_NATIVE_PATH";

export function resolvePeerCredentialsAddonPath(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const directory = options.moduleDir ?? moduleDir;
  const exists = options.exists ?? existsSync;

  const explicit = options.addonPath?.trim();
  if (explicit) return exists(explicit) ? explicit : undefined;

  const fromEnv = env[PEER_CREDENTIALS_NATIVE_PATH_ENV]?.trim();
  if (fromEnv) return exists(fromEnv) ? fromEnv : undefined;

  const prebuilt = join(directory, "prebuilds", `${platform}-${arch}`, "peercred.node");
  if (exists(prebuilt)) return prebuilt;

  const fallback = join(directory, "build", "Release", "peercred.node");
  if (exists(fallback)) return fallback;

  return undefined;
}

export function loadPeerCredentials(options = {}) {
  const addonPath = resolvePeerCredentialsAddonPath(options);
  if (addonPath === undefined) return undefined;
  const load = options.requireModule ?? require;
  const loaded = load(addonPath);
  if (typeof loaded?.getPeerCredentials !== "function") {
    throw new Error(
      `native peer credentials addon ${addonPath} does not export getPeerCredentials`,
    );
  }
  return loaded;
}

/** 当前平台的已构建 addon；未构建时为 undefined（调用方必须 fail-closed）。 */
export const peerCredentials = loadPeerCredentials();
