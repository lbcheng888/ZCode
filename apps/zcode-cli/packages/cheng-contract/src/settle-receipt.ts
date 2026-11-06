import { z } from "zod";

import { NonNegativeIntSchema, Sha256Schema, TaskNameSchema } from "./primitives.js";

const FrameIndexSchema = z.number().int().min(-1);

/**
 * One `settle` event from `csg.decision_trace.v1`.
 *
 * `verdict=pass` is a conjunction: examples >= 1 and passed === examples.
 * `verdict=fail` requires passed < examples. A fn settle must name a real fn;
 * a program settle must use fn=-1 and the program scope.
 */
export const SettleEventSchema = z
  .object({
    kind: z.enum(["fn", "program"]),
    task: TaskNameSchema,
    taskId: NonNegativeIntSchema,
    settleIndex: NonNegativeIntSchema,
    frame: FrameIndexSchema,
    promiseFrame: FrameIndexSchema,
    fn: FrameIndexSchema,
    scope: z.enum(["fn_examples", "program_examples"]),
    examples: NonNegativeIntSchema,
    passed: NonNegativeIntSchema,
    verdict: z.enum(["pass", "fail"]),
    failedFn: FrameIndexSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    if (value.passed > value.examples) {
      issue("passed must be <= examples", ["passed"]);
    }
    if (value.verdict === "pass" && value.passed !== value.examples) {
      issue("verdict=pass requires passed=examples", ["verdict"]);
    }
    if (value.verdict === "pass" && value.examples === 0) {
      issue("verdict=pass requires examples >= 1", ["examples"]);
    }
    if (value.verdict === "fail" && value.passed === value.examples) {
      issue("verdict=fail requires passed < examples", ["verdict"]);
    }
    if (value.verdict === "pass" && value.failedFn !== -1) {
      issue("verdict=pass requires failed_fn=-1", ["failedFn"]);
    }
    if (value.kind === "fn") {
      if (value.fn < 0) {
        issue("kind=fn requires fn >= 0", ["fn"]);
      }
      if (value.scope !== "fn_examples") {
        issue("kind=fn requires scope=fn_examples", ["scope"]);
      }
    } else {
      if (value.fn !== -1) {
        issue("kind=program requires fn=-1", ["fn"]);
      }
      if (value.scope !== "program_examples") {
        issue("kind=program requires scope=program_examples", ["scope"]);
      }
    }
  });

export type SettleEvent = z.infer<typeof SettleEventSchema>;

/**
 * The terminal `trace_done` event, reduced to the fields a settle receipt needs.
 * The three booleans are mutually exclusive; final counts must agree with the
 * program settle when one exists.
 */
export const TraceDoneSchema = z
  .object({
    event: z.literal("trace_done"),
    schema: z.literal("csg.decision_trace.v1"),
    task: TaskNameSchema,
    taskId: NonNegativeIntSchema,
    solved: z.boolean(),
    invalidPath: z.boolean(),
    settleFailed: z.boolean(),
    steps: NonNegativeIntSchema,
    frames: NonNegativeIntSchema,
    invalidatedCount: NonNegativeIntSchema,
    reason: z.string().min(1),
    programAuthenticated: z.boolean(),
    finalPassed: NonNegativeIntSchema,
    finalExamples: NonNegativeIntSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    const trueCount = [value.solved, value.invalidPath, value.settleFailed].filter(
      (flag) => flag,
    ).length;
    if (trueCount !== 1) {
      issue("exactly one of solved/invalid_path/settle_failed must be true", [
        "solved",
      ]);
    }
    if (value.finalPassed > value.finalExamples) {
      issue("final_passed must be <= final_examples", ["finalPassed"]);
    }
    if (value.solved) {
      if (value.reason !== "solved") {
        issue("solved requires reason=solved", ["reason"]);
      }
      if (value.finalPassed !== value.finalExamples) {
        issue("solved requires final_passed=final_examples", ["finalPassed"]);
      }
      if (value.finalExamples === 0) {
        issue("solved requires final_examples >= 1", ["finalExamples"]);
      }
      if (value.invalidatedCount !== 0) {
        issue("solved requires invalidated_count=0", ["invalidatedCount"]);
      }
      if (!value.programAuthenticated) {
        issue("solved requires program_authenticated=true", [
          "programAuthenticated",
        ]);
      }
    }
    if (value.settleFailed) {
      if (value.reason !== "settle_failed") {
        issue("settle_failed requires reason=settle_failed", ["reason"]);
      }
      if (value.finalPassed >= value.finalExamples) {
        issue("settle_failed requires final_passed < final_examples", [
          "finalPassed",
        ]);
      }
      if (!value.programAuthenticated) {
        issue("settle_failed requires program_authenticated=true", [
          "programAuthenticated",
        ]);
      }
    }
    if (value.invalidPath) {
      if (value.invalidatedCount !== 0) {
        issue("invalid_path requires invalidated_count=0", ["invalidatedCount"]);
      }
      if (value.reason === "solved" || value.reason === "settle_failed") {
        issue("invalid_path requires a path-rejection reason", ["reason"]);
      }
    }
  });

