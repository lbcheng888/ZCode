import { z } from "zod";

import { NonNegativeIntSchema, Sha256Schema, TaskNameSchema } from "./primitives.js";

/**
 * Typed projection of one row in `<run>/judge_inputs.tsv`.
 *
 * `declared_rows` is the spec's declared oracle row count. `rows` is the count
 * actually read by the judge. Both must agree, and the declared sha must match
 * the observed sha; otherwise the judge input is not trustworthy.
 */
export const JudgeInputRowSchema = z
  .object({
    task: TaskNameSchema,
    tier: z.enum(["eval", "property"]),
    path: z.string().min(1),
    sha256: Sha256Schema,
    declaredSha256: Sha256Schema,
    rows: NonNegativeIntSchema,
    declaredRows: NonNegativeIntSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    if (value.sha256 !== value.declaredSha256) {
      issue("sha256 must equal declared_sha256", ["sha256"]);
    }
    if (value.rows !== value.declaredRows) {
      issue("rows must equal declared_rows", ["rows"]);
    }
    if (value.rows === 0) {
      issue("rows must be greater than zero", ["rows"]);
    }
  });

export type JudgeInputRow = z.infer<typeof JudgeInputRowSchema>;

export const JudgeInputsReceiptSchema = z
  .object({
    kind: z.literal("judge_inputs"),
    schema: z.literal("cheng.contract.judge_inputs.v1"),
    sourcePath: z.string().min(1),
    sourceSha256: Sha256Schema,
    rows: z.array(JudgeInputRowSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    const tiersByTask = new Map<string, Set<string>>();
    value.rows.forEach((row, index) => {
      const tiers = tiersByTask.get(row.task) ?? new Set<string>();
      if (tiers.has(row.tier)) {
        issue(`duplicate ${row.tier} row for ${row.task}`, ["rows", index, "tier"]);
      }
      tiers.add(row.tier);
      tiersByTask.set(row.task, tiers);
    });
    for (const [task, tiers] of tiersByTask) {
      if (!tiers.has("eval")) {
        issue(`task ${task} is missing its eval row`, ["rows"]);
      }
      if (!tiers.has("property")) {
        issue(`task ${task} is missing its property row`, ["rows"]);
      }
    }
  });

export type JudgeInputsReceipt = z.infer<typeof JudgeInputsReceiptSchema>;
