// spec restricted profile（M5 spec lane）实施测试。
// 锚：docs/architecture/super-agent-spec-lane-spec.md §2——工具面白名单、出站/信道/逃逸
// 剔除表、dontAsk 权限模式、与既有 subagent tool-policy 合流。
import { describe, expect, it } from "vitest";

import type {
  ExecutionPort,
  ExecutionRequest,
  McpPort,
  ModelRequest,
} from "@zcode/contracts";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";

import { toMcpToolName } from "../src/mcp/index.js";
import {
  SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS,
  SPEC_RESTRICTED_PERMISSION_MODE,
  SPEC_RESTRICTED_PROFILE_NAME,
  SPEC_RESTRICTED_TOOLFACE,
  buildSpecRestrictedDisallowRules,
  buildSpecRestrictedProfile,
  filterSpecRestrictedToolNames,
  filterSubagentChildToolNames,
  isSpecRestrictedOutboundToolName,
} from "../src/subagent/tool-policy.js";
import { SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS } from "../src/subagent/tool-policy.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("spec restricted profile (M5)", () => {
  it("pins the workspace-write toolface and the fixed restriction fields", () => {
    const profile = buildSpecRestrictedProfile();

    expect(profile.name).toBe(SPEC_RESTRICTED_PROFILE_NAME);
    expect(profile.tools).toEqual([...SPEC_RESTRICTED_TOOLFACE]);
    expect(profile.disallowedTools).toEqual([...SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS]);
    expect(profile.permissionMode).toBe(SPEC_RESTRICTED_PERMISSION_MODE);
    // 静默 run 不弹窗：dontAsk → resolveSubagentPermissionMode 映射 yolo（spec §2.3）。
    expect(SPEC_RESTRICTED_PERMISSION_MODE).toBe("dontAsk");
    // 复现-修复所需本地执行能力必须在面内（设计 M5：CI 复现必须 Bash + 装依赖）。
    expect(profile.tools).toContain("Bash");
    expect(profile.tools).toContain("Write");
  });

  it("overrides cannot weaken the toolface or the permission mode", () => {
    const profile = buildSpecRestrictedProfile({
      systemPrompt: "custom prompt",
      maxTurns: 7,
    });
    expect(profile.systemPrompt).toBe("custom prompt");
    expect(profile.maxTurns).toBe(7);
    // tools/disallowedTools/permissionMode 是结构性固定的：overrides 类型不接受这些字段，
    // 运行期返回值也必须仍是受限三件套（比任何既有模式都严的机械保证，spec §2.3）。
    expect(profile.tools).toEqual([...SPEC_RESTRICTED_TOOLFACE]);
    expect(profile.permissionMode).toBe("dontAsk");
  });

  it("strips outbound, channel and MCP tools from any tool list", () => {
    const candidate = [
      "Read",
      "Bash",
      "WebFetch",
      "WebSearch",
      "web_search", // 别名归一后同样命中
      "ReplyToChannel",
      "SendMessage",
      "escalate",
      "submit_result",
      "js",
      "Agent",
      "Task",
      "CreateWorkflow",
      "CronCreate",
      "OffPeakCreate",
      "GoalCreate",
      "mcp__github__create_issue",
      "mcp__server__*",
      "Grep",
    ];
    expect([...filterSpecRestrictedToolNames(candidate)]).toEqual([
      "Read",
      "Bash",
      "Grep",
    ]);
  });

  it("recognizes outbound names including the mcp__ prefix", () => {
    expect(isSpecRestrictedOutboundToolName("WebFetch")).toBe(true);
    expect(isSpecRestrictedOutboundToolName("web_search")).toBe(true);
    expect(isSpecRestrictedOutboundToolName("mcp__x__y")).toBe(true);
    expect(isSpecRestrictedOutboundToolName("Bash")).toBe(false);
    expect(isSpecRestrictedOutboundToolName("Read")).toBe(false);
  });

  it("composes with the existing child tool-policy machinery", () => {
    const profile = buildSpecRestrictedProfile();
    const rules = buildSpecRestrictedDisallowRules(undefined);
    // child 强制规则（plan 两件套）与出站表都在。
    for (const name of SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS) expect(rules).toContain(name);
    for (const name of SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS) expect(rules).toContain(name);

    // 既有 filterSubagentChildToolNames（精确名，含出站表）+ filterSpecRestrictedToolNames
    // （mcp__ 前缀）组合：即使调用方把 tools 改写成全集，出站工具仍被剔除（第二道闸，
    // spec §2.1）。两层分工：child 过滤剔 plan 两件套与精确名，前缀过滤剔动态 MCP 名。
    const inherited = filterSpecRestrictedToolNames(
      filterSubagentChildToolNames(
        [
          ...SPEC_RESTRICTED_TOOLFACE,
          "WebFetch",
          "mcp__x__y",
          ...SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS,
        ],
        profile.disallowedTools,
      ),
    );
    expect([...inherited]).toEqual([...SPEC_RESTRICTED_TOOLFACE]);
  });

  it("keeps the profile's own toolface free of outbound tools", () => {
    const profile = buildSpecRestrictedProfile();
    const filtered = filterSpecRestrictedToolNames(profile.tools ?? []);
    expect([...filtered]).toEqual([...profile.tools ?? []]);
    for (const tool of filtered) expect(isSpecRestrictedOutboundToolName(tool)).toBe(false);
  });
});

