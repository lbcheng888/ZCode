import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  CHENG_EXPLAIN_TOOL_NAME,
  CHENG_GENERATE_TOOL_NAME,
  CHENG_INSPECT_TOOL_NAME,
  CHENG_JOB_STATES,
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
  type JsonSchema,
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

export const CHENG_CHECK_SURFACE_TOOL_NAME = "ChengCheckSurface";
export const CHENG_PROBE_LEAF_TOOL_NAME = "ChengProbeLeaf";

const CHENG_TOOL_TIMEOUT_MS = 30_000;
const CHENG_GENERATE_TIMEOUT_MS = 600_000;
const CHENG_PROBE_LEAF_TIMEOUT_MS = 35_000;
const CHENG_TOOL_MAX_OUTPUT_BYTES = 64 * 1024;

const CLOSURE_ROOT_SUFFIXES = [
  "kernel/driver/selfhost_main.cheng",
  "src/core/tooling/system_link_exec_pure_main.cheng",
  "src/core/tooling/backend_driver_dispatch_min.cheng",
] as const;

function toLocalToolJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = raw;
  return rest as JsonSchema;
}

const ChengCapabilityAbsentSchema = z
  .object({
    status: z.literal("capability_absent"),
    reason: z.string().min(1),
  })
  .strict();

const ChengGenerateToolInputSchema = z
  .object({
    spec: z.record(z.string(), z.unknown()),
    budget: z.number().int().min(1).max(900_000).optional(),
    mode: z.enum(["production", "diagnostic"]).optional(),
    moves: z.literal("macro").optional(),
    useLiblearn: z.boolean().optional(),
    allowDraftUnowned: z.boolean().optional(),
    waitMode: z.enum(["sync", "bounded"]).optional(),
    maxWaitMs: z.number().int().min(100).max(600_000).optional(),
  })
  .strict();

type ChengGenerateToolInput = z.infer<typeof ChengGenerateToolInputSchema>;

const ChengGenerateOkLocalSchema = z
  .object({
    status: z.literal("ok"),
    jobId: z.string().regex(/^[0-9a-f]{64}$/),
    runId: z.string().min(1).nullable(),
    state: z.enum(CHENG_JOB_STATES),
  })
  .strict();

const ChengGenerateAcceptedRunningSchema = z
  .object({
    status: z.literal("accepted_running"),
    jobId: z.string().regex(/^[0-9a-f]{64}$/),
    runId: z.string().min(1).nullable(),
    state: z.enum(CHENG_JOB_STATES),
    nextTool: z.literal("ChengInspect"),
  })
  .strict();

const ChengGenerateToolOutputSchema = z.union([
  ChengGenerateOkLocalSchema,
  ChengCapabilityAbsentSchema,
  ChengGenerateAcceptedRunningSchema,
]);

const ChengGenerateToolInputJsonSchema = toLocalToolJsonSchema(ChengGenerateToolInputSchema);
const ChengGenerateToolOutputJsonSchema = toLocalToolJsonSchema(ChengGenerateToolOutputSchema);

export const ChengCheckSurfaceInputSchema = z
  .object({
    filePath: z.string().min(1).optional(),
    filePaths: z.array(z.string().min(1)).min(1).max(32).optional(),
  })
  .strict()
  .refine((val) => val.filePath !== undefined || (val.filePaths !== undefined && val.filePaths.length > 0), {
    message: "filePath or filePaths is required",
  });

const ChengSurfaceViolationSchema = z
  .object({
    ruleId: z.string().min(1),
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative().optional(),
    message: z.string(),
  })
  .strict();

