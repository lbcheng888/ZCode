import { z } from "zod";

import {
  NonNegativeIntSchema,
  ProgJudgeSchema,
  ProgStatusSchema,
  Sha256OrDashSchema,
  TaskNameSchema,
} from "./primitives.js";

/**
 * Typed projection of one row in `<run>/prog_receipts.tsv`.
 *
 * The pipeline writes `pending/pending` before the independent judge runs and
 * backfills `semantic_pass/judged` only when the judge row passes. The schema
 * preserves that state machine instead of flattening it.
 */
export const ProgReceiptSchema = z
  .object({
    kind: z.literal("prog_receipt"),
    schema: z.literal("cheng.contract.prog_receipt.v1"),
    task: TaskNameSchema,
    progSha256: Sha256OrDashSchema,
    exeSha256: Sha256OrDashSchema,
    reportSha256: Sha256OrDashSchema,
    compileRc: NonNegativeIntSchema,
    runRc: NonNegativeIntSchema,
    judge: ProgJudgeSchema,
    status: ProgStatusSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };

    const judged = value.judge === "semantic_pass";
    if (judged !== (value.status === "judged")) {
      issue("judge=semantic_pass and status=judged must agree", ["status"]);
    }
    if (judged && (value.compileRc !== 0 || value.runRc !== 0)) {
      issue("judge=semantic_pass requires compile_rc=0 and run_rc=0", ["judge"]);
    }
    if (judged && value.progSha256 === "-") {
      issue("judge=semantic_pass requires a program sha256", ["progSha256"]);
    }
  });

export type ProgReceipt = z.infer<typeof ProgReceiptSchema>;
