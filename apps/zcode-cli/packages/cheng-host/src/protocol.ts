import { z } from "zod";
import {
  ChengErrorSchema,
  ChengGateResultSchema,
  ChengLeafProbeReceiptSchema,
  ChengPlanSchema,
  ChengSpecRefSchema,
  ChengSurfaceReportSchema,
  RunVolumeReceiptSchema,
  RuntimeManifestSchema,
  SettleReceiptSchema,
  Sha256Schema,
  StructureReceiptSchema,
  ZeroCReceiptSchema,
} from "@zcode/cheng-contract";

import { CONTRACT_MAJOR, PROTOCOL_VERSION } from "./version.js";
import { HostErrorPayloadSchema } from "./errors.js";

export const RequestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const JobIdSchema = Sha256Schema;
export const JobStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const ChengRunModeSchema = z.enum(["production", "diagnostic"]);
export const NonNegativeIntSchema = z.number().int().nonnegative();

const AttemptSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

export const JobFailureSchema = z.union([ChengErrorSchema, HostErrorPayloadSchema]);

export const JobStatusSchema = z
  .object({
    jobId: JobIdSchema,
    baseKey: z.string().min(1),
    attempt: AttemptSchema.nullable(),
    state: JobStateSchema,
    mode: ChengRunModeSchema,
    phase: z.string().min(1),
    seq: NonNegativeIntSchema,
    createdAt: z.string().min(1),
    startedAt: z.string().min(1).nullable(),
    finishedAt: z.string().min(1).nullable(),
    cancelRequested: z.boolean(),
    runId: z.string().min(1).nullable(),
    runDir: z.string().min(1).nullable(),
    exitCode: z.number().int().nullable(),
    error: JobFailureSchema.nullable(),
  })
  .strict();

export const GenerateResultSchema = z
  .object({
    jobId: JobIdSchema,
    dedupKey: z.string().min(1),
    state: JobStateSchema,
    mode: ChengRunModeSchema,
  })
  .strict();

export const JobCancelResultSchema = z
  .object({
    jobId: JobIdSchema,
    cancelRequested: z.boolean(),
    state: JobStateSchema,
  })
  .strict();

export const VerifyResultSchema = z
  .object({
    receipt: RunVolumeReceiptSchema,
    settle: SettleReceiptSchema.nullable(),
    structure: StructureReceiptSchema.nullable(),
    structureReason: z.string().min(1).nullable(),
    runtimeManifest: RuntimeManifestSchema.nullable(),
    zeroC: ZeroCReceiptSchema.nullable(),
    gate: ChengGateResultSchema,
    artifactRef: z.string().min(1),
  })
  .strict();

export const PlanResultSchema = z
  .object({
    gate: ChengGateResultSchema,
    plan: ChengPlanSchema,
  })
  .strict();

export const GraphSummarySchema = z
  .object({
    nodes: NonNegativeIntSchema,
    edges: NonNegativeIntSchema,
    roots: NonNegativeIntSchema,
    gateOk: z.boolean().nullable(),
  })
  .strict();

export const GraphResultSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().min(1).nullable(),
    artifactRef: z.string().min(1),
    digest: Sha256Schema,
    summary: GraphSummarySchema.nullable(),
  })
  .strict();

export const GraphDiffParamsSchema = z
  .object({
    runDirA: z.string().min(1),
    runDirB: z.string().min(1),
  })
  .strict();

export const GraphDiffResultSchema = z
  .object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.string()),
    digestA: Sha256Schema,
    digestB: Sha256Schema,
  })
  .strict();

export const DraftModuleInterfaceSchema = z
  .object({
    fn: z.string().min(1),
    params: z.array(
      z
        .object({
          name: z.string().min(1),
          type: z.string().min(1),
        })
        .strict(),
    ),
    returnType: z.string().min(1),
  })
  .strict();

export const DraftModuleSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(["entry", "helper"]).optional(),
    interface: DraftModuleInterfaceSchema,
  })
  .strict();

export const DraftLinkSchema = z
  .object({
    id: z.string().min(1).optional(),
    from: z.string().min(1),
    to: z.string().min(1),
    type: z.enum(["composes", "implemented_by", "verified_by", "exercises"]),
  })
  .strict();

export const DraftCaseSchema = z
  .object({
    args: z.array(z.number().int()),
    expected: z.number().int(),
  })
  .strict();

export const ChengSpecDraftSchema = z
  .object({
    task: z.string().min(1),
    title: z.string().min(1).optional(),
    domain: z.string().min(1).default("pure_scalar"),
    modules: z.array(DraftModuleSchema).min(1).max(64),
    links: z.array(DraftLinkSchema).default([]),
    requirements: z.array(z.string().min(1)).optional(),
    oracle: z
      .object({
        kind: z.enum(["settle", "property", "scenario"]).default("settle"),
      })
      .strict()
      .optional(),
    settleCases: z.array(DraftCaseSchema).min(1).max(1024),
    evalCases: z.array(DraftCaseSchema).max(1024).optional(),
    propertyDefs: z.array(z.string().min(1)).optional(),
    moves: z.enum(["macro"]).optional(),
    useLiblearn: z.boolean().optional(),
  })
  .strict();

