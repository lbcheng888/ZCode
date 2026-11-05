// P6 OS 级 egress 围栏测试（spec §3）。
//
// 覆盖：
// 1) 三平台命令/配置构建器单测（纯函数，任何平台可跑）；
// 2) 平台矩阵/能力探测的 fail-closed 语义（win32 typed unimplemented）；
// 3) macOS sandbox-exec 真围栏（darwin 真跑：代理放行；curl --noproxy 直连
//    非白名单必须失败；node fetch(undici) 直连必须失败）；
// 4) Linux netns 真围栏（平台守卫；当前开发机 darwin 明确 skip 并注明）。
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import type {
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
} from "@zcode/contracts";

import { buildSpecRunEnv } from "../../../adapters/src/network/subprocess-env.js";
import { sweepResidualFences } from "../../src/super-agent/spec-lane/fence/residual.js";
import {
  FenceStartupError,
  SPEC_FENCE_PLATFORM_MATRIX,
  buildDarwinFenceProfile,
  buildFenceCommandPlan,
  buildFencedExecutionCommand,
  buildLinuxFenceNetworkPlan,
  buildLinuxFenceNetworkSetupCommands,
  buildLinuxFenceRuleset,
  buildLinuxFenceRulesetCommand,
  buildLinuxFenceTeardownCommands,
  createFencedExecutionPort,
  createSpecFence,
  createSuperAgentSpecLane,
  fencePlatformMatrixEntry,
  quotePosixShellArg,
  type LinuxFenceCommandPlan,
  type LinuxFenceNetworkPlan,
} from "../../src/super-agent/spec-lane/index.js";

const LINUX_TEST_ENTROPY = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 1, 2, 0x80]);
const LINUX_TEST_NETWORK: LinuxFenceNetworkPlan = buildLinuxFenceNetworkPlan({
  runId: "r-linux",
  entropy: LINUX_TEST_ENTROPY,
});

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

function brokerFromProxyUrl(proxyUrl: string): { host: string; port: number } {
  const parsed = new URL(proxyUrl);
  return { host: parsed.hostname, port: Number(parsed.port) };
}

