// ============================================================
// ProposeBestPlan Tool Handler
// ============================================================
// 主代理在每条用户指令开头先交一张六字段方案卡（现状证据 / 候选方案 / 推荐 / 影响面 /
// 验证），再动手。工具只读：不写文件、不改会话状态，唯一产物是这条工具结果本身——
// UI 据此在消息流内联渲染卡片。
//
// planId 由 handler 从**归一化后的输入**算出，模型既不能指定也不能伪造：同一份方案
// 重放得到同一个指纹，卡片与后续回合的动作才能对上。

import { createHash } from "node:crypto";
import {
  BEST_PLAN_RECORDED_MESSAGE,
  BEST_PLAN_TOOL_NAME,
  BestPlanInputJsonSchema,
  BestPlanInputSchema,
  BestPlanOutputJsonSchema,
  BestPlanOutputSchema,
  type BestPlanInput,
  type BestPlanOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_BEST_PLAN_MODEL_BYTES = 4_096;

/**
 * 描述就是这个工具的全部纪律：调用时机（每条指令一次、先于任何其它工具与实质回答）、
 * 填满全部字段、写完直接执行不等审批、同一 turn 不重复。
 */
const BEST_PLAN_DESCRIPTION =
  "Call this exactly once at the start of every user instruction, before any other tool call or substantive answer. Fill all fields; then execute the recommendation without waiting for approval. Never repeat it in the same turn.";

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
    // 常驻而非延迟加载：它必须出现在每条指令开头；defer 到 ToolSearch 之后等于让模型
    // 先找到一个才想起要交方案。
    shouldDefer: false,
    alwaysLoad: true,
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
