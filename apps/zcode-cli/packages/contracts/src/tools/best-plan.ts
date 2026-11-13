// ============================================================
// ProposeBestPlan Tool - 每条用户指令开头的六字段最佳方案卡
// ============================================================
// 只读：不写文件、不改会话状态，只把主代理当下的最佳方案固化成一张内联卡。
// 字段名与长度上限是与 UI / 提示词共享的冻结契约；planId 是同一份输入的稳定指纹，
// 让卡片能与后续回合的动作对应（由 handler 计算，不从模型输入接收）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const BEST_PLAN_TOOL_NAME = "ProposeBestPlan";

/** 一句话方案名的上限：卡片标题行只装得下这个量级。 */
export const BEST_PLAN_SUMMARY_MAX_CHARS = 200;
/** 证据 / 推荐 / 影响面 / 验证四个正文段的上限，四段共用一档。 */
export const BEST_PLAN_BODY_MAX_CHARS = 4_000;
/** 单个候选方案的描述与代价各自的上限。 */
export const BEST_PLAN_OPTION_MAX_CHARS = 500;
export const BEST_PLAN_MIN_CANDIDATE_OPTIONS = 2;
export const BEST_PLAN_MAX_CANDIDATE_OPTIONS = 4;

/** 记录成功后的固定回执：模型据它继续执行，不再等审批。 */
export const BEST_PLAN_RECORDED_MESSAGE =
  "Best plan recorded. Execute the recommendation; the user sees this card inline before your work.";

export const BestPlanCandidateOptionSchema = z
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
export type BestPlanCandidateOption = z.infer<typeof BestPlanCandidateOptionSchema>;

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
  })
  .strict();
export type BestPlanInput = z.infer<typeof BestPlanInputSchema>;

export const BestPlanInputJsonSchema = toToolJsonSchema(BestPlanInputSchema);

export const BestPlanOutputSchema = z
  .object({
    ok: z.literal(true).describe("True when the plan card was recorded."),
    planId: z.string().describe("Stable 12-character hex fingerprint of the recorded plan."),
    message: z.string().describe("The receipt telling the model to execute the recommendation."),
  })
  .strict();
export type BestPlanOutput = z.infer<typeof BestPlanOutputSchema>;

export const BestPlanOutputJsonSchema = toToolJsonSchema(BestPlanOutputSchema);
