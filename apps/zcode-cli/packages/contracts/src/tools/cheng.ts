import { z } from "zod";

import { toToolJsonSchema } from "./json-schema.js";

/**
 * Cheng 数据面的四个**只读**模型工具：Inspect / Verify / Explain / Plan。
 *
 * 它们只消费已经存在的 jobId（由工作流里的 `cheng.generate`、host 或 ChengGenerate 产生），
 * 绝不开新作业、不重试、不改工作区。端口缺席时输出 `capability_absent`——这是命名的
 * 能力缺席，不是降级。
 *
 * ChengGenerate 是唯一的效应工具：校验 spec 草案 → 落盘 → 经 host 开作业。草案校验失败
 * 是 400 型业务失败（不落盘不开作业）；生成端口缺席与只读端口缺席同款 `capability_absent`。
 */

export const CHENG_INSPECT_TOOL_NAME = "ChengInspect";
export const CHENG_VERIFY_TOOL_NAME = "ChengVerify";
export const CHENG_EXPLAIN_TOOL_NAME = "ChengExplain";
export const CHENG_PLAN_TOOL_NAME = "ChengPlan";
export const CHENG_GENERATE_TOOL_NAME = "ChengGenerate";

/**
 * CLI 隐藏子命令：`cheng-host` 的打包入口。SEA 单文件二进制不解释 Node CLI 旗标，也不能
 * `node <dist/main.js>`；`cheng-host` 随 CLI bundle 发布，由本二进制自 re-exec 进入。
 * 与 `ZCODE_DWF_CHILD_COMMAND` 同一条 SEA 论证（contracts/src/plugins/index.ts）。
 */
export const CHENG_HOST_COMMAND = "__zcode-cheng-host";

/**
 * CLI 启动时置位的标记：安装产物里没有独立的 host 文件，cheng-host 由 CLI bundle 携带；
 * 标记在场时 `resolveChengHostPortForApp` 默认用“自 re-exec + 隐藏子命令”，不必手工配
 * `ZCODE_CHENG_HOST_ENTRY`。显式 entry 仍然优先。
 */
export const CHENG_HOST_VIA_CLI_ENV = "ZCODE_CHENG_HOST_VIA_CLI";

const CHENG_JOB_ID_PATTERN = /^[0-9a-f]{64}$/;
const ChengJobIdSchema = z.string().regex(CHENG_JOB_ID_PATTERN);
const ChengSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const CHENG_JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type ChengJobState = (typeof CHENG_JOB_STATES)[number];

const ChengCapabilityAbsentSchema = z
  .object({
    status: z.literal("capability_absent"),
    reason: z.string().min(1),
  })
  .strict();

export const ChengInspectInputSchema = z.object({ jobId: ChengJobIdSchema }).strict();

export const ChengInspectOkSchema = z
  .object({
    status: z.literal("ok"),
    jobId: ChengJobIdSchema,
    state: z.enum(CHENG_JOB_STATES),
    runId: z.string().min(1).nullable(),
    runDir: z.string().min(1).nullable(),
    exitCode: z.number().int().nullable(),
    cancelRequested: z.boolean(),
  })
  .strict();

export const ChengInspectOutputSchema = z.union([
  ChengInspectOkSchema,
  ChengCapabilityAbsentSchema,
]);

export const CHENG_GATE_LEVELS = ["PRODUCTION", "DIAGNOSTIC_NOT_ACCEPTANCE", "BLOCKED"] as const;

export const ChengGateVerdictSchema = z
  .object({
    ok: z.boolean(),
    level: z.enum(CHENG_GATE_LEVELS),
    reasons: z.array(z.string()),
  })
  .strict();

export type ChengGateVerdict = z.infer<typeof ChengGateVerdictSchema>;

export type ChengDeliveryGateResult = { allowed: true } | { allowed: false; reason: string };

/**
 * 所有出站面共用的 Cheng 交付门判定：红/blocked 一律拒绝，绿（含 diagnostic）放行。
 * 只做判定，不解析来源；trigger 与 channel-reply 都复用同一 reason 格式。
 */
