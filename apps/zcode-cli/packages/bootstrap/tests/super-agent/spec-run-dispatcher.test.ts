import { describe, expect, it } from "vitest";
import {
  SPEC_RESTRICTED_PROFILE_NAME,
  filterSpecRestrictedToolNames,
} from "@zcode/core";

import {
  FenceStartupError,
  createSpecRunDispatcher,
  type PrepareFenceRequest,
  type PrepareSpecRunEgressRequest,
  type SpecFenceContract,
  type SpecFenceHandle,
  type SpecRunEgressPlan,
  type SpecRunLaunchRequest,
  type SuperAgentSpecLaneContract,
} from "../../src/super-agent/spec-lane/index.js";

const WORKSPACE_ROOT = "/tmp/ws-spec";

function fakeEgress(options?: {
  proxyUrl?: string;
  allowHostsEcho?: PrepareSpecRunEgressRequest[];
}): SuperAgentSpecLaneContract & { stops: string[] } {
  const stops: string[] = [];
  return {
    stops,
    async prepareSpecRunEgress(request: PrepareSpecRunEgressRequest): Promise<SpecRunEgressPlan> {
      options?.allowHostsEcho?.push(request);
      return {
        workspaceRoot: request.workspaceRoot,
        proxyUrl: options?.proxyUrl ?? "http://127.0.0.1:12345",
        networkPolicy: {
          httpProxy: options?.proxyUrl ?? "http://127.0.0.1:12345",
          noProxy: "",
        },
        allowHosts: request.allowHosts ?? [],
      };
    },
    async stopSpecRunEgress(workspaceRoot: string): Promise<void> {
      stops.push(workspaceRoot);
    },
  };
}

function specInput() {
  return {
    triggerId: "t-1",
    workspaceIdentity: "ws-a",
    threadKey: "bot:bot-1:u1:t1",
    source: "im",
    tier: "speculative" as const,
    reason: "CI 失败可复现",
    evidence: ["log:1"],
    card: {
      currentEvidence: "runner.ts:2178",
      candidateOptions: [
        { option: "A", cost: "c1" },
        { option: "B", cost: "c2" },
      ],
      recommendation: "A",
      impact: "core",
      verification: "vitest",
    },
  };
}

function proxyEnv(plan: SpecRunEgressPlan): Record<string, string> {
  return {
    PATH: "/usr/bin",
    HOME: "/home/u",
    HTTP_PROXY: plan.proxyUrl,
    HTTPS_PROXY: plan.proxyUrl,
    http_proxy: plan.proxyUrl,
    https_proxy: plan.proxyUrl,
  };
}