export type ChengSpecDraft = z.infer<typeof ChengSpecDraftSchema>;

export const BundlePrepareParamsSchema = z
  .object({
    draft: ChengSpecDraftSchema,
  })
  .strict();

export const BundlePrepareResultSchema = z
  .object({
    bundleSha256: Sha256Schema,
    bundleDir: z.string().min(1),
    specPath: z.string().min(1),
    task: z.string().min(1),
    cached: z.boolean(),
  })
  .strict();

export type BundlePrepareResult = z.infer<typeof BundlePrepareResultSchema>;

export const SurfaceCheckParamsSchema = z
  .object({
    filePath: z.string().min(1),
  })
  .strict();

export const LeafProbeParamsSchema = z
  .object({
    filePath: z.string().min(1),
    allowClosureProbe: z.boolean().optional(),
  })
  .strict();

export const EvolveParamsSchema = z
  .object({
    runDirs: z.array(z.string().min(1)).max(32).default([]),
    dryRun: z.boolean().optional(),
  })
  .strict();

export const EvolveResultSchema = z
  .object({
    ok: z.boolean(),
    kind: z.enum(["counterexample", "sleep"]),
    exitCode: z.number().int(),
    receiptRef: z.string().min(1).nullable(),
    forbiddenHoldoutReads: NonNegativeIntSchema,
    summary: z.record(z.string(), z.unknown()),
  })
  .strict();

export type EvolveResult = z.infer<typeof EvolveResultSchema>;

export const CapabilityOpSchema = z
  .object({
    available: z.boolean(),
    sync: z.boolean(),
    cancellable: z.boolean(),
  })
  .strict();

export const ProductionSlotSummarySchema = z
  .object({
    driverPath: z.string().min(1),
    driverSha256: Sha256Schema,
    linkerPath: z.string().min(1),
    linkerSha256: Sha256Schema,
    provenanceReportSha256: Sha256Schema,
    donorsListSha256: Sha256Schema,
    donorProvenanceSha256: Sha256Schema,
    donorCount: z.number().int().positive(),
  })
  .strict();

export const DiagnosticSlotSummarySchema = z
  .object({
    driverPath: z.string().min(1),
    driverSha256: Sha256Schema,
  })
  .strict();

export const ActiveSeedPinSchema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema,
  })
  .strict();

export const RuntimePinSchema = z
  .object({
    chengRoot: z.string().min(1),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    runnerSha256: Sha256Schema,
    driverSha256: Sha256Schema,
    gitWorkTree: z.literal(true),
    readyModes: z.array(ChengRunModeSchema).min(1),
    productionSlot: ProductionSlotSummarySchema.nullable(),
    diagnosticSlot: DiagnosticSlotSummarySchema.nullable(),
    activeSeedPin: ActiveSeedPinSchema.nullable(),
  })
  .strict();

export const CapabilitiesSchema = z
  .object({
    contractMajor: z.literal(CONTRACT_MAJOR),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    hostVersion: z.string().min(1),
    fingerprint: Sha256Schema,
    runtime: RuntimePinSchema,
    ops: z.record(z.string(), CapabilityOpSchema),
  })
  .strict();

export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type GenerateResult = z.infer<typeof GenerateResultSchema>;
export type JobCancelResult = z.infer<typeof JobCancelResultSchema>;
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
export type PlanResult = z.infer<typeof PlanResultSchema>;
export type GraphResult = z.infer<typeof GraphResultSchema>;
export type GraphSummary = z.infer<typeof GraphSummarySchema>;
export type GraphDiffResult = z.infer<typeof GraphDiffResultSchema>;
export type JobFailure = z.infer<typeof JobFailureSchema>;

export const GenerateParamsSchema = z
  .object({
    specPath: z.string().min(1),
    bundleDir: z.string().min(1).optional(),
    task: z.string().min(1),
    mode: ChengRunModeSchema,
    budget: z.number().int().positive().max(900_000),
    allowDraftUnowned: z.boolean().optional(),
    moves: z.enum(["macro"]).optional(),
    useLiblearn: z.boolean().optional(),
    attempt: AttemptSchema.optional(),
  })
  .strict();

export const SpecValidateParamsSchema = z
  .object({
    specPath: z.string().min(1),
    indexPath: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
  })
  .strict();

export const JobParamsSchema = z.object({ jobId: JobIdSchema }).strict();

export const SettleParamsSchema = z
  .object({ jobId: JobIdSchema, task: z.string().min(1) })
  .strict();

