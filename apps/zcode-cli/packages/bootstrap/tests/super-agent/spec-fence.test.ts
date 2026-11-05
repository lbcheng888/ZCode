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
import {
  FenceStartupError,
  SPEC_FENCE_PLATFORM_MATRIX,
  buildDarwinFenceProfile,
  buildFenceCommandPlan,
  buildFencedExecutionCommand,
  buildLinuxFenceRuleset,
  createFencedExecutionPort,
  createSpecFence,
  createSuperAgentSpecLane,
  fencePlatformMatrixEntry,
  quotePosixShellArg,
  type LinuxFenceCommandPlan,
} from "../../src/super-agent/spec-lane/index.js";

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
  it("linux: unshare --net + nftables 默认拒绝，只放行 loopback broker 端口", () => {
    const plan = buildFenceCommandPlan({
      platform: "linux",
      broker: { host: "127.0.0.1", port: 3128 },
    });
    expect(plan.mechanism).toBe("linux-netns-nftables");
    if (plan.platform !== "linux") throw new Error("expected linux plan");
    const linuxPlan: LinuxFenceCommandPlan = plan;
    expect(linuxPlan.unsharePath).toBe("unshare");
    expect(plan.rulesetText).toContain("policy drop");
    expect(plan.rulesetText).toContain('oif "lo" tcp dport 3128 accept');
    expect(plan.rulesetText).not.toContain("dport 3138");
    expect(plan.setupScript).toContain("ip link set lo up");
    expect(plan.setupScript).toContain('nft -f "$1"');
    expect(plan.setupScript).toContain('exec "$@"');

    const argv = buildFencedExecutionCommand({
      plan,
      command: { mode: "argv", file: "/usr/bin/npm", args: ["ci", "--ignore-scripts=false"] },
      artifacts: { rulesetPath: "/tmp/fence/ruleset.nft" },
    });
    expect(argv.mode).toBe("argv");
    if (argv.mode !== "argv") throw new Error("expected argv");
    expect(argv.file).toBe("unshare");
    expect(argv.args).toEqual([
      "--net",
      "--map-root-user",
      "--fork",
      "--",
      "/bin/bash",
      "-c",
      plan.setupScript,
      "zcode-spec-fence",
      "/tmp/fence/ruleset.nft",
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
    // 不使用 `exec`：保留外层 shell，否则后置退出码处理永不执行。
    expect(shell.command).toContain("unshare --net --map-root-user --fork -- /bin/bash");
    expect(shell.command).not.toMatch(/\bexec unshare\b/);
    expect(shell.command).toContain("/tmp/fence/ruleset.nft");
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

  it("平台矩阵登记三平台状态；darwin 标记 deprecated；win32 unimplemented", () => {
    const linux = fencePlatformMatrixEntry("linux");
    expect(linux.status).toBe("implemented");
    expect(linux.mechanism).toBe("linux-netns-nftables");
    // 机器可读能力范围：Linux 当前没有 veth/围栏内 broker，只能零 egress。
    expect(linux.egressScope).toBe("zero-egress-only");
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

  it("linux 非空 allowHosts：配置级 typed 拒绝（零 egress only，不先启动再中途失败）", async () => {
    const fence = createSpecFence({ platform: "linux" });
    await expect(
      fence.prepare({
        runId: "r-linux-allow",
        workspaceRoot: "/tmp/ws",
        broker: { host: "127.0.0.1", port: 3128 },
        allowHosts: ["registry.npmjs.org"],
      }),
    ).rejects.toMatchObject({ code: "fence.unsupported_platform" });
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
    expect(buildLinuxFenceRuleset(1001)).not.toBe(buildLinuxFenceRuleset(1002));
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

// Linux 真围栏：当前开发机是 darwin，明确 skip（不是静默通过）。
// 若在 Linux 上运行但 user namespace/CAP_NET_ADMIN 不可用，probe 会给出 typed
// 原因并按探测门禁跳过——探测本身即 fail-closed 证据。
describe.skipIf(process.platform !== "linux")("P6 Linux netns 真围栏（当前 darwin 跳过）", () => {
  it("围栏内 curl --noproxy 直连与 node fetch 直连必须失败", async (context) => {
    const fence = createSpecFence();
    const capability = await fence.probeCapability();
    if (!capability.available) {
      context.skip(`Linux 围栏不可用（探测门禁）：${capability.detail}`);
      return;
    }
    const mirror = await startMirror();
    const outputRoot = await mkdtemp(join(tmpdir(), "zcode-fence-exec-"));
    try {
      const handle = await fence.prepare({
        runId: "fence-linux",
        workspaceRoot: "/repos/fence-linux",
        broker: { host: "127.0.0.1", port: 65535 },
      });
      const port = createNodeExecutionAdapter({
        outputRootDir: join(outputRoot, "exec"),
        bashOutputTempDir: tmpdir(),
        processEnv: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      });
      const fenced = createFencedExecutionPort(port, handle);

      const bypass = await fenced.run({
        command: {
          mode: "shell",
          command: `curl -fsS --noproxy '*' --max-time 15 http://127.0.0.1:${mirror.port}/`,
        },
        cwd: outputRoot,
        timeoutMs: 30_000,
      });
      expect(bypass.status).toBe("failed");
      expect(bypass.stdout.text).not.toContain("mirror-ok");

      const undici = await fenced.run({
        command: {
          mode: "shell",
          command: `node -e "fetch('http://127.0.0.1:${mirror.port}/').then(()=>process.exit(0)).catch(()=>process.exit(1))"`,
        },
        cwd: outputRoot,
        timeoutMs: 30_000,
      });
      expect(undici.status).toBe("failed");

      await handle.teardown();
      await port.close?.();
    } finally {
      await closeServer(mirror.server);
      await rm(outputRoot, { force: true, recursive: true });
    }
  });
});
