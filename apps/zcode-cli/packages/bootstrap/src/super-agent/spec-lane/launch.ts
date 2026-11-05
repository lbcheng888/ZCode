/**
 * M5 spec run 生产 launch 适配器（spec §6-1 第 4 步：subagent 形态唯一）。
 *
 * dispatcher 已按固定顺序备好 egress plan / 无凭据 processEnv / restricted profile；
 * 本适配器把它们接到既有 subagent 端口（AgentRuntime.launchSubagent → 既有
 * createExploreSubagentPort 生命周期），并只对本次 run 注入无凭据执行端口：
 *   - 执行端口 = 宿主适配器工厂用 processEnv + network 构造（生产 =
 *     createNodeExecutionAdapter），Bash 等子进程 I/O 才真正吃到代理 env；
 *   - profile 以显式覆盖传入，不进 runtime 的 agent registry（模型侧 Agent 工具
 *     不能自选 spec profile，避免拿到常规 env 执行）；
 *   - 若 dispatcher 已建立 OS 围栏（P6 §3），执行端口被包装：每条命令改写为
 *     围栏内执行（Linux unshare --net + nftables / macOS sandbox-exec）；
 *   - run 终态（成功/失败/取消）后关闭本次执行端口，围栏与 egress 代理由
 *     dispatcher finally 清理。
 *
 * fail-closed：无 subagent 端口、env 代理与 network 不同源、执行端口工厂缺席
 * 一律拒绝启动；不降级到直连或其它执行形态。
 */
import { createChildTraceContext } from "@zcode/contracts";
import type {
  AgentOutput,
  ExecutionPort,
  SessionId,
  SubagentLaunchOptions,
  SubagentLaunchRequest,
  TraceContext,
} from "@zcode/contracts";

import type { SpecRunNetworkPolicy } from "./contract.js";
import type { SpecRunLaunchPort, SpecRunLaunchRequest } from "./dispatcher.js";
import { createFencedExecutionPort } from "./fence/index.js";

/** 执行端口工厂输入：无凭据 env 与同源 network 策略（生产接 createNodeExecutionAdapter）。 */
export interface SpecRunExecutionPortInput {
  processEnv: Record<string, string>;
  network: SpecRunNetworkPolicy;
}

export interface SpecRunSubagentLaunchPortDeps {
  /** 父会话 id：child 会话事件 / 审计归属。 */
  parentSessionId: SessionId;
  /** 父 trace（child trace 由此派生，保留同一条 traceId）。 */
  traceContext: TraceContext;
  /** 父 runtime 的既有 subagent 启动入口（AgentRuntime.launchSubagent）。 */
  launchSubagent(
    request: SubagentLaunchRequest,
    options?: SubagentLaunchOptions,
  ): Promise<AgentOutput>;
  /** 无凭据执行端口工厂（每次 run 一个实例，run 终态关闭）。 */
  createExecutionPort(input: SpecRunExecutionPortInput): ExecutionPort;
  /** 控制面停止信号（superAgentAbort）；abort 时 child run 同步取消。 */
  signal?: AbortSignal;
}

/** 程序化 run 的父工具调用归属前缀（triggerId 前缀成稳定可追溯的 toolCallId）。 */
const SPEC_RUN_PARENT_TOOL_CALL_PREFIX = "spec_run_";

export function createSpecRunSubagentLaunchPort(
  deps: SpecRunSubagentLaunchPortDeps,
): SpecRunLaunchPort {
  return {
    async launch(request: SpecRunLaunchRequest): Promise<{ runId: string }> {
      if (request.form !== "subagent") {
        throw new Error(
          `spec run 拒绝启动：Phase 3 仅支持 subagent 形态，收到 ${String(request.form)}`,
        );
      }
      const envProxy = request.processEnv.HTTP_PROXY ?? request.processEnv.http_proxy;
      if (!envProxy || envProxy !== request.network.httpProxy) {
        // dispatcher 已校验 env 携带代理；这里再校验两者同源——执行端口的
        // network 会覆盖 spawn env 的代理键，不同源等于跑在另一个 egress 上。
        throw new Error(
          "spec run 拒绝启动：processEnv 代理与 network.httpProxy 不同源",
        );
      }

      const baseExecutionPort = deps.createExecutionPort({
        processEnv: request.processEnv,
        network: request.network,
      });
      // fence 由 dispatcher 在 egress 代理之后、命令执行之前建立；这里把每条
      // 执行请求改写为围栏内执行。未启用围栏时行为不变（现状协作式代理）。
      const executionPort = request.fence
        ? createFencedExecutionPort(baseExecutionPort, request.fence)
        : baseExecutionPort;
      const traceContext = createChildTraceContext(deps.traceContext, {
        sessionId: deps.parentSessionId,
        attributes: {
          specRunTriggerId: request.trigger.triggerId,
          specRunTier: request.trigger.tier,
          specRunWorkspace: request.workspaceRoot,
        },
      });

      try {
        const output = await deps.launchSubagent(
          {
            sessionId: deps.parentSessionId,
            // 程序化 run 没有真实父工具调用；用 triggerId 生成稳定可追溯的归属名。
            parentToolCallId: `${SPEC_RUN_PARENT_TOOL_CALL_PREFIX}${request.trigger.triggerId}`,
            agentType: request.profile.name,
            description: `spec run ${request.trigger.tier} (${request.trigger.source})`,
            prompt: request.prompt,
            workingDirectory: request.workspaceRoot,
            workspaceRoot: request.workspaceRoot,
            trace: traceContext,
          },
          {
            profile: request.profile,
            executionPort,
            ...(deps.signal ? { signal: deps.signal } : {}),
          },
        );
        return { runId: output.agentId };
      } finally {
        // 子进程 I/O 端口随本次 run 关闭；close 失败不掩盖 run 本身的终态错误
        // （与 ctx 关闭约定一致，进程退出仍会回收）。
        try {
          await executionPort.close?.();
        } catch {
          // 清理失败静默：原始 run 结果/错误优先。
        }
      }
    },
  };
}