export type TraceDone = z.infer<typeof TraceDoneSchema>;

/**
 * Typed aggregate of the settle phase of one replay trace.
 *
 * `settle_index` is strictly increasing; each `(kind, fn)` settles at most once.
 * A solved trace has only pass settles and a program settle whose counts match
 * `trace_done.final_*`. A settle_failed trace has at least one fail settle.
 */
export const SettleReceiptSchema = z
  .object({
    kind: z.literal("settle_receipt"),
    schema: z.literal("cheng.contract.settle_receipt.v1"),
    task: TaskNameSchema,
    taskId: NonNegativeIntSchema,
    tracePath: z.string().min(1),
    traceSha256: Sha256Schema,
    settles: z.array(SettleEventSchema).min(1),
    traceDone: TraceDoneSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };

    if (value.task !== value.traceDone.task) {
      issue("receipt task must equal trace_done.task", ["task"]);
    }
    if (value.taskId !== value.traceDone.taskId) {
      issue("receipt taskId must equal trace_done.task_id", ["taskId"]);
    }

    const seenKeys = new Set<string>();
    value.settles.forEach((settle, index) => {
      if (settle.task !== value.traceDone.task) {
        issue(`settle task ${settle.task} does not match trace_done.task`, [
          "settles",
          index,
          "task",
        ]);
      }
      if (settle.taskId !== value.traceDone.taskId) {
        issue(`settle task_id ${settle.taskId} does not match trace_done.task_id`, [
          "settles",
          index,
          "taskId",
        ]);
      }
      if (index > 0) {
        const previous = value.settles[index - 1];
        if (previous !== undefined && settle.settleIndex <= previous.settleIndex) {
          issue("settle_index must be strictly increasing", [
            "settles",
            index,
            "settleIndex",
          ]);
        }
      }
      const key = `${settle.kind}:${settle.fn}`;
      if (seenKeys.has(key)) {
        issue(`duplicate settle for ${key}`, ["settles", index]);
      }
      seenKeys.add(key);
    });

    const programSettles = value.settles.filter((settle) => settle.kind === "program");
    if (programSettles.length > 1) {
      issue("at most one program settle is allowed", ["settles"]);
    }
    const programSettle = programSettles[0];

    if (value.traceDone.invalidPath) {
      issue("invalid_path traces must not carry settle events", ["traceDone"]);
    }

    if (value.traceDone.solved) {
      if (!value.settles.every((settle) => settle.verdict === "pass")) {
        issue("solved requires every settle to pass", ["settles"]);
      }
      if (programSettle === undefined) {
        issue("solved requires a program settle", ["settles"]);
      }
    }

    if (value.traceDone.settleFailed) {
      if (!value.settles.some((settle) => settle.verdict === "fail")) {
        issue("settle_failed requires at least one fail settle", ["settles"]);
      }
    }

    if (programSettle !== undefined) {
      if (programSettle.passed !== value.traceDone.finalPassed) {
        issue("trace_done.final_passed must equal the program settle passed", [
          "traceDone",
          "finalPassed",
        ]);
      }
      if (programSettle.examples !== value.traceDone.finalExamples) {
        issue(
          "trace_done.final_examples must equal the program settle examples",
          ["traceDone", "finalExamples"],
        );
      }
    }
  });

export type SettleReceipt = z.infer<typeof SettleReceiptSchema>;
