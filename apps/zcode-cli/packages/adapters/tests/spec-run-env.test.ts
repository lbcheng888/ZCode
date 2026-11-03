// spec run env（M5 spec lane）实施测试。
// 锚：docs/architecture/super-agent-spec-lane-spec.md §3——白名单拷贝、强制代理注入、
// 凭据真空、fail-closed（无代理拒绝启动）。
import { describe, expect, it } from "vitest";

import { buildSpecRunEnv } from "../src/network/subprocess-env.js";

const FAKE_CREDENTIALS = {
  GITHUB_TOKEN: "ghp_spec_secret_bytes",
  ANTHROPIC_API_KEY: "sk-spec-secret-bytes",
  npm_config__authToken: "npm-spec-secret-bytes",
  AWS_SECRET_ACCESS_KEY: "aws-spec-secret-bytes",
  ZCODE_TOOL_ENV_PASSTHROUGH_JSON: JSON.stringify({
    SLACK_BOT_TOKEN: "xoxb-spec-secret-bytes",
  }),
} as const;

describe("buildSpecRunEnv (spec lane)", () => {
  it("fails closed when no proxy url is given", () => {
    expect(() => buildSpecRunEnv({ proxyUrl: "" })).toThrow(/缺少 egress 代理地址/);
    expect(() => buildSpecRunEnv({ proxyUrl: "   " })).toThrow(/缺少 egress 代理地址/);
  });

  it("injects the proxy through the applyNetworkEgressEnv channel with no NO_PROXY bypass", () => {
    const proxyUrl = "http://127.0.0.1:18080";
    const env = buildSpecRunEnv({ proxyUrl, sourceEnv: {} });

    expect(env.HTTP_PROXY).toBe(proxyUrl);
    expect(env.http_proxy).toBe(proxyUrl);
    expect(env.HTTPS_PROXY).toBe(proxyUrl);
    expect(env.ALL_PROXY).toBe(proxyUrl);
    // noProxy 恒空 ⇒ 不设 NO_PROXY——一切主机都过代理，由 allowlist 统一裁决（spec §3）。
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
    // 不恢复可能携带凭据的 passthrough JSON（toolEnvPassthrough: false）。
    expect(env.ZCODE_TOOL_ENV_PASSTHROUGH_JSON).toBeUndefined();
  });

  it("copies exactly the spec §3 allowlist key set — full equality, no extras, none missing", () => {
    // spec §3 白名单键集合全等断言：以实现为准（含 USERPROFILE、无 PWD），
    // spec 文档与 SPEC_RUN_ENV_ALLOWLIST 必须逐键一致；防止单侧增删键造成漂移。
    const SPEC_RUN_ENV_ALLOWLIST_KEYS = [
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
    ];
    const sourceEnv: Record<string, string> = {};
    for (const key of SPEC_RUN_ENV_ALLOWLIST_KEYS) {
      sourceEnv[key] = `value-of-${key.toLowerCase()}`;
    }
    // 白名单外的键必须被剔除（含 PWD：cwd 由 spawn 决定，不从 env 传）。
    sourceEnv.PWD = "/stale/parent/cwd";
    sourceEnv.GITHUB_TOKEN = "ghp_spec_secret_bytes";

    const env = buildSpecRunEnv({ proxyUrl: "http://127.0.0.1:18080", sourceEnv });

    // 键集合全等：产出键 = 白名单键 ∪ 代理注入键（ALL_PROXY 六键），无其它键。
    const PROXY_INJECTED_KEYS = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ];
    expect(Object.keys(env).sort()).toEqual(
      [...SPEC_RUN_ENV_ALLOWLIST_KEYS, ...PROXY_INJECTED_KEYS].sort(),
    );
    expect(env.PWD).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("copies only allowlisted keys — the produced env carries no credential bytes", () => {
    const env = buildSpecRunEnv({
      proxyUrl: "http://127.0.0.1:18080",
      sourceEnv: {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/spec",
        LANG: "en_US.UTF-8",
        TMPDIR: "/tmp",
        ...FAKE_CREDENTIALS,
        // 白名单外的杂键同样不得漏过。
        RANDOM_INTERNAL_FLAG: "should-not-pass",
      },
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/spec");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TMPDIR).toBe("/tmp");

    const serialized = JSON.stringify(env);
    for (const [key, value] of Object.entries(FAKE_CREDENTIALS)) {
      expect(env[key]).toBeUndefined();
      expect(serialized).not.toContain(value);
      expect(serialized).not.toContain(key);
    }
    expect(env.RANDOM_INTERNAL_FLAG).toBeUndefined();
    expect(serialized).not.toContain("should-not-pass");
  });

  it("does not fall back to ZCODE_* egress env from the source environment", () => {
    const env = buildSpecRunEnv({
      proxyUrl: "http://127.0.0.1:18080",
      sourceEnv: {
        ZCODE_HTTP_PROXY: "http://evil-proxy:1080",
        ZCODE_NO_PROXY: ".internal",
        ZCODE_AGENT_CA_CERT: "/tmp/evil-ca.pem",
        PATH: "/usr/bin",
      },
    });
    expect(JSON.stringify(env)).not.toContain("evil-proxy");
    expect(JSON.stringify(env)).not.toContain(".internal");
    expect(JSON.stringify(env)).not.toContain("evil-ca");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:18080");
  });
});
