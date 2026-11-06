import { z } from "zod";

import { JudgeInputsReceiptSchema, type JudgeInputRow, type JudgeInputsReceipt } from "./judge-inputs.js";
import { JudgeVerdictSchema, type JudgeVerdict } from "./judge-verdict.js";
import { ModuleLedgerSchema } from "./module-ledger.js";
import { ProgReceiptSchema, type ProgReceipt } from "./prog-receipt.js";
import { NonNegativeIntSchema, Sha256Schema } from "./primitives.js";

export const ArtifactRefSchema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema,
    bytes: NonNegativeIntSchema,
  })
  .strict();

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/**
 * Run-level acceptance, sourced from `run.env` + `report.txt`.
 *
 * `mode` is the pipeline mode (`diagnostic`/`production`), not the trace mode
 * (`replay`). `level` is the acceptance class: a diagnostic run may be green
 * (`semantic_pass`) but must never be consumed as production.
 */
export const RunAcceptanceSchema = z
  .object({
    mode: z.enum(["production", "diagnostic", "unknown"]),
    level: z.enum(["PRODUCTION", "DIAGNOSTIC_NOT_ACCEPTANCE", "UNKNOWN"]),
    productionAcceptance: z.boolean().nullable(),
    verdict: z.string().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    if (value.level === "PRODUCTION") {
      if (value.productionAcceptance !== true) {
        issue("PRODUCTION requires production_acceptance=true", ["productionAcceptance"]);
      }
      if (value.verdict !== "PASS") {
        issue("PRODUCTION requires verdict=PASS", ["verdict"]);
      }
      if (value.mode !== "production") {
        issue("PRODUCTION requires mode=production", ["mode"]);
      }
    }
    if (value.level === "DIAGNOSTIC_NOT_ACCEPTANCE") {
      if (value.productionAcceptance !== false) {
        issue(
          "DIAGNOSTIC_NOT_ACCEPTANCE requires production_acceptance=false",
          ["productionAcceptance"],
        );
      }
      if (value.verdict === null || !value.verdict.startsWith("DIAGNOSTIC")) {
        issue(
          "DIAGNOSTIC_NOT_ACCEPTANCE requires a DIAGNOSTIC verdict",
          ["verdict"],
        );
      }
      if (value.mode !== "diagnostic") {
        issue("DIAGNOSTIC_NOT_ACCEPTANCE requires mode=diagnostic", ["mode"]);
      }
    }
  });

export type RunAcceptance = z.infer<typeof RunAcceptanceSchema>;

export const RunChecksSchema = z
  .object({
    judgeRowsDeclared: z.boolean(),
    programShaPresent: z.boolean(),
    programShaMatchesProg: z.boolean(),
    acceptanceClassified: z.boolean(),
  })
  .strict();

export type RunChecks = z.infer<typeof RunChecksSchema>;

interface RunCheckInput {
  judge: JudgeVerdict[];
  progReceipts: ProgReceipt[];
  judgeInputs: JudgeInputsReceipt | null;
  acceptance: RunAcceptance;
}

/**
 * Compute the run-level checks from the artifacts themselves. The receipt
 * stores this value so consumers can see why a run is not production-ready.
 */
export function computeRunChecks(value: RunCheckInput): RunChecks {
  const judgeByTask = new Map<string, JudgeVerdict>();
  for (const verdict of value.judge) {
    judgeByTask.set(verdict.task, verdict);
  }
  const progByTask = new Map<string, ProgReceipt>();
  for (const receipt of value.progReceipts) {
    progByTask.set(receipt.task, receipt);
  }
  const inputsByTask = new Map<string, JudgeInputRow[]>();
  for (const row of value.judgeInputs?.rows ?? []) {
    const rows = inputsByTask.get(row.task) ?? [];
    rows.push(row);
    inputsByTask.set(row.task, rows);
  }

  let judgeRowsDeclared = value.judgeInputs !== null && value.judge.length > 0;
  if (value.judgeInputs !== null) {
    for (const verdict of value.judge) {
      const rows = inputsByTask.get(verdict.task);
      if (rows === undefined) {
        judgeRowsDeclared = false;
        continue;
      }
      const evalRow = rows.find((row) => row.tier === "eval");
      const propertyRow = rows.find((row) => row.tier === "property");
      if (evalRow === undefined || propertyRow === undefined) {
        judgeRowsDeclared = false;
        continue;
      }
      if (
        verdict.eval.total !== evalRow.declaredRows ||
        verdict.props.total !== propertyRow.declaredRows
      ) {
        judgeRowsDeclared = false;
      }
    }
    for (const task of inputsByTask.keys()) {
      if (!judgeByTask.has(task)) {
        judgeRowsDeclared = false;
      }
    }
  }

  const programShaPresent = value.judge.every(
    (verdict) => verdict.status !== "semantic_pass" || verdict.programSha256 !== "-",
  );

  let programShaMatchesProg = true;
  for (const verdict of value.judge) {
    const receipt = progByTask.get(verdict.task);
    if (receipt === undefined) {
      programShaMatchesProg = false;
      continue;
    }
    if (verdict.status === "semantic_pass") {
      if (
        receipt.judge !== "semantic_pass" ||
        receipt.progSha256 === "-" ||
        receipt.progSha256 !== verdict.programSha256
      ) {
        programShaMatchesProg = false;
      }
    } else if (
      verdict.programSha256 !== "-" &&
      receipt.progSha256 !== "-" &&
      verdict.programSha256 !== receipt.progSha256
    ) {
      programShaMatchesProg = false;
    }
  }

  return {
    judgeRowsDeclared,
    programShaPresent,
    programShaMatchesProg,
    acceptanceClassified: value.acceptance.level !== "UNKNOWN",
  };
}

