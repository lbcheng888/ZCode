import { z } from "zod";

import { ChengContractError } from "./errors.js";

export const DecisionJudgeVerdictSchema = z.enum([
  "not_judged",
  "semantic_pass",
  "semantic_fail",
  "dual_pass",
  "car_pass",
  "cold_pass",
  "suite_green",
  "registered_realizer_gap",
  "verdict_confirmed",
]);

export type DecisionJudgeVerdict = z.infer<typeof DecisionJudgeVerdictSchema>;

const DecisionCandidateSchema = z
  .object({
    id: z.string().min(1),
    legal: z.boolean(),
    score: z.number().int().nullable().optional(),
    hit: z.number().int().optional(),
  })
  .strict();

export type DecisionCandidate = z.infer<typeof DecisionCandidateSchema>;

/**
 * M5 hole shape (`definitions.hole_type_m5`). Field values are signed
 * integers in the real corpus (`gate=-1`, `slot=-1`), so no minimum applies.
 */
const HoleTypeM5Schema = z
  .object({
    kind: z.enum(["stmt", "expr"]),
    ty: z.number().int().optional(),
    gate: z.number().int().optional(),
    marker: z.number().int().optional(),
    depth: z.number().int().optional(),
    slot: z.number().int().optional(),
    block: z.number().int().optional(),
    fn: z.number().int().optional(),
    round: z.number().int().optional(),
    role: z.number().int().optional(),
    loop_role: z.string().optional(),
  })
  .strict();

/** Precedent hole shape (`definitions.hole_type_precedent`). */
const HoleTypePrecedentSchema = z
  .object({
    kind: z.literal("source_migration"),
    family: z.string().regex(/^F-/u, "family must start with F-"),
    verdict_class: z.string(),
  })
  .strict();

const HoleTypeSchema = z.discriminatedUnion("kind", [
  HoleTypeM5Schema,
  HoleTypePrecedentSchema,
]);

export type DecisionHoleType = z.infer<typeof HoleTypeSchema>;

/**
 * `_precedent_extension` in `schema.decision_data.v0.json`: precedent pairs
 * additionally carry `hole_ctx` with these keys (extras are tolerated).
 */
const HoleCtxSchema = z
  .object({
    family: z.string(),
    verdict_class: z.string(),
    error_verdict: z.string(),
    site: z.string(),
    code_shape: z.string(),
  })
  .passthrough();

export type DecisionHoleCtx = z.infer<typeof HoleCtxSchema>;

/**
 * `provenance` has no `additionalProperties: false` in the v0 schema; the
 * listed fields are typed, anything else is carried through unchanged.
 *
 * `source`/`sha256_or_commit` are declared at the top level of the v0 schema,
 * but the real M5 corpus uses `source_trace`/`source_sha256` instead (0/389
 * M5 frames carry `source`; 50/50 precedents do). Per-form requirements are
 * enforced in `DecisionFrameSchema.superRefine` rather than fabricated here.
 */
const ProvenanceSchema = z
  .object({
    source: z.string().optional(),
    sha256_or_commit: z.string().optional(),
    source_trace: z.string().optional(),
    source_sha256: z.string().optional(),
    trace_tag: z.string().optional(),
    path_sha256: z.string().optional(),
    split: z
      .enum(["train", "train_negative", "determinism_only", "heldout_eval"])
      .optional(),
    parent_step: z.number().int().nullable().optional(),
    created_holes: z.array(z.string()).optional(),
    call_edges: z.array(z.unknown()).optional(),
    invalidated: z.boolean().optional(),
    invalidated_by: z.array(z.unknown()).optional(),
    prune: z.record(z.string(), z.unknown()).optional(),
    pruned: z.array(z.unknown()).optional(),
    closure: z.record(z.string(), z.unknown()).optional(),
    commit: z.string().optional(),
  })
  .passthrough();

const HOLE_ID_PATTERN =
  /^(?:[A-Za-z0-9_.-]+(?:\/[^/@]+)+@\d+|prec\/\d{3})$/u;

/**
 * One `csg.decision_data/v0` record.
 *
 * `schema` is the base literal for M5 frames. Real precedent frames carry
 * either the base literal or `csg.decision_data/v0.precedent` (the corpus
 * uses the latter); the `.precedent` spelling is accepted only when
 * `hole_type.kind=source_migration`.
 */
