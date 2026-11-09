// ============================================================
// Agent Tool - Subagent orchestration tool
// ============================================================
// 支持基于配置的子代理和异步启动。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import type { ModelUsage } from "../model/index.js";
import { toToolJsonSchema } from "./json-schema.js";

export const AgentType = {
  GeneralPurpose: "general-purpose",
  Explore: "Explore",
} as const;

export type AgentType = string;

export const AgentInputSchema = z.object({
  description: z.string().describe("A short (3-5 word) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .optional()
    .describe("The type of specialized agent to use for this task"),
  // subagent 模型由 Settings / Markdown profile 统一决定；若把调用级
  // model 暴露给父模型，历史 tool call 会持续生成旧 override 并覆盖当前配置。
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Set to true to run this agent in the background. You will be notified when it completes.",
    ),
});

export type AgentInput = z.infer<typeof AgentInputSchema>;

export const AgentInputJsonSchema = toToolJsonSchema(AgentInputSchema);

// ============================================================
// AgentSwarm - 一个模板对多个输入的同形 fan-out
// ============================================================

/** 一次 AgentSwarm 调用的任务总数上限（items 条数 + resume_agent_ids 键数）。 */
export const AGENT_SWARM_MAX_TASKS = 128;

/** 聚合结果（含 <agent_swarm_result> 框架与属性）的 UTF-16 字符上限。 */
export const AGENT_SWARM_MAX_OUTPUT_CHARS = 200_000;

/** items 模式下一段 prompt 里唯一的模板占位符。 */
export const AGENT_SWARM_ITEM_PLACEHOLDER = "{{item}}";

/**
 * resume_agent_ids 键（agentId）的字符上限；超长键在 schema 层就以 typed invalid input 拒绝。
 * AgentSwarm 输出的 agent_id 属性共用同一上限：512 字符内的 ID 可原样用于 resume_agent_ids。
 */
export const AGENT_SWARM_MAX_RESUME_AGENT_ID_CHARS = 512;

/** resume_agent_ids 值（续跑消息）的字符上限；超出同样在 schema 层拒绝。 */
export const AGENT_SWARM_MAX_RESUME_PROMPT_CHARS = 20_000;

export const AgentSwarmInputSchema = z
  .object({
    description: z.string().min(1).describe("A short (3-5 word) description of the whole swarm"),
    subagent_type: z
      .string()
      .optional()
      .describe("The type of specialized agent to use for the new item tasks"),
    prompt_template: z
      .string()
      .optional()
      .describe(
        `Template applied to every item; must contain the literal placeholder ${AGENT_SWARM_ITEM_PLACEHOLDER}. Required whenever items are provided.`,
      ),
    items: z
      .array(z.string())
      .max(AGENT_SWARM_MAX_TASKS)
      .optional()
      .describe(
        `Independent inputs for one same-shape task; each is substituted into prompt_template. At least 2 are required unless resume_agent_ids is used.`,
      ),
    resume_agent_ids: z
      .record(
        z.string().min(1).max(AGENT_SWARM_MAX_RESUME_AGENT_ID_CHARS),
        z.string().min(1).max(AGENT_SWARM_MAX_RESUME_PROMPT_CHARS),
      )
      .optional()
      .describe(
        `Continue existing agents by id: each key is an agentId returned by a previous Agent/AgentSwarm call (1-${AGENT_SWARM_MAX_RESUME_AGENT_ID_CHARS} characters), each value is the message to send (1-${AGENT_SWARM_MAX_RESUME_PROMPT_CHARS} characters). Resumed agents keep their context.`,
      ),
  })
  .strict();

export type AgentSwarmInput = z.infer<typeof AgentSwarmInputSchema>;

export const AgentSwarmInputJsonSchema = toToolJsonSchema(AgentSwarmInputSchema);

/** 聚合结果是带 <agent_swarm_result> 框架的一段文本。 */
export const AgentSwarmOutputSchema = z.string();

export type AgentSwarmOutput = z.infer<typeof AgentSwarmOutputSchema>;

export const AgentSwarmOutputJsonSchema = toToolJsonSchema(AgentSwarmOutputSchema);

export interface AgentTextContentBlock {
  type: "text";
  text: string;
}

export interface AgentCompletedOutput {
  status: "completed";
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  content: AgentTextContentBlock[];
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
}

export interface AgentBackgroundedOutput {
  status: "async_launched";
  isAsync: true;
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  childSessionId: string;
  backgroundTaskId: string;
  outputFile: string;
  canReadOutputFile: boolean;
}

export type AgentOutput = AgentCompletedOutput | AgentBackgroundedOutput;

export const AgentTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const AgentCompletedOutputSchema = z
  .object({
    status: z.literal("completed"),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    content: z.array(AgentTextContentBlockSchema),
    totalToolUseCount: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
    usage: z.record(z.unknown()).optional(),
  })
  .strict();

export const AgentBackgroundedOutputSchema = z
  .object({
    status: z.literal("async_launched"),
    isAsync: z.literal(true),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    childSessionId: z.string(),
    backgroundTaskId: z.string(),
    outputFile: z.string(),
    canReadOutputFile: z.boolean(),
  })
  .strict();

export const AgentOutputSchema = z.union([
  AgentCompletedOutputSchema,
  AgentBackgroundedOutputSchema,
]);

export const AgentOutputJsonSchema = toToolJsonSchema(AgentOutputSchema);

export interface AgentToolCall {
  id: ToolCallId;
  name: "Agent";
  input: AgentInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface AgentToolResult {
  toolCallId: ToolCallId;
  output: AgentOutput;
  traceId: TraceId;
  durationMs: number;
}

export const AgentErrorCode = {
  SUBAGENT_UNAVAILABLE: "agent_subagent_unavailable",
  BACKGROUND_UNAVAILABLE: "agent_background_unavailable",
  UNKNOWN_AGENT_TYPE: "agent_unknown_type",
  CHILD_RUNTIME_FAILED: "agent_child_runtime_failed",
  /** AgentSwarm 输入不满足 items/resume 语义时在启动任何子代理之前拒绝。 */
  SWARM_INVALID_INPUT: "agent_swarm_invalid_input",
} as const;

export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];
