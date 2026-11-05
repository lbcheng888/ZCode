/**
 * native addon loader 契约（milestone-b-spec §3.8）：
 * 显式路径（参数/env）只认该路径，缺失即 undefined；未显式给出时才探测
 * prebuilds → build/Release。缺失返回 undefined，绝不伪造身份。
 * 真实 PID 断言在 bootstrap 的 peerIdentity.test.ts 用真实 Unix socket + 子进程完成。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  PEER_CREDENTIALS_NATIVE_PATH_ENV,
  loadPeerCredentials,
  resolvePeerCredentialsAddonPath,
} from "../index.mjs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const builtAddonPath = join(
  packageDir,
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "peercred.node",
);
const repoRoot = dirname(dirname(packageDir));
const buildScript = join(repoRoot, "scripts", "build-native-peer-credentials.mjs");

// 产物不入库：干净 checkout 下显式构建，工具链缺失即失败，不静默 skip。
beforeAll(() => {
  // Windows 运行时拿不到 named-pipe HANDLE，addon 不参与认证；不在测试里强制 MSVC 构建。
  if (process.platform === "win32") return;
  if (existsSync(builtAddonPath)) return;
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to build native peer credentials addon: ${result.stderr || result.stdout || result.error}`,
    );
  }
  if (!existsSync(builtAddonPath)) {
    throw new Error(`build script finished without producing ${builtAddonPath}`);
  }
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-peercred-loader-"));
  temporaryRoots.push(root);
  return root;
}

describe("resolvePeerCredentialsAddonPath", () => {
  it("prefers an existing path from the env override", async () => {
    const root = await temporaryRoot();
    const addon = join(root, "peercred.node");
    await writeFile(addon, "");
    const resolved = resolvePeerCredentialsAddonPath({
      env: { [PEER_CREDENTIALS_NATIVE_PATH_ENV]: addon },
      moduleDir: root,
    });
    expect(resolved).toBe(addon);
  });

  it("falls back to prebuilds/<platform>-<arch> when env is absent", async () => {
    const root = await temporaryRoot();
    const platform = process.platform;
    const arch = process.arch;
    const addon = join(root, "prebuilds", `${platform}-${arch}`, "peercred.node");
    await mkdir(join(root, "prebuilds", `${platform}-${arch}`), { recursive: true });
    await writeFile(addon, "");
    const resolved = resolvePeerCredentialsAddonPath({ env: {}, moduleDir: root });
    expect(resolved).toBe(addon);
  });

  it("returns undefined when no candidate exists", async () => {
    const root = await temporaryRoot();
    const resolved = resolvePeerCredentialsAddonPath({
      env: { [PEER_CREDENTIALS_NATIVE_PATH_ENV]: join(root, "missing.node") },
      moduleDir: root,
    });
    expect(resolved).toBeUndefined();
  });

  it("does not fall back to prebuilds when the explicit env path is missing", async () => {
    const root = await temporaryRoot();
    const platform = process.platform;
    const arch = process.arch;
    const prebuilt = join(root, "prebuilds", `${platform}-${arch}`, "peercred.node");
    await mkdir(join(root, "prebuilds", `${platform}-${arch}`), { recursive: true });
    await writeFile(prebuilt, "");
    const resolved = resolvePeerCredentialsAddonPath({
      env: { [PEER_CREDENTIALS_NATIVE_PATH_ENV]: join(root, "missing.node") },
      moduleDir: root,
    });
    expect(resolved).toBeUndefined();
  });

  it("does not fall back to prebuilds when the explicit addonPath is missing", async () => {
    const root = await temporaryRoot();
    const platform = process.platform;
    const arch = process.arch;
    const prebuilt = join(root, "prebuilds", `${platform}-${arch}`, "peercred.node");
    await mkdir(join(root, "prebuilds", `${platform}-${arch}`), { recursive: true });
    await writeFile(prebuilt, "");
    const resolved = resolvePeerCredentialsAddonPath({
      addonPath: join(root, "missing.node"),
      env: {},
      moduleDir: root,
    });
    expect(resolved).toBeUndefined();
  });
});

describe("loadPeerCredentials", () => {
  it("returns undefined instead of faking credentials when the addon is missing", () => {
    expect(
      loadPeerCredentials({ addonPath: join(tmpdir(), "definitely-missing-peercred.node") }),
    ).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "loads the built addon and exposes getPeerCredentials",
    () => {
      const loaded = loadPeerCredentials({ addonPath: builtAddonPath });
      expect(typeof loaded?.getPeerCredentials).toBe("function");
      // 非法 fd 必须返回 typed null，不能返回伪造 PID。
      expect(loaded.getPeerCredentials(-1)).toBeNull();
      expect(loaded.getPeerCredentials(Number.NaN)).toBeNull();
    },
  );

  it("does not treat an explicit missing env path as the prebuilt addon", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "prebuilds", `${process.platform}-${process.arch}`), {
      recursive: true,
    });
    await writeFile(
      join(root, "prebuilds", `${process.platform}-${process.arch}`, "peercred.node"),
      "",
    );
    expect(
      loadPeerCredentials({
        env: { [PEER_CREDENTIALS_NATIVE_PATH_ENV]: join(root, "missing.node") },
        moduleDir: root,
      }),
    ).toBeUndefined();
  });
});
