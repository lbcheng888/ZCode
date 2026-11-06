import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { ChengContractError } from "../errors.js";
import {
  SettleReceiptSchema,
  type SettleEvent,
  type SettleReceipt,
  type TraceDone,
} from "../settle-receipt.js";

const TRACE_SCHEMA = "csg.decision_trace.v1";
const TRACE_EVENTS = new Set(["trace_begin", "decision", "settle", "trace_done"]);

interface RawTraceEvent {
  event: string;
  schema: string;
  task: string;
  task_id: number;
  [key: string]: unknown;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readTraceFile(tracePath: string): { text: string; sha256: string } {
  const path = resolve(tracePath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_MISSING_FILE",
        sourcePath: path,
        detail: "file not found",
        cause: error,
      });
    }
    throw new ChengContractError({
      code: "CHENG_CONTRACT_IO_ERROR",
      sourcePath: path,
      detail: `cannot read file: ${(error as Error).message}`,
      cause: error,
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath: path,
      detail: "file is not valid UTF-8",
      cause: error,
    });
  }
  return { text, sha256: sha256Hex(bytes) };
}

function parseEventObject(
  text: string,
  sourcePath: string,
  line: number,
): RawTraceEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line,
      detail: `invalid JSON: ${(error as Error).message}`,
      cause: error,
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line,
      detail: "trace event must be a JSON object",
    });
  }
  const event = value as Record<string, unknown>;
  const eventName = event.event;
  if (typeof eventName !== "string" || !TRACE_EVENTS.has(eventName)) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line,
      detail: `unknown trace event ${JSON.stringify(eventName)}`,
    });
  }
  if (event.schema !== TRACE_SCHEMA) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line,
      detail: `schema must be ${TRACE_SCHEMA}, got ${JSON.stringify(event.schema)}`,
    });
  }
  if (typeof event.task !== "string" || event.task.length === 0) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line,
      detail: "trace event is missing a non-empty task",
    });
  }
  if (
    typeof event.task_id !== "number" ||
    !Number.isInteger(event.task_id) ||
    event.task_id < 0
  ) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line,
      detail: "trace event is missing a non-negative integer task_id",
    });
  }
  return {
    ...event,
    event: eventName,
    schema: TRACE_SCHEMA,
    task: event.task,
    task_id: event.task_id,
  };
}

function parseWithSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  sourcePath: string,
  line: number | null,
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new ChengContractError({
    code: "CHENG_CONTRACT_SCHEMA_INVALID",
    sourcePath,
    line,
    detail,
    cause: result.error,
  });
}

function toSettleEvent(event: RawTraceEvent): SettleEvent {
  return {
    kind: event.kind as SettleEvent["kind"],
    task: event.task,
    taskId: event.task_id,
    settleIndex: event.settle_index as number,
    frame: event.frame as number,
    promiseFrame: event.promise_frame as number,
    fn: event.fn as number,
    scope: event.scope as SettleEvent["scope"],
    examples: event.examples as number,
    passed: event.passed as number,
    verdict: event.verdict as SettleEvent["verdict"],
    failedFn: event.failed_fn as number,
  };
}

function toTraceDone(event: RawTraceEvent): TraceDone {
  return {
    event: "trace_done",
    schema: "csg.decision_trace.v1",
    task: event.task,
    taskId: event.task_id,
    solved: event.solved as boolean,
    invalidPath: event.invalid_path as boolean,
    settleFailed: event.settle_failed as boolean,
    steps: event.steps as number,
    frames: event.frames as number,
    invalidatedCount: event.invalidated_count as number,
    reason: event.reason as string,
    programAuthenticated: event.program_authenticated as boolean,
    finalPassed: event.final_passed as number,
    finalExamples: event.final_examples as number,
  };
}

/**
 * Parse a `csg.decision_trace.v1` JSONL file into a SettleReceipt.
 *
 * Structural checks are fail-closed: BOM/empty/blank lines, unknown events,
 * mixed schemas, missing/duplicate trace_begin or trace_done, and traces with no
 * settle events are rejected. `invalid_path` traces carry no settles and
 * therefore have no settle receipt.
 */
export function parseSettleReceiptJsonl(
  text: string,
  sourcePath = "<memory>",
  sourceSha256 = sha256Hex(Buffer.from(text, "utf8")),
): SettleReceipt {
  if (text.startsWith("\uFEFF")) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line: 1,
      detail: "UTF-8 BOM is not allowed",
    });
  }
  const lines = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line: null,
      detail: "trace file is empty",
    });
  }

  const events: RawTraceEvent[] = [];
  lines.forEach((line, index) => {
    if (line.length === 0) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line: index + 1,
        detail: "blank line is not allowed",
      });
    }
    events.push(parseEventObject(line, sourcePath, index + 1));
  });

  const beginIndexes = events
    .map((event, index) => (event.event === "trace_begin" ? index : -1))
    .filter((index) => index >= 0);
  const doneIndexes = events
    .map((event, index) => (event.event === "trace_done" ? index : -1))
    .filter((index) => index >= 0);
  if (beginIndexes.length !== 1 || beginIndexes[0] !== 0) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line: null,
      detail: "trace must start with exactly one trace_begin",
    });
  }
  if (doneIndexes.length !== 1 || doneIndexes[0] !== events.length - 1) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line: null,
      detail: "trace must end with exactly one trace_done",
    });
  }

  const settleEvents = events.filter((event) => event.event === "settle");
  if (settleEvents.length === 0) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_SCHEMA_INVALID",
      sourcePath,
      line: null,
      detail: "trace has no settle events (invalid_path traces have no settle receipt)",
    });
  }

  const traceDone = parseWithSchema(
    z.object({
      event: z.literal("trace_done"),
      schema: z.literal(TRACE_SCHEMA),
      task: z.string().min(1),
      taskId: z.number().int().nonnegative(),
      solved: z.boolean(),
      invalidPath: z.boolean(),
      settleFailed: z.boolean(),
      steps: z.number().int().nonnegative(),
      frames: z.number().int().nonnegative(),
      invalidatedCount: z.number().int().nonnegative(),
      reason: z.string().min(1),
      programAuthenticated: z.boolean(),
      finalPassed: z.number().int().nonnegative(),
      finalExamples: z.number().int().nonnegative(),
    }).strict(),
    toTraceDone(events[events.length - 1] as RawTraceEvent),
    sourcePath,
    events.length,
  );

  const settles = settleEvents.map((event) =>
    parseWithSchema(
      z.object({
        kind: z.enum(["fn", "program"]),
        task: z.string().min(1),
        taskId: z.number().int().nonnegative(),
        settleIndex: z.number().int().nonnegative(),
        frame: z.number().int().min(-1),
        promiseFrame: z.number().int().min(-1),
        fn: z.number().int().min(-1),
        scope: z.enum(["fn_examples", "program_examples"]),
        examples: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        verdict: z.enum(["pass", "fail"]),
        failedFn: z.number().int().min(-1),
      }).strict(),
      toSettleEvent(event),
      sourcePath,
      null,
    ),
  );

  return parseWithSchema(
    SettleReceiptSchema,
    {
      kind: "settle_receipt",
      schema: "cheng.contract.settle_receipt.v1",
      task: traceDone.task,
      taskId: traceDone.taskId,
      tracePath: sourcePath,
      traceSha256: sourceSha256,
      settles,
      traceDone,
    },
    sourcePath,
    null,
  );
}

export function readSettleReceipt(tracePath: string): SettleReceipt {
  const file = readTraceFile(tracePath);
  return parseSettleReceiptJsonl(file.text, resolve(tracePath), file.sha256);
}