const ChengSurfaceReportSchema = z
  .object({
    schema: z.literal("cheng.contract.surface_report.v1").optional(),
    filePath: z.string().min(1),
    fileSha256: z.string().optional(),
    v4Ok: z.boolean(),
    budgetOk: z.boolean(),
    lineCount: z.number().int().nonnegative(),
    lineCapOk: z.boolean(),
    violations: z.array(ChengSurfaceViolationSchema),
    truncatedCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ChengCheckSurfaceOutputSchema = z.union([
  z
    .object({
      status: z.literal("ok"),
      reports: z.array(ChengSurfaceReportSchema).min(1),
    })
    .strict(),
  ChengCapabilityAbsentSchema,
]);

export const ChengProbeLeafInputSchema = z
  .object({
    filePath: z.string().min(1),
    allowClosureProbe: z.boolean().optional(),
  })
  .strict();

export const ChengProbeLeafOutputSchema = z.union([
  z
    .object({
      status: z.literal("ok"),
      schema: z.literal("cheng.contract.leaf_probe.v1").optional(),
      filePath: z.string().min(1),
      driverSha256: z.string().optional(),
      exitCode: z.number().int(),
      objBytes: z.number().int().nonnegative(),
      compileMaxRssBytes: z.number().int().nonnegative(),
      wallMs: z.number().int().nonnegative(),
      admissionTicketId: z.string().optional(),
      firstError: z.string().nullable(),
    })
    .strict(),
  ChengCapabilityAbsentSchema,
]);

const ChengCheckSurfaceInputJsonSchema = toLocalToolJsonSchema(ChengCheckSurfaceInputSchema);
const ChengCheckSurfaceOutputJsonSchema = toLocalToolJsonSchema(ChengCheckSurfaceOutputSchema);
const ChengProbeLeafInputJsonSchema = toLocalToolJsonSchema(ChengProbeLeafInputSchema);
const ChengProbeLeafOutputJsonSchema = toLocalToolJsonSchema(ChengProbeLeafOutputSchema);

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
// 分诊三分段（何时用/何时不用/不确定时）：判据是「能否用 settle/eval oracle 表达」，
// 不是任务难易——交互/UI/IO 类程序没有可判定输出，走常规编码；不确定时先拆可判定
// 纯核心，拆不出就不用本工具。
const GENERATE_DESCRIPTION = [
  "Validate a Cheng spec draft (csg.spec.v2 fixture shape), persist it under <workspaceRoot>/.chengcode/cheng-specs/, and start a Cheng generate job through the wired host. The model only provides the spec draft: legality is decided by the validator, and program generation is a deterministic host job. Returns a { jobId, runId, state } summary; follow up with ChengInspect/ChengVerify. An invalid draft writes nothing and starts nothing.",
  "",
  "When to use: tasks expressible as pure functions or state transitions checked by a settle/eval oracle — algorithms, data transformations, parsing, pure core logic whose correct output is decidable from its inputs.",
  "",
  "When NOT to use: interactive/UI/IO-bound or open-ended framework programs (game rendering, web pages, apps). Build those with the regular coding tools, where structure is constrained by the existing gates — do not route them through this tool.",
  "",
  "When unsure: first try to carve the task's decidable core into a pure-function spec draft with settle oracle assertions; if no such core can be carved out, do not use this tool.",
].join("\n");

const MODEL_INSTRUCTIONS = [
  "Only call with a jobId produced earlier by cheng.generate (inside a workflow) or by the Cheng host; these tools never create work.",
  "A diagnostic run is DIAGNOSTIC_NOT_ACCEPTANCE even when green — never report it as production acceptance.",
] as const;

const GENERATE_MODEL_INSTRUCTIONS = [
  "The spec draft must pass validation first (task name safe for filenames, non-empty unique modules, links typed per the fixture enum and resolving to declared entities, acyclic composes graph, non-empty assertions); a rejected draft is a 400 with every error listed and no side effects.",
  "This tool starts real compute; treat the returned jobId as the only handle for follow-up facts (ChengInspect/ChengVerify/ChengExplain/ChengPlan).",
] as const;

function readPort(context: ToolExecutionContext): ChengReadPort | undefined {
  return context.chengReadPort ?? context.chengHostPort;
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
  const parsed = ChengGenerateToolInputSchema.parse(input) as ChengGenerateToolInput;
  const port = context.chengGeneratePort ?? context.chengHostPort;
  if (port === undefined) {
    // 与只读四件套同款的命名能力缺席：宿主没接 cheng host，受理即谎言。
    return ChengGenerateToolOutputSchema.parse(absent());
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

  const bundlePrepare = context.chengHostPort?.bundlePrepare ?? port.bundlePrepare;
  let specPath: string;
  let bundleDir: string | undefined;
  let task = verdict.task;

  if (bundlePrepare !== undefined) {
    const prepared = await bundlePrepare({ draft: parsed.spec });
    specPath = prepared.specPath;
    bundleDir = prepared.bundleDir;
    task = prepared.task;
  } else {
    const specDir = path.join(context.workspaceRoot, ...CHENG_SPECS_DIR_SEGMENTS);
    specPath = path.join(specDir, `${verdict.task}-${randomUUID()}.json`);
    // 写工具入口统一 admission：目标路径解析出来之后、碰盘之前（端口缺席时零行为）。
    assertWorkspaceWriteLease(context, CHENG_GENERATE_TOOL_NAME, [specPath]);
    await mkdir(specDir, { recursive: true });
    // wx = 排他创建：uuid 撞名的既有文件会让写入失败上浮，而不是覆盖宿主或前次草案。
    await writeFile(specPath, `${JSON.stringify(parsed.spec, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  const mode = parsed.mode ?? (bundlePrepare !== undefined ? "production" : undefined);
  const result = await port.generate({
    specPath,
    task,
    ...(bundleDir === undefined ? {} : { bundleDir }),
    ...(mode === undefined ? {} : { mode }),
    ...(parsed.budget === undefined ? {} : { budget: parsed.budget }),
    ...(parsed.moves === undefined ? {} : { moves: parsed.moves }),
    ...(parsed.useLiblearn === undefined ? {} : { useLiblearn: parsed.useLiblearn }),
    ...(parsed.allowDraftUnowned === undefined ? {} : { allowDraftUnowned: parsed.allowDraftUnowned }),
    ...(parsed.waitMode === undefined ? {} : { waitMode: parsed.waitMode }),
    ...(parsed.maxWaitMs === undefined ? {} : { maxWaitMs: parsed.maxWaitMs }),
  });

  if (result.status === "accepted_running") {
    return ChengGenerateToolOutputSchema.parse({
      status: "accepted_running",
      jobId: result.jobId,
      runId: result.runId,
      state: result.state,
      nextTool: result.nextTool ?? "ChengInspect",
    });
  }

  return ChengGenerateToolOutputSchema.parse({
    status: "ok",
    jobId: result.jobId,
    runId: result.runId,
    state: result.state,
  });
};

const checkSurfaceHandler: ToolHandler = async (input, context) => {
  const parsed = ChengCheckSurfaceInputSchema.parse(input);
  const checkSurface = context.chengHostPort?.checkSurface;
  if (checkSurface === undefined) {
    return ChengCheckSurfaceOutputSchema.parse(absent());
  }
  const targets = parsed.filePaths ?? (parsed.filePath ? [parsed.filePath] : []);
  const reports = await Promise.all(targets.map((filePath) => checkSurface({ filePath })));
  return ChengCheckSurfaceOutputSchema.parse({
    status: "ok",
    reports,
  });
};

const probeLeafHandler: ToolHandler = async (input, context) => {
  const parsed = ChengProbeLeafInputSchema.parse(input);
  const normalizedPath = parsed.filePath.replace(/\\/g, "/");
  if (
    parsed.allowClosureProbe !== true &&
    CLOSURE_ROOT_SUFFIXES.some((suffix) => normalizedPath === suffix || normalizedPath.endsWith(`/${suffix}`))
  ) {
    return {
      result: false,
      errorCode: 400,
      message: `ChengProbeLeaf rejected top-level closure root "${parsed.filePath}" without allowClosureProbe: true. Probe a single leaf .cheng module or use the formal gate after all edits.`,
    } satisfies ToolHandlerFailure;
  }
  const probeLeaf = context.chengHostPort?.probeLeaf;
  if (probeLeaf === undefined) {
    return ChengProbeLeafOutputSchema.parse(absent());
  }
  const receipt = await probeLeaf({
    filePath: parsed.filePath,
    ...(parsed.allowClosureProbe === undefined ? {} : { allowClosureProbe: parsed.allowClosureProbe }),
  });
  return ChengProbeLeafOutputSchema.parse({
    status: "ok",
    ...receipt,
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
  inputSchema: ChengGenerateToolInputJsonSchema,
  outputSchema: ChengGenerateToolOutputJsonSchema,
  runtimeInputSchema: ChengGenerateToolInputSchema,
  runtimeOutputSchema: ChengGenerateToolOutputSchema,
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

export const chengCheckSurfaceToolEntry: ToolEntry = {
  capability: "Check Cheng v4.0 surface syntax and source budget on .cheng files (read-only)",
  metadata: {
    shouldDefer: true,
    name: CHENG_CHECK_SURFACE_TOOL_NAME,
    description:
      "Run the <5ms Cheng v4.0 surface and source budget gate on one or more .cheng files (ZD01/UA01/UA02/RL01/line cap). Read-only.",
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
  handler: checkSurfaceHandler,
  inputSchema: ChengCheckSurfaceInputJsonSchema,
  outputSchema: ChengCheckSurfaceOutputJsonSchema,
  runtimeInputSchema: ChengCheckSurfaceInputSchema,
  runtimeOutputSchema: ChengCheckSurfaceOutputSchema,
  permission: chengPermission("cheng.surface.check", "Check .cheng file surface and budget"),
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
    userVisibleMessage: "ChengCheckSurface was cancelled before checking finished",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const chengProbeLeafToolEntry: ToolEntry = {
  capability: "Compile-probe a single leaf .cheng file under admission control (read-only)",
  metadata: {
    shouldDefer: true,
    name: CHENG_PROBE_LEAF_TOOL_NAME,
    description:
      "Compile-probe a single leaf .cheng module (<30s, 768 MiB RSS cap) via cheng-host probe admission. Rejects full-closure top-level roots unless allowClosureProbe is true. Read-only.",
    modelInstructions: [...MODEL_INSTRUCTIONS],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CHENG_PROBE_LEAF_TIMEOUT_MS,
    maxOutputBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: probeLeafHandler,
  inputSchema: ChengProbeLeafInputJsonSchema,
  outputSchema: ChengProbeLeafOutputJsonSchema,
  runtimeInputSchema: ChengProbeLeafInputSchema,
  runtimeOutputSchema: ChengProbeLeafOutputSchema,
  permission: chengPermission("cheng.leaf.probe", "Compile-probe a single leaf .cheng file"),
  resultBudget: {
    maxInlineBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    maxModelBytes: CHENG_TOOL_MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: CHENG_TOOL_MAX_OUTPUT_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: CHENG_PROBE_LEAF_TIMEOUT_MS,
    maxMs: CHENG_PROBE_LEAF_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ChengProbeLeaf was cancelled before probe finished",
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
  chengCheckSurfaceToolEntry,
  chengProbeLeafToolEntry,
];