export function evaluateChengDeliveryGate(
  gate: Pick<ChengGateVerdict, "ok" | "level"> & { reasons: readonly string[] },
): ChengDeliveryGateResult {
  if (!gate.ok || gate.level === "BLOCKED") {
    return {
      allowed: false,
      reason: `cheng_gate_blocked:${gate.reasons.join(",") || gate.level}`,
    };
  }
  return { allowed: true };
}

export const ChengVerifyInputSchema = z.object({ jobId: ChengJobIdSchema }).strict();

export const ChengVerifyOkSchema = z
  .object({
    status: z.literal("ok"),
    level: z.enum(["PRODUCTION", "DIAGNOSTIC_NOT_ACCEPTANCE", "UNKNOWN"]),
    productionAcceptance: z.boolean().nullable(),
    verdict: z.string().min(1),
    semanticPass: z.boolean(),
    settlePassed: z.number().int().nonnegative(),
    settleTotal: z.number().int().nonnegative(),
    structureGateOk: z.boolean().nullable(),
    /** host 用原始回执经真实 ChengGate 评估的结果。 */
    gate: ChengGateVerdictSchema,
    artifactRef: z.string().min(1),
  })
  .strict();

export const ChengVerifyOutputSchema = z.union([ChengVerifyOkSchema, ChengCapabilityAbsentSchema]);

export const ChengExplainInputSchema = z
  .object({
    jobId: ChengJobIdSchema,
    task: z.string().min(1),
    view: z.enum(["structure", "decision"]).optional(),
  })
  .strict();

export const ChengExplainOkSchema = z
  .object({
    status: z.literal("ok"),
    available: z.boolean(),
    reason: z.string().min(1).nullable(),
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    roots: z.number().int().nonnegative(),
    gateOk: z.boolean().nullable(),
    artifactRef: z.string().min(1),
    digest: ChengSha256Schema,
  })
  .strict();

export const ChengExplainOutputSchema = z.union([
  ChengExplainOkSchema,
  ChengCapabilityAbsentSchema,
]);

const ChengPlanStageSchema = z.enum([
  "spec",
  "structure",
  "settle",
  "judge",
  "compile",
  "provenance",
]);
const ChengPlanActionSchema = z.enum([
  "fix_spec",
  "fix_oracle",
  "regenerate_module",
  "change_template_plan",
  "split_module",
  "raise_budget",
  "fix_codegen",
  "stop",
]);
const ChengPlanRiskSchema = z.enum(["low", "medium", "high"]);
const ChengPlanEvidenceSchema = z.array(z.string().min(1)).min(1);
const ChengPlanCostSchema = z
  .object({
    wallMs: z.number().int().nonnegative(),
    expansions: z.number().int().nonnegative(),
  })
  .strict();
const ChengPlanFrontierSchema = z
  .object({
    stage: ChengPlanStageSchema,
    target: z.string().min(1),
    evidence: ChengPlanEvidenceSchema,
  })
  .strict();
const ChengPlanCandidateSchema = z
  .object({
    action: ChengPlanActionSchema,
    target: z.string().min(1),
    cost: ChengPlanCostSchema,
    risk: ChengPlanRiskSchema,
    expectedGain: z.number().min(0).max(1),
    evidence: ChengPlanEvidenceSchema,
  })
  .strict();
const ChengPlanRecommendedSchema = z
  .object({
    action: ChengPlanActionSchema,
    target: z.string().min(1),
  })
  .strict();
const ChengPlanSchema = z
  .object({
    kind: z.literal("cheng_plan"),
    schema: z.literal("cheng.contract.cheng_plan.v1"),
    frontier: ChengPlanFrontierSchema,
    candidates: z.array(ChengPlanCandidateSchema).min(1),
    recommended: ChengPlanRecommendedSchema,
    blockedBy: z.array(z.string().min(1)),
    budget: ChengPlanCostSchema,
  })
  .strict();

