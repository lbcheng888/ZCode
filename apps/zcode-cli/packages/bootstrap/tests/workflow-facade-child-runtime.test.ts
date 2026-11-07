// workflow facade 的 child runtime 接缝（super-agent-spec-lane-spec §6-1）：
// createWorkflowChildRuntime 的 profile 工具面过滤与 processEnv 直采。
// 与 script-workflow-child-runtime.test.ts 同规则；facade 路径没有 request.opts.tools，
// 工具面只来自 profile.tools。
import * as executionAdapters from "@zcode/adapters/exec";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  type ModelResult,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  type SessionStorePort,
} from "@zcode/contracts";
import {
  buildSpecRestrictedProfile,
  type AgentRuntime,
  PermissionService,
  SPEC_RESTRICTED_TOOLFACE,
  defaultPermissionConfig,
} from "@zcode/core";
import { createModelTelemetry } from "@zcode/telemetry";
import { buildSpecRunEnv } from "../../adapters/src/network/subprocess-env.js";
import { createWorkflowChildRuntime } from "../src/app/workflow-facade.js";
import {
  createTestAgentRuntime,
  createTestModelFactoryFromAdapter,
} from "./helpers/test-agent-runtime.js";

type FacadeDeps = Parameters<typeof createWorkflowChildRuntime>[0];
type ChildRuntimeOptions = Parameters<typeof createWorkflowChildRuntime>[1];

