import { z } from "zod";

import { ChengContractError } from "./errors.js";
import { NonNegativeIntSchema } from "./primitives.js";

/**
 * Stage order of the pipeline: the planner walks these in order and stops at the
 * first red point. The enum is closed; an unknown stage fails closed.
 */
export const ChengPlanStageSchema = z.enum([
  "spec",
  "structure",
  "settle",
  "judge",
  "compile",
  "provenance",
]);

export type ChengPlanStage = z.infer<typeof ChengPlanStageSchema>;

/** Fixed candidate-action enum from the deterministic planner contract. */
export const ChengPlanActionSchema = z.enum([
  "fix_spec",
  "fix_oracle",
  "regenerate_module",
  "change_template_plan",
  "split_module",
  "raise_budget",
  "fix_codegen",
  "stop",
]);

export type ChengPlanAction = z.infer<typeof ChengPlanActionSchema>;

export const ChengPlanRiskSchema = z.enum(["low", "medium", "high"]);

export type ChengPlanRisk = z.infer<typeof ChengPlanRiskSchema>;

/** Measured p50 cost in wall time and expansions. Zero is legal, negative is not. */
export const ChengPlanCostSchema = z
  .object({
    wallMs: NonNegativeIntSchema,
    expansions: NonNegativeIntSchema,
  })
  .strict();

export type ChengPlanCost = z.infer<typeof ChengPlanCostSchema>;

/** Evidence refs are opaque non-empty strings; an empty list is not evidence. */
export const ChengPlanEvidenceSchema = z.array(z.string().min(1)).min(1);

export type ChengPlanEvidence = z.infer<typeof ChengPlanEvidenceSchema>;

export const ChengPlanFrontierSchema = z
  .object({
    stage: ChengPlanStageSchema,
    target: z.string().min(1),
    evidence: ChengPlanEvidenceSchema,
  })
  .strict();

export type ChengPlanFrontier = z.infer<typeof ChengPlanFrontierSchema>;

export const ChengPlanCandidateSchema = z
  .object({
    action: ChengPlanActionSchema,
    target: z.string().min(1),
    cost: ChengPlanCostSchema,
    risk: ChengPlanRiskSchema,
    expectedGain: z.number().min(0).max(1),
    evidence: ChengPlanEvidenceSchema,
  })
  .strict();

export type ChengPlanCandidate = z.infer<typeof ChengPlanCandidateSchema>;

/**
 * The recommended candidate is named by the same `(action, target)` identity
 * every candidate carries. There are no candidate ids in the contract, so a
 * pair is the smallest unambiguous reference; that exact pair must appear in
 * `candidates`, and duplicate pairs are rejected to keep the reference unique.
 */
export const ChengPlanRecommendedSchema = z
  .object({
    action: ChengPlanActionSchema,
    target: z.string().min(1),
  })
  .strict();

export type ChengPlanRecommended = z.infer<typeof ChengPlanRecommendedSchema>;

export const ChengPlanSchema = z
  .object({
    kind: z.literal("cheng_plan"),
    schema: z.literal("cheng.contract.cheng_plan.v1"),
    frontier: ChengPlanFrontierSchema,
    candidates: z.array(ChengPlanCandidateSchema).min(1),
    recommended: ChengPlanRecommendedSchema,
    blockedBy: z.array(z.string().min(1)),
    budget: ChengPlanCostSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.candidates.forEach((candidate, index) => {
      const key = JSON.stringify([candidate.action, candidate.target]);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate candidate ${candidate.action}@${candidate.target}`,
          path: ["candidates", index],
        });
      } else {
        seen.add(key);
      }
    });

    const inCandidates = value.candidates.some(
      (candidate) =>
        candidate.action === value.recommended.action &&
        candidate.target === value.recommended.target,
    );
    if (!inCandidates) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `recommended ${value.recommended.action}@${value.recommended.target} is not in candidates`,
        path: ["recommended"],
      });
    }
  });

export type ChengPlan = z.infer<typeof ChengPlanSchema>;

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "<root>";
  }
  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      rendered = `${rendered}[${segment}]`;
    } else if (typeof segment === "string") {
      rendered = rendered === "" ? segment : `${rendered}.${segment}`;
    } else {
      rendered = `${rendered}[${String(segment)}]`;
    }
  }
  return rendered;
}

/**
 * Parse a `cheng.contract.cheng_plan.v1` JSON document.
 *
 * Structural failures fail closed with `CHENG_CONTRACT_SCHEMA_INVALID`: malformed
 * JSON, missing/extra fields, unknown enum values, negative cost, out-of-range
 * expectedGain, empty evidence, and a `recommended` pair that is not among the
 * candidates. This module is schema-only; it does not plan, execute, or rank.
 */
export function parseChengPlanJson(
  text: string,
  sourcePath = "<memory>",
): ChengPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_SCHEMA_INVALID",
      sourcePath,
      line: null,
      detail: `invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      cause: error,
    });
  }

  const result = ChengPlanSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
      .join("; ");
    throw new ChengContractError({
      code: "CHENG_CONTRACT_SCHEMA_INVALID",
      sourcePath,
      line: null,
      detail: details,
      cause: result.error,
    });
  }
  return result.data;
}
