// ============================================================
// Best-plan super-agent：每条用户指令开头的独立六字段方案卡
// ============================================================
// 主会话的每个用户回合起步后，这里用一次独立的 model-only 调用生成最佳方案，再经内部
// ProposeBestPlan 工具把卡片注入当前回合。worker 模型不必自愿调用；本调用失败时硬门禁
// 仍会把它引回 ProposeBestPlan（能力缺席时错误可见，不伪造卡）。

import type { AgentRuntime, WorkspaceGenerateTextInput } from "@zcode/core";
import {
  BEST_PLAN_TOOL_NAME,
  BestPlanInputJsonSchema,
  BestPlanInputSchema,
  createSessionEvent,
  createToolCallId,
  SessionEventType,
  traceContextToLogContext,
  type BestPlanInput,
  type JsonSchema,
  type Logger,
  type SessionId,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";

const BEST_PLAN_SUPER_AGENT_QUERY_SOURCE = "best_plan_super_agent";
const BEST_PLAN_SUPER_AGENT_MAX_OUTPUT_TOKENS = 2_048;

const BEST_PLAN_SUPER_AGENT_SYSTEM = `You are an independent best-plan super-agent for a coding session. The user message is the current user instruction. Produce the six-field best plan for that instruction and nothing else.

Rules:
- Return one JSON object with exactly these fields: summary, currentEvidence, candidateOptions, recommendation, impact, verification.
- candidateOptions must contain at least two entries. Each entry is {"option": what would be done, "cost": what it costs or risks compared with the alternatives}.
- currentEvidence must state verified current-state evidence (file:line references or actual command output), not assumptions.
- You cannot inspect the workspace in this call. Do not invent file:line references or command output; if no verified evidence was supplied, say so in currentEvidence.
- recommendation must name the option to execute and why it beats the other candidates.
- impact must list the files and packages touched, protocol/storage compatibility, and how to roll back.
- verification must give the commands or steps that prove the work, plus a clear success criterion.
- You are model-only: do not execute anything, do not call tools, do not ask questions. Emit raw JSON without markdown fences or prose.`;

/**
 * 结构化输出 schema 随输入交给 Core；本地交集类型让本文件在 Core 的声明更新前后都保持
 * 类型收敛，实际校验闸始终是 JSON.parse + BestPlanInputSchema。
 */
type BestPlanGenerateTextInput = WorkspaceGenerateTextInput & {
  responseJsonSchema: JsonSchema;
};

export interface BestPlanSuperAgentTurnStartedInput {
  turnId: TurnId;
  requestText: string;
  traceContext: TraceContext;
  userOrigin: boolean;
  /** 回合结束即取消：注入必须发生在 turn 仍 running 时，否则投影会丢弃卡片。 */
  signal?: AbortSignal;
}

export interface BestPlanSuperAgent {
  onTurnStarted(input: BestPlanSuperAgentTurnStartedInput): Promise<void>;
}

export interface CreateBestPlanSuperAgentDeps {
  runtime: AgentRuntime;
  sessionId: SessionId;
  logger: Logger;
}

export function createBestPlanSuperAgent(deps: CreateBestPlanSuperAgentDeps): BestPlanSuperAgent {
  return {
    async onTurnStarted(input) {
      // 只有人类发起的回合法案卡；trigger/automation 回合不替用户生成方案。
      if (!input.userOrigin) return;
      // 子代理/worker 的工具面没有 ProposeBestPlan，注入会直接失败；能力缺席即跳过。
      if (!deps.runtime.getToolRegistry().has(BEST_PLAN_TOOL_NAME)) return;

      const selection = deps.runtime.getSessionModelSelection();
      if (!selection) {
        deps.logger.warn("Best plan super-agent skipped: no session model selection", {
          ...traceContextToLogContext(input.traceContext),
          event: "best_plan.super_agent.selection_missing",
          module: "bootstrap",
          sessionId: String(deps.sessionId),
          status: "failed",
          turnId: String(input.turnId),
        });
        return;
      }

      // worker 可能已先被写前门禁引回 ProposeBestPlan；已经交过方案就不再花一次模型请求。
      if (deps.runtime.isBestPlanSatisfied(input.turnId)) return;

      const generateInput: BestPlanGenerateTextInput = {
        selection,
        messages: [
          { role: "system", content: BEST_PLAN_SUPER_AGENT_SYSTEM },
          { role: "user", content: `Current user instruction:\n${input.requestText}` },
        ],
        querySource: BEST_PLAN_SUPER_AGENT_QUERY_SOURCE,
        maxOutputTokens: BEST_PLAN_SUPER_AGENT_MAX_OUTPUT_TOKENS,
        responseJsonSchema: BestPlanInputJsonSchema,
      };
      if (input.signal?.aborted) return;
      let generated;
      try {
        generated = await deps.runtime.generateWorkspaceText(generateInput, {
          ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
          traceContext: input.traceContext,
        });
      } catch (error) {
        if (input.signal?.aborted) return;
        throw error;
      }
      // 主回合可能在模型调用期间结束；TurnComplete 后投影会丢弃同 turn 的 tool 事件。
      if (input.signal?.aborted) return;

      let plan: BestPlanInput;
      try {
        plan = BestPlanInputSchema.parse(JSON.parse(generated.text));
      } catch (error) {
        // 解析失败不兜底造卡：worker 会撞上写前硬门禁，被引回 ProposeBestPlan 自行提交。
        deps.logger.warn("Best plan super-agent returned unusable JSON", {
          ...traceContextToLogContext(input.traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "best_plan.super_agent.parse_failed",
          module: "bootstrap",
          sessionId: String(deps.sessionId),
          status: "failed",
          turnId: String(input.turnId),
        });
        return;
      }

      // 投影按 toolCallId 在整会话内定位工具行；固定 id 会让下一轮的卡片覆盖上一轮的行，
      // 所以 id 带上 turnId，保证每个回合各得一张独立卡片。
      // worker 被门禁拒绝后可能已自行调用 ProposeBestPlan；同一 turn 只允许一张卡。
      if (deps.runtime.isBestPlanSatisfied(input.turnId)) return;
      // 投影的 currentTurnId 是回合是否仍在跑的权威读面：TurnComplete 后注入会被丢弃。
      const projection = await deps.runtime.getProjection();
      if (projection.currentTurnId !== input.turnId) return;

      const toolCall = {
        id: createToolCallId(`best-plan-super-agent:${input.turnId}`),
        name: BEST_PLAN_TOOL_NAME,
        input: plan,
      };
      const schedule = await deps.runtime.scheduleTools([toolCall]);
      // executeTools 只发 started/result；产品投影靠 ToolCallScheduled 的 input 建卡片行，
      // 这里与 turn loop / provider tool card 的先例一致，先补 scheduled 事件再执行。
      await deps.runtime.appendEvent(
        createSessionEvent(
          SessionEventType.ToolCallScheduled,
          deps.sessionId,
          {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.input,
            dependencies: [],
            canRunParallel: true,
            schedule: {
              parallelGroups: schedule.parallelGroups,
              executionOrder: schedule.executionOrder,
            },
          },
          { turnId: input.turnId, traceId: input.traceContext.traceId },
        ),
        input.traceContext,
      );
      // traceContext 携带本回合 turnId：成功记录后写前门禁按同一 turnId 放行。
      const executed = await deps.runtime.executeTools([toolCall], schedule, {
        traceContext: input.traceContext,
      });
      const result = executed.results[0];
      if (result?.success !== true) {
        throw new Error(`ProposeBestPlan 注入失败: ${result?.error?.message ?? "工具未返回结果"}`);
      }
    },
  };
}