describe("workflow facade child runtime — spec profile 与 processEnv 接缝", () => {
  const parentSessionId = createSessionId("spec-lane-facade-parent");
  let tempRoot: string;
  let sessionStore: SessionStorePort;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-spec-lane-facade-"));
    sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  const modelFactory = createTestModelFactoryFromAdapter({
    async generateText() {
      return {
        finishReason: "stop",
        providerMetadata: undefined,
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as unknown as ModelResult;
    },
  });

  function makeDeps(): FacadeDeps {
    return {
      agentTelemetry: createModelTelemetry().agentExecution,
      appOptions: { env: process.env },
      appVersion: "0.0.0-test",
      cliStorageRoot: tempRoot,
      configResult: {
        config: {
          features: { skill: false },
          modelStream: { idleTimeoutMs: 0 },
          network: {},
          skillOverrides: {},
          skills: { enabled: false, roots: [] },
        },
      },
      imageProcessorPort: {},
      logger: undefined,
      modelFactory,
      permissionService: new PermissionService(defaultPermissionConfig),
      prepareUserExecutionBoundary: async () => {},
      runtime: createTestAgentRuntime(
        parentSessionId,
        { workingDirectory: tempRoot },
        { modelFactory },
      ),
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: parentSessionId,
      sessionStore,
      storageRoot: tempRoot,
      traceContext: createRootTraceContext({ sessionId: parentSessionId }),
      workingDirectory: tempRoot,
    } as unknown as FacadeDeps;
  }

  function configOf(runtime: AgentRuntime): Record<string, unknown> {
    return (runtime as unknown as { config: Record<string, unknown> }).config;
  }

  function childRuntime(
    options: Partial<ChildRuntimeOptions> & Pick<ChildRuntimeOptions, "profile" | "processEnv">,
  ): AgentRuntime {
    const childSessionId = createSessionId("spec-lane-facade-child");
    return createWorkflowChildRuntime(makeDeps(), {
      childSessionId,
      childTraceContext: createRootTraceContext({ sessionId: childSessionId }),
      workflowKind: "expert",
      ...options,
    });
  }

  it("spec profile 生效：工具面剔除出站工具与 mcp__ 动态名", () => {
    // 加固：显式混入出站与动态 MCP 名，证明过滤在跑（而非本来就不在面里）。
    const profile = {
      ...buildSpecRestrictedProfile(),
      tools: [...SPEC_RESTRICTED_TOOLFACE, "WebFetch", "mcp__x__y", "EnterPlanMode"],
    };
    const runtime = childRuntime({ profile });
    const config = configOf(runtime);
    expect(config.toolAllowlist).toEqual([...SPEC_RESTRICTED_TOOLFACE]);
    expect(config.toolAllowlist).not.toContain("WebFetch");
    expect(config.toolAllowlist).not.toContain("mcp__x__y");
    const registry = runtime.getToolRegistry();
    expect(registry.has("Read")).toBe(true);
    expect(registry.has("WebFetch")).toBe(false);
    expect(config.toolDisallowlist).toEqual(expect.arrayContaining(["WebFetch", "mcp__*"]));
  });

  it("processEnv 在场：执行适配器直接采用 buildSpecRunEnv 产出（无凭据、白名单键），network 从 env 派生", () => {
    const execution = vi.spyOn(executionAdapters, "createNodeExecutionAdapter");
    const specEnv = buildSpecRunEnv({
      proxyUrl: "http://127.0.0.1:9",
      sourceEnv: {
        PATH: "/usr/bin:/bin",
        GITHUB_TOKEN: "ghp_should_not_leak",
        ANTHROPIC_API_KEY: "sk_should_not_leak",
      },
    });
    childRuntime({ profile: undefined, processEnv: specEnv });
    const options = execution.mock.calls.at(-1)?.[0];
    expect(options?.processEnv).toBe(specEnv);
    const bytes = JSON.stringify(options?.processEnv ?? {});
    expect(bytes).not.toContain("ghp_should_not_leak");
    expect(bytes).not.toContain("sk_should_not_leak");
    expect(options?.processEnv?.PATH).toBe("/usr/bin:/bin");
    expect(options?.processEnv?.HTTP_PROXY).toBe("http://127.0.0.1:9");
    // network 从 processEnv 派生（§6-3）：spawn 链路 sanitize 后按它回填代理键。
    expect(options?.network?.httpProxy).toBe("http://127.0.0.1:9");
    expect(options?.network?.noProxy).toBe("");
    execution.mockRestore();
  });

  it("processEnv 在场：用户 config 的代理/noProxy 不得进入 network（egress 不被旁路）", () => {
    const execution = vi.spyOn(executionAdapters, "createNodeExecutionAdapter");
    const deps = makeDeps();
    deps.configResult.config.network = {
      httpProxy: "http://user-corp:8080",
      noProxy: "localhost",
      timeout: 0,
    };
    const specEnv = buildSpecRunEnv({
      proxyUrl: "http://127.0.0.1:9",
      sourceEnv: { PATH: "/usr/bin:/bin" },
    });
    createWorkflowChildRuntime(deps, {
      childSessionId: createSessionId("spec-lane-facade-proxy-derive"),
      childTraceContext: createRootTraceContext({
        sessionId: createSessionId("spec-lane-facade-proxy-derive"),
      }),
      workflowKind: "expert",
      processEnv: specEnv,
    });
    const options = execution.mock.calls.at(-1)?.[0];
    expect(options?.network?.httpProxy).toBe("http://127.0.0.1:9");
    expect(options?.network?.noProxy).toBe("");
    execution.mockRestore();
  });

  it("processEnv 缺代理键：fail-closed 抛错，不回退直连", () => {
    expect(() =>
      childRuntime({ profile: undefined, processEnv: { PATH: "/usr/bin" } }),
    ).toThrow(/缺少代理键/);
  });

  it("processEnv/profile 与宿主 executionPort 同在：fail-closed 抛错", () => {
    const specEnv = buildSpecRunEnv({
      proxyUrl: "http://127.0.0.1:9",
      sourceEnv: { PATH: "/usr/bin:/bin" },
    });
    const depsWithPort = (): FacadeDeps => {
      const deps = makeDeps();
      deps.appOptions.executionPort = {
        run: vi.fn(async () => ({
          status: "completed" as const,
          stdout: { text: "", bytes: 0, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          exitCode: 0,
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: new Date(),
          completedAt: new Date(),
        })),
      };
      return deps;
    };
    expect(() =>
      createWorkflowChildRuntime(depsWithPort(), {
        childSessionId: createSessionId("spec-lane-facade-port-env"),
        childTraceContext: createRootTraceContext({
          sessionId: createSessionId("spec-lane-facade-port-env"),
        }),
        workflowKind: "expert",
        processEnv: specEnv,
      }),
    ).toThrow(/executionPort/);
    expect(() =>
      createWorkflowChildRuntime(depsWithPort(), {
        childSessionId: createSessionId("spec-lane-facade-port-profile"),
        childTraceContext: createRootTraceContext({
          sessionId: createSessionId("spec-lane-facade-port-profile"),
        }),
        workflowKind: "expert",
        profile: buildSpecRestrictedProfile(),
      }),
    ).toThrow(/executionPort/);
  });

  it("缺省 profile/processEnv：不收窄工具面，env 回落 appOptions.env", () => {
    const execution = vi.spyOn(executionAdapters, "createNodeExecutionAdapter");
    const deps = makeDeps();
    const childSessionId = createSessionId("spec-lane-facade-default");
    const runtime = createWorkflowChildRuntime(deps, {
      childSessionId,
      childTraceContext: createRootTraceContext({ sessionId: childSessionId }),
      workflowKind: "expert",
    });
    const config = configOf(runtime);
    expect(config.toolAllowlist).toBeUndefined();
    expect(config.toolDisallowlist).toBeUndefined();
    const options = execution.mock.calls.at(-1)?.[0];
    expect(options?.processEnv).toBe(deps.appOptions.env);
    // 缺省路径 network 原样回退用户 config（字节不变）。
    expect(options?.network).toEqual({
      httpProxy: undefined,
      noProxy: undefined,
      caCertFile: undefined,
    });
    execution.mockRestore();
  });

  it("expert workflow child 写工具继承父会话 admission，第二写者被拒", async () => {
    const assertWriteAllowed = vi.fn(() => {
      throw new Error(
        "workspace write rejected: active spec-lane write lease owned by run-spec (tool=Write)",
      );
    });
    const deps = {
      ...makeDeps(),
      workspaceWriteLeaseAdmission: { assertWriteAllowed },
    };
    const childSessionId = createSessionId("spec-lane-facade-lease");
    const runtime = createWorkflowChildRuntime(deps, {
      childSessionId,
      childTraceContext: createRootTraceContext({ sessionId: childSessionId }),
      workflowKind: "expert",
    });
    const call = {
      id: createToolCallId("facade-lease-write"),
      name: "Write",
      input: { file_path: join(tempRoot, "blocked.txt"), content: "second writer" },
    };
    const schedule = await runtime.scheduleTools([call]);
    const result = await runtime.executeTools([call], schedule, {
      traceContext: createRootTraceContext({ sessionId: childSessionId }),
    });

    expect(result.results[0]?.success).toBe(false);
    expect(result.results[0]?.error?.message).toContain("workspace write rejected");
    expect(assertWriteAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Write", workspaceRoot: tempRoot }),
    );
    expect(assertWriteAllowed.mock.calls[0]?.[0]).not.toHaveProperty("ownerRunId");
  });
});
