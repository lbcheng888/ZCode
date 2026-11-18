// ============================================================
// Best-plan super-agent：每条用户指令开头的独立六字段方案卡
// ============================================================
// 主会话的每个用户回合起步后，这里用一次独立的 model-only 调用生成最佳方案，再经内部
// ProposeBestPlan 工具把卡片注入当前回合。worker 模型不必自愿调用；本调用失败时硬门禁
// 仍会把它引回 ProposeBestPlan（能力缺席时错误可见，不伪造卡）。

import type { AgentRuntime, TurnEvidenceEntry, WorkspaceGenerateTextInput } from "@zcode/core";
import {
  BEST_PLAN_TOOL_NAME,
  BestPlanInputJsonSchema,
  BestPlanInputSchema,
  createRootTraceContext,
  createSessionEvent,
  createToolCallId,
  SessionEventType,
  traceContextToLogContext,
  type BestPlanInput,
  type GoalContinuationChengPlanCard,
  type JsonSchema,
  type Logger,
  type SessionId,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";

// 与 core workspace-generate-text.ts 导出的 BEST_PLAN_SUPER_AGENT_QUERY_SOURCE 字面量互指：
// @zcode/core 公开入口未 re-export 该值，bootstrap 保持本地字面量，改动需两处同步。
// Core 按此 querySource 把方案卡调用绑定到辅助档（最低公开档位），避免格式化任务深推理。
const BEST_PLAN_SUPER_AGENT_QUERY_SOURCE = "best_plan_super_agent";
const BEST_PLAN_SUPER_AGENT_MAX_OUTPUT_TOKENS = 2_048;
/** 隐藏 system reminder 的注册源名（core system-reminder/source.ts 的 per-request 源）。 */
const BEST_PLAN_REMINDER_SOURCE = "best_plan_super_agent";

const BEST_PLAN_SUPER_AGENT_SYSTEM = `You are an independent best-plan super-agent for a coding session. The user message is the current user instruction. Produce the six-field best plan for that instruction and nothing else.

Rules:
- Return one JSON object with exactly these fields: summary, currentEvidence, candidateOptions, recommendation, impact, verification.
- candidateOptions must contain at least two entries. Each entry is {"option": what would be done, "cost": what it costs or risks compared with the alternatives}.
- currentEvidence must state verified current-state evidence (file:line references, tool summaries, or actual command output) grounded in the supplied TurnEvidenceBuffer and ChengPlan, not assumptions.
- Ground currentEvidence and impact in the real observed evidence supplied in the prompt. Never fabricate file:line references or command output; if the evidence buffer is empty, state that no prior read-only evidence was gathered before this side-effect call.
- recommendation must name the option to execute and why it beats the other candidates.
- impact must list the files and packages touched, protocol/storage compatibility, and how to roll back.
- verification must give the commands or steps that prove the work, plus a clear success criterion.
- You are model-only: do not execute anything, do not call tools, do not ask questions. Emit raw JSON without markdown fences or prose.`;

/**
 * 结构化输出 schema 随输入交给 Core；本地交集类型让本文件在 Core 的声明更新前后都保持
 * 类型收敛，实际校验闸始终是 JSON.parse + BestPlanInputSchema。
 */
type BestPlanGenerateTextInput = WorkspaceGenerateTextInput & {
  responseJsonSchema?: JsonSchema;
  onlyIfModelSupportsJsonSchema?: boolean;
};

function stripOptionalJsonCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return match ? (match[1] ?? "").trim() : trimmed;
}

function isStructuredOutputUnsupportedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Model does not support structured output");
}

export interface BestPlanGroundedInput {
  readonly turnId: TurnId;
  readonly requestText: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly evidence: readonly TurnEvidenceEntry[];
  readonly evidenceDigest: string;
  readonly traceContext?: TraceContext;
  readonly signal?: AbortSignal;
}

