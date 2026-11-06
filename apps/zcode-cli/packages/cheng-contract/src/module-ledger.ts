import { z } from "zod";

import {
  ModuleRoleSchema,
  ModuleVerdictSchema,
  NonNegativeIntSchema,
  Sha256Schema,
  TaskNameSchema,
} from "./primitives.js";

/**
 * Typed projection of one row in `evidence/modules.tsv`.
 *
 * `role` is the plan role (entry/helper); `fn` is the emitted-program function
 * index; `name` is the function name. Count invariants are enforced here; the
 * acceptance gate (all modules pass, entry program settle passes) is a separate
 * consumer-level decision.
 */
export const ModuleRowSchema = z
  .object({
    level: NonNegativeIntSchema,
    fn: NonNegativeIntSchema,
    name: TaskNameSchema,
    role: ModuleRoleSchema,
    decisions: NonNegativeIntSchema,
    settles: NonNegativeIntSchema,
    callEdges: NonNegativeIntSchema,
    parentRoots: NonNegativeIntSchema,
    parentInFn: NonNegativeIntSchema,
    fnExamples: NonNegativeIntSchema,
    fnPassed: NonNegativeIntSchema,
    fnVerdict: ModuleVerdictSchema,
    programExamples: NonNegativeIntSchema,
    programPassed: NonNegativeIntSchema,
    programVerdict: ModuleVerdictSchema,
    segmentSha256: Sha256Schema,
    projectionSha256: Sha256Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };

    if (value.fnPassed > value.fnExamples) {
      issue("fn_passed must be <= fn_examples", ["fnPassed"]);
    }
    if (value.programPassed > value.programExamples) {
      issue("program_passed must be <= program_examples", ["programPassed"]);
    }
    if (value.fnVerdict === "pass" && value.fnPassed !== value.fnExamples) {
      issue("fn_verdict=pass requires fn_passed=fn_examples", ["fnVerdict"]);
    }
    if (value.programVerdict === "pass" && value.programPassed !== value.programExamples) {
      issue("program_verdict=pass requires program_passed=program_examples", ["programVerdict"]);
    }
    if (
      value.programVerdict === "-" &&
      (value.programExamples !== 0 || value.programPassed !== 0)
    ) {
      issue("program_verdict='-' requires program_examples=0 and program_passed=0", [
        "programVerdict",
      ]);
    }
  });

export type ModuleRow = z.infer<typeof ModuleRowSchema>;

export const ModuleLedgerSchema = z
  .object({
    kind: z.literal("module_ledger"),
    schema: z.literal("cheng.contract.module_ledger.v1"),
    sourcePath: z.string().min(1),
    sourceSha256: Sha256Schema,
    modules: z.array(ModuleRowSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    const names = new Set<string>();
    const fns = new Set<number>();
    value.modules.forEach((module, index) => {
      if (names.has(module.name)) {
        issue(`duplicate module name: ${module.name}`, ["modules", index, "name"]);
      }
      names.add(module.name);
      if (fns.has(module.fn)) {
        issue(`duplicate module fn: ${module.fn}`, ["modules", index, "fn"]);
      }
      fns.add(module.fn);
    });
  });

export type ModuleLedger = z.infer<typeof ModuleLedgerSchema>;
