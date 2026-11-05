/**
 * §3.8 显式 peer 门模式的真实 CLI 集成：
 * - 子进程走 `runSuperAgentControlPlaneCommand`（真实 env 解析），而不是测试直连；
 * - 原生 addon 在真实 Unix socket 上解析对端 PID；
 * - 可信集合 = spawn 父进程 + `ZCODE_CONTROL_PLANE_TRUSTED_PIDS`（Supervisor 投影的 Core PID）；
 * - addon 缺失/未显式开启时启动 fatal，绝不静默退化。
 *
 * Windows 运行时拿不到 named-pipe 句柄，addon 恒 unavailable，这里按平台守卫跳过。
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  resolveControlPlaneSocketPath,
} from "@zcode/shared/super-agent-control-plane-protocol";

const TEST_TIMEOUT_MS = 30_000;
const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const addonPath = join(
  repoRoot,
  "packages",
  "native-peer-credentials",
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "peercred.node",
);
const buildScript = join(repoRoot, "scripts", "build-native-peer-credentials.mjs");
const supportedPlatform = process.platform === "darwin" || process.platform === "linux";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(() => {
  if (!supportedPlatform) return;
  if (existsSync(addonPath)) return;
  // 干净 checkout / CI 没有预构建产物：显式构建，工具链缺失就失败，不静默 skip。
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to build native peer credentials addon: ${result.stderr || result.stdout || result.error}`,
    );
  }
  if (!existsSync(addonPath)) {
    throw new Error(`build script finished without producing ${addonPath}`);
  }
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bundleFixture(): Promise<string> {
  const fixture = fileURLToPath(
    new URL("./fixtures/control-plane-peer-mode-child.ts", import.meta.url),
  );
  const result = await build({
    entryPoints: [fixture],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("fixture bundle produced no output");
  return output.text;
}

interface DaemonMessages {
  child: ChildProcessWithoutNullStreams;
  messages: Array<Record<string, unknown>>;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

function collectMessages(child: ChildProcessWithoutNullStreams): DaemonMessages {
  const messages: Array<Record<string, unknown>> = [];
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.on("message", (raw: unknown) => messages.push(raw as Record<string, unknown>));
  return { child, messages, exited };
}

async function waitForDaemonMessage(
  daemon: DaemonMessages,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = daemon.messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for daemon message; got ${JSON.stringify(daemon.messages)}`);
}

async function spawnPeerDaemon(options: {
  dataBaseDir: string;
  serverRoot: string;
  peerMode: boolean;
  nativeAddonPath?: string;
  trustedPids?: readonly number[];
}): Promise<DaemonMessages> {
  const bundle = await bundleFixture();
  mkdirSync(options.dataBaseDir, { recursive: true });
  const bundlePath = join(options.dataBaseDir, `peer-fixture-${Date.now()}.cjs`);
  await writeFile(bundlePath, bundle, "utf8");
  const child = spawn(process.execPath, [bundlePath], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      ZCODE_CONTROL_PLANE_GENERATION: "1",
      ZCODE_CONTROL_PLANE_PROTOCOL_VERSION: String(CONTROL_PLANE_PROTOCOL_VERSION),
      ZCODE_DATA_BASE_DIR: options.dataBaseDir,
      ZCODE_SERVER_ROOT: options.serverRoot,
      ...(options.peerMode ? { ZCODE_CONTROL_PLANE_PEER_MODE: "1" } : {}),
      ...(options.nativeAddonPath
        ? { ZCODE_PEER_CREDENTIALS_NATIVE_PATH: options.nativeAddonPath }
        : {}),
      ...(options.trustedPids && options.trustedPids.length > 0
        ? { ZCODE_CONTROL_PLANE_TRUSTED_PIDS: options.trustedPids.join(",") }
        : {}),
    },
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  return collectMessages(child);
}

const TRUSTED_CLIENT_SCRIPT = `
const fs = require("node:fs");
const net = require("node:net");
const socketPath = process.argv[1];
function attempt() {
  if (!fs.existsSync(socketPath)) return setTimeout(attempt, 25);
  const socket = net.connect(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("connect", () => {
    socket.write(JSON.stringify({ v: 1, id: "1", method: "lease.list", params: {} }) + "\\n");
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.includes('"ok":true')) process.exit(0);
    if (buffer.includes('"ok":false')) process.exit(2);
  });
  socket.on("error", () => process.exit(3));
  socket.on("close", () => process.exit(4));
  setTimeout(() => process.exit(5), 4000);
}
attempt();
setTimeout(() => process.exit(6), 8000);
`;

/** 未被信任的连接：socket 必须被服务端立即断开，且收不到任何回执。 */
const UNTRUSTED_CLIENT_SCRIPT = `
const net = require("node:net");
const socket = net.connect(process.argv[1]);
socket.setEncoding("utf8");
let received = false;
socket.on("data", () => { received = true; });
socket.on("close", () => process.exit(received ? 11 : 0));
socket.on("error", () => process.exit(0));
setTimeout(() => process.exit(10), 4000);
`;