describe("P6 围栏命令构建器（三平台分支，纯函数）", () => {
  it("linux: 持久 netns + veth，nftables 默认拒绝且只放行 veth 宿主端 broker relay", () => {
    expect(LINUX_TEST_NETWORK).toMatchObject({
      namespaceName: "zcode-spec-1122334455",
      hostInterface: "zch-11223344",
      namespaceInterface: "zcn-11223344",
      hostAddress: "10.2.3.1",
      namespaceAddress: "10.2.3.2",
      prefixLength: 30,
    });
    const plan = buildFenceCommandPlan({
      platform: "linux",
      broker: { host: "127.0.0.1", port: 3128 },
      linuxNetwork: LINUX_TEST_NETWORK,
    });
    expect(plan.mechanism).toBe("linux-netns-nftables");
    if (plan.platform !== "linux") throw new Error("expected linux plan");
    const linuxPlan: LinuxFenceCommandPlan = plan;
    expect(linuxPlan.ipPath).toBe("ip");
    expect(linuxPlan.nftPath).toBe("nft");
    expect(linuxPlan.network).toEqual(LINUX_TEST_NETWORK);

    const ruleset = buildLinuxFenceRuleset({
      network: linuxPlan.network,
      broker: { host: linuxPlan.network.hostAddress, port: 3128 },
    });
    expect(ruleset).toContain("policy drop");
    expect(ruleset).toContain(
      `oif "${linuxPlan.network.namespaceInterface}" ip daddr ${linuxPlan.network.hostAddress} tcp dport 3128 accept`,
    );
    expect(ruleset).not.toContain("dport 3138");
    // 不放行 loopback 出站：宿主 broker 在初始 netns，新 netns 的 127.0.0.1 没有代理。
    expect(ruleset).not.toContain('oif "lo"');
    expect(() =>
      buildLinuxFenceRuleset({
        network: linuxPlan.network,
        broker: { host: "127.0.0.1", port: 3128 },
      }),
    ).toThrow(/veth 宿主地址/);

    const setup = buildLinuxFenceNetworkSetupCommands(linuxPlan.network);
    expect(setup[0]).toEqual(["ip", "netns", "add", "zcode-spec-1122334455"]);
    expect(setup[1]).toEqual([
      "ip",
      "link",
      "add",
      "zch-11223344",
      "type",
      "veth",
      "peer",
      "name",
      "zcn-11223344",
    ]);
    expect(setup[2]).toEqual([
      "ip",
      "link",
      "set",
      "zcn-11223344",
      "netns",
      "zcode-spec-1122334455",
    ]);
    expect(setup[4]).toEqual(["ip", "addr", "add", "10.2.3.1/30", "dev", "zch-11223344"]);
    expect(setup[7]).toEqual([
      "ip",
      "netns",
      "exec",
      "zcode-spec-1122334455",
      "ip",
      "addr",
      "add",
      "10.2.3.2/30",
      "dev",
      "zcn-11223344",
    ]);
    expect(
      buildLinuxFenceRulesetCommand(linuxPlan.network, "/tmp/fence/ruleset.nft"),
    ).toEqual([
      "ip",
      "netns",
      "exec",
      "zcode-spec-1122334455",
      "nft",
      "-f",
      "/tmp/fence/ruleset.nft",
    ]);
    expect(buildLinuxFenceTeardownCommands(linuxPlan.network)).toEqual([
      ["ip", "netns", "del", "zcode-spec-1122334455"],
      ["ip", "link", "del", "zch-11223344"],
    ]);

    const argv = buildFencedExecutionCommand({
      plan,
      command: { mode: "argv", file: "/usr/bin/npm", args: ["ci", "--ignore-scripts=false"] },
      artifacts: { rulesetPath: "/tmp/fence/ruleset.nft" },
    });
    expect(argv.mode).toBe("argv");
    if (argv.mode !== "argv") throw new Error("expected argv");
    expect(argv.file).toBe("ip");
    expect(argv.args).toEqual([
      "netns",
      "exec",
      "zcode-spec-1122334455",
      "/usr/bin/npm",
      "ci",
      "--ignore-scripts=false",
    ]);

    const shell = buildFencedExecutionCommand({
      plan,
      command: { mode: "shell", command: "echo 'quoted'", shellProfile: "posix-bash" },
      artifacts: { rulesetPath: "/tmp/fence/ruleset.nft" },
    });
    expect(shell.mode).toBe("shell");
    if (shell.mode !== "shell") throw new Error("expected shell");
    expect(shell.command).toContain("ip netns exec zcode-spec-1122334455 /bin/bash -c");
    expect(shell.command).toContain("echo '\\''quoted'\\''");
    expect(shell.shellProfile).toBe("posix-bash");
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

  it("平台矩阵登记三平台状态；darwin 标记 deprecated；linux/win32 unimplemented", () => {
    const linux = fencePlatformMatrixEntry("linux");
    // 特权子进程与父进程同 caps，可 nft flush / nsenter 逃逸；降权隔离落地前
    // 不得宣称内核级 egress 围栏（矩阵 fail-closed）。
    expect(linux.status).toBe("unimplemented");
    expect(linux.mechanism).toBe("unsupported");
    expect(linux.egressScope).toBeUndefined();
    expect(linux.notes).toContain("降权");
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

  it("linux 能力探测 = typed unavailable（降权隔离未实现，任何平台可跑）", async () => {
    // 即使探测进程恰好有 CAP_NET_ADMIN 能建 netns，被围栏子进程同样持有该特权，
    // 可 nft flush / 进入宿主 netns；因此在降权隔离+逃逸负向验证落地前必须拒绝。
    const fence = createSpecFence({ platform: "linux" });
    const capability = await fence.probeCapability();
    expect(capability.available).toBe(false);
    if (capability.available) throw new Error("Linux 围栏不应报告可用");
    expect(capability.code).toBe("fence.unsupported_platform");
    expect(capability.detail).toContain("capabilities");
    await expect(
      fence.prepare({
        runId: "r-linux-disabled",
        workspaceRoot: "/tmp/ws",
        broker: { host: "127.0.0.1", port: 1 },
      }),
    ).rejects.toBeInstanceOf(FenceStartupError);
  });

  it("linux 网络计划由熵派生，非法熵/runId 拒绝构建", () => {
    const first = buildLinuxFenceNetworkPlan({
      runId: "r-a",
      entropy: LINUX_TEST_ENTROPY,
    });
    const second = buildLinuxFenceNetworkPlan({
      runId: "r-b",
      entropy: Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 3, 4, 0x04]),
    });
    expect(first.namespaceName).not.toBe(second.namespaceName);
    expect(first.hostAddress).not.toBe(second.hostAddress);
    expect(() =>
      buildLinuxFenceNetworkPlan({ runId: "", entropy: LINUX_TEST_ENTROPY }),
    ).toThrow(/runId/);
    expect(() =>
      buildLinuxFenceNetworkPlan({ runId: "r", entropy: new Uint8Array(7) }),
    ).toThrow(/熵不足/);
  });

  it("fenced execution port：run/start 都改写命令，生命周期方法原样委托", async () => {
    const runs: ExecutionRequest[] = [];
    const starts: ExecutionRequest[] = [];
    const result = { status: "completed", stdout: { text: "", bytes: 0, truncated: false } } as ExecutionResult;
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
      cancelBackgroundTask: async (taskId) => ({ taskId, status: "cancelled", startedAt: new Date() }),
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

  it("ruleset 与 profile 端口唯一：不同 broker 端口产出不同配置", () => {
    const linuxRuleset = (port: number) =>
      buildLinuxFenceRuleset({
        network: LINUX_TEST_NETWORK,
        broker: { host: LINUX_TEST_NETWORK.hostAddress, port },
      });
    expect(linuxRuleset(1001)).not.toBe(linuxRuleset(1002));
    expect(buildDarwinFenceProfile(1001)).not.toBe(buildDarwinFenceProfile(1002));
    expect(buildDarwinFenceProfile(1001)).toContain("localhost:1001");
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

// 共享 tmpdir 的残留对账会执行特权 ip 命令；owner.json 可能由其他本地用户伪造。
// 这些用例不依赖 CAP_NET_ADMIN：校验必须在任何 ip 命令之前拒绝。
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

  it("伪造 namespace/接口前缀或非法 /30 地址：typed 拒绝且不调用回收命令", async () => {
    const maliciousPlans: Record<string, unknown>[] = [
      { ...LINUX_TEST_NETWORK, namespaceName: "evil-netns" },
      { ...LINUX_TEST_NETWORK, hostInterface: "eth0" },
      { ...LINUX_TEST_NETWORK, namespaceInterface: "eth1" },
      { ...LINUX_TEST_NETWORK, hostAddress: "10.2.3.2", namespaceAddress: "10.2.3.3" },
      { ...LINUX_TEST_NETWORK, namespaceAddress: "10.2.4.2" },
      { ...LINUX_TEST_NETWORK, prefixLength: 16 },
    ];
    for (const linuxNetwork of maliciousPlans) {
      const dir = await writeStaleOwner({ linuxNetwork });
      let reclaimed = 0;
      try {
        await expect(
          sweepResidualFences("linux", "current-run", async () => {
            reclaimed += 1;
          }),
        ).rejects.toMatchObject({ code: "fence.startup_failed" });
        expect(reclaimed).toBe(0);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    }
  });

  it("owner.json 篡改 ipPath：拒绝执行未知可执行文件", async () => {
    const dir = await writeStaleOwner({ ipPath: "/tmp/evil-ip" });
    try {
      await expect(
        sweepResidualFences("linux", "current-run", async () => undefined),
      ).rejects.toMatchObject({ code: "fence.startup_failed" });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("合法网络计划 + 死 pid：仍按预期交给回收回调并删除目录", async () => {
    const dir = await writeStaleOwner({
      linuxNetwork: LINUX_TEST_NETWORK,
      ipPath: "ip",
    });
    const reclaimed: string[] = [];
    try {
      await sweepResidualFences("linux", "current-run", async (owner) => {
        reclaimed.push(owner.runId);
      });
      expect(reclaimed).toContain("evil-run");
      await expect(access(dir)).rejects.toThrow();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

// Linux 真围栏执行测试已移除：平台矩阵把 Linux 登记为 unimplemented（子进程降权
// 隔离与逃逸负向验证未实现），probe 在任何 Linux 环境下都返回 typed unavailable。
// fail-closed 证据由上面的「linux 能力探测」单测承担，不再用 127.0.0.1 空连接伪装负向断言。
