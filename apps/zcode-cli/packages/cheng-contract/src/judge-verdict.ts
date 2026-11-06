import { z } from "zod";

import {
  NonNegativeIntSchema,
  SemanticStatusSchema,
  Sha256OrDashSchema,
  TaskNameSchema,
} from "./primitives.js";

const CountPairSchema = z
  .object({
    passed: NonNegativeIntSchema,
    total: NonNegativeIntSchema,
  })
  .strict();

/**
 * Typed projection of one row in `<run>/judge/judge.tsv`.
 *
 * `semantic_pass` is a conjunction, not a label: compile_rc=0, run_rc=0,
 * judge rc=0, non-empty eval/props, and every eval/prop row passing. A row
 * that claims `semantic_pass` without that conjunction is rejected.
 */
export const JudgeVerdictSchema = z
  .object({
    kind: z.literal("judge_verdict"),
    schema: z.literal("cheng.contract.judge_verdict.v1"),
    task: TaskNameSchema,
    eval: CountPairSchema,
    props: CountPairSchema,
    settleDiag: CountPairSchema,
    status: SemanticStatusSchema,
    rc: NonNegativeIntSchema,
    programSha256: Sha256OrDashSchema,
    note: z.string(),
    compileRc: NonNegativeIntSchema,
    runRc: NonNegativeIntSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };

    for (const [name, pair] of [
      ["eval", value.eval],
      ["props", value.props],
      ["settleDiag", value.settleDiag],
    ] as const) {
      if (pair.passed > pair.total) {
        issue(`${name}.passed must be <= ${name}.total`, [name, "passed"]);
      }
    }

    const semanticPass =
      value.compileRc === 0 &&
      value.runRc === 0 &&
      value.rc === 0 &&
      value.eval.total > 0 &&
      value.eval.passed === value.eval.total &&
      value.props.total > 0 &&
      value.props.passed === value.props.total;

    if (value.status === "semantic_pass" && value.programSha256 === "-") {
      issue("semantic_pass requires a program sha256", ["programSha256"]);
    }
    if (value.status === "semantic_pass" && !semanticPass) {
      issue(
        "semantic_pass requires compile_rc=0, run_rc=0, rc=0, non-empty eval/props, and all eval/props passing",
        ["status"],
      );
    }
    if (value.status === "semantic_fail" && semanticPass) {
      issue("semantic_fail contradicts a fully passing verdict", ["status"]);
    }
  });

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;