export const PlanParamsSchema = z
  .object({ jobId: JobIdSchema, task: z.string().min(1) })
  .strict();

export const GraphParamsSchema = z
  .object({
    jobId: JobIdSchema,
    task: z.string().min(1),
    view: z.enum(["structure", "decision"]),
  })
  .strict();

export const EmptyParamsSchema = z.object({}).strict();

export type HostMethod =
  | "capabilities"
  | "spec.validate"
  | "bundle.prepare"
  | "generate"
  | "job.status"
  | "job.cancel"
  | "verify"
  | "settle"
  | "plan"
  | "graph.query"
  | "graph.diff"
  | "surface.check"
  | "leaf.probe"
  | "evolve.counterexample"
  | "evolve.sleep"
  | "parse"
  | "typecheck"
  | "decide";

export interface MethodSchema {
  readonly params: z.ZodType;
  readonly result: z.ZodType;
  readonly available: boolean;
  readonly sync: boolean;
  readonly cancellable: boolean;
}

const UNAVAILABLE = {
  params: z.unknown(),
  available: false,
  sync: false,
  cancellable: false,
} as const;

export const METHOD_SCHEMAS = {
  capabilities: {
    params: EmptyParamsSchema,
    result: CapabilitiesSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  "spec.validate": {
    params: SpecValidateParamsSchema,
    result: ChengSpecRefSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  "bundle.prepare": {
    params: BundlePrepareParamsSchema,
    result: BundlePrepareResultSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  generate: {
    params: GenerateParamsSchema,
    result: GenerateResultSchema,
    available: true,
    sync: false,
    cancellable: false,
  },
  "job.status": {
    params: JobParamsSchema,
    result: JobStatusSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  "job.cancel": {
    params: JobParamsSchema,
    result: JobCancelResultSchema,
    available: true,
    sync: true,
    cancellable: true,
  },
  verify: {
    params: JobParamsSchema,
    result: VerifyResultSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  settle: {
    params: SettleParamsSchema,
    result: SettleReceiptSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  plan: {
    params: PlanParamsSchema,
    result: PlanResultSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  "graph.query": {
    params: GraphParamsSchema,
    result: GraphResultSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  "graph.diff": {
    params: GraphDiffParamsSchema,
    result: GraphDiffResultSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  "surface.check": {
    params: SurfaceCheckParamsSchema,
    result: ChengSurfaceReportSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  "leaf.probe": {
    params: LeafProbeParamsSchema,
    result: ChengLeafProbeReceiptSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  "evolve.counterexample": {
    params: EvolveParamsSchema,
    result: EvolveResultSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  "evolve.sleep": {
    params: EvolveParamsSchema,
    result: EvolveResultSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  parse: { ...UNAVAILABLE, result: z.never() },
  typecheck: { ...UNAVAILABLE, result: z.never() },
  decide: { ...UNAVAILABLE, result: z.never() },
} as const satisfies Record<HostMethod, MethodSchema>;

export function isHostMethod(value: string): value is HostMethod {
  return Object.prototype.hasOwnProperty.call(METHOD_SCHEMAS, value);
}

export const HelloFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    t: z.literal("hello"),
    id: z.literal("hello"),
    auth: z.string().min(1).nullable(),
    workspaceRoot: z.string().min(1),
    workspaceIdentity: z.string().min(1),
    contract: z.literal(CONTRACT_MAJOR),
    client: z
      .object({
        kind: z.enum(["cli", "desktop", "daemon", "workflow"]),
        sessionId: z.string().min(1).optional(),
        pid: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();

export const RequestFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    t: z.literal("req"),
    id: RequestIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
    deadlineMs: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict();

export const ResponseOkFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    t: z.literal("res"),
    id: RequestIdSchema,
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

export const ResponseErrFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    t: z.literal("res"),
    id: RequestIdSchema,
    ok: z.literal(false),
    error: HostErrorPayloadSchema,
  })
  .strict();

export const JobEventParamsSchema = z
  .object({
    jobId: JobIdSchema,
    seq: NonNegativeIntSchema,
    state: JobStateSchema,
    phase: z.string().min(1),
    at: z.string().min(1),
    elapsedMs: NonNegativeIntSchema,
    runId: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    error: JobFailureSchema.optional(),
  })
  .strict();

export const EventFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    t: z.literal("evt"),
    id: JobIdSchema,
    method: z.enum(["job.progress", "job.state"]),
    params: JobEventParamsSchema,
  })
  .strict();

export type HelloFrame = z.infer<typeof HelloFrameSchema>;
export type RequestFrame = z.infer<typeof RequestFrameSchema>;
export type JobEventParams = z.infer<typeof JobEventParamsSchema>;
export type EventFrame = z.infer<typeof EventFrameSchema>;
