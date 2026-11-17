// ============================================================
// ProposeBestPlan Tool Handler
// ============================================================
// 主代理的六字段方案卡（现状证据 / 候选方案 / 推荐 / 影响面 / 验证）通常由 super-agent
// 在副作用工具前自动提交；只有写/执行工具结果明确要求当前 turn 没有方案卡时，模型才
// 自己调用。工具只读：不写文件、不改会话状态，唯一产物是这条工具结果本身——UI 据此在
// 消息流内联渲染卡片。
//
// planId 由 handler 从**归一化后的输入**算出，模型既不能指定也不能伪造：同一份方案
// 重放得到同一个指纹，卡片与后续回合的动作才能对上。

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BEST_PLAN_BODY_MAX_CHARS,
  BEST_PLAN_MAX_CANDIDATE_OPTIONS,
  BEST_PLAN_MIN_CANDIDATE_OPTIONS,
  BEST_PLAN_OPTION_MAX_CHARS,
  BEST_PLAN_RECORDED_MESSAGE,
  BEST_PLAN_SUMMARY_MAX_CHARS,
  BEST_PLAN_TOOL_NAME,
  BestPlanOutputJsonSchema,
  BestPlanOutputSchema,
  type BestPlanOutput,
  type JsonSchema,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

export const BestPlanGroundingSchema = z
  .object({
    phase: z.enum(["turn_start", "pre_mutation_grounded"]),
    readToolCallIds: z.array(z.string().min(1)),
    chengPlanId: z.string().min(1).optional(),
    chengRunId: z.string().min(1).optional(),
    evidenceDigest: z.string().min(1),
  })
  .strict();

export type BestPlanGrounding = z.infer<typeof BestPlanGroundingSchema>;

const BestPlanCandidateOptionSchema = z
  .object({
    option: z
      .string()
      .min(1)
      .max(BEST_PLAN_OPTION_MAX_CHARS)
      .describe("A candidate approach, stated as what would be done."),
    cost: z
      .string()
      .min(1)
      .max(BEST_PLAN_OPTION_MAX_CHARS)
      .describe("What this candidate costs or risks compared with the others."),
  })
  .strict();

export const BestPlanInputSchema = z
  .object({
    summary: z
      .string()
      .min(1)
      .max(BEST_PLAN_SUMMARY_MAX_CHARS)
      .describe("One sentence naming the plan."),
    currentEvidence: z
      .string()
      .min(1)
      .max(BEST_PLAN_BODY_MAX_CHARS)
      .describe(
        "Verified current-state evidence: file:line references or the actual command output. Not assumptions.",
      ),
    candidateOptions: z
      .array(BestPlanCandidateOptionSchema)
      .min(BEST_PLAN_MIN_CANDIDATE_OPTIONS)
      .max(BEST_PLAN_MAX_CANDIDATE_OPTIONS)
      .describe(
        `The candidate approaches considered (${BEST_PLAN_MIN_CANDIDATE_OPTIONS}-${BEST_PLAN_MAX_CANDIDATE_OPTIONS}). Each carries its own cost or risk.`,
      ),
    recommendation: z
      .string()
      .min(1)
      .max(BEST_PLAN_BODY_MAX_CHARS)
      .describe("The option you will execute, and why it beats the other candidates."),
    impact: z
      .string()
      .min(1)
      .max(BEST_PLAN_BODY_MAX_CHARS)
      .describe(
        "Files and packages touched, protocol and storage compatibility, and how to roll back.",
      ),
    verification: z
      .string()
      .min(1)
      .max(BEST_PLAN_BODY_MAX_CHARS)
      .describe("The commands or steps that prove the work, and the success criterion."),
    grounding: BestPlanGroundingSchema.optional(),
  })
  .strict();

export type BestPlanInput = z.infer<typeof BestPlanInputSchema>;

function toLocalToolJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = raw;
  return rest as JsonSchema;
}

export const BestPlanInputJsonSchema = toLocalToolJsonSchema(BestPlanInputSchema);

const MAX_BEST_PLAN_MODEL_BYTES = 4_096;

/**
 * 描述即调用契约：super-agent 通常自动提交，模型只在写/执行工具结果明确要求当前 turn
 * 没有方案卡时自己调用；填满全部字段后重试被拦截的工具。deferred 后 schema 不在请求里，
 * 末句告知加载路径。
 */
const BEST_PLAN_DESCRIPTION =
  "Super-agent normally submits the best plan automatically before side-effecting tools, so do not call this on your own. Call it only when a write or execution tool result explicitly says the current turn has no plan card yet. Fill all six fields, then retry the tool. If this tool is not loaded yet, load it with ToolSearch first.";

const bestPlanHandler: ToolHandler = async (input) => {
  const parsed = BestPlanInputSchema.parse(input);

  return {
    ok: true,
    planId: planIdForBestPlan(parsed),
    message: BEST_PLAN_RECORDED_MESSAGE,
  } satisfies BestPlanOutput;
};

/**
 * 输入经 Zod 按 schema 声明顺序重建，所以模型换 key 顺序不改变指纹。
 * 前 12 位十六进制足够区分一次会话内的方案，又短到能直接渲染进卡片。
 */
function planIdForBestPlan(plan: BestPlanInput): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 12);
}

/** 模型只读到回执：卡片正文在 tool call 的 input 上，不重复灌进上下文。 */
function formatBestPlanModelContent(output: unknown): ModelMessageContent {
  const parsed = BestPlanOutputSchema.safeParse(output);
  if (!parsed.success) return "ProposeBestPlan returned an invalid result.";
  return parsed.data.message;
}

export const bestPlanToolEntry: ToolEntry = {
  capability: "Record the six-field best plan for the current user instruction as an inline card",
  metadata: {
    // deferred：正常路径由 super-agent 每回合自动注入，worker 从不自己调用，常驻 schema
    // 是每请求纯开销；super-agent 失败后的硬门禁兜底靠 ToolSearch 公告让模型发现并加载本工具。
    shouldDefer: true,
    name: BEST_PLAN_TOOL_NAME,
    description: BEST_PLAN_DESCRIPTION,
    allowedInPlanMode: true,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: MAX_BEST_PLAN_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: bestPlanHandler,
  formatModelContent: formatBestPlanModelContent,
  inputSchema: BestPlanInputJsonSchema,
  outputSchema: BestPlanOutputJsonSchema,
  runtimeInputSchema: BestPlanInputSchema,
  runtimeOutputSchema: BestPlanOutputSchema,
  permission: {
    permission: "best-plan.propose",
    reason:
      "ProposeBestPlan only records the plan in the tool result; it is read-only and has no side effects",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_BEST_PLAN_MODEL_BYTES,
    maxModelBytes: MAX_BEST_PLAN_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_BEST_PLAN_MODEL_BYTES,
      direction: "head",
    },
  },
  // 纯内存计算，没有可等的外部 I/O。
  timeout: { kind: "none" },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ProposeBestPlan records the plan in memory and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
