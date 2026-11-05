import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_PLANE_PROTOCOL_VERSION, type ReleaseManifest } from "../src/contracts.js";
import {
  CONTROL_PLANE_SUBCOMMAND,
  createControlPlaneLauncher,
  createDefaultControlPlaneLauncher,
  resolveDefaultControlPlaneCommand,
} from "../src/supervisor/controlPlaneLauncher.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-control-plane-launcher-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function writeFileTree(
  root: string,
  relativePaths: readonly string[],
  content = "",
): Promise<void> {
  for (const relativePath of relativePaths) {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
}

const CHILD_SCRIPT = `
const generation = Number(process.env.ZCODE_CONTROL_PLANE_GENERATION);
const protocolVersion = Number(process.env.ZCODE_CONTROL_PLANE_PROTOCOL_VERSION);
process.send({
  type: "ready",
  protocolVersion,
  generation,
  version: "test",
});
process.send({
  type: "env",
  generation,
  protocolVersion,
  dataBaseDir: process.env.ZCODE_DATA_BASE_DIR,
  serverRoot: process.env.ZCODE_SERVER_ROOT,
  releaseId: process.env.ZCODE_SERVER_RELEASE_ID ?? null,
  mandateGate: process.env.ZCODE_CONTROL_PLANE_MANDATE_GATE ?? null,
});
process.on("message", (message) => {
  if (message && message.command === "shutdown") process.exit(0);
});
setInterval(() => {}, 1000);
`;

function releaseManifest(releaseDir: string, releaseId?: string): ReleaseManifest {
  return { version: "1.0.0", releaseDir, ...(releaseId ? { releaseId } : {}) };
}

function waitForChildMessage(
  child: ChildProcess,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error("timed out waiting for child message"));
    }, timeoutMs);
    const onMessage = (message: unknown): void => {
      if (typeof message !== "object" || message === null) return;
      if (!predicate(message as Record<string, unknown>)) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(message as Record<string, unknown>);
    };
    child.on("message", onMessage);
  });
}

describe("default control plane command resolution", () => {
 it("resolves packaged entry from release runtime layout", async () => {
    const root = await temporaryRoot();
    const releaseDir = join(root, "releases", "1.0.0");
    await writeFileTree(releaseDir, ["runtime/zcode.cjs", "runtime/node"]);

    const resolution = resolveDefaultControlPlaneCommand(
      { serverRoot: join(root, "server"), release: releaseManifest(releaseDir) },
      { platform: "linux" },
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.source).toBe("release");
    expect(resolution.command).toEqual({
      executable: join(releaseDir, "runtime", "node"),
      args: [join(releaseDir, "runtime", "zcode.cjs"), CONTROL_PLANE_SUBCOMMAND],
      cwd: releaseDir,
    });
  });

  it("uses node.exe on win32", async () => {
    const root = await temporaryRoot();
    const releaseDir = join(root, "release");
    await writeFileTree(releaseDir, ["runtime/zcode.cjs", "runtime/node.exe"]);

    const resolution = resolveDefaultControlPlaneCommand(
      { serverRoot: join(root, "server"), release: releaseManifest(releaseDir) },
      { platform: "win32" },
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.command.executable).toBe(join(releaseDir, "runtime", "node.exe"));
  });

  it("fails loudly instead of guessing when release entry is missing", async () => {
    const root = await temporaryRoot();
    const releaseDir = join(root, "release");
    await writeFileTree(releaseDir, ["runtime/node"]);

    const resolution = resolveDefaultControlPlaneCommand(
      { serverRoot: join(root, "server"), release: releaseManifest(releaseDir) },
      { platform: "linux" },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain("runtime/zcode.cjs");
  });

  it("resolves the development entry through the repository tsx cli", async () => {
    const root = await temporaryRoot();
    await writeFileTree(root, [
      "apps/zcode-cli/packages/cli/src/main.ts",
      "node_modules/tsx/dist/cli.mjs",
    ]);
    const searchFrom = join(root, "packages", "zcode-server-cli", "src", "supervisor");
    await mkdir(searchFrom, { recursive: true });

    const resolution = resolveDefaultControlPlaneCommand(
      { serverRoot: join(root, "server"), release: null },
      { devSearchFrom: searchFrom, platform: "darwin" },
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.source).toBe("development");
    expect(resolution.command.executable).toBe(process.execPath);
    expect(resolution.command.args).toEqual([
      join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      join(root, "apps", "zcode-cli", "packages", "cli", "src", "main.ts"),
      CONTROL_PLANE_SUBCOMMAND,
    ]);
    expect(resolution.command.cwd).toBe(root);
  });

  it("reports both missing release and missing development entry", async () => {
    const root = await temporaryRoot();
    const resolution = resolveDefaultControlPlaneCommand(
      { serverRoot: join(root, "server"), release: null },
      { devSearchFrom: root, platform: "darwin" },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain("找不到");
  });
});

describe("default control plane launcher", () => {
  // win32 的 runtime 可执行文件是 node.exe，且本用例用 symlink(process.execPath→runtime/node)
  // 构造 release 布局；win32 无法可靠复现该布局，显式跳过而不是假设 Unix 路径行为。
  it.skipIf(process.platform === "win32")(
    "maps launch params to env and really spawns the release entry",
    async () => {
      const root = await temporaryRoot();
      const releaseDir = join(root, "release");
      await writeFileTree(releaseDir, ["runtime/zcode.cjs"], CHILD_SCRIPT);
      await symlink(process.execPath, join(releaseDir, "runtime", "node"));

      const launcher = createDefaultControlPlaneLauncher({ platform: "darwin" });
      const child = launcher.launch({
        generation: 7,
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        dataBaseDir: join(root, "data"),
        serverRoot: join(root, "server"),
        release: releaseManifest(releaseDir, "release-7"),
        mandateGate: true,
      });
      try {
        const envMessage = await waitForChildMessage(child, (message) => message.type === "env");
        expect(envMessage).toMatchObject({
          generation: 7,
          protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
          dataBaseDir: join(root, "data"),
          serverRoot: join(root, "server"),
          releaseId: "release-7",
          // §2.3：launcher 只投影 flag，不在子进程里重新读取 RuntimeConfig。
          mandateGate: "1",
        });
      } finally {
        child.kill("SIGKILL");
      }
    },
  );

  it("throws before spawn when the entry cannot be resolved", async () => {
    const root = await temporaryRoot();
    const launcher = createDefaultControlPlaneLauncher({
      devSearchFrom: root,
      platform: "darwin",
    });
    expect(() =>
      launcher.launch({
        generation: 1,
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        dataBaseDir: join(root, "data"),
        serverRoot: join(root, "server"),
        release: null,
      }),
    ).toThrow(/headless 入口不可解析/);
  });

  it("keeps explicit command injection working", () => {
    const launcher = createControlPlaneLauncher({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    expect(typeof launcher.launch).toBe("function");
  });
});