describe("M5 spec run dispatcher（三件套绑死 + subagent 唯一形态）", () => {
  it("按 egress → env → restricted profile → subagent launch 顺序装配", async () => {
    const launched: SpecRunLaunchRequest[] = [];
    const egress = fakeEgress();
    const dispatcher = createSpecRunDispatcher({
      egress,
      buildProcessEnv: proxyEnv,
      resolveWorkspaceRoot: () => WORKSPACE_ROOT,
      launch: {
        launch: async (request) => {
          launched.push(request);
          return { runId: "run-1" };
        },
      },
    });

    await dispatcher.start(specInput());

    expect(launched).toHaveLength(1);
    const request = launched[0]!;
    expect(request.form).toBe("subagent");
    expect(request.workspaceRoot).toBe(WORKSPACE_ROOT);
    expect(request.profile.name).toBe(SPEC_RESTRICTED_PROFILE_NAME);
    expect(request.profile.permissionMode).toBe("dontAsk");
    // 工具面结构性无出站工具（二次过滤仍相等）。
    expect(filterSpecRestrictedToolNames(request.profile.tools ?? [])).toEqual(
      request.profile.tools ?? [],
    );
    // 无凭据 env：只有白名单键 + 代理。
    expect(Object.keys(request.processEnv).sort()).toEqual(
      ["HOME", "HTTPS_PROXY", "HTTP_PROXY", "PATH", "http_proxy", "https_proxy"].sort(),
    );
    expect(request.prompt).toContain("方案卡（M6）");
    expect(request.prompt).toContain("runner.ts:2178");
    // run 终态后代理已停。
    expect(egress.stops).toEqual([WORKSPACE_ROOT]);
  });

  it("egress 缺 proxyUrl → 拒绝启动、launch 不执行、代理仍被清理", async () => {
    const launched: SpecRunLaunchRequest[] = [];
    const egress = fakeEgress({ proxyUrl: "" });
    const dispatcher = createSpecRunDispatcher({
      egress,
      buildProcessEnv: proxyEnv,
      resolveWorkspaceRoot: () => WORKSPACE_ROOT,
      launch: {
        launch: async (request) => {
          launched.push(request);
          return { runId: "run-1" };
        },
      },
    });

    await expect(dispatcher.start(specInput())).rejects.toThrow(/缺 proxyUrl/);
    expect(launched).toHaveLength(0);
    expect(egress.stops).toEqual([WORKSPACE_ROOT]);
  });

  it("processEnv 未携带代理 → 拒绝启动（三件套未绑死）", async () => {
    const launched: SpecRunLaunchRequest[] = [];
    const dispatcher = createSpecRunDispatcher({
      egress: fakeEgress(),
      buildProcessEnv: () => ({ PATH: "/usr/bin" }),
      resolveWorkspaceRoot: () => WORKSPACE_ROOT,
      launch: {
        launch: async (request) => {
          launched.push(request);
          return { runId: "run-1" };
        },
      },
    });

    await expect(dispatcher.start(specInput())).rejects.toThrow(/未携带 egress 代理/);
    expect(launched).toHaveLength(0);
  });

  it("launch 失败原样上抛且代理仍被清理", async () => {
    const egress = fakeEgress();
    const dispatcher = createSpecRunDispatcher({
      egress,
      buildProcessEnv: proxyEnv,
      resolveWorkspaceRoot: () => WORKSPACE_ROOT,
      launch: {
        launch: async () => {
          throw new Error("subagent 配额耗尽");
        },
      },
    });

    await expect(dispatcher.start(specInput())).rejects.toThrow(/subagent 配额耗尽/);
    expect(egress.stops).toEqual([WORKSPACE_ROOT]);
  });

  it("per-repo allowHosts 注入 prepare（缺省空表 = 零 egress）", async () => {
    const seen: PrepareSpecRunEgressRequest[] = [];
    const dispatcher = createSpecRunDispatcher({
      egress: fakeEgress({ allowHostsEcho: seen }),
      buildProcessEnv: proxyEnv,
      resolveWorkspaceRoot: () => WORKSPACE_ROOT,
      resolveAllowHosts: () => ["registry.npmjs.org"],
      launch: { launch: async () => ({ runId: "run-1" }) },
    });

    await dispatcher.start(specInput());
    expect(seen[0]?.allowHosts).toEqual(["registry.npmjs.org"]);
  });

  it("围栏准备失败 → run 拒绝启动（FenceStartupError 上抛、launch 不执行、代理仍被清理）", async () => {
    const launched: SpecRunLaunchRequest[] = [];
    const fenceCalls = { prepares: 0, teardowns: 0 };
    const fence: SpecFenceContract = {
      async probeCapability() {
        throw new Error("dispatcher 不应直接 probe；prepare 内部负责");
      },
      async prepare() {
        fenceCalls.prepares += 1;
        throw new FenceStartupError("fence.unsupported_platform", "win32", "Windows WFP 未实现");
      },
    };
    const egress = fakeEgress();
    const dispatcher = createSpecRunDispatcher({
      egress,
      fence,
      buildProcessEnv: proxyEnv,
      resolveWorkspaceRoot: () => WORKSPACE_ROOT,
      launch: {
        launch: async (request) => {
          launched.push(request);
          return { runId: "run-1" };
        },
      },
    });

    await expect(dispatcher.start(specInput())).rejects.toBeInstanceOf(FenceStartupError);
    expect(fenceCalls.prepares).toBe(1);
    expect(fenceCalls.teardowns).toBe(0);
    expect(launched).toHaveLength(0);
    expect(egress.stops).toEqual([WORKSPACE_ROOT]);
  });

  it("围栏建立成功 → launch 携带句柄，run 终态先拆围栏再停代理", async () => {
    const launched: SpecRunLaunchRequest[] = [];
    const events: string[] = [];
    const fencePrepares: PrepareFenceRequest[] = [];
    const fence: SpecFenceContract = {
      async probeCapability() {
        throw new Error("dispatcher 不应直接 probe；prepare 内部负责");
      },
      async prepare(request) {
        fencePrepares.push(request);
        events.push(`fence.prepare:${request.runId}`);
        const handle: SpecFenceHandle = {
          runId: request.runId,
          mechanism: "linux-netns-nftables",
          broker: request.broker,
          wrapExecutionRequest: (execution) => execution,
          async teardown() {
            events.push(`fence.teardown:${request.runId}`);
          },
        };
        return handle;
      },
    };
    const egress: SuperAgentSpecLaneContract = {
      async prepareSpecRunEgress(): Promise<SpecRunEgressPlan> {
        events.push("egress.prepare");
        return {
          workspaceRoot: WORKSPACE_ROOT,
          proxyUrl: "http://127.0.0.1:12345",
          networkPolicy: { httpProxy: "http://127.0.0.1:12345", noProxy: "" },
          allowHosts: [],
        };
      },
      async stopSpecRunEgress(): Promise<void> {
        events.push("egress.stop");
      },
    };
    const dispatcher = createSpecRunDispatcher({
      egress,
      fence,
      buildProcessEnv: proxyEnv,
      resolveWorkspaceRoot: () => WORKSPACE_ROOT,
      launch: {
        launch: async (request) => {
          launched.push(request);
          events.push("launch");
          return { runId: "run-1" };
        },
      },
    });

    await dispatcher.start(specInput());
    expect(launched).toHaveLength(1);
    expect(launched[0]?.fence?.runId).toBe("t-1");
    expect(launched[0]?.fence?.broker).toEqual({ host: "127.0.0.1", port: 12345 });
    // 能力范围必须跟随本次 egress plan（Linux 非空白名单据此 typed 拒绝）。
    expect(fencePrepares[0]?.allowHosts).toEqual([]);
    expect(events).toEqual([
      "egress.prepare",
      "fence.prepare:t-1",
      "launch",
      "fence.teardown:t-1",
      "egress.stop",
    ]);
  });

  it("同 workspace 并发 start 串行：prepare→launch→stop 原子，后一个 run 等前一个停代理", async () => {
    // egress 契约是同 workspace 单代理：并发 prepare 会关掉对方的监听。一批 accept
    // 可同时 dispatch 多个 run，因此 dispatcher 必须按 workspace 串行。
    const events: string[] = [];
    let prepareCount = 0;
    let launchCount = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const egress: SuperAgentSpecLaneContract = {
      async prepareSpecRunEgress(request): Promise<SpecRunEgressPlan> {
        prepareCount += 1;
        events.push(`prepare:${prepareCount}`);
        return {
          workspaceRoot: request.workspaceRoot,
          proxyUrl: "http://127.0.0.1:12345",
          networkPolicy: { httpProxy: "http://127.0.0.1:12345", noProxy: "" },
          allowHosts: [],
        };
      },
      async stopSpecRunEgress(workspaceRoot): Promise<void> {
        events.push(`stop:${workspaceRoot}`);
      },
    };
    const dispatcher = createSpecRunDispatcher({
      egress,
      buildProcessEnv: proxyEnv,
      resolveWorkspaceRoot: () => WORKSPACE_ROOT,
      launch: {
        launch: async () => {
          launchCount += 1;
          const current = launchCount;
          events.push(`launch:${current}:start`);
          if (current === 1) await firstGate;
          events.push(`launch:${current}:end`);
          return { runId: `run-${current}` };
        },
      },
    });

    const first = dispatcher.start(specInput());
    const second = dispatcher.start(specInput());
    while (!events.includes("launch:1:start")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // 第一个 run 未结束前，第二个 run 不得 prepare（否则代理已被替换）。
    expect(prepareCount).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "prepare:1",
      "launch:1:start",
      "launch:1:end",
      `stop:${WORKSPACE_ROOT}`,
      "prepare:2",
      "launch:2:start",
      "launch:2:end",
      `stop:${WORKSPACE_ROOT}`,
    ]);
  });
});
