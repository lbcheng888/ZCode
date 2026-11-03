import { describe, expect, it } from "vitest";
import {
  SPEC_RESTRICTED_PROFILE_NAME,
  filterSpecRestrictedToolNames,
} from "@zcode/core";

import {
  createSpecRunDispatcher,
  type SpecRunLaunchRequest,
} from "../../src/super-agent/spec-lane/index.js";
import type {
  PrepareSpecRunEgressRequest,
  SpecRunEgressPlan,
  SuperAgentSpecLaneContract,
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
});
