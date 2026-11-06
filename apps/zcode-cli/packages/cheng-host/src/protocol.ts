import { z } from "zod";
import {
  ChengErrorSchema,
  ChengSpecRefSchema,
  RunVolumeReceiptSchema,
  SettleReceiptSchema,
  StructureReceiptSchema,
  Sha256Schema,
} from "@zcode/cheng-contract";

import { CONTRACT_MAJOR, PROTOCOL_VERSION } from "./version.js";
import { HostErrorPayloadSchema } from "./errors.js";

export const RequestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const JobIdSchema = Sha256Schema;
export const JobStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const NonNegativeIntSchema = z.number().int().nonnegative();

const AttemptSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

export const JobFailureSchema = z.union([ChengErrorSchema, HostErrorPayloadSchema]);

export const JobStatusSchema = z
  .object({
    jobId: JobIdSchema,
    baseKey: z.string().min(1),
    attempt: AttemptSchema.nullable(),
    state: JobStateSchema,
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
    artifactRef: z.string().min(1),
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

export const CapabilityOpSchema = z
  .object({
    available: z.boolean(),
    sync: z.boolean(),
    cancellable: z.boolean(),
  })
  .strict();

export const RuntimePinSchema = z
  .object({
    chengRoot: z.string().min(1),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    runnerSha256: Sha256Schema,
    driverSha256: Sha256Schema,
    gitWorkTree: z.literal(true),
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
export type GraphResult = z.infer<typeof GraphResultSchema>;
export type GraphSummary = z.infer<typeof GraphSummarySchema>;
export type JobFailure = z.infer<typeof JobFailureSchema>;

export const GenerateParamsSchema = z
  .object({
    specPath: z.string().min(1),
    task: z.string().min(1),
    mode: z.literal("diagnostic"),
    budget: z.number().int().positive().max(900_000),
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
  | "generate"
  | "job.status"
  | "job.cancel"
  | "verify"
  | "settle"
  | "graph.query"
  | "parse"
  | "typecheck"
  | "plan"
  | "decide"
  | "graph.diff";

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
  "graph.query": {
    params: GraphParamsSchema,
    result: GraphResultSchema,
    available: true,
    sync: true,
    cancellable: false,
  },
  parse: { ...UNAVAILABLE, result: z.never() },
  typecheck: { ...UNAVAILABLE, result: z.never() },
  plan: { ...UNAVAILABLE, result: z.never() },
  decide: { ...UNAVAILABLE, result: z.never() },
  "graph.diff": { ...UNAVAILABLE, result: z.never() },
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
