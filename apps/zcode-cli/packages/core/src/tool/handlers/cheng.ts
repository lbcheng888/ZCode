import {
  CHENG_EXPLAIN_TOOL_NAME,
  CHENG_INSPECT_TOOL_NAME,
  CHENG_PLAN_TOOL_NAME,
  CHENG_VERIFY_TOOL_NAME,
  ChengExplainInputJsonSchema,
  ChengExplainInputSchema,
  ChengExplainOutputJsonSchema,
  ChengExplainOutputSchema,
  ChengInspectInputJsonSchema,
  ChengInspectInputSchema,
  ChengInspectOutputJsonSchema,
  ChengInspectOutputSchema,
  ChengPlanInputJsonSchema,
  ChengPlanInputSchema,
  ChengPlanOutputJsonSchema,
  ChengPlanOutputSchema,
  ChengVerifyInputJsonSchema,
  ChengVerifyInputSchema,
  ChengVerifyOutputJsonSchema,
  ChengVerifyOutputSchema,
  type ChengExplainInput,
  type ChengInspectInput,
  type ChengPlanInput,
  type ChengVerifyInput,
  type ToolPermissionSpec,
} from "@zcode/contracts";

import { CHENG_READ_PORT_UNAVAILABLE_REASON, type ChengReadPort } from "../cheng-read-port.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const CHENG_TOOL_TIMEOUT_MS = 30_000;
const CHENG_TOOL_MAX_OUTPUT_BYTES = 64 * 1024;

const INSPECT_DESCRIPTION =
  "Read the state and run reference of an existing Cheng job by jobId. Read-only: never starts, retries or cancels a job.";
const VERIFY_DESCRIPTION =
  "Read the run-volume verdict of a finished Cheng job: acceptance level, judge/semantic summary, settle counts, structure gate, and the real ChengGate result evaluated from structured receipts. Read-only; diagnostic runs are never production acceptance.";
const EXPLAIN_DESCRIPTION =
  "Summarize the decision or structure graph of a finished Cheng job as bounded counts plus an artifact ref. Read-only; the full graph stays on disk.";
const PLAN_DESCRIPTION =
  "Read the deterministic ChengPlan for a finished Cheng job from structured receipts: frontier, candidate actions with costs/risk, recommended next action and blockedBy. Read-only; never starts, retries or cancels a job.";

const MODEL_INSTRUCTIONS = [
  "Only call with a jobId produced earlier by cheng.generate (inside a workflow) or by the Cheng host; these tools never create work.",
  "A diagnostic run is DIAGNOSTIC_NOT_ACCEPTANCE even when green — never report it as production acceptance.",
] as const;

function readPort(context: ToolExecutionContext): ChengReadPort | undefined {
  return context.chengReadPort;
}

function absent() {
  return {
    status: "capability_absent" as const,
    reason: CHENG_READ_PORT_UNAVAILABLE_REASON,
  };
}

const inspectHandler: ToolHandler = async (input, context) => {
  const parsed = ChengInspectInputSchema.parse(input) as ChengInspectInput;
  const port = readPort(context);
  if (port === undefined) {
    return ChengInspectOutputSchema.parse(absent());
  }
  return ChengInspectOutputSchema.parse(await port.inspect(parsed.jobId));
};

const verifyHandler: ToolHandler = async (input, context) => {
  const parsed = ChengVerifyInputSchema.parse(input) as ChengVerifyInput;
  const port = readPort(context);
  if (port === undefined) {
    return ChengVerifyOutputSchema.parse(absent());
  }
  return ChengVerifyOutputSchema.parse(await port.verify(parsed.jobId));
};

const explainHandler: ToolHandler = async (input, context) => {
  const parsed = ChengExplainInputSchema.parse(input) as ChengExplainInput;
  const port = readPort(context);
  if (port === undefined) {
    return ChengExplainOutputSchema.parse(absent());
  }
  return ChengExplainOutputSchema.parse(await port.explain(parsed));
};

const planHandler: ToolHandler = async (input, context) => {
  const parsed = ChengPlanInputSchema.parse(input) as ChengPlanInput;
  const port = readPort(context);
  if (port === undefined) {
    return ChengPlanOutputSchema.parse(absent());
  }
  return ChengPlanOutputSchema.parse(await port.plan(parsed));
};

function chengPermission(permission: string, reason: string): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  };
}

