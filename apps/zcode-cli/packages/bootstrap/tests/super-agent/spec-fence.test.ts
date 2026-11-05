// P6 OS 级 egress 围栏测试（spec §3）。
//
// 覆盖：
// 1) 三平台命令/配置构建器单测（纯函数，任何平台可跑）；
// 2) 宿主 AF_UNIX→TCP relay 与围栏内 relay 脚本真 socket 测试（任何平台可跑）；
// 3) 平台矩阵/能力探测的 fail-closed 语义（win32 typed unimplemented；非 Linux
//    平台上的 Linux 探测必须 typed unavailable）；
// 4) macOS sandbox-exec 真围栏（darwin 真跑：代理放行；curl --noproxy 直连
//    非白名单必须失败；node fetch(undici) 直连必须失败）；
// 5) Linux user+net namespace 真围栏（Linux 真跑；darwin 明确 skip）：
//    命令经 relay 达 broker；直连宿主端口/外部 IP/nsenter 全部被拒。
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import type {
  ExecutionCommand,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
} from "@zcode/contracts";

import { buildSpecRunEnv } from "../../../adapters/src/network/subprocess-env.js";
import { startUnixBrokerRelay } from "../../src/super-agent/spec-lane/fence/linux-network.js";
import { sweepResidualFences } from "../../src/super-agent/spec-lane/fence/residual.js";
import {
  DEFAULT_UNSHARE_PATH,
  FenceStartupError,
  LINUX_IP_CANDIDATE_PATHS,
  SPEC_FENCE_PLATFORM_MATRIX,
  buildDarwinFenceProfile,
  buildFenceCommandPlan,
  buildFencedExecutionCommand,
  buildLinuxFenceBootstrapScript,
  buildLinuxFenceProbeScript,
  buildLinuxFenceRelayPort,
  buildLinuxFenceRelayScript,
  createFencedExecutionPort,
  createSpecFence,
  createSuperAgentSpecLane,
  fencePlatformMatrixEntry,
  quotePosixShellArg,
  resolveLinuxIpPath,
  type LinuxFenceCommandPlan,
} from "../../src/super-agent/spec-lane/index.js";

const LINUX_TEST_ENTROPY = Uint8Array.from([0x11, 0x22]);
const LINUX_TEST_PORT = buildLinuxFenceRelayPort(LINUX_TEST_ENTROPY);

/** 旧版（已退役 netns+veth 实现）owner.json 中的合法网络计划；仅用于残留校验测试。 */
const LEGACY_LINUX_NETWORK = {
  namespaceName: "zcode-spec-1122334455",
  hostInterface: "zch-11223344",
  namespaceInterface: "zcn-11223344",
  hostAddress: "10.2.3.1",
  namespaceAddress: "10.2.3.2",
  prefixLength: 30,
} as const;

function linuxPlan(overrides: Partial<LinuxFenceCommandPlan> = {}): LinuxFenceCommandPlan {
  const plan = buildFenceCommandPlan({
    platform: "linux",
    broker: { host: "127.0.0.1", port: 3128 },
    ipPath: "/usr/sbin/ip",
    linuxEntropy: LINUX_TEST_ENTROPY,
  });
  if (plan.platform !== "linux") throw new Error("expected linux plan");
  return { ...plan, ...overrides };
}

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("无法解析监听端口");
  return address.port;
}

async function startMirror(): Promise<{
  server: Server;
  port: number;
  requests: () => number;
}> {
  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("mirror-ok");
  });
  const port = await listen(server);
  return { server, port, requests: () => requestCount };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 往返 TCP echo 服务（模拟 broker 侧字节流）。 */
