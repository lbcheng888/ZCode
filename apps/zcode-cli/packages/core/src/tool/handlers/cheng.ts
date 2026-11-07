import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CHENG_EXPLAIN_TOOL_NAME,
  CHENG_GENERATE_TOOL_NAME,
  CHENG_INSPECT_TOOL_NAME,
  CHENG_PLAN_TOOL_NAME,
  CHENG_VERIFY_TOOL_NAME,
  ChengExplainInputJsonSchema,
  ChengExplainInputSchema,
  ChengExplainOutputJsonSchema,
  ChengExplainOutputSchema,
  ChengGenerateInputJsonSchema,
  ChengGenerateInputSchema,
  ChengGenerateOutputJsonSchema,
  ChengGenerateOutputSchema,
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
  type ChengGenerateInput,
  type ChengInspectInput,
  type ChengPlanInput,
  type ChengVerifyInput,
  type ToolPermissionSpec,
} from "@zcode/contracts";

import { CHENG_READ_PORT_UNAVAILABLE_REASON, type ChengReadPort } from "../cheng-read-port.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";
import { assertWorkspaceWriteLease } from "../types.js";
import { validateChengSpecDraft } from "./cheng-spec-draft.js";

const CHENG_TOOL_TIMEOUT_MS = 30_000;
const CHENG_GENERATE_TIMEOUT_MS = 600_000;
const CHENG_TOOL_MAX_OUTPUT_BYTES = 64 * 1024;

/** spec 草案的落盘目录（相对 workspaceRoot）；文件名 `<task>-<uuid>.json`，task 已过校验器字符闸。 */
const CHENG_SPECS_DIR_SEGMENTS = [".chengcode", "cheng-specs"] as const;

const INSPECT_DESCRIPTION =
  "Read the state and run reference of an existing Cheng job by jobId. Read-only: never starts, retries or cancels a job.";
const VERIFY_DESCRIPTION =
  "Read the run-volume verdict of a finished Cheng job: acceptance level, judge/semantic summary, settle counts, structure gate, and the real ChengGate result evaluated from structured receipts. Read-only; diagnostic runs are never production acceptance.";
const EXPLAIN_DESCRIPTION =
  "Summarize the decision or structure graph of a finished Cheng job as bounded counts plus an artifact ref. Read-only; the full graph stays on disk.";
const PLAN_DESCRIPTION =
  "Read the deterministic ChengPlan for a finished Cheng job from structured receipts: frontier, candidate actions with costs/risk, recommended next action and blockedBy. Read-only; never starts, retries or cancels a job.";
const GENERATE_DESCRIPTION =
  "Validate a Cheng spec draft (csg.spec.v2 fixture shape), persist it under <workspaceRoot>/.chengcode/cheng-specs/, and start a Cheng generate job through the wired host. The model only provides the spec draft: legality is decided by the validator, and program generation is a deterministic host job. Returns a { jobId, runId, state } summary; follow up with ChengInspect/ChengVerify. An invalid draft writes nothing and starts nothing.";

const MODEL_INSTRUCTIONS = [
  "Only call with a jobId produced earlier by cheng.generate (inside a workflow) or by the Cheng host; these tools never create work.",
  "A diagnostic run is DIAGNOSTIC_NOT_ACCEPTANCE even when green — never report it as production acceptance.",
] as const;

const GENERATE_MODEL_INSTRUCTIONS = [
  "The spec draft must pass validation first (task name safe for filenames, non-empty unique modules, links typed per the fixture enum and resolving to declared entities, acyclic composes graph, non-empty assertions); a rejected draft is a 400 with every error listed and no side effects.",
  "This tool starts real compute; treat the returned jobId as the only handle for follow-up facts (ChengInspect/ChengVerify/ChengExplain/ChengPlan).",
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

const generateHandler: ToolHandler = async (input, context) => {
  const parsed = ChengGenerateInputSchema.parse(input) as ChengGenerateInput;
  const port = context.chengGeneratePort;
  if (port === undefined) {
    // 与只读四件套同款的命名能力缺席：宿主没接 cheng host，受理即谎言。
    return ChengGenerateOutputSchema.parse(absent());
  }
  const verdict = validateChengSpecDraft(parsed.spec);
  if (!verdict.ok) {
    // 校验失败是可预期业务失败：一次性带上全部错误，不落盘、不碰 host。
    return {
      result: false,
      errorCode: 400,
      message: `ChengGenerate wrote nothing: spec draft failed validation (${verdict.errors.length} errors):\n${verdict.errors
        .map((error) => `- ${error}`)
        .join("\n")}`,
    } satisfies ToolHandlerFailure;
  }
  const specDir = path.join(context.workspaceRoot, ...CHENG_SPECS_DIR_SEGMENTS);
  const specPath = path.join(specDir, `${verdict.task}-${randomUUID()}.json`);
  // 写工具入口统一 admission：目标路径解析出来之后、碰盘之前（端口缺席时零行为）。
  assertWorkspaceWriteLease(context, CHENG_GENERATE_TOOL_NAME, [specPath]);
  await mkdir(specDir, { recursive: true });
  // wx = 排他创建：uuid 撞名的既有文件会让写入失败上浮，而不是覆盖宿主或前次草案。
  await writeFile(specPath, `${JSON.stringify(parsed.spec, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  const result = await port.generate({
    specPath,
    task: verdict.task,
    ...(parsed.budget === undefined ? {} : { budget: parsed.budget }),
  });
  return ChengGenerateOutputSchema.parse({
    status: "ok",
    jobId: result.jobId,
    runId: result.runId,
    state: result.state,
  });
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

export const chengGenerateToolEntry: ToolEntry = {
  capability: "Validate a Cheng spec draft, persist it, and start a generate job",
  metadata: {
    shouldDefer: true,
    name: CHENG_GENERATE_TOOL_NAME,
    description: GENERATE_DESCRIPTION,
    modelInstructions: [...GENERATE_MODEL_INSTRUCTIONS],
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CHENG_GENERATE_TIMEOUT_MS,
    maxOutputBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: generateHandler,
  inputSchema: ChengGenerateInputJsonSchema,
  outputSchema: ChengGenerateOutputJsonSchema,
  runtimeInputSchema: ChengGenerateInputSchema,
  runtimeOutputSchema: ChengGenerateOutputSchema,
  permission: {
    permission: "cheng.generate",
    reason: "Start a Cheng generate job from a validated spec draft (writes the draft under .chengcode/cheng-specs)",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    maxModelBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: CHENG_TOOL_MAX_OUTPUT_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: CHENG_GENERATE_TIMEOUT_MS,
    maxMs: CHENG_GENERATE_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ChengGenerate was cancelled; the spec draft stays on disk and the host job runs to its own terminal state",
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
  chengGenerateToolEntry,
];