export interface BestPlanSuperAgent {
  synthesizeGroundedBestPlan(input: BestPlanGroundedInput): Promise<{ satisfied: boolean }>;
}

export interface CreateBestPlanSuperAgentDeps {
  runtime: AgentRuntime;
  sessionId: SessionId;
  logger: Logger;
  /** 当 SessionGoal 绑定 chengRef 时，读取确定性 ChengPlan 摘要置入方案输入首段。 */
  resolveChengPlanSummary?: () => Promise<GoalContinuationChengPlanCard | undefined>;
}

/**
 * 六字段要点正文：summary / recommendation / verification 保留全文（worker 按它们陈述与执行），
 * 其余三段压缩成单行。正文只进模型上下文不进 UI，直接对 worker 下执行指令。
 */
function buildBestPlanReminderBody(plan: BestPlanInput): string {
  const candidates = plan.candidateOptions
    .map((candidate, index) => `${index + 1}. ${candidate.option}（代价：${candidate.cost}）`)
    .join("；");
  return [
    "独立方案 super-agent 已提交本回合最佳方案（ProposeBestPlan 卡片已记录）。",
    "",
    `【方案摘要】${plan.summary}`,
    "",
    `【推荐方案】${plan.recommendation}`,
    "",
    `【验证方式】${plan.verification}`,
    "",
    `【现状证据】${compressPlanSection(plan.currentEvidence)}`,
    `【候选方案】${candidates}`,
    `【影响面】${compressPlanSection(plan.impact)}`,
    "",
    "执行要求：先用一段话向用户陈述推荐方案与选择理由，然后严格按【推荐方案】执行；本回合方案已提交，不要调用 ProposeBestPlan。",
  ].join("\n");
}

/** 其余字段压缩成单行：换行折叠为「；」，不截断内容，避免提醒正文膨胀挤占回合上下文。 */
function compressPlanSection(text: string): string {
  return text.replaceAll(/\s*\n+\s*/g, "；").trim();
}