async function startEcho(): Promise<{ close: () => Promise<void>; port: number }> {
  const server = createNetServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("无法解析 echo 端口");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function brokerFromProxyUrl(proxyUrl: string): { host: string; port: number } {
  const parsed = new URL(proxyUrl);
  return { host: parsed.hostname, port: Number(parsed.port) };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("P6 围栏命令构建器（三平台分支，纯函数）", () => {
  it("linux: unshare user+net namespace，新 netns 内 relay + childBroker proxy env（无 veth/nft）", () => {
    const plan = linuxPlan();
    expect(plan.mechanism).toBe("linux-userns-netns-unix-relay");
    expect(plan.unsharePath).toBe(DEFAULT_UNSHARE_PATH);
    expect(plan.ipPath).toBe("/usr/sbin/ip");
    expect(plan.shellPath).toBe("/bin/bash");
    expect(plan.relayPort).toBe(LINUX_TEST_PORT);

    const argv = buildFencedExecutionCommand({
      plan,
      command: { mode: "argv", file: "/usr/bin/npm", args: ["ci", "--ignore-scripts=false"] },
      artifacts: {
        relayScriptPath: "/tmp/fence/relay.mjs",
        unixSocketPath: "/tmp/fence/relay.sock",
        readyFilePath: "/tmp/fence/relay-ready-a",
      },
    });
    expect(argv.mode).toBe("argv");
    if (argv.mode !== "argv") throw new Error("expected argv");
    expect(argv.file).toBe(DEFAULT_UNSHARE_PATH);
    expect(argv.args?.slice(0, 7)).toEqual([
      "--user",
      "--map-root-user",
      "--net",
      "--fork",
      "--",
      "/bin/bash",
      "-c",
    ]);
    const script = argv.args?.[7];
    if (!script) throw new Error("expected bootstrap script");
    expect(script).toContain("/usr/sbin/ip link set lo up");
    expect(script).toContain("/tmp/fence/relay.mjs /tmp/fence/relay.sock");
    expect(script).toContain("ready=/tmp/fence/relay-ready-a.$$");
    expect(script).toContain(`"$ready" ${plan.relayPort} &`);
    expect(script).toContain('while [ ! -s "$ready" ]; do');
    // desktop 宿主 process.execPath 是 Electron：必须以 Node 模式启动 relay。
    expect(script).toContain("ELECTRON_RUN_AS_NODE=1");
    // 整数秒预算，不依赖 fractional sleep（BusyBox 等无法 sleep 0.01）。
    expect(script).toContain("sleep 1");
    expect(script).not.toContain("sleep 0.01");
    expect(script).toContain('kill -0 "$relay_pid"');
    expect(script).toContain(`HTTP_PROXY=http://127.0.0.1:${plan.relayPort}`);
    expect(script).toContain("NO_PROXY='' no_proxy=''");
    expect(script).toContain("/usr/bin/npm ci --ignore-scripts=false");
    expect(script).toContain('exit "$status"');
    // 新机制不依赖 veth/nftables。
    expect(script).not.toContain("veth");
    expect(script).not.toContain("nft");
    expect(script).not.toContain("ip netns");
  });

  it("linux: shell 风格命令也走 argv，用户命令由内层 shell 执行", () => {
    const plan = linuxPlan();
    const wrapped = buildFencedExecutionCommand({
      plan,
      command: { mode: "shell", command: "echo 'quoted'", shellProfile: "posix-bash" },
      artifacts: {
        relayScriptPath: "/tmp/fence/relay.mjs",
        unixSocketPath: "/tmp/fence/relay.sock",
        readyFilePath: "/tmp/fence/relay-ready-b",
      },
    });
    expect(wrapped.mode).toBe("argv");
    if (wrapped.mode !== "argv") throw new Error("expected argv");
    expect(wrapped.file).toBe(DEFAULT_UNSHARE_PATH);
    const script = wrapped.args?.[7];
    if (!script) throw new Error("expected bootstrap script");
    expect(script).toContain("/bin/bash -c");
    expect(script).toContain("echo '\\''quoted'\\''");
  });

  it("linux: 缺少 relay artifacts 直接拒绝（不生成半截围栏命令）", () => {
    const plan = linuxPlan();
    expect(() =>
      buildFencedExecutionCommand({
        plan,
        command: { mode: "argv", file: "/bin/true" },
        artifacts: { relayScriptPath: "/tmp/fence/relay.mjs" },
      }),
    ).toThrow(/relay 脚本/);
  });

  it("linux: relay 端口由熵派生且在保留范围内；熵不足拒绝", () => {
    const first = buildLinuxFenceRelayPort(Uint8Array.from([0x11, 0x22]));
    const second = buildLinuxFenceRelayPort(Uint8Array.from([0x33, 0x44]));
    expect(first).toBe(LINUX_TEST_PORT);
    expect(first).not.toBe(second);
    expect(first).toBeGreaterThanOrEqual(20_000);
    expect(first).toBeLessThan(60_000);
    expect(() => buildLinuxFenceRelayPort(new Uint8Array(1))).toThrow(/熵不足/);
  });

  it("linux: relay 脚本只在 127.0.0.1 监听并转发到 AF_UNIX，不解释协议", () => {
    const script = buildLinuxFenceRelayScript();
    expect(script).toContain('server.listen(port, "127.0.0.1"');
    expect(script).toContain("connectUnix(socketPath)");
    expect(script).toContain('writeFileSync(readyPath');
    expect(script).not.toContain("nft");
    expect(script).not.toContain("veth");
  });

  it("linux: ip 按绝对候选路径解析，不依赖 PATH；显式配置优先", async () => {
    const tried: string[] = [];
    const resolved = await resolveLinuxIpPath(undefined, async (path) => {
      tried.push(path);
      return path === "/usr/bin/ip";
    });
    expect(resolved).toBe("/usr/bin/ip");
    expect(tried).toEqual([...LINUX_IP_CANDIDATE_PATHS]);
    expect(await resolveLinuxIpPath(undefined, async () => false)).toBeUndefined();
    expect(
      await resolveLinuxIpPath("/opt/bin/ip", async (path) => path === "/opt/bin/ip"),
    ).toBe("/opt/bin/ip");
  });

  it("linux: 语义探测在真实 netns 内启动生产 relay 并读回转发结果", () => {
    const plan = linuxPlan();
    const script = buildLinuxFenceProbeScript({
      plan,
      artifacts: {
        relayScriptPath: "/tmp/fence/relay.mjs",
        unixSocketPath: "/tmp/fence/relay.sock",
        readyFilePath: "/tmp/fence/relay-ready-probe",
      },
      expectation: "spec-fence-probe-ok",
    });
    expect(script).toContain("/usr/sbin/ip link set lo up");
    expect(script).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(script).toContain(`exec 3<>/dev/tcp/127.0.0.1/${plan.relayPort}`);
    expect(script).toContain("[ \"$greeting\" = spec-fence-probe-ok ]");
    const syntax = spawnSync("/bin/bash", ["-n", "-c", script], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("darwin: sandbox-exec profile deny network-outbound，仅放行 localhost broker", () => {
    const plan = buildFenceCommandPlan({
      platform: "darwin",
      broker: { host: "127.0.0.1", port: 4321 },
    });
    expect(plan.mechanism).toBe("darwin-sandbox-exec");
    if (plan.platform !== "darwin") throw new Error("expected darwin plan");
    expect(plan.sandboxExecPath).toBe("/usr/bin/sandbox-exec");
    expect(plan.profileText).toContain("(deny network-outbound)");
    expect(plan.profileText).toContain('(allow network-outbound (remote ip "localhost:4321"))');
    // sandbox-exec 的 remote ip 只接受 localhost/*，写 127.0.0.1 会在编译期报错。
    expect(plan.profileText).not.toContain("127.0.0.1");

    const argv = buildFencedExecutionCommand({
      plan,
      command: { mode: "argv", file: "/usr/bin/npm", args: ["ci"] },
      artifacts: { profilePath: "/tmp/fence/profile.sb" },
    });
    expect(argv.mode).toBe("argv");
    if (argv.mode !== "argv") throw new Error("expected argv");
    expect(argv.file).toBe("/usr/bin/sandbox-exec");
    expect(argv.args).toEqual(["-f", "/tmp/fence/profile.sb", "--", "/usr/bin/npm", "ci"]);

    const shell = buildFencedExecutionCommand({
      plan,
      command: { mode: "shell", command: "curl --noproxy '*' http://example.com" },
      artifacts: { profilePath: "/tmp/fence/profile.sb" },
    });
    expect(shell.mode).toBe("shell");
    if (shell.mode !== "shell") throw new Error("expected shell");
    expect(shell.command).toContain("/usr/bin/sandbox-exec -f /tmp/fence/profile.sb -- /bin/bash -c");
  });

  it("win32: typed unimplemented（不静默降级）", () => {
    const plan = buildFenceCommandPlan({
      platform: "win32",
      broker: { host: "127.0.0.1", port: 3128 },
    });
    expect(plan.mechanism).toBe("unsupported");
    if (plan.mechanism !== "unsupported") throw new Error("expected unsupported");
    expect(plan.reason).toBe("fence.unsupported_platform");
    expect(() =>
      buildFencedExecutionCommand({
        plan,
        command: { mode: "argv", file: "cmd.exe", args: ["/c", "dir"] },
        artifacts: {},
      }),
    ).toThrow(/fence\.unsupported_platform/);
  });

  it("未登记平台按 unsupported 处理；非 loopback broker 拒绝构建", () => {
    const plan = buildFenceCommandPlan({
      platform: "freebsd",
      broker: { host: "127.0.0.1", port: 3128 },
    });
    expect(plan.mechanism).toBe("unsupported");
    expect(() =>
      buildFenceCommandPlan({ platform: "linux", broker: { host: "10.0.0.1", port: 3128 } }),
    ).toThrow(/loopback/);
    expect(() =>
      buildFenceCommandPlan({ platform: "darwin", broker: { host: "localhost", port: 0 } }),
    ).toThrow(/端口非法/);
  });

  it("平台矩阵登记三平台状态；darwin deprecated；linux = 已实现的 rootless 机制", () => {
    const linux = fencePlatformMatrixEntry("linux");
    expect(linux.status).toBe("implemented");
    expect(linux.mechanism).toBe("linux-userns-netns-unix-relay");
    expect(linux.egressScope).toBe("allowlist");
    expect(linux.notes).toContain("unshare");
    const darwin = fencePlatformMatrixEntry("darwin");
    expect(darwin.status).toBe("implemented");
    expect(darwin.egressScope).toBe("allowlist");
    expect(darwin.deprecated).toBe(true);
    const win32 = fencePlatformMatrixEntry("win32");
    expect(win32.status).toBe("unimplemented");
    expect(win32.mechanism).toBe("unsupported");
    expect(SPEC_FENCE_PLATFORM_MATRIX.map((entry) => entry.platform).sort()).toEqual([
      "darwin",
      "linux",
      "win32",
    ]);
  });

  it("quotePosixShellArg 安全处理空串/空格/单引号", () => {
    expect(quotePosixShellArg("plain")).toBe("plain");
    expect(quotePosixShellArg("")).toBe("''");
    expect(quotePosixShellArg("a b")).toBe("'a b'");
    expect(quotePosixShellArg("it's")).toBe("'it'\\''s'");
  });

  it("win32 能力探测 = typed unavailable；prepare 拒绝启动", async () => {
    const fence = createSpecFence({ platform: "win32" });
    const capability = await fence.probeCapability();
    expect(capability.available).toBe(false);
    if (capability.available) throw new Error("expected unavailable");
    expect(capability.code).toBe("fence.unsupported_platform");
    await expect(
      fence.prepare({
        runId: "r-win",
        workspaceRoot: "/tmp/ws",
        broker: { host: "127.0.0.1", port: 1 },
      }),
    ).rejects.toBeInstanceOf(FenceStartupError);
  });

  it("fenced execution port：run/start 都改写命令，生命周期方法原样委托", async () => {
    const runs: ExecutionRequest[] = [];
    const starts: ExecutionRequest[] = [];
    const result = {
      status: "completed",
      stdout: { text: "", bytes: 0, truncated: false },
    } as ExecutionResult;
    let closed = false;
    const inner: ExecutionPort = {
      run: async (request) => {
        runs.push(request);
        return result;
      },
      start: async (request) => {
        starts.push(request);
        return { taskId: "t", status: "running", startedAt: new Date() };
      },
      getBackgroundTask: async (taskId) => ({ taskId, status: "running", startedAt: new Date() }),
      cancelBackgroundTask: async (taskId) => ({
        taskId,
        status: "cancelled",
        startedAt: new Date(),
      }),
      readBackgroundBashOutput: async (taskId) => ({
        taskId,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
      }),
      close: async () => {
        closed = true;
      },
    };
    const fence = {
      runId: "r",
      mechanism: "darwin-sandbox-exec" as const,
      broker: { host: "127.0.0.1", port: 1 },
      childBroker: { host: "127.0.0.1", port: 1 },
      wrapExecutionRequest: (request: ExecutionRequest): ExecutionRequest => ({
        ...request,
        command: { mode: "argv", file: "fenced-bin" },
      }),
      teardown: async () => undefined,
    };
    const wrapped = createFencedExecutionPort(inner, fence);
    await wrapped.run({ command: { mode: "argv", file: "orig" } });
    await wrapped.start?.({ command: { mode: "argv", file: "orig" } });
    expect(runs[0]?.command).toEqual({ mode: "argv", file: "fenced-bin" });
    expect(starts[0]?.command).toEqual({ mode: "argv", file: "fenced-bin" });
    expect(await wrapped.getBackgroundTask?.("x")).toMatchObject({ taskId: "x" });
    await wrapped.close?.();
    expect(closed).toBe(true);
  });

  it("bootstrap 脚本把代理 env 固定为 childBroker，命令退出码透传", () => {
    const plan = linuxPlan();
    const script = buildLinuxFenceBootstrapScript({
      plan,
      command: { mode: "argv", file: "/bin/echo", args: ["hi"] } as ExecutionCommand,
      artifacts: {
        relayScriptPath: "/tmp/fence/relay.mjs",
        unixSocketPath: "/tmp/fence/relay.sock",
        readyFilePath: "/tmp/fence/relay-ready-c",
      },
    });
    expect(script).toContain(`http://127.0.0.1:${plan.relayPort}`);
    expect(script).toContain("/bin/echo hi");
    expect(script).toContain('exit "$status"');
    // bootstrap 必须是合法 POSIX shell（Linux 上由 /bin/bash -c 执行）。
    const syntax = spawnSync("/bin/bash", ["-n", "-c", script], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("darwin profile 端口唯一：不同 broker 端口产出不同配置", () => {
    expect(buildDarwinFenceProfile(1001)).not.toBe(buildDarwinFenceProfile(1002));
    expect(buildDarwinFenceProfile(1001)).toContain("localhost:1001");
  });
});

// 宿主 AF_UNIX→TCP relay 与围栏内 relay 脚本都不依赖 Linux netns：darwin 上用真实
// socket 跑完整字节中继链路，证明 relay 自身正确（netns 隔离由 Linux 集成测试承担）。
describe("P6 Linux relay 真 socket（任何平台可跑）", () => {
  it("宿主 AF_UNIX relay 0600，字节经 unix→TCP echo 往返", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fence-relay-"));
    const echo = await startEcho();
    const relay = await startUnixBrokerRelay({
      socketPath: join(dir, "relay.sock"),
      target: { host: "127.0.0.1", port: echo.port },
      platform: "linux",
    });
    try {
      const stats = await stat(relay.socketPath);
      expect(stats.mode & 0o777).toBe(0o600);
      const received = await new Promise<string>((resolve, reject) => {
        const client = netConnect(relay.socketPath);
        client.on("error", reject);
        client.on("data", (chunk) => {
          resolve(chunk.toString("utf8"));
          client.end();
        });
        client.write("relay-host-ok");
      });
      expect(received).toBe("relay-host-ok");
    } finally {
      await relay.close();
      await relay.close(); // 幂等
      await echo.close();
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("围栏内 relay 脚本：127.0.0.1 监听，经 AF_UNIX 转发到 broker TCP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fence-relay-script-"));
    const echo = await startEcho();
    const relay = await startUnixBrokerRelay({
      socketPath: join(dir, "relay.sock"),
      target: { host: "127.0.0.1", port: echo.port },
      platform: "linux",
    });
    const scriptPath = join(dir, "relay.mjs");
    const readyPath = join(dir, "ready.json");
    await writeFile(scriptPath, buildLinuxFenceRelayScript(), "utf8");
    const child = spawn(process.execPath, [scriptPath, relay.socketPath, readyPath, "0"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    try {
      const ready = await waitFor(async () => {
        try {
          return (await readFile(readyPath, "utf8")).trim().length > 0;
        } catch {
          return false;
        }
      }, 5_000);
      if (!ready) throw new Error("围栏内 relay 未在 5s 内就绪");
      const port = JSON.parse(await readFile(readyPath, "utf8")).port as number;
      const received = await new Promise<string>((resolve, reject) => {
        const client = netConnect(port, "127.0.0.1");
        client.on("error", reject);
        client.on("data", (chunk) => {
          resolve(chunk.toString("utf8"));
          client.end();
        });
        client.write("relay-in-netns-ok");
      });
      expect(received).toBe("relay-in-netns-ok");
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await relay.close();
      await echo.close();
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe.skipIf(process.platform === "linux")(
  "P6 非 Linux 平台上的 Linux 围栏探测（fail-closed）",
  () => {
    it("缺少 unshare → typed unavailable，prepare 拒绝启动", async () => {
      const fence = createSpecFence({ platform: "linux" });
      const capability = await fence.probeCapability();
      expect(capability.available).toBe(false);
      if (capability.available) throw new Error("非 Linux 不应报告 Linux 围栏可用");
      expect(capability.code).toBe("fence.startup_failed");
      expect(capability.detail).toContain("unshare");
      await expect(
        fence.prepare({
          runId: "r-linux-unavailable",
          workspaceRoot: "/tmp/ws",
          broker: { host: "127.0.0.1", port: 1 },
        }),
      ).rejects.toBeInstanceOf(FenceStartupError);
    });
  },
);

describe("P6 Linux 围栏探测 fail-closed（任何平台可跑）", () => {
  it("unshare 不可执行 → typed unavailable，prepare 拒绝启动", async () => {
    const fence = createSpecFence({
      platform: "linux",
      unsharePath: "/nonexistent/unshare",
    });
    const capability = await fence.probeCapability();
    expect(capability.available).toBe(false);
    if (capability.available) throw new Error("unshare 不可执行不应报告可用");
    expect(capability.code).toBe("fence.startup_failed");
    expect(capability.detail).toContain("unshare");
    await expect(
      fence.prepare({
        runId: "r-linux-no-unshare",
        workspaceRoot: "/tmp/ws",
        broker: { host: "127.0.0.1", port: 1 },
      }),
    ).rejects.toBeInstanceOf(FenceStartupError);
  });
});

describe.skipIf(process.platform !== "darwin")("P6 macOS sandbox-exec 真围栏（darwin 真跑）", () => {
  it("代理放行白名单；curl --noproxy 直连与 node fetch 直连必须失败", async () => {
    const lane = createSuperAgentSpecLane();
    const mirror = await startMirror();
    const outputRoot = await mkdtemp(join(tmpdir(), "zcode-fence-exec-"));
    const fence = createSpecFence();
    try {
      const plan = await lane.prepareSpecRunEgress({
        workspaceRoot: "/repos/fence-darwin",
        allowHosts: [`127.0.0.1:${mirror.port}`],
      });
      const capability = await fence.probeCapability();
      expect(capability.available).toBe(true);
      if (!capability.available) throw new Error(capability.detail);

      const handle = await fence.prepare({
        runId: "fence-darwin",
        workspaceRoot: "/repos/fence-darwin",
        broker: brokerFromProxyUrl(plan.proxyUrl),
      });
      const specEnv = buildSpecRunEnv({
        proxyUrl: plan.proxyUrl,
        sourceEnv: { ...process.env },
      });
      const port = createNodeExecutionAdapter({
        outputRootDir: join(outputRoot, "exec"),
        bashOutputTempDir: tmpdir(),
        network: plan.networkPolicy,
        processEnv: specEnv,
      });
      const fenced = createFencedExecutionPort(port, handle);

      // 1) 白名单 mirror：curl 走代理（代理端口被围栏放行）→ 200 mirror-ok。
      const allowed = await fenced.run({
        command: {
          mode: "shell",
          command: `curl -fsS --max-time 15 http://127.0.0.1:${mirror.port}/`,
        },
        cwd: outputRoot,
        timeoutMs: 30_000,
      });
      expect(allowed.status).toBe("completed");
      expect(allowed.stdout.text).toBe("mirror-ok");

      // 2) 已知残留升级为硬拦截：curl --noproxy '*' 直连非白名单参数（这里
      //    mirror 端口不是 broker 端口）→ 内核/围栏拒绝，curl 必须非零退出。
      const bypass = await fenced.run({
        command: {
          mode: "shell",
          command: `curl -fsS --noproxy '*' --max-time 15 http://127.0.0.1:${mirror.port}/`,
        },
        cwd: outputRoot,
        timeoutMs: 30_000,
      });
      expect(bypass.status).toBe("failed");
      expect(bypass.exitCode).not.toBe(0);
      expect(bypass.stdout.text).not.toContain("mirror-ok");

      // 3) node fetch（undici，不读代理 env）直连必须失败（E2）。
      const undici = await fenced.run({
        command: {
          mode: "shell",
          command: `node -e "fetch('http://127.0.0.1:${mirror.port}/').then(()=>process.exit(0)).catch(()=>process.exit(1))"`,
        },
        cwd: outputRoot,
        timeoutMs: 30_000,
      });
      expect(undici.status).toBe("failed");
      expect(undici.exitCode).toBe(1);

      // 4) 通过代理访问非白名单 host 仍被代理 403（纵深防御协作层仍在）。
      const nonAllowlisted = await fenced.run({
        command: {
          mode: "shell",
          command: `curl -fsS --max-time 15 http://localhost:${mirror.port}/`,
        },
        cwd: outputRoot,
        timeoutMs: 30_000,
      });
      expect(nonAllowlisted.status).toBe("failed");
      expect(nonAllowlisted.exitCode).toBe(22);

      await handle.teardown();
      await port.close?.();
    } finally {
      await lane.stopSpecRunEgress("/repos/fence-darwin");
      await closeServer(mirror.server);
      await rm(outputRoot, { force: true, recursive: true });
    }
  });
});

describe.skipIf(process.platform !== "darwin")("P6 围栏残留对账与状态（darwin 真跑）", () => {
  it("prepare 回收死进程遗留目录；status 只读报告活跃围栏；teardown 后消失", async () => {
    const staleDir = await mkdtemp(join(tmpdir(), "zcode-spec-fence-stale-"));
    await writeFile(
      join(staleDir, "owner.json"),
      JSON.stringify({ runId: "dead-run", pid: 2_000_000_000, startedAt: Date.now() }),
      "utf8",
    );
    const swept: number[] = [];
    const fence = createSpecFence({
      onResidualSwept: ({ removed }) => swept.push(removed),
    });
    const capability = await fence.probeCapability();
    expect(capability.available).toBe(true);
    if (!capability.available) throw new Error(capability.detail);

    const handle = await fence.prepare({
      runId: "residual-ok",
      workspaceRoot: "/repos/fence-residual",
      broker: { host: "127.0.0.1", port: 65535 },
    });
    try {
      expect(fence.status?.("residual-ok")).toMatchObject({
        runId: "residual-ok",
        mechanism: "darwin-sandbox-exec",
        broker: { host: "127.0.0.1", port: 65535 },
        childBroker: { host: "127.0.0.1", port: 65535 },
        pid: process.pid,
      });
      // 死进程（pid 早已不存在）的目录已被启动对账回收（E7），且计数可观测。
      expect(swept[0]).toBeGreaterThanOrEqual(1);
      await expect(access(staleDir)).rejects.toThrow();
    } finally {
      await handle.teardown();
    }
    expect(fence.status?.("residual-ok")).toBeUndefined();
  });

  it("同 runId 仍被存活进程持有 → typed fence.residual_conflict", async () => {
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
      stdio: "ignore",
    });
    const holderPid = holder.pid;
    if (holderPid === undefined) throw new Error("无法取得存活进程 pid");
    const liveDir = await mkdtemp(join(tmpdir(), "zcode-spec-fence-live-"));
    await writeFile(
      join(liveDir, "owner.json"),
      JSON.stringify({ runId: "dup-run", pid: holderPid, startedAt: Date.now() }),
      "utf8",
    );
    const fence = createSpecFence();
    try {
      const capability = await fence.probeCapability();
      expect(capability.available).toBe(true);
      if (!capability.available) throw new Error(capability.detail);
      await expect(
        fence.prepare({
          runId: "dup-run",
          workspaceRoot: "/repos/fence-dup",
          broker: { host: "127.0.0.1", port: 65535 },
        }),
      ).rejects.toMatchObject({ code: "fence.residual_conflict" });
    } finally {
      holder.kill();
      await rm(liveDir, { force: true, recursive: true });
    }
  });
});

describe.skipIf(process.platform !== "darwin")(
  "P6 围栏启用时禁止围栏外 source 用户 rc（darwin 真跑）",
  () => {
    it("~/.bashrc 内直连网络命令不会在围栏外执行；围栏内直连仍被拒", async () => {
      const lane = createSuperAgentSpecLane();
      const mirror = await startMirror();
      const home = await mkdtemp(join(tmpdir(), "zcode-fence-home-"));
      const marker = join(home, "rc-executed");
      // snapshot（bash -lc）会 source ~/.bashrc；login shell（bash -lc）会
      // source ~/.bash_profile。两边都放同一条直连命令，覆盖两种围栏外路径。
      // 只有 curl 真正成功才 touch marker（重定向本身会在失败时也创建文件）。
      const rcScript = `curl -fsS --noproxy '*' --max-time 5 "http://127.0.0.1:${mirror.port}/" >/dev/null 2>&1 && touch '${marker}'\n`;
      await writeFile(join(home, ".bashrc"), rcScript, "utf8");
      await writeFile(join(home, ".bash_profile"), rcScript, "utf8");

      const outputRoot = await mkdtemp(join(tmpdir(), "zcode-fence-exec-"));
      const fence = createSpecFence();
      try {
        const plan = await lane.prepareSpecRunEgress({
          workspaceRoot: "/repos/fence-rc",
          allowHosts: [],
        });
        const capability = await fence.probeCapability();
        expect(capability.available).toBe(true);
        if (!capability.available) throw new Error(capability.detail);
        const handle = await fence.prepare({
          runId: "fence-rc",
          workspaceRoot: "/repos/fence-rc",
          broker: brokerFromProxyUrl(plan.proxyUrl),
          allowHosts: plan.allowHosts,
        });
        const specEnv = buildSpecRunEnv({
          proxyUrl: plan.proxyUrl,
          sourceEnv: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            SHELL: "/bin/bash",
          },
        });
        const port = createNodeExecutionAdapter({
          outputRootDir: join(outputRoot, "exec"),
          bashOutputTempDir: tmpdir(),
          network: plan.networkPolicy,
          processEnv: specEnv,
        });
        const fenced = createFencedExecutionPort(port, handle);

        // 普通 Bash（带 captureCwdAfterSuccess，验证围栏下不跑不可靠的后置捕获）。
        const ok = await fenced.run({
          command: {
            mode: "shell",
            command: "echo fence-ok",
            shellProfile: "posix-bash",
          },
          cwd: outputRoot,
          captureCwdAfterSuccess: true,
          timeoutMs: 30_000,
        });
        expect(ok.status).toBe("completed");
        expect(ok.stdout.text).toContain("fence-ok");

        // 围栏外 rc 一次都没执行：mirror 零请求（marker 只在 curl 成功后 touch）。
        expect(mirror.requests()).toBe(0);
        await expect(access(marker)).rejects.toThrow();

        // 对照：同一围栏内直连仍被硬拒绝（不是“围栏没生效”）。
        const bypass = await fenced.run({
          command: {
            mode: "shell",
            command: `curl -fsS --noproxy '*' --max-time 15 http://127.0.0.1:${mirror.port}/`,
            shellProfile: "posix-bash",
          },
          cwd: outputRoot,
          timeoutMs: 30_000,
        });
        expect(bypass.status).toBe("failed");

        await handle.teardown();
        await port.close?.();
      } finally {
        await lane.stopSpecRunEgress("/repos/fence-rc");
        await closeServer(mirror.server);
        await rm(home, { force: true, recursive: true });
        await rm(outputRoot, { force: true, recursive: true });
      }
    });
  },
);

// Linux 真围栏：只有 Linux + probe 可用（内核允许 unprivileged user namespace）
// 才执行。darwin 上明确 skip；Linux 上 probe 不可用时也 skip，并打印 typed 原因
// （不把环境限制伪装成围栏验证）。
const linuxProbe =
  process.platform === "linux"
    ? await createSpecFence({ platform: "linux" }).probeCapability()
    : undefined;
if (linuxProbe && !linuxProbe.available) {
  console.warn(
    `[spec-fence] Linux userns/netns 集成测试跳过（环境限制）: ${linuxProbe.code} ${linuxProbe.detail}`,
  );
}

describe.skipIf(process.platform !== "linux" || linuxProbe?.available !== true)(
  "P6 Linux user+net namespace 真围栏（Linux 真跑；darwin 明确 skip）",
  () => {
    it("命令经 relay 达 broker；直连宿主端口/外部 IP/nsenter 全部被拒", async () => {
      const lane = createSuperAgentSpecLane();
      const mirror = await startMirror();
      const outputRoot = await mkdtemp(join(tmpdir(), "zcode-fence-linux-exec-"));
      // 固定 relay 端口（24386，低于 Linux 默认 ephemeral 范围），避免与 mirror 端口碰撞。
      const fence = createSpecFence({
        platform: "linux",
        linuxNetworkEntropy: () => Uint8Array.from([0x11, 0x22]),
      });
      try {
        const plan = await lane.prepareSpecRunEgress({
          workspaceRoot: "/repos/fence-linux",
          allowHosts: [`127.0.0.1:${mirror.port}`],
        });
        const capability = await fence.probeCapability();
        expect(capability.available).toBe(true);
        if (!capability.available) throw new Error(capability.detail);

        const handle = await fence.prepare({
          runId: "fence-linux",
          workspaceRoot: "/repos/fence-linux",
          broker: brokerFromProxyUrl(plan.proxyUrl),
          allowHosts: plan.allowHosts,
        });
        // 围栏内 proxy env 必须指向 childBroker（netns 内 relay），不是宿主 broker。
        const childProxy = `http://${handle.childBroker.host}:${handle.childBroker.port}`;
        const specEnv = buildSpecRunEnv({
          proxyUrl: childProxy,
          sourceEnv: { ...process.env },
        });
        const port = createNodeExecutionAdapter({
          outputRootDir: join(outputRoot, "exec"),
          bashOutputTempDir: tmpdir(),
          network: { httpProxy: childProxy, noProxy: "" },
          processEnv: specEnv,
        });
        const fenced = createFencedExecutionPort(port, handle);
        const run = (command: string) =>
          fenced.run({
            command: { mode: "shell", command },
            cwd: outputRoot,
            timeoutMs: 30_000,
          });

        // 0) 围栏内 env：HTTP_PROXY = childBroker，NO_PROXY 为空。
        const envCheck = await run(`echo "$HTTP_PROXY|$NO_PROXY"`);
        expect(envCheck.status).toBe("completed");
        expect(envCheck.stdout.text.trim()).toBe(`${childProxy}|`);

        // 1) E5：白名单 mirror 经 relay→宿主 AF_UNIX→broker 成功。
        const allowed = await run(`curl -fsS --max-time 20 http://127.0.0.1:${mirror.port}/`);
        expect(allowed.status).toBe("completed");
        expect(allowed.stdout.text).toBe("mirror-ok");

        // 2) E1/E3：绕过 proxy env 直连宿主端口（netns 的 127.0.0.1 没有该服务）。
        const direct = await run(
          `curl -fsS --noproxy '*' --max-time 10 http://127.0.0.1:${mirror.port}/`,
        );
        expect(direct.status).toBe("failed");
        expect(direct.exitCode).not.toBe(0);

        // 3) E3：外部 IP 在新 netns 无路由，结构性不可达。
        const external = await run(
          `curl -fsS --noproxy '*' --max-time 10 http://1.1.1.1/`,
        );
        expect(external.status).toBe("failed");
        expect(external.exitCode).not.toBe(0);

        // 4) 逃逸负向验证：宿主 userns 无 CAP_SYS_ADMIN，不能进入宿主 netns。
        const escape = await run("nsenter -t 1 -n true");
        expect(escape.status).toBe("failed");
        expect(escape.exitCode).not.toBe(0);

        await handle.teardown();
        await port.close?.();
      } finally {
        await lane.stopSpecRunEgress("/repos/fence-linux");
        await closeServer(mirror.server);
        await rm(outputRoot, { force: true, recursive: true });
      }
    });
  },
);

// 共享 tmpdir 的残留对账不会执行任何 ip 命令；owner.json 可能由其他本地用户伪造。
// 校验必须在删除/信任任何内容之前拒绝（任何平台可跑）。
describe("P6 围栏残留 owner.json 安全校验（任何平台可跑）", () => {
  async function writeStaleOwner(owner: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zcode-spec-fence-evil-"));
    await writeFile(
      join(dir, "owner.json"),
      JSON.stringify({ runId: "evil-run", pid: 2_000_000_000, startedAt: 0, ...owner }),
      "utf8",
    );
    return dir;
  }

  it("伪造 namespace/接口前缀或非法 /30 地址：typed 拒绝且不删除目录", async () => {
    const maliciousPlans: Record<string, unknown>[] = [
      { ...LEGACY_LINUX_NETWORK, namespaceName: "evil-netns" },
      { ...LEGACY_LINUX_NETWORK, hostInterface: "eth0" },
      { ...LEGACY_LINUX_NETWORK, namespaceInterface: "eth1" },
      { ...LEGACY_LINUX_NETWORK, hostAddress: "10.2.3.2", namespaceAddress: "10.2.3.3" },
      { ...LEGACY_LINUX_NETWORK, namespaceAddress: "10.2.4.2" },
      { ...LEGACY_LINUX_NETWORK, prefixLength: 16 },
    ];
    for (const linuxNetwork of maliciousPlans) {
      const dir = await writeStaleOwner({ linuxNetwork });
      try {
        await expect(
          sweepResidualFences("linux", "current-run"),
        ).rejects.toMatchObject({ code: "fence.startup_failed" });
        await expect(access(dir)).resolves.toBeUndefined();
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    }
  });

  it("owner.json 篡改 ipPath：拒绝处理不可信残留", async () => {
    const dir = await writeStaleOwner({ ipPath: "/tmp/evil-ip" });
    try {
      await expect(
        sweepResidualFences("linux", "current-run"),
      ).rejects.toMatchObject({ code: "fence.startup_failed" });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("合法旧版网络计划 + 死 pid：仅删除目录（新设计不执行 ip 命令）", async () => {
    const dir = await writeStaleOwner({
      linuxNetwork: LEGACY_LINUX_NETWORK,
      ipPath: "ip",
    });
    try {
      const swept = await sweepResidualFences("linux", "current-run");
      expect(swept.removed).toBeGreaterThanOrEqual(1);
      await expect(access(dir)).rejects.toThrow();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
