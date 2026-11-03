import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  readZCodeToolEnvPassthroughEnv,
} from "@zcode/shared";

export interface NetworkEgressEnvPolicy {
  caCertFile?: string;
  httpProxy?: string;
  noProxy?: string;
}

interface NetworkEgressEnvOptions {
  network?: NetworkEgressEnvPolicy;
  platform?: NodeJS.Platform;
  sourceEnv?: Record<string, string | undefined>;
  toolEnvPassthrough?: boolean;
}

const ALL_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;
const CA_SOURCE_KEYS = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
] as const;
const CA_TARGET_KEYS = CA_SOURCE_KEYS;
const EXPLICIT_CA_SOURCE_KEYS = [ZCODE_AGENT_CA_CERT_ENV_KEY] as const;
const EXPLICIT_NO_PROXY_SOURCE_KEYS = [ZCODE_NO_PROXY_ENV_KEY] as const;

/**
 * spec run（M5 投机执行）子进程 env 的白名单键：运行必需（shell/路径/临时目录/
 * locale）。不在表内的键——一切凭据形态（token/authKey/Authorization/OTEL headers/
 * ZCODE_TOOL_ENV_PASSTHROUGH_JSON…）——结构性不进 env。这是「无凭据」的机械保证，
 * 不靠 denylist 猜键名（凭据形态不可穷举，denylist 无法证明零字节，见
 * docs/architecture/super-agent-spec-lane-spec.md §3）。
 */
const SPEC_RUN_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export interface SpecRunEnvOptions {
  /** 本地 egress 代理地址（如 http://127.0.0.1:12345）。为空即抛——无代理拒绝启动。 */
  proxyUrl: string;
  sourceEnv?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

/**
 * 构造 spec run 的子进程 env：白名单拷贝 + 强制代理注入（复用
 * `applyNetworkEgressEnv` 通道）。fail-closed：`proxyUrl` 为空直接抛错，
 * 任何路径都不回退直连（spec §3 硬不变量）。
 *
 * 注入语义：`sourceEnv: {}` 不回落 ZCODE_HTTP_PROXY/ZCODE_NO_PROXY/
 * ZCODE_AGENT_CA_CERT；`noProxy` 空 ⇒ 不设 NO_PROXY，一切主机（含 localhost）
 * 都必须过代理，由代理 allowlist 统一裁决；`toolEnvPassthrough: false` ⇒
 * 不恢复可能携带凭据的 ZCODE_TOOL_ENV_PASSTHROUGH_JSON。
 */
export function buildSpecRunEnv(options: SpecRunEnvOptions): Record<string, string> {
  const proxyUrl = normalizeEnvValue(options.proxyUrl);
  if (!proxyUrl) {
    throw new Error(
      "spec run 缺少 egress 代理地址：无代理即拒绝启动（fail-closed），不回退直连",
    );
  }
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.sourceEnv ?? {};
  const env: Record<string, string> = {};
  for (const key of SPEC_RUN_ENV_ALLOWLIST) {
    const value = getEnvValue(sourceEnv, key, platform);
    if (value !== undefined) {
      setEnvKey(env, key, value, platform);
    }
  }
  applyNetworkEgressEnv(env, {
    network: { httpProxy: proxyUrl, noProxy: "" },
    sourceEnv: {},
    toolEnvPassthrough: false,
    platform,
  });
  return env;
}

export function applyNetworkEgressEnv(
  env: Record<string, string>,
  options: NetworkEgressEnvOptions,
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.sourceEnv ?? {};
  const network = options.network ?? {};

  deleteEnvKey(env, ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY, platform);
  if (options.toolEnvPassthrough !== false) {
    applyToolEnvPassthroughEnv(env, sourceEnv, platform);
  }
  applyProxyEnv(env, sourceEnv, network, platform);
  applyNoProxyEnv(env, sourceEnv, network, platform);
  applyCaEnv(env, sourceEnv, network, platform);
  return env;
}

function applyToolEnvPassthroughEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): void {
  const passthroughEnv = readZCodeToolEnvPassthroughEnv(sourceEnv);
  for (const [key, value] of Object.entries(passthroughEnv)) {
    setEnvKey(env, key, value, platform);
  }
}

function applyProxyEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const configuredProxy = normalizeProxyValue(network.httpProxy);
  if (configuredProxy) {
    for (const key of ALL_PROXY_KEYS) {
      setEnvKey(env, key, configuredProxy, platform);
    }
    return;
  }

  const zcodeProxy = normalizeProxyValue(
    getFirstEnvValue(sourceEnv, [ZCODE_HTTP_PROXY_ENV_KEY], platform),
  );
  if (zcodeProxy) {
    for (const key of ALL_PROXY_KEYS) {
      setEnvKey(env, key, zcodeProxy, platform);
    }
    return;
  }
}

function applyNoProxyEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const noProxy =
    normalizeEnvValue(network.noProxy) ??
    getFirstEnvValue(sourceEnv, EXPLICIT_NO_PROXY_SOURCE_KEYS, platform);
  if (!noProxy) {
    return;
  }
  for (const key of NO_PROXY_KEYS) {
    setEnvKey(env, key, noProxy, platform);
  }
}

function applyCaEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const caCertFile =
    normalizeEnvValue(network.caCertFile) ??
    getFirstEnvValue(sourceEnv, EXPLICIT_CA_SOURCE_KEYS, platform);
  if (!caCertFile) {
    return;
  }
  for (const key of CA_TARGET_KEYS) {
    setEnvKey(env, key, caCertFile, platform);
  }
}

function normalizeProxyValue(value: string | undefined): string | undefined {
  const trimmed = normalizeEnvValue(value);
  if (!trimmed) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getFirstEnvValue(
  env: Record<string, string | undefined>,
  keys: readonly string[],
  platform: NodeJS.Platform,
): string | undefined {
  for (const key of keys) {
    const value = getEnvValue(env, key, platform);
    if (normalizeEnvValue(value)) {
      return value;
    }
  }
  return undefined;
}

function setEnvKey(
  env: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  deleteEnvKey(env, key, platform);
  env[key] = value;
}

function deleteEnvKey(env: Record<string, string>, key: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    delete env[key];
    return;
  }

  const lowerKey = key.toLowerCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === lowerKey) {
      delete env[existingKey];
    }
  }
}

function getEnvValue(
  env: Record<string, string | undefined>,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") {
    return env[key];
  }
  const lowerKey = key.toLowerCase();
  const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
  return actualKey ? env[actualKey] : undefined;
}