// 生产路径测试（P3 对抗评审 3）：不许在测试里手工拼 filter——直接让真实 runtime
// 解析 spec profile。调用方把 tools 改写成 "*"（spec §2.3 第二道闸的场景）时，
// 父 registry + MCP snapshot 展开出的 mcp__x__y 必须被 profile.disallowedTools
// 里的 "mcp__*" 前缀规则剔除（runner.resolveAllowedTools →
// resolveSubagentToolAllowlist → filterSubagentChildToolNames 全链路）。
describe("spec restricted profile — production resolution path", () => {
  it('strips mcp__x__y from the child toolface when tools is rewritten to ["*"]', async () => {
    const sessionId = createSessionId("spec-restricted-star-mcp");
    const eventStore = createTestSessionEventStore();
    const childRequests: Array<{ tools: Array<{ name: string }> }> = [];
    const parentRequests: Array<{ tools: Array<{ name: string }> }> = [];

    const mcpDescriptor = {
      serverName: "x",
      toolName: "y",
      description: "Outbound-capable MCP tool.",
      inputSchema: { type: "object", properties: {} },
    };
    const mcpToolName = toMcpToolName(mcpDescriptor);
    const connectedStatus = {
      status: "connected" as const,
      toolCount: 1,
      transport: "stdio" as const,
      updatedAt: new Date(0).toISOString(),
    };
    const mcpPort: McpPort = {
      async callTool() {
        return { content: [{ text: "ok", type: "text" }] };
      },
      async close() {},
      async connectConfiguredServers() {
        return { statuses: { x: connectedStatus }, tools: [mcpDescriptor] };
      },
      async connectServer() {
        return connectedStatus;
      },
      async disconnectServer() {
        return undefined;
      },
      async listTools() {
        return [mcpDescriptor];
      },
      async status() {
        return { x: connectedStatus };
      },
    };

    // 模拟调用方削弱：tools 被改写成 "*"，但 name/disallowedTools 仍是 spec 受限口径。
    const weakenedSpecProfile = {
      ...buildSpecRestrictedProfile(),
      tools: ["*"],
    };
    expect(weakenedSpecProfile.name).toBe(SPEC_RESTRICTED_PROFILE_NAME);

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mcp: { enabled: true, servers: { x: { command: "x-mcp", type: "stdio" } } },
        mode: "build",
        workingDirectory: "/workspace/project",
        subagents: { profiles: [weakenedSpecProfile] },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentRequests.push(request);
              if (parentRequests.length === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_spec_restricted",
                      name: "Agent",
                      input: {
                        description: "spec run",
                        prompt: "Reproduce the failure.",
                        subagent_type: SPEC_RESTRICTED_PROFILE_NAME,
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "父 agent 收到了 spec run 结果。",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childRequests.push(request);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "spec run 完成。",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("跑一次 spec run");

    expect(result.response).toBe("父 agent 收到了 spec run 结果。");
    expect(childRequests).toHaveLength(1);
    // 上游对照：父 registry 确实持有 mcp__x__y——child 缺席只能来自 spec 受限解析，
    // 不是工具从未存在。
    const parentToolNames = parentRequests[0].tools.map((tool) => tool.name);
    expect(parentToolNames).toContain(mcpToolName);
    const childToolNames = childRequests[0].tools.map((tool) => tool.name);
    // 本地读写工具在面内（复现-修复所需）。
    expect(childToolNames).toContain("Read");
    // 生产路径剔除断言：MCP 动态名、出站网络、信道句柄都不进 child 工具面。
    expect(childToolNames).not.toContain(mcpToolName);
    expect(childToolNames.some((name) => name.startsWith("mcp__"))).toBe(false);
    expect(childToolNames).not.toContain("WebFetch");
    expect(childToolNames).not.toContain("WebSearch");
    expect(childToolNames).not.toContain("SendMessage");
    expect(childToolNames).not.toContain("Agent");
  });

  it("launchSubagent 显式 profile + executionPort：child 工具面受限、Bash 走宿主注入的执行端口", async () => {
    const sessionId = createSessionId("spec-programmatic-launch");
    const childRequests: ModelRequest[] = [];
    const executions: ExecutionRequest[] = [];
    const executionPort: ExecutionPort = {
      async run(request) {
        executions.push(request);
        const now = new Date();
        return {
          status: "completed",
          exitCode: 0,
          stdout: { text: "ok", bytes: 2, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
        };
      },
      async close() {},
    };
    let step = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      { workingDirectory: process.cwd() },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: ModelRequest) {
            childRequests.push(request);
            if (step === 0) {
              step += 1;
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  { id: "call_bash", name: "Bash", input: { command: "echo ok" } },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              } as never;
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            } as never;
          },
        } as never),
      },
    );

    const output = await runtime.launchSubagent(
      {
        sessionId,
        parentToolCallId: "spec-run-test",
        agentType: SPEC_RESTRICTED_PROFILE_NAME,
        description: "spec run",
        prompt: "复现并修复",
        workingDirectory: process.cwd(),
        workspaceRoot: process.cwd(),
        trace: createRootTraceContext({ sessionId }),
      },
      { profile: buildSpecRestrictedProfile(), executionPort },
    );

    expect(output.status).toBe("completed");
    // 显式 profile 不经 registry 也生效：工具面来自 profile（出站/信道全无）。
    expect(childRequests.length).toBeGreaterThanOrEqual(1);
    const childToolNames = childRequests[0]!.tools.map((tool) => tool.name);
    expect(childToolNames).toContain("Read");
    expect(childToolNames).toContain("Bash");
    for (const forbidden of ["WebFetch", "WebSearch", "SendMessage", "Agent", "RespondToCoordinator"]) {
      expect(childToolNames).not.toContain(forbidden);
    }
    // Bash 子进程 I/O 走本次 run 的覆盖端口（spec env / egress network 的落点）。
    expect(executions).toHaveLength(1);
    expect(executions[0]!.command).toMatchObject({ mode: "shell", command: "echo ok" });
  });
});