export const ChengPlanInputSchema = z
  .object({
    jobId: ChengJobIdSchema,
    task: z.string().min(1),
  })
  .strict();

export const ChengPlanOkSchema = z
  .object({
    status: z.literal("ok"),
    gate: ChengGateVerdictSchema,
    plan: ChengPlanSchema,
  })
  .strict();

export const ChengPlanOutputSchema = z.union([ChengPlanOkSchema, ChengCapabilityAbsentSchema]);

/**
 * ChengGenerate 入参：`spec` 是未加解释的 JSON 对象，形状交给 core 侧的
 * `validateChengSpecDraft`（以 csg.spec.v2 夹具为事实来源）裁决——schema 只保证它是对象，
 * 不在两处重复维护字段表。`budget` 缺省由装配层按 host 缺省档补齐。
 */
export const ChengGenerateInputSchema = z
  .object({
    spec: z.record(z.unknown()),
    // 与 cheng-host RPC GenerateParamsSchema（.max(900_000)）与 workflow world-read
    // boundedBudget 同口径：越界拒绝必须发生在草案落盘之前，不留孤儿 spec 文件。
    budget: z.number().int().min(1).max(900_000).optional(),
  })
  .strict();

/** 成功只回作业摘要：后续事实一概走 ChengInspect/Verify/Explain/Plan。 */
export const ChengGenerateOkSchema = z
  .object({
    status: z.literal("ok"),
    jobId: ChengJobIdSchema,
    runId: z.string().min(1).nullable(),
    state: z.enum(CHENG_JOB_STATES),
  })
  .strict();

export const ChengGenerateOutputSchema = z.union([
  ChengGenerateOkSchema,
  ChengCapabilityAbsentSchema,
]);

export type ChengInspectInput = z.infer<typeof ChengInspectInputSchema>;
export type ChengInspectOk = z.infer<typeof ChengInspectOkSchema>;
export type ChengInspectOutput = z.infer<typeof ChengInspectOutputSchema>;
export type ChengVerifyInput = z.infer<typeof ChengVerifyInputSchema>;
export type ChengVerifyOk = z.infer<typeof ChengVerifyOkSchema>;
export type ChengVerifyOutput = z.infer<typeof ChengVerifyOutputSchema>;
export type ChengExplainInput = z.infer<typeof ChengExplainInputSchema>;
export type ChengExplainOk = z.infer<typeof ChengExplainOkSchema>;
export type ChengExplainOutput = z.infer<typeof ChengExplainOutputSchema>;
export type ChengPlanInput = z.infer<typeof ChengPlanInputSchema>;
export type ChengPlanOk = z.infer<typeof ChengPlanOkSchema>;
export type ChengPlanOutput = z.infer<typeof ChengPlanOutputSchema>;
export type ChengGenerateInput = z.infer<typeof ChengGenerateInputSchema>;
export type ChengGenerateOk = z.infer<typeof ChengGenerateOkSchema>;
export type ChengGenerateOutput = z.infer<typeof ChengGenerateOutputSchema>;

export const ChengInspectInputJsonSchema = toToolJsonSchema(ChengInspectInputSchema);
export const ChengInspectOutputJsonSchema = toToolJsonSchema(ChengInspectOutputSchema);
export const ChengVerifyInputJsonSchema = toToolJsonSchema(ChengVerifyInputSchema);
export const ChengVerifyOutputJsonSchema = toToolJsonSchema(ChengVerifyOutputSchema);
export const ChengExplainInputJsonSchema = toToolJsonSchema(ChengExplainInputSchema);
export const ChengExplainOutputJsonSchema = toToolJsonSchema(ChengExplainOutputSchema);
export const ChengPlanInputJsonSchema = toToolJsonSchema(ChengPlanInputSchema);
export const ChengPlanOutputJsonSchema = toToolJsonSchema(ChengPlanOutputSchema);
export const ChengGenerateInputJsonSchema = toToolJsonSchema(ChengGenerateInputSchema);
export const ChengGenerateOutputJsonSchema = toToolJsonSchema(ChengGenerateOutputSchema);
