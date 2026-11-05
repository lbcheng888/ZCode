// M5 spec run 生产 launch 适配器集成测试：flag 开 + speculative mandate + accept verdict
// → applyVerdicts → dispatcher → 真实 egress 代理 / buildSpecRunEnv / restricted profile
// → 既有 subagent 端口（真实 child runtime）。模型用脚本化 adapter（测试替身只存在于
// 测试代码）；执行端口、代理、subagent 生命周期都是生产实现。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import {
  createRootTraceContext,
  createSessionId,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionResult,
  type ModelRequest,
  type SubagentLaunchOptions,
  type SubagentLaunchRequest,
} from "@zcode/contracts";
import {
  SPEC_RESTRICTED_PROFILE_NAME,
  buildSpecRestrictedProfile,
  filterSpecRestrictedToolNames,
} from "@zcode/core";

import { buildSpecRunEnv } from "../../../adapters/src/network/subprocess-env.js";
import {
  createTestAgentRuntime,
  createTestModelFactoryFromAdapter,
} from "../helpers/test-agent-runtime.js";
import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createDecisionLog } from "../../src/super-agent/decision-log/index.js";
import { createMandateContract, createMandateRepo } from "../../src/super-agent/mandate/index.js";
import {
  createSpecRunDispatcher,
  createSpecRunSubagentLaunchPort,
  createSuperAgentSpecLane,
  type SpecFenceHandle,
  type SpecRunExecutionPortInput,
} from "../../src/super-agent/spec-lane/index.js";
import { applyVerdicts } from "../../src/super-agent/trigger/verdict-interpret.js";
import type { TriggerSchemeCard } from "../../src/super-agent/trigger/contract.js";

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const WORKSPACE_IDENTITY = "ws-spec";
const TRIGGER_ID = "t-spec-1";
const THREAD_KEY = `${WORKSPACE_IDENTITY}|bot:bot-1+u1:t1`;

const VALID_SCHEME: TriggerSchemeCard = {
  currentEvidence: "runner.ts:2178 双闸只过滤精确名",
  candidateOptions: [
    { option: "出口校验", cost: "需要内容生产配合" },
    { option: "只做内容生产", cost: "缺字段仍会外发" },
  ],
  recommendation: "成对落地（生产 + 出口门）",
  impact: "decision_log 加列，旧行 NULL 兼容",
  verification: "vitest run tests/super-agent",
};

let db: DatabaseSync | undefined;
let root: string | undefined;
let closeRuntime: (() => void) | undefined;