/**
 * Aggregate receipt for one run volume. It is intentionally a read-only
 * projection: it does not decide acceptance, it proves that the artifacts agree
 * with each other and exposes the acceptance class.
 */
export const RunVolumeReceiptSchema = z
  .object({
    kind: z.literal("run_volume"),
    schema: z.literal("cheng.contract.run_volume.v1"),
    runId: z.string().min(1),
    runDir: z.string().min(1),
    judge: z.array(JudgeVerdictSchema).min(1),
    progReceipts: z.array(ProgReceiptSchema).min(1),
    judgeInputs: JudgeInputsReceiptSchema.nullable(),
    acceptance: RunAcceptanceSchema,
    checks: RunChecksSchema,
    moduleLedger: ModuleLedgerSchema.nullable(),
    artifacts: z
      .object({
        judgeTsv: ArtifactRefSchema,
        progReceiptsTsv: ArtifactRefSchema,
        judgeInputsTsv: ArtifactRefSchema.nullable(),
        reportTxt: ArtifactRefSchema.nullable(),
        runEnv: ArtifactRefSchema.nullable(),
        modulesTsv: ArtifactRefSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };

    const judgeByTask = new Map<string, (typeof value.judge)[number]>();
    value.judge.forEach((verdict, index) => {
      if (judgeByTask.has(verdict.task)) {
        issue(`duplicate judge task: ${verdict.task}`, ["judge", index, "task"]);
      }
      judgeByTask.set(verdict.task, verdict);
    });

    const progByTask = new Map<string, (typeof value.progReceipts)[number]>();
    value.progReceipts.forEach((receipt, index) => {
      if (progByTask.has(receipt.task)) {
        issue(`duplicate prog receipt task: ${receipt.task}`, [
          "progReceipts",
          index,
          "task",
        ]);
      }
      progByTask.set(receipt.task, receipt);
    });

    for (const task of judgeByTask.keys()) {
      if (!progByTask.has(task)) {
        issue(`prog_receipts.tsv is missing task: ${task}`, ["progReceipts"]);
      }
    }
    for (const task of progByTask.keys()) {
      if (!judgeByTask.has(task)) {
        issue(`judge.tsv is missing task: ${task}`, ["judge"]);
      }
    }

    for (const [task, verdict] of judgeByTask) {
      const receipt = progByTask.get(task);
      if (receipt === undefined) {
        continue;
      }
      if (
        verdict.programSha256 !== "-" &&
        receipt.progSha256 !== "-" &&
        verdict.programSha256 !== receipt.progSha256
      ) {
        issue(`program sha mismatch for ${task}`, ["progReceipts"]);
      }
      if (verdict.status === "semantic_pass") {
        if (receipt.judge !== "semantic_pass") {
          issue(
            `judge.tsv says semantic_pass but prog receipt says ${receipt.judge} for ${task}`,
            ["progReceipts"],
          );
        }
        if (receipt.status !== "judged") {
          issue(
            `judge.tsv says semantic_pass but prog receipt status is ${receipt.status} for ${task}`,
            ["progReceipts"],
          );
        }
      } else if (receipt.judge === "semantic_pass") {
        issue(
          `judge.tsv says semantic_fail but prog receipt says semantic_pass for ${task}`,
          ["progReceipts"],
        );
      }
    }

    const computed = computeRunChecks(value);
    for (const field of [
      "judgeRowsDeclared",
      "programShaPresent",
      "programShaMatchesProg",
      "acceptanceClassified",
    ] as const) {
      if (value.checks[field] !== computed[field]) {
        issue(`checks.${field} does not match the artifact-derived value`, [
          "checks",
          field,
        ]);
      }
    }

    if (value.judgeInputs !== null && !computed.judgeRowsDeclared) {
      issue(
        "judge rows do not match judge_inputs declared_rows",
        ["judge"],
      );
    }

    if (value.acceptance.level === "PRODUCTION") {
      if (
        !computed.judgeRowsDeclared ||
        !computed.programShaPresent ||
        !computed.programShaMatchesProg
      ) {
        issue("PRODUCTION requires all run checks to pass", [
          "acceptance",
          "level",
        ]);
      }
      if (value.judge.some((verdict) => verdict.status !== "semantic_pass")) {
        issue("PRODUCTION requires every judge row to be semantic_pass", [
          "judge",
        ]);
      }
    }
  });

export type RunVolumeReceipt = z.infer<typeof RunVolumeReceiptSchema>;