function formatGroundedPrompt(
  input: BestPlanGroundedInput,
  chengPlan: GoalContinuationChengPlanCard | undefined,
): string {
  const sections: string[] = [];
  if (chengPlan !== undefined) {
    sections.push(
      [
        "Deterministic ChengPlan (SessionGoal.chengRef):",
        `- planId: ${chengPlan.planId}${chengPlan.runId ? `, runId: ${chengPlan.runId}` : ""}`,
        `- frontier: stage=${chengPlan.frontier.stage}, target=${chengPlan.frontier.target}`,
        `- recommended: action=${chengPlan.recommended.action}, target=${chengPlan.recommended.target}`,
        ...(chengPlan.evidenceRefs.length > 0
          ? [`- evidenceRefs: ${chengPlan.evidenceRefs.join("; ")}`]
          : []),
      ].join("\n"),
    );
  }
  sections.push(`Current user instruction:\n${input.requestText || "(none)"}`);
  const inputSummary = (() => {
    try {
      const json = JSON.stringify(input.toolInput);
      return json && json.length > 600 ? `${json.slice(0, 600)}...` : (json ?? "{}");
    } catch {
      return "{}";
    }
  })();
  sections.push(`Pending first side-effect tool:\n- ${input.toolName}: ${inputSummary}`);
  if (input.evidence.length === 0) {
    sections.push(
      "Observed TurnEvidenceBuffer: (empty — no read-only tool evidence gathered yet in this turn)",
    );
  } else {
    const lines = input.evidence.map((entry, index) => {
      const record = entry as unknown as Record<string, unknown>;
      const tool = String(record.toolName ?? "read");
      const target =
        typeof record.target === "string"
          ? record.target
          : typeof record.filePath === "string"
            ? record.filePath
            : "";
      const summary = typeof record.summary === "string" ? record.summary : JSON.stringify(entry);
      return `${index + 1}. [${tool}]${target ? ` (${target})` : ""} ${summary}`;
    });
    sections.push(
      `Observed TurnEvidenceBuffer (${input.evidence.length} entries, digest=${input.evidenceDigest}):\n${lines.join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

export function createBestPlanSuperAgent(deps: CreateBestPlanSuperAgentDeps): BestPlanSuperAgent {
  return {
    async synthesizeGroundedBestPlan(input) {
      // 子代理/worker 的工具面没有 ProposeBestPlan，注入会直接失败；能力缺席即跳过。
      if (!deps.runtime.getToolRegistry().has(BEST_PLAN_TOOL_NAME)) {
        return { satisfied: false };
      }

      const traceContext =
        input.traceContext ??
        createRootTraceContext({
          sessionId: deps.sessionId,
          turnId: input.turnId,
          attributes: { querySource: BEST_PLAN_SUPER_AGENT_QUERY_SOURCE },
        });

      const selection = deps.runtime.getSessionModelSelection();
      if (!selection) {
        deps.logger.warn("Best plan super-agent skipped: no session model selection", {
          ...traceContextToLogContext(traceContext),
          event: "best_plan.super_agent.selection_missing",
          module: "bootstrap",
          sessionId: String(deps.sessionId),
          status: "failed",
          turnId: String(input.turnId),
        });
        return { satisfied: false };
      }

      // 已经交过方案就不再花一次模型请求。
      if (deps.runtime.isBestPlanSatisfied(input.turnId)) {
        return { satisfied: true };
      }

      const chengPlan = await deps.resolveChengPlanSummary?.().catch(() => undefined);

      const generateInput: BestPlanGenerateTextInput = {
        selection,
        messages: [
          { role: "system", content: BEST_PLAN_SUPER_AGENT_SYSTEM },
          { role: "user", content: formatGroundedPrompt(input, chengPlan) },
        ],
        querySource: BEST_PLAN_SUPER_AGENT_QUERY_SOURCE,
        maxOutputTokens: BEST_PLAN_SUPER_AGENT_MAX_OUTPUT_TOKENS,
        responseJsonSchema: BestPlanInputJsonSchema,
        onlyIfModelSupportsJsonSchema: true,
      };
      if (input.signal?.aborted) return { satisfied: false };
      const callOptions = {
        ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
        traceContext,
      };
      const warnModelFailure = (err: unknown) => {
        deps.logger.warn("Best plan super-agent failed", {
          ...traceContextToLogContext(traceContext),
          error: err instanceof Error ? err.message : String(err),
          event: "best_plan.super_agent.failed",
          module: "bootstrap",
          sessionId: String(deps.sessionId),
          status: "failed",
          turnId: String(input.turnId),
        });
      };
      let generated;
      try {
        generated = await deps.runtime.generateWorkspaceText(generateInput, callOptions);
      } catch (error) {
        if (input.signal?.aborted) return { satisfied: false };
        if (!isStructuredOutputUnsupportedError(error)) {
          warnModelFailure(error);
          return { satisfied: false };
        }
        try {
          const { responseJsonSchema: _drop, onlyIfModelSupportsJsonSchema: _flag, ...plainInput } =
            generateInput;
          generated = await deps.runtime.generateWorkspaceText(plainInput, callOptions);
        } catch (retryError) {
          if (!input.signal?.aborted) warnModelFailure(retryError);
          return { satisfied: false };
        }
      }
      // 主回合可能在模型调用期间结束；TurnComplete 后投影会丢弃同 turn 的 tool 事件。
      if (input.signal?.aborted) return { satisfied: false };

      let plan: BestPlanInput;
      try {
        plan = BestPlanInputSchema.parse(JSON.parse(stripOptionalJsonCodeFence(generated.text)));
      } catch (error) {
        // 解析失败不兜底造卡：worker 会撞上写前硬门禁，被引回 ProposeBestPlan 自行提交。
        deps.logger.warn("Best plan super-agent returned unusable JSON", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "best_plan.super_agent.parse_failed",
          module: "bootstrap",
          sessionId: String(deps.sessionId),
          status: "failed",
          turnId: String(input.turnId),
        });
        return { satisfied: false };
      }

      // 投影按 toolCallId 在整会话内定位工具行；固定 id 会让下一轮的卡片覆盖上一轮的行，
      // 所以 id 带上 turnId，保证每个回合各得一张独立卡片。
      // worker 被门禁拒绝后可能已自行调用 ProposeBestPlan；同一 turn 只允许一张卡。
      if (deps.runtime.isBestPlanSatisfied(input.turnId)) return { satisfied: true };
      // 投影的 currentTurnId 是回合是否仍在跑的权威读面：TurnComplete 后注入会被丢弃。
      const projection = await deps.runtime.getProjection();
      if (projection.currentTurnId !== input.turnId) return { satisfied: false };

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
          { turnId: input.turnId, traceId: traceContext.traceId },
        ),
        traceContext,
      );
      // traceContext 携带本回合 turnId：成功记录后写前门禁按同一 turnId 放行。
      const startedAt = Date.now();
      const executed = await deps.runtime.executeTools([toolCall], schedule, {
        traceContext,
      });
      const result = executed.results[0];
      if (result?.success !== true) {
        throw new Error(`ProposeBestPlan 注入失败: ${result?.error?.message ?? "工具未返回结果"}`);
      }
      const endedAt = Date.now();

      // 卡片只解决写前门禁放行与 UI 呈现；worker 模型要看到方案本身才会按它行动。
      // 这里把六字段要点作为隐藏 system reminder 入队：本回合下一次模型请求生效，
      // 一次性消费、不进 UI 消息流。队列失败只 warn，不推翻已成立的卡片注入。
      try {
        deps.runtime.queueTurnSystemReminder({
          turnId: input.turnId,
          source: BEST_PLAN_REMINDER_SOURCE,
          body: buildBestPlanReminderBody(plan),
        });
        deps.logger.debug("Best plan reminder queued for next model request", {
          ...traceContextToLogContext(traceContext),
          event: "best_plan.super_agent.reminder_queued",
          module: "bootstrap",
          sessionId: String(deps.sessionId),
          status: "completed",
          turnId: String(input.turnId),
        });
      } catch (error) {
        deps.logger.warn("Best plan reminder queue failed; card intact, worker runs without inline guidance", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "best_plan.super_agent.reminder_failed",
          module: "bootstrap",
          sessionId: String(deps.sessionId),
          status: "failed",
          turnId: String(input.turnId),
        });
      }

      // executeTools 只发事件不落 tool part，冷恢复的 hydration 只认 message 的 tool part；
      // 这里把卡片补成 transcript 事实，刷新/重启后仍在。幂等与 parent 解析由 Core 按
      // callID/turnId 负责。卡片 live 已在（scheduled/started/result 事件已发），持久化只是
      // 恢复层：失败响亮告警但不推翻注入——抛错会让 facade 把已成立的注入记成失败。
      try {
        await deps.runtime.persistSyntheticToolPart(
          {
            turnId: input.turnId,
            toolCallId: toolCall.id,
            toolName: BEST_PLAN_TOOL_NAME,
            input: plan,
            output: result.output,
            startedAt,
            endedAt,
          },
          traceContext,
        );
        deps.logger.debug("Best plan card persisted as transcript fact", {
          ...traceContextToLogContext(traceContext),
          event: "best_plan.super_agent.persisted",
          module: "bootstrap",
          sessionId: String(deps.sessionId),
          status: "completed",
          turnId: String(input.turnId),
        });
      } catch (error) {
        deps.logger.warn("Best plan card persistence failed: live card intact, cold recovery loses it", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "best_plan.super_agent.persist_failed",
          module: "bootstrap",
          sessionId: String(deps.sessionId),
          status: "failed",
          turnId: String(input.turnId),
        });
      }
      return { satisfied: true };
    },
  };
}