afterEach(async () => {
  closeRuntime?.();
  closeRuntime = undefined;
  db?.close();
  db = undefined;
  if (root) {
    await rm(root, { force: true, recursive: true });
    root = undefined;
  }
});

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("等待 spec run 启动超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("M5 spec run 生产 launch 适配器（flag 开 → speculative accept → 真实 subagent run）", () => {
  it("用受限 profile + 无凭据 env 启动 child run，工具面无出站、env 无凭据，终态停代理", async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-spec-run-launch-"));
    const workspaceRoot = root;
    const sessionId = createSessionId("spec-run-parent");
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    db.prepare(
      `insert into trigger_events (
        id, workspace_identity, source, thread_key, actor_kind, actor_id, payload,
        payload_digest, taint, provider, provider_message_id, fast_path,
        adjudication_status, final_disposition, settled_at, created_at, updated_at
      ) values (?, ?, 'im', ?, 'human', 'u1', '{"text":"CI 失败"}',
        'digest-1', 1, 'feishu', 'pm-1', 'unowned_candidate', 'pending', null, null, ?, ?)`,
    ).run(TRIGGER_ID, WORKSPACE_IDENTITY, THREAD_KEY, NOW, NOW);

    const mandateRepo = createMandateRepo(db);
    mandateRepo.insert({
      workspaceIdentity: WORKSPACE_IDENTITY,
      triggerClass: "bot:bot-1",
      tier: "speculative",
      policyVersion: 1,
      now: NOW,
    });
    const mandate = createMandateContract({
      repo: mandateRepo,
      workspaceIdentity: WORKSPACE_IDENTITY,
      now: () => NOW,
    });
    const decisionLog = createDecisionLog(db);

    // 父 runtime：真实 AgentRuntime + 真实 subagent 端口；模型是脚本化测试替身。
    // 首轮让 child 真跑一次 Bash（真实 createNodeExecutionAdapter + 真实子进程）打印 env，
    // 用来证明无凭据 env 端到端落到子进程，而不只是停在适配器入参。
    const childModelRequests: ModelRequest[] = [];
    let childStep = 0;
    const modelFactory = createTestModelFactoryFromAdapter({
      async generateText(request) {
        childModelRequests.push(request);
        const hasBash = (request.tools ?? []).some((tool) => tool.name === "Bash");
        if (hasBash && childStep === 0) {
          childStep = 1;
          return {
            finishReason: "tool-calls",
            providerMetadata: undefined,
            text: "",
            toolCalls: [
              {
                id: "call_env",
                name: "Bash",
                input: { command: 'node -e "console.log(JSON.stringify(process.env))"' },
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as never;
        }
        return {
          finishReason: "stop",
          providerMetadata: undefined,
          text: "spec run 完成",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as never;
      },
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", workingDirectory: workspaceRoot },
      {
        eventStore: createInMemorySessionEventStore(),
        sessionStore: await createSqliteSessionStore({ dbPath: ":memory:" }),
        modelFactory,
      },
    );
    closeRuntime = () => {
      try {
        runtime.beginShutdown();
      } catch {
        // 已关闭/未启动的收尾不掩盖断言。
      }
    };

    const launches: Array<{
      request: SubagentLaunchRequest;
      options?: SubagentLaunchOptions;
    }> = [];
    const executionInputs: SpecRunExecutionPortInput[] = [];
    const egressCalls = { prepares: [] as string[], stops: [] as string[] };
    const lane = createSuperAgentSpecLane();
    const dispatcher = createSpecRunDispatcher({
      egress: {
        prepareSpecRunEgress: (request) => {
          egressCalls.prepares.push(request.workspaceRoot);
          return lane.prepareSpecRunEgress(request);
        },
        stopSpecRunEgress: (workspace) => {
          egressCalls.stops.push(workspace);
          return lane.stopSpecRunEgress(workspace);
        },
      },
      buildProcessEnv: (egressPlan) =>
        buildSpecRunEnv({
          proxyUrl: egressPlan.proxyUrl,
          // 与生产同源：宿主完整 env 进白名单拷贝，凭据键结构性缺席。
          sourceEnv: {
            ...process.env,
            GITHUB_TOKEN: "ghp_should_never_leak",
            ANTHROPIC_API_KEY: "sk-ant-should-never-leak",
            NPM_TOKEN: "npm_should_never_leak",
            ZCODE_TOOL_ENV_PASSTHROUGH_JSON: '{"SECRET":"leak"}',
          } as Record<string, string | undefined>,
        }),
      resolveWorkspaceRoot: () => workspaceRoot,
      launch: createSpecRunSubagentLaunchPort({
        parentSessionId: sessionId,
        traceContext: createRootTraceContext({ sessionId }),
        launchSubagent: (request, options) => {
          launches.push({ request, ...(options ? { options } : {}) });
          return runtime.launchSubagent(request, options);
        },
        createExecutionPort: (input) => {
          executionInputs.push(input);
          return createNodeExecutionAdapter({
            outputRootDir: join(workspaceRoot, "exec"),
            bashOutputTempDir: tmpdir(),
            network: input.network,
            processEnv: input.processEnv,
          });
        },
      }),
    });

    let dispatchPromise: Promise<void> | undefined;
    const errors: unknown[] = [];
    applyVerdicts(
      {
        db,
        decisionLog,
        now: () => NOW,
        mandate,
        proposalGate: true,
        specRun: {
          start(input) {
            dispatchPromise = dispatcher.start(input);
            return dispatchPromise;
          },
        },
        onError: (error) => {
          errors.push(error);
        },
      },
      "batch-spec-1",
      [{ triggerId: TRIGGER_ID, disposition: "accept", scheme: VALID_SCHEME }],
    );

    await waitFor(() => dispatchPromise !== undefined);
    await dispatchPromise;
    expect(errors).toEqual([]);

    // 三件套：受限 profile 原样进入 subagent 端口。
    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    expect(launch.request.agentType).toBe(SPEC_RESTRICTED_PROFILE_NAME);
    expect(launch.options?.profile?.name).toBe(SPEC_RESTRICTED_PROFILE_NAME);
    const profileTools = launch.options?.profile?.tools ?? [];
    expect([...filterSpecRestrictedToolNames(profileTools)]).toEqual([...profileTools]);
    expect(profileTools).toContain("Bash");
    expect(profileTools).toContain("Read");
    expect(launch.options?.executionPort).toBeDefined();

    // 无凭据 env：白名单键 + 代理；凭据键结构性缺席。
    expect(executionInputs).toHaveLength(1);
    const specEnv = executionInputs[0]!.processEnv;
    for (const credentialKey of [
      "GITHUB_TOKEN",
      "ANTHROPIC_API_KEY",
      "NPM_TOKEN",
      "ZCODE_TOOL_ENV_PASSTHROUGH_JSON",
    ]) {
      expect(specEnv[credentialKey]).toBeUndefined();
    }
    // win32 的 setEnvKey 大小写不敏感删除只保留小写变体；两态都认。
    const effectiveProxy = specEnv.HTTP_PROXY ?? specEnv.http_proxy;
    expect(effectiveProxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(specEnv.HTTPS_PROXY ?? specEnv.https_proxy).toBe(effectiveProxy);
    expect(executionInputs[0]!.network.httpProxy).toBe(effectiveProxy);

    // 真实子进程 env（child 首轮 Bash = node 打印 process.env）：代理键在、凭据字节不在。
    const toolOutputs = childModelRequests.flatMap((request) =>
      ((request.messages ?? []) as Array<{ role?: string; content?: unknown }>)
        .filter((message) => message.role === "tool")
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        ),
    );
    expect(toolOutputs.length).toBeGreaterThan(0);
    const childEnvDump = toolOutputs.join("\n");
    expect(childEnvDump).toMatch(/"(?:HTTP_PROXY|http_proxy)":"http:\/\/127\.0\.0\.1:\d+"/);
    expect(childEnvDump).not.toContain("ghp_should_never_leak");
    expect(childEnvDump).not.toContain("sk-ant-should-never-leak");
    expect(childEnvDump).not.toContain("npm_should_never_leak");
    expect(childEnvDump).not.toContain("ZCODE_TOOL_ENV_PASSTHROUGH_JSON");

    // child run 真的跑了：模型请求的工具面 = 受限白名单，无出站/信道工具。
    const toolRequests = childModelRequests.filter((request) => (request.tools ?? []).length > 0);
    expect(toolRequests.length).toBeGreaterThan(0);
    const childToolNames = new Set(
      toolRequests.flatMap((request) => (request.tools ?? []).map((tool) => tool.name)),
    );
    const forbiddenPresent = [
      "WebFetch",
      "WebSearch",
      "SendMessage",
      "ReplyToChannel",
      "RespondToCoordinator",
      "Agent",
      "Task",
      "CreateWorkflow",
      "CronCreate",
    ].filter((name) => childToolNames.has(name));
    expect(forbiddenPresent).toEqual([]);
    expect(childToolNames.has("Read")).toBe(true);
    expect(childToolNames.has("Bash")).toBe(true);
    expect([...childToolNames].some((name) => name.startsWith("mcp__"))).toBe(false);

    // run 终态后 egress 代理已停（dispatcher finally）。
    expect(egressCalls.stops).toContain(workspaceRoot);
    // decision_log 已落 accept（事务内写入）。
    const accepted = db
      .prepare("select adjudication_status from trigger_events where id = ?")
      .get(TRIGGER_ID) as { adjudication_status: string };
    expect(accepted.adjudication_status).toBe("accepted");
  });
});

describe("M5 launch 适配器的围栏接线（request.fence → 执行端口改写）", () => {
  const PARENT = createSessionId("spec-launch-fence-parent");
  const PROXY = "http://127.0.0.1:1";

  it("fence 在场时每条执行请求都经围栏改写；缺席时原样委托", async () => {
    const runRequests: ExecutionRequest[] = [];
    const result = {
      status: "completed",
      stdout: { text: "", bytes: 0, truncated: false },
    } as ExecutionResult;
    const basePort: ExecutionPort = {
      run: async (request) => {
        runRequests.push(request);
        return result;
      },
    };

    const wrappedRequests: ExecutionRequest[] = [];
    const handle: SpecFenceHandle = {
      runId: "r-fence",
      mechanism: "darwin-sandbox-exec",
      broker: { host: "127.0.0.1", port: 1 },
      wrapExecutionRequest: (request) => {
        wrappedRequests.push(request);
        return { ...request, command: { mode: "argv", file: "fenced-bin" } };
      },
      teardown: async () => undefined,
    };

    let capturedPort: ExecutionPort | undefined;
    const launchPort = createSpecRunSubagentLaunchPort({
      parentSessionId: PARENT,
      traceContext: createRootTraceContext({ sessionId: PARENT }),
      launchSubagent: async (_request, options) => {
        capturedPort = options?.executionPort;
        return { agentId: "agent-fence" } as never;
      },
      createExecutionPort: () => basePort,
    });
    await launchPort.launch({
      workspaceRoot: "/tmp/ws-launch-fence",
      form: "subagent",
      profile: buildSpecRestrictedProfile(),
      processEnv: { HTTP_PROXY: PROXY, http_proxy: PROXY },
      network: { httpProxy: PROXY, noProxy: "" },
      fence: handle,
      prompt: "p",
      trigger: {
        triggerId: "t-launch-fence",
        workspaceIdentity: "ws",
        threadKey: "bot:bot-1:u1:t1",
        source: "im",
        tier: "speculative",
      },
    });

    expect(capturedPort).toBeDefined();
    await capturedPort!.run({ command: { mode: "argv", file: "orig" } });
    // 这三行接线被删掉时，这里会收到 orig 而不是 fenced-bin。
    expect(wrappedRequests).toHaveLength(1);
    expect(runRequests[0]?.command).toEqual({ mode: "argv", file: "fenced-bin" });

    // fence 缺席：执行端口保持内层实例，命令不被改写。
    wrappedRequests.length = 0;
    capturedPort = undefined;
    await launchPort.launch({
      workspaceRoot: "/tmp/ws-launch-nofence",
      form: "subagent",
      profile: buildSpecRestrictedProfile(),
      processEnv: { HTTP_PROXY: PROXY, http_proxy: PROXY },
      network: { httpProxy: PROXY, noProxy: "" },
      prompt: "p",
      trigger: {
        triggerId: "t-launch-nofence",
        workspaceIdentity: "ws",
        threadKey: "bot:bot-1:u1:t1",
        source: "im",
        tier: "speculative",
      },
    });
    expect(capturedPort).toBe(basePort);
    await capturedPort!.run({ command: { mode: "argv", file: "orig" } });
    expect(wrappedRequests).toHaveLength(0);
    expect(runRequests[1]?.command).toEqual({ mode: "argv", file: "orig" });
  });
});