export const DecisionFrameSchema = z
  .object({
    schema: z.enum(["csg.decision_data/v0", "csg.decision_data/v0.precedent"]),
    hole_id: z.string().regex(HOLE_ID_PATTERN, "invalid hole_id"),
    hole_type: HoleTypeSchema,
    context_cid: z.string().regex(/^[0-9a-f]{64}$/u, "expected a lowercase 64-hex sha256"),
    candidates: z.array(DecisionCandidateSchema).min(1),
    chosen: z.string().min(1),
    score: z.number().int().nullable(),
    settle_rc: z.record(z.string(), z.unknown()),
    judge_verdict: DecisionJudgeVerdictSchema,
    spec_cid: z.string().min(1),
    provenance: ProvenanceSchema,
    hole_ctx: HoleCtxSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    const isPrecedent = value.hole_type.kind === "source_migration";

    if (!value.candidates.some((candidate) => candidate.id === value.chosen)) {
      issue(`chosen is not in candidates: ${value.chosen}`, ["chosen"]);
    }
    if (!isPrecedent && value.schema !== "csg.decision_data/v0") {
      issue("csg.decision_data/v0.precedent requires a precedent hole_type", [
        "schema",
      ]);
    }
    if (!isPrecedent && value.hole_ctx !== undefined) {
      issue("hole_ctx is only valid for precedent frames", ["hole_ctx"]);
    }
    if (isPrecedent) {
      if (value.provenance.source === undefined) {
        issue("precedent provenance requires source", ["provenance", "source"]);
      }
      if (value.provenance.sha256_or_commit === undefined) {
        issue("precedent provenance requires sha256_or_commit", [
          "provenance",
          "sha256_or_commit",
        ]);
      }
    } else {
      const hasTraceAnchor =
        value.provenance.source_trace !== undefined &&
        value.provenance.source_sha256 !== undefined;
      const hasSchemaAnchor =
        value.provenance.source !== undefined &&
        value.provenance.sha256_or_commit !== undefined;
      if (!hasTraceAnchor && !hasSchemaAnchor) {
        issue(
          "M5 provenance requires source_trace+source_sha256 or source+sha256_or_commit",
          ["provenance"],
        );
      }
    }
  });

export type DecisionFrame = z.infer<typeof DecisionFrameSchema>;

function invalid(
  sourcePath: string,
  detail: string,
  line?: number,
): ChengContractError {
  return new ChengContractError({
    code: "CHENG_CONTRACT_SCHEMA_INVALID",
    sourcePath,
    line: line ?? null,
    detail,
  });
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.map((segment) => String(segment)).join(".") || "<root>"}: ${issue.message}`,
    )
    .join("; ");
}

/**
 * Parse a decision-trajectory JSONL file. Blank lines are rejected (a single
 * trailing newline is allowed), as are invalid JSON, schema drift, `chosen`
 * outside `candidates` and duplicate `hole_id` values inside the same file.
 */
export function parseDecisionFrameJsonl(
  text: string,
  sourcePath = "<memory>",
): DecisionFrame[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    throw invalid(sourcePath, "JSONL input has no records");
  }

  const frames: DecisionFrame[] = [];
  const firstLineByHoleId = new Map<string, number>();
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === "") {
      throw invalid(sourcePath, "blank line in JSONL", lineNumber);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw invalid(
        sourcePath,
        `invalid JSON: ${(error as Error).message}`,
        lineNumber,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalid(sourcePath, "JSONL record must be an object", lineNumber);
    }
    const result = DecisionFrameSchema.safeParse(parsed);
    if (!result.success) {
      throw invalid(sourcePath, formatIssues(result.error), lineNumber);
    }
    const frame = result.data;
    const previousLine = firstLineByHoleId.get(frame.hole_id);
    if (previousLine !== undefined) {
      throw invalid(
        sourcePath,
        `duplicate hole_id ${frame.hole_id} (first seen at line ${previousLine})`,
        lineNumber,
      );
    }
    firstLineByHoleId.set(frame.hole_id, lineNumber);
    frames.push(frame);
  });
  return frames;
}