export const chengInspectToolEntry: ToolEntry = {
  capability: "Read Cheng job state by jobId (read-only)",
  metadata: {
    shouldDefer: true,
    name: CHENG_INSPECT_TOOL_NAME,
    description: INSPECT_DESCRIPTION,
    modelInstructions: [...MODEL_INSTRUCTIONS],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CHENG_TOOL_TIMEOUT_MS,
    maxOutputBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: inspectHandler,
  inputSchema: ChengInspectInputJsonSchema,
  outputSchema: ChengInspectOutputJsonSchema,
  runtimeInputSchema: ChengInspectInputSchema,
  runtimeOutputSchema: ChengInspectOutputSchema,
  permission: chengPermission("cheng.inspect", "Read an existing Cheng job's state"),
  resultBudget: {
    maxInlineBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    maxModelBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: CHENG_TOOL_MAX_OUTPUT_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: CHENG_TOOL_TIMEOUT_MS,
    maxMs: CHENG_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ChengInspect was cancelled before the job state was read",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const chengVerifyToolEntry: ToolEntry = {
  capability: "Read a finished Cheng run's verdict receipts (read-only)",
  metadata: {
    shouldDefer: true,
    name: CHENG_VERIFY_TOOL_NAME,
    description: VERIFY_DESCRIPTION,
    modelInstructions: [...MODEL_INSTRUCTIONS],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CHENG_TOOL_TIMEOUT_MS,
    maxOutputBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: verifyHandler,
  inputSchema: ChengVerifyInputJsonSchema,
  outputSchema: ChengVerifyOutputJsonSchema,
  runtimeInputSchema: ChengVerifyInputSchema,
  runtimeOutputSchema: ChengVerifyOutputSchema,
  permission: chengPermission("cheng.verify", "Read a finished Cheng run's verdict receipts"),
  resultBudget: {
    maxInlineBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    maxModelBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: CHENG_TOOL_MAX_OUTPUT_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: CHENG_TOOL_TIMEOUT_MS,
    maxMs: CHENG_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ChengVerify was cancelled before the run volume was read",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const chengExplainToolEntry: ToolEntry = {
  capability: "Summarize a finished Cheng run's decision/structure graph (read-only)",
  metadata: {
    shouldDefer: true,
    name: CHENG_EXPLAIN_TOOL_NAME,
    description: EXPLAIN_DESCRIPTION,
    modelInstructions: [...MODEL_INSTRUCTIONS],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CHENG_TOOL_TIMEOUT_MS,
    maxOutputBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: explainHandler,
  inputSchema: ChengExplainInputJsonSchema,
  outputSchema: ChengExplainOutputJsonSchema,
  runtimeInputSchema: ChengExplainInputSchema,
  runtimeOutputSchema: ChengExplainOutputSchema,
  permission: chengPermission("cheng.explain", "Summarize a finished Cheng run's graph"),
  resultBudget: {
    maxInlineBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    maxModelBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: CHENG_TOOL_MAX_OUTPUT_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: CHENG_TOOL_TIMEOUT_MS,
    maxMs: CHENG_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ChengExplain was cancelled before the graph summary was read",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const chengPlanToolEntry: ToolEntry = {
  capability: "Read a deterministic ChengPlan from a finished Cheng run's receipts (read-only)",
  metadata: {
    shouldDefer: true,
    name: CHENG_PLAN_TOOL_NAME,
    description: PLAN_DESCRIPTION,
    modelInstructions: [...MODEL_INSTRUCTIONS],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CHENG_TOOL_TIMEOUT_MS,
    maxOutputBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: planHandler,
  inputSchema: ChengPlanInputJsonSchema,
  outputSchema: ChengPlanOutputJsonSchema,
  runtimeInputSchema: ChengPlanInputSchema,
  runtimeOutputSchema: ChengPlanOutputSchema,
  permission: chengPermission("cheng.plan", "Read the deterministic next-action plan"),
  resultBudget: {
    maxInlineBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    maxModelBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: CHENG_TOOL_MAX_OUTPUT_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: CHENG_TOOL_TIMEOUT_MS,
    maxMs: CHENG_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ChengPlan was cancelled before the plan was read",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const chengToolEntries: ToolEntry[] = [
  chengInspectToolEntry,
  chengVerifyToolEntry,
  chengExplainToolEntry,
  chengPlanToolEntry,
];