function runClient(script: string, socketPath: string): Promise<number> {
  const child = spawn(process.execPath, ["-e", script, socketPath], {
    stdio: ["ignore", "ignore", "ignore"],
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });
}

describe.skipIf(!supportedPlatform)("control-plane peer mode (real CLI env)", () => {
  it(
    "env 显式 peer 模式：原生 addon 放行 env 可信 PID，拒绝陌生同 UID 进程",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-peer-mode-"));
      roots.push(root);
      const dataBaseDir = join(root, "data");
      const serverRoot = join(root, "server");
      mkdirSync(serverRoot, { recursive: true });
      const socketPath = resolveControlPlaneSocketPath(serverRoot);

      // 先拉起真实客户端进程，拿到它的 PID；它等待 socket 出现后再连接。
      const trustedClient = spawn(process.execPath, ["-e", TRUSTED_CLIENT_SCRIPT, socketPath], {
        stdio: ["ignore", "ignore", "ignore"],
      }) as ChildProcessWithoutNullStreams;
      children.push(trustedClient);
      if (trustedClient.pid === undefined) throw new Error("trusted client has no pid");
      const trustedExit = new Promise<number>((resolve) =>
        trustedClient.once("exit", (code) => resolve(code ?? -1)),
      );

      const daemon = await spawnPeerDaemon({
        dataBaseDir,
        serverRoot,
        peerMode: true,
        nativeAddonPath: addonPath,
        // Core PID 由 Supervisor 经 env 投影；这里用真实客户端 PID 等价证明。
        trustedPids: [trustedClient.pid],
      });
      await waitForDaemonMessage(daemon, (message) => message.type === "ready");
      expect(await trustedExit).toBe(0);

      // 陌生同 UID 进程（真实子进程，不在可信集合且不是 daemon 的 ppid）必须被拒。
      const strangerExit = await runClient(UNTRUSTED_CLIENT_SCRIPT, socketPath);
      expect(strangerExit).toBe(0);
      const rejected = daemon.messages.find(
        (message) =>
          message.type === "test-error" &&
          String(message.context).includes("daemon.peer.rejected"),
      );
      expect(rejected).toBeDefined();

      // 主动 shutdown 证明 daemon 仍在正常服务。
      daemon.child.send({ command: "shutdown" });
      await waitForDaemonMessage(daemon, (message) => message.type === "stopped");
      const exit = await daemon.exited;
      expect(exit.code).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "peer 模式缺少 addon 路径 → 启动 fatal，绝不绑定未认证端点",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-peer-no-addon-"));
      roots.push(root);
      const daemon = await spawnPeerDaemon({
        dataBaseDir: join(root, "data"),
        serverRoot: join(root, "server"),
        peerMode: true,
      });
      const fatal = await waitForDaemonMessage(daemon, (message) => message.type === "fatal");
      expect(String(fatal.message)).toContain("peer mode requires a native peer credentials addon");
      expect(daemon.messages.some((message) => message.type === "ready")).toBe(false);
      const exit = await daemon.exited;
      expect(exit.code).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "peer 模式 addon 文件不存在 → 启动 fatal，不回退到 /proc 或未认证端点",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-peer-bad-addon-"));
      roots.push(root);
      const daemon = await spawnPeerDaemon({
        dataBaseDir: join(root, "data"),
        serverRoot: join(root, "server"),
        peerMode: true,
        nativeAddonPath: join(root, "missing-peercred.node"),
      });
      const fatal = await waitForDaemonMessage(daemon, (message) => message.type === "fatal");
      expect(String(fatal.message)).toContain("native peer credentials addon unavailable");
      expect(daemon.messages.some((message) => message.type === "ready")).toBe(false);
      const exit = await daemon.exited;
      expect(exit.code).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "只配置 addon 路径不会隐式切到 peer 模式：仍要求 auth token",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-token-mode-"));
      roots.push(root);
      const daemon = await spawnPeerDaemon({
        dataBaseDir: join(root, "data"),
        serverRoot: join(root, "server"),
        peerMode: false,
        nativeAddonPath: addonPath,
      });
      const fatal = await waitForDaemonMessage(daemon, (message) => message.type === "fatal");
      expect(String(fatal.message)).toContain("auth token file unreadable");
      const exit = await daemon.exited;
      expect(exit.code).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
