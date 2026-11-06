import { z } from "zod";

import { ChengContractError } from "./errors.js";

export const ChengErrorClassSchema = z.enum([
  "input",
  "infra",
  "unsolved",
  "judge_fail",
  "structure_fail",
  "provenance_fail",
  "cancelled",
]);

export type ChengErrorClass = z.infer<typeof ChengErrorClassSchema>;

export interface RunnerExitEntry {
  /** Runner exit code (v2 contract table, never v1 modgen). */
  code: number;
  /** Human-readable meaning from the runner contract. */
  meaning: string;
  /** Typed failure class for consumers. */
  class: ChengErrorClass;
  /** True only when retrying without changing inputs can plausibly help. */
  retryable: boolean;
}

/**
 * CSG v2 runner exit-code table (`docs/contracts/csg_generation_v2.md` §7).
 * v1 modgen codes (12/13/34/35, …) are a separate table and are not merged.
 * `0` is PASS and therefore not an error entry.
 */
export const RUNNER_EXIT_TABLE: readonly RunnerExitEntry[] = [
  { code: 10, meaning: "precondition/input", class: "input", retryable: false },
  { code: 20, meaning: "M5 compile", class: "infra", retryable: false },
  { code: 21, meaning: "M5 spec/input", class: "input", retryable: false },
  { code: 22, meaning: "dual-run mismatch", class: "infra", retryable: false },
  { code: 23, meaning: "replay/trace", class: "structure_fail", retryable: false },
  { code: 30, meaning: "coverage", class: "unsolved", retryable: false },
  { code: 31, meaning: "gap/unsolved", class: "unsolved", retryable: false },
  { code: 32, meaning: "judge failed", class: "judge_fail", retryable: false },
  { code: 33, meaning: "judge infrastructure", class: "infra", retryable: true },
  { code: 40, meaning: "driver/provenance", class: "provenance_fail", retryable: false },
  { code: 41, meaning: "diagnostic complete (not production acceptance)", class: "provenance_fail", retryable: false },
  { code: 50, meaning: "program compile", class: "judge_fail", retryable: false },
  { code: 51, meaning: "program run", class: "judge_fail", retryable: false },
] as const;

const RUNNER_EXIT_BY_CODE = new Map(
  RUNNER_EXIT_TABLE.map((entry) => [entry.code, entry]),
);

export const ChengErrorSchema = z
  .object({
    kind: z.literal("cheng_error"),
    schema: z.literal("cheng.contract.cheng_error.v1"),
    code: z.number().int().positive(),
    class: ChengErrorClassSchema,
    retryable: z.boolean(),
    message: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ChengError = z.infer<typeof ChengErrorSchema>;

export function runnerExitMeaning(code: number): string | null {
  if (code === 0) {
    return "PASS";
  }
  return RUNNER_EXIT_BY_CODE.get(code)?.meaning ?? null;
}

/**
 * Map a CSG v2 runner exit code to a typed ChengError.
 *
 * `0` returns null (PASS). An unknown code throws
 * `CHENG_CONTRACT_UNKNOWN_EXIT_CODE`; empty evidence throws
 * `CHENG_CONTRACT_MISSING_EVIDENCE`. There is no fallback classification.
 */
export function classifyRunnerExit(
  code: number,
  evidence: readonly string[],
  options: { message?: string } = {},
): ChengError | null {
  if (!Number.isInteger(code) || code < 0) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_UNKNOWN_EXIT_CODE",
      sourcePath: "<runner>",
      line: null,
      detail: `runner exit code must be a non-negative integer, got ${JSON.stringify(code)}`,
    });
  }
  if (code === 0) {
    return null;
  }
  const entry = RUNNER_EXIT_BY_CODE.get(code);
  if (entry === undefined) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_UNKNOWN_EXIT_CODE",
      sourcePath: "<runner>",
      line: null,
      detail: `unknown CSG v2 runner exit code ${code}; v1 modgen codes are a separate table`,
    });
  }
  if (evidence.length === 0) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_MISSING_EVIDENCE",
      sourcePath: "<runner>",
      line: null,
      detail: `runner exit ${code} (${entry.meaning}) requires at least one evidence string`,
    });
  }
  const message = options.message ?? `runner exit ${code}: ${entry.meaning}`;
  const parsed = ChengErrorSchema.safeParse({
    kind: "cheng_error",
    schema: "cheng.contract.cheng_error.v1",
    code,
    class: entry.class,
    retryable: entry.retryable,
    message,
    evidence: [...evidence],
  });
  if (!parsed.success) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_SCHEMA_INVALID",
      sourcePath: "<runner>",
      line: null,
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
      cause: parsed.error,
    });
  }
  return parsed.data;
}
