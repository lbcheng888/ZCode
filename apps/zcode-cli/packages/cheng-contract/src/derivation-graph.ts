import { createHash } from "node:crypto";

import { z } from "zod";

import { ChengContractError } from "./errors.js";
import {
  NonNegativeIntSchema,
  Sha256Schema,
  TaskNameSchema,
} from "./primitives.js";

const TRACE_SCHEMA = "csg.decision_trace.v1";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function invalidTsv(
  sourcePath: string,
  line: number | null,
  detail: string,
): ChengContractError {
  return new ChengContractError({
    code: "CHENG_CONTRACT_INVALID_TSV",
    sourcePath,
    line,
    detail,
  });
}

function schemaInvalid(
  sourcePath: string,
  line: number | null,
  detail: string,
): ChengContractError {
  return new ChengContractError({
    code: "CHENG_CONTRACT_SCHEMA_INVALID",
    sourcePath,
    line,
    detail,
  });
}

function failSchema(sourcePath: string, detail: string): never {
  throw schemaInvalid(sourcePath, null, detail);
}

export const DerivationNodeKindSchema = z.enum([
  "trace",
  "frame",
  "hole",
  "fn",
  "settle",
]);

export type DerivationNodeKind = z.infer<typeof DerivationNodeKindSchema>;

export const DerivationEdgeKindSchema = z.enum([
  "roots",
  "creates",
  "fills",
  "member",
  "calls",
  "settles",
  "invalidates",
]);

export type DerivationEdgeKind = z.infer<typeof DerivationEdgeKindSchema>;

/**
 * One `decision.call_edges` tuple. `frame` is the decision step that
 * materialized the call; `caller`/`callee` are fn indices.
 */
export const DerivationCallEdgeSchema = z
  .object({
    caller: NonNegativeIntSchema,
    callee: NonNegativeIntSchema,
    frame: NonNegativeIntSchema,
  })
  .strict();

export type DerivationCallEdge = z.infer<typeof DerivationCallEdgeSchema>;

const nodeRequiredFields: Record<DerivationNodeKind, readonly string[]> = {
  trace: [],
  frame: ["step", "fn", "hole", "parent", "callEdges", "invalidated"],
  hole: ["hole", "parent"],
  fn: ["fn"],
  settle: ["fn"],
};

const nodeForbiddenFields: Record<DerivationNodeKind, readonly string[]> = {
  trace: ["step", "fn", "hole", "parent", "callEdges", "invalidated"],
  frame: [],
  hole: ["step", "fn", "callEdges", "invalidated"],
  fn: ["step", "hole", "parent", "callEdges", "invalidated"],
  settle: ["hole", "parent", "callEdges", "invalidated"],
};

/**
 * Per-kind node shape.
 *
 * - `trace`: the single graph root; id is `trace`.
 * - `frame`: one decision step; id is `frame:<step>`; carries the call tuples
 *   materialized by that decision and the `invalidated` projection flag.
 * - `hole`: a roots/setup or created hole; id is the raw trace hole id;
 *   `parent` is the creator step (`-1` for roots). The creator is never
 *   inferred from step-1/depth/slot.
 * - `fn`: a function index advertised by `trace_begin.fn_count`; id is
 *   `fn:<index>`.
 * - `settle`: one settle event; id is `settle:<settle_index>`; `fn=-1` is the
 *   program settle, `step` is `settle.frame` when known.
 */
export const DerivationNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: DerivationNodeKindSchema,
    step: NonNegativeIntSchema.optional(),
    fn: z.number().int().min(-1).optional(),
    hole: z.string().min(1).optional(),
    parent: z.number().int().min(-1).optional(),
    callEdges: z.array(DerivationCallEdgeSchema).optional(),
    invalidated: z.boolean().optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    for (const key of nodeRequiredFields[node.kind]) {
      if (node[key as keyof typeof node] === undefined) {
        issue(`${node.kind} node requires ${key}`, [key]);
      }
    }
    for (const key of nodeForbiddenFields[node.kind]) {
      if (node[key as keyof typeof node] !== undefined) {
        issue(`${node.kind} node must not carry ${key}`, [key]);
      }
    }
    if (node.kind === "trace" && node.id !== "trace") {
      issue("trace node id must be trace", ["id"]);
    }
    if (
      node.kind === "frame" &&
      node.step !== undefined &&
      node.id !== `frame:${node.step}`
    ) {
      issue("frame node id must be frame:<step>", ["id"]);
    }
    if (
      (node.kind === "frame" || node.kind === "fn") &&
      node.fn !== undefined &&
      node.fn < 0
    ) {
      issue(`${node.kind} node requires a non-negative fn`, ["fn"]);
    }
    if (node.kind === "fn" && node.fn !== undefined && node.id !== `fn:${node.fn}`) {
      issue("fn node id must be fn:<index>", ["id"]);
    }
    if (node.kind === "hole" && node.hole !== undefined && node.hole !== node.id) {
      issue("hole node hole must equal its id", ["hole"]);
    }
    if (node.kind === "settle" && !/^settle:\d+$/u.test(node.id)) {
      issue("settle node id must be settle:<settle_index>", ["id"]);
    }
  });

export type DerivationNode = z.infer<typeof DerivationNodeSchema>;

export const DerivationEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: DerivationEdgeKindSchema,
  })
  .strict();

export type DerivationEdge = z.infer<typeof DerivationEdgeSchema>;

function pushEdge(
  map: Map<string, DerivationEdge[]>,
  key: string,
  edge: DerivationEdge,
): void {
  const current = map.get(key);
  if (current === undefined) {
    map.set(key, [edge]);
  } else {
    current.push(edge);
  }
}

/**
 * Graph of one `csg.decision_trace.v1` replay trace.
 *
 * The trace contract is the only source of truth. The graph does not invent
 * level/cid/program_cid/model_version fields because the trace does not carry
 * them; absent evidence stays absent.
 *
 * Edge directions:
 * - `roots`: trace -> root hole.
 * - `creates`: creating frame -> created hole.
 * - `fills`: filling frame -> filled hole.
 * - `member`: frame -> owning fn.
 * - `calls`: call-site frame -> callee fn (one edge per
 *   `{caller,callee,frame}` tuple; the caller is the frame's fn).
 * - `settles`: settle node -> its `frame`.
 * - `invalidates`: failed-anchor frame -> invalidated frame. This is only the
 *   `invalidated_by` projection; it never supplies dependency edges or a
 *   recomputed invalidation closure.
 */
export const DerivationGraphSchema = z
  .object({
    kind: z.literal("derivation_graph"),
    schema: z.literal("cheng.contract.derivation_graph.v1"),
    task: TaskNameSchema,
    taskId: NonNegativeIntSchema,
    tracePath: z.string().min(1),
    traceSha256: Sha256Schema,
    roots: z.array(z.string().min(1)),
    nodes: z.array(DerivationNodeSchema).min(1),
    edges: z.array(DerivationEdgeSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    const nodeById = new Map<string, DerivationNode>();
    value.nodes.forEach((node, index) => {
      if (nodeById.has(node.id)) {
        issue(`duplicate node id: ${node.id}`, ["nodes", index, "id"]);
      }
      nodeById.set(node.id, node);
    });
    if (value.nodes.filter((node) => node.kind === "trace").length !== 1) {
      issue("graph requires exactly one trace node", ["nodes"]);
    }

    const roots = new Set<string>();
    value.roots.forEach((root, index) => {
      if (roots.has(root)) {
        issue(`duplicate root: ${root}`, ["roots", index]);
      }
      roots.add(root);
    });

    const outgoing = new Map<string, DerivationEdge[]>();
    const incoming = new Map<string, DerivationEdge[]>();
    const edgeKeys = new Set<string>();
    value.edges.forEach((edge, index) => {
      const key = `${edge.kind}|${edge.from}|${edge.to}`;
      if (edgeKeys.has(key)) {
        issue(`duplicate edge: ${key}`, ["edges", index]);
      }
      edgeKeys.add(key);
      if (!nodeById.has(edge.from)) {
        issue(`edge from node not found: ${edge.from}`, ["edges", index, "from"]);
      }
      if (!nodeById.has(edge.to)) {
        issue(`edge to node not found: ${edge.to}`, ["edges", index, "to"]);
      }
      pushEdge(outgoing, edge.from, edge);
      pushEdge(incoming, edge.to, edge);
    });

    const frames = value.nodes.filter((node) => node.kind === "frame");
    const holes = value.nodes.filter((node) => node.kind === "hole");
    const settles = value.nodes.filter((node) => node.kind === "settle");
    const rootEdges = outgoing.get("trace")?.filter((edge) => edge.kind === "roots") ?? [];

    for (const hole of holes) {
      if (hole.parent === -1 && !roots.has(hole.id)) {
        issue(`root hole ${hole.id} is missing from roots`, ["nodes"]);
      }
      if (hole.parent !== -1 && roots.has(hole.id)) {
        issue(`roots entry ${hole.id} must be a root hole`, ["roots"]);
      }
    }
    for (const root of roots) {
      const hole = nodeById.get(root);
      if (hole?.kind !== "hole" || hole.parent !== -1) {
        issue(`root ${root} must be a root hole node`, ["roots"]);
      }
      if (!rootEdges.some((edge) => edge.to === root)) {
        issue(`root ${root} has no roots edge`, ["edges"]);
      }
    }
    for (const edge of rootEdges) {
      if (!roots.has(edge.to)) {
        issue(`roots edge target ${edge.to} is not declared in roots`, ["edges"]);
      }
    }

    for (const frame of frames) {
      const out = outgoing.get(frame.id) ?? [];
      const [member, ...extraMembers] = out.filter((edge) => edge.kind === "member");
      if (member === undefined || extraMembers.length > 0) {
        issue(`frame ${frame.id} requires exactly one member edge`, ["edges"]);
      } else {
        const target = nodeById.get(member.to);
        if (target?.kind !== "fn" || target.fn !== frame.fn) {
          issue(`frame ${frame.id} member edge must target fn:${frame.fn}`, ["edges"]);
        }
      }
      const [fill, ...extraFills] = out.filter((edge) => edge.kind === "fills");
      if (fill === undefined || extraFills.length > 0) {
        issue(`frame ${frame.id} requires exactly one fills edge`, ["edges"]);
      } else {
        const hole = nodeById.get(fill.to);
        if (
          hole?.kind !== "hole" ||
          hole.id !== frame.hole ||
          hole.parent !== frame.parent
        ) {
          issue(`frame ${frame.id} fills edge must target its hole and creator`, [
            "edges",
          ]);
        }
      }

      const tuples = frame.callEdges ?? [];
      for (const tuple of tuples) {
        if (tuple.frame !== frame.step || tuple.caller !== frame.fn) {
          issue(`frame ${frame.id} call_edges must match its step and fn`, [
            "nodes",
            frame.id,
            "callEdges",
          ]);
        }
        if (
          !out.some(
            (edge) => edge.kind === "calls" && edge.to === `fn:${tuple.callee}`,
          )
        ) {
          issue(`frame ${frame.id} call tuple has no calls edge`, ["edges"]);
        }
      }
      for (const edge of out.filter((candidate) => candidate.kind === "calls")) {
        const callee = nodeById.get(edge.to);
        if (
          callee?.kind !== "fn" ||
          !tuples.some(
            (tuple) =>
              tuple.caller === frame.fn &&
              tuple.callee === callee.fn &&
              tuple.frame === frame.step,
          )
        ) {
          issue(`calls edge ${frame.id}->${edge.to} has no call_edges tuple`, [
            "edges",
          ]);
        }
      }
    }

    for (const hole of holes) {
      const creates =
        incoming.get(hole.id)?.filter((edge) => edge.kind === "creates") ?? [];
      if (hole.parent === -1) {
        if (creates.length > 0) {
          issue(`root hole ${hole.id} must not have a creates edge`, ["edges"]);
        }
      } else {
        const create = creates[0];
        if (create === undefined || creates.length > 1) {
          issue(`hole ${hole.id} requires exactly one creates edge`, ["edges"]);
        } else {
          const creator = nodeById.get(create.from);
          if (creator?.kind !== "frame" || creator.step !== hole.parent) {
            issue(`hole ${hole.id} creates edge must start at frame:${hole.parent}`, [
              "edges",
            ]);
          }
        }
      }
      if (
        (incoming.get(hole.id) ?? []).filter((edge) => edge.kind === "fills").length >
        1
      ) {
        issue(`hole ${hole.id} is filled more than once`, ["edges"]);
      }
    }

    for (const settle of settles) {
      const out = outgoing.get(settle.id)?.filter((edge) => edge.kind === "settles") ?? [];
      if (settle.step === undefined) {
        if (out.length > 0) {
          issue(`settle ${settle.id} with frame=-1 must not have a settles edge`, [
            "edges",
          ]);
        }
        continue;
      }
      const edge = out[0];
      if (edge === undefined || out.length > 1) {
        issue(`settle ${settle.id} requires exactly one settles edge`, ["edges"]);
        continue;
      }
      const frame = nodeById.get(edge.to);
      if (frame?.kind !== "frame" || frame.step !== settle.step) {
        issue(`settle ${settle.id} settles edge must target frame:${settle.step}`, [
          "edges",
        ]);
      }
    }

    const invalidateEdges = value.edges.filter((edge) => edge.kind === "invalidates");
    for (const edge of invalidateEdges) {
      const target = nodeById.get(edge.to);
      const anchor = nodeById.get(edge.from);
      if (target?.kind !== "frame" || target.invalidated !== true) {
        issue(`invalidates edge target ${edge.to} is not an invalidated frame`, [
          "edges",
        ]);
      }
      if (anchor?.kind !== "frame") {
        issue(`invalidates edge anchor ${edge.from} is not a frame`, ["edges"]);
      }
    }
    for (const frame of frames) {
      const count =
        incoming.get(frame.id)?.filter((edge) => edge.kind === "invalidates").length ??
        0;
      if (frame.invalidated === true && count === 0) {
        issue(`invalidated frame ${frame.id} has no invalidates edge`, ["edges"]);
      }
      if (frame.invalidated === false && count > 0) {
        issue(`frame ${frame.id} is not invalidated but has invalidates edges`, [
          "edges",
        ]);
      }
    }
  });

export type DerivationGraph = z.infer<typeof DerivationGraphSchema>;

const TraceCommonFields = {
  schema: z.literal(TRACE_SCHEMA),
  task: TaskNameSchema,
  task_id: NonNegativeIntSchema,
};

const TraceBeginEventSchema = z
  .object({
    event: z.literal("trace_begin"),
    ...TraceCommonFields,
    roots: z.array(z.string().min(1)),
    fn_count: NonNegativeIntSchema,
  })
  .passthrough();

const DecisionEventSchema = z
  .object({
    event: z.literal("decision"),
    ...TraceCommonFields,
    step: NonNegativeIntSchema,
    hole: z.string().min(1),
    parent: z.number().int().min(-1),
    fn: NonNegativeIntSchema,
    created: z.array(z.string().min(1)),
    call_edges: z.array(DerivationCallEdgeSchema),
    invalidated: z.boolean(),
    invalidated_by: z.array(NonNegativeIntSchema),
  })
  .passthrough();

const SettleEventSchema = z
  .object({
    event: z.literal("settle"),
    ...TraceCommonFields,
    settle_index: NonNegativeIntSchema,
    frame: z.number().int().min(-1),
    promise_frame: z.number().int().min(-1),
    fn: z.number().int().min(-1),
    kind: z.enum(["fn", "program"]),
    verdict: z.enum(["pass", "fail"]),
  })
  .passthrough();

const TraceDoneEventSchema = z
  .object({
    event: z.literal("trace_done"),
    ...TraceCommonFields,
  })
  .passthrough();

const RawTraceEventSchema = z.discriminatedUnion("event", [
  TraceBeginEventSchema,
  DecisionEventSchema,
  SettleEventSchema,
  TraceDoneEventSchema,
]);

type RawTraceEvent = z.infer<typeof RawTraceEventSchema>;

interface ParsedDecision {
  step: number;
  hole: string;
  parent: number;
  fn: number;
  created: string[];
  callEdges: DerivationCallEdge[];
  invalidated: boolean;
  invalidatedBy: number[];
}

interface ParsedSettle {
  settleIndex: number;
  frame: number;
  promiseFrame: number;
  fn: number;
  kind: "fn" | "program";
  verdict: "pass" | "fail";
}

interface TraceHeader {
  task: string;
  taskId: number;
  roots: string[];
  fnCount: number;
}

/**
 * Parse a `csg.decision_trace.v1` JSONL trace into a DerivationGraph.
 *
 * The graph is a projection of the trace contract, never a re-derivation of
 * facts the trace does not carry. Structural violations fail closed:
 * malformed JSONL, unknown events, missing/duplicate trace_begin or trace_done,
 * non-contiguous steps, unknown or future holes, parent != creator, duplicate
 * or root-overlapping created ids, holes filled twice, call_edges with unknown
 * fn/frame or a caller that is not the frame's fn, settle frames that are not
 * decisions, and invalidated_by anchors that are not failed settle anchors.
 */
export function parseDerivationGraphJsonl(
  text: string,
  sourcePath = "<memory>",
  sourceSha256 = sha256Hex(Buffer.from(text, "utf8")),
): DerivationGraph {
  if (text.startsWith("\uFEFF")) {
    throw invalidTsv(sourcePath, 1, "UTF-8 BOM is not allowed");
  }
  const lines = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    throw invalidTsv(sourcePath, null, "trace file is empty");
  }

  const events: RawTraceEvent[] = lines.map((line, index) => {
    if (line.length === 0) {
      throw invalidTsv(sourcePath, index + 1, "blank line is not allowed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw invalidTsv(
        sourcePath,
        index + 1,
        `invalid JSON: ${(error as Error).message}`,
      );
    }
    const result = RawTraceEventSchema.safeParse(parsed);
    if (!result.success) {
      throw invalidTsv(
        sourcePath,
        index + 1,
        result.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; "),
      );
    }
    return result.data;
  });

  const beginIndexes = events
    .map((event, index) => (event.event === "trace_begin" ? index : -1))
    .filter((index) => index >= 0);
  const doneIndexes = events
    .map((event, index) => (event.event === "trace_done" ? index : -1))
    .filter((index) => index >= 0);
  if (beginIndexes.length !== 1 || beginIndexes[0] !== 0) {
    throw invalidTsv(sourcePath, null, "trace must start with exactly one trace_begin");
  }
  if (doneIndexes.length !== 1 || doneIndexes[0] !== events.length - 1) {
    throw invalidTsv(sourcePath, null, "trace must end with exactly one trace_done");
  }

  const begin = events[0];
  if (begin === undefined || begin.event !== "trace_begin") {
    throw invalidTsv(sourcePath, null, "trace file is empty");
  }
  const header: TraceHeader = {
    task: begin.task,
    taskId: begin.task_id,
    roots: begin.roots,
    fnCount: begin.fn_count,
  };
  for (const event of events) {
    if (event.task !== header.task || event.task_id !== header.taskId) {
      throw invalidTsv(
        sourcePath,
        null,
        `task/task_id must match trace_begin ${header.task}/${header.taskId}`,
      );
    }
  }

  const roots = new Set<string>();
  for (const root of header.roots) {
    if (roots.has(root)) {
      throw invalidTsv(sourcePath, 1, `duplicate root: ${root}`);
    }
    roots.add(root);
  }

  const creator = new Map<string, number>();
  for (const root of header.roots) {
    creator.set(root, -1);
  }
  const createdIds = new Set<string>();
  const filledHoles = new Set<string>();
  const decisions: ParsedDecision[] = [];
  const settles: ParsedSettle[] = [];
  let expectedStep = 0;
  let previousSettleIndex: number | null = null;
  const settleKeys = new Set<string>();

  for (const [index, event] of events.slice(1, -1).entries()) {
    const line = index + 2;
    if (event.event === "decision") {
      if (event.step !== expectedStep) {
        throw invalidTsv(
          sourcePath,
          line,
          `decision step must be continuous from 0: expected ${expectedStep}, got ${event.step}`,
        );
      }
      if (event.fn >= header.fnCount) {
        throw schemaInvalid(
          sourcePath,
          line,
          `decision fn ${event.fn} is outside fn_count=${header.fnCount}`,
        );
      }
      const creatorStep = creator.get(event.hole);
      if (creatorStep === undefined) {
        throw schemaInvalid(
          sourcePath,
          line,
          `decision hole ${event.hole} is neither a root nor an earlier created hole`,
        );
      }
      if (creatorStep >= event.step) {
        throw schemaInvalid(
          sourcePath,
          line,
          `decision hole ${event.hole} creator ${creatorStep} is not earlier than step ${event.step}`,
        );
      }
      if (event.parent !== creatorStep) {
        throw schemaInvalid(
          sourcePath,
          line,
          `decision hole ${event.hole} parent ${event.parent} must equal creator ${creatorStep}`,
        );
      }
      if (filledHoles.has(event.hole)) {
        throw schemaInvalid(
          sourcePath,
          line,
          `decision hole ${event.hole} is filled more than once`,
        );
      }
      filledHoles.add(event.hole);

      for (const createdId of event.created) {
        if (roots.has(createdId)) {
          throw schemaInvalid(
            sourcePath,
            line,
            `decision created ${createdId} collides with roots`,
          );
        }
        if (createdIds.has(createdId)) {
          throw schemaInvalid(
            sourcePath,
            line,
            `decision created ${createdId} is created more than once`,
          );
        }
        createdIds.add(createdId);
        creator.set(createdId, event.step);
      }

      decisions.push({
        step: event.step,
        hole: event.hole,
        parent: event.parent,
        fn: event.fn,
        created: event.created,
        callEdges: event.call_edges,
        invalidated: event.invalidated,
        invalidatedBy: event.invalidated_by,
      });
      expectedStep += 1;
      continue;
    }

    if (event.event === "settle") {
      if (previousSettleIndex !== null && event.settle_index <= previousSettleIndex) {
        throw schemaInvalid(
          sourcePath,
          line,
          "settle_index must be strictly increasing",
        );
      }
      previousSettleIndex = event.settle_index;
      if (event.kind === "fn") {
        if (event.fn < 0 || event.fn >= header.fnCount) {
          throw schemaInvalid(
            sourcePath,
            line,
            `kind=fn settle fn ${event.fn} is outside fn_count=${header.fnCount}`,
          );
        }
      } else if (event.fn !== -1) {
        throw schemaInvalid(sourcePath, line, "kind=program settle must use fn=-1");
      }
      const key = `${event.kind}:${event.fn}`;
      if (settleKeys.has(key)) {
        throw schemaInvalid(sourcePath, line, `duplicate settle for ${key}`);
      }
      settleKeys.add(key);
      settles.push({
        settleIndex: event.settle_index,
        frame: event.frame,
        promiseFrame: event.promise_frame,
        fn: event.fn,
        kind: event.kind,
        verdict: event.verdict,
      });
      continue;
    }

    throw invalidTsv(
      sourcePath,
      line,
      `${event.event} is not allowed between trace_begin and trace_done`,
    );
  }

  const lastDecisionStep = decisions.length - 1;
  for (const decision of decisions) {
    for (const callEdge of decision.callEdges) {
      if (callEdge.caller >= header.fnCount || callEdge.callee >= header.fnCount) {
        failSchema(sourcePath, `decision ${decision.step} call_edges fn outside fn_count=${header.fnCount}`);
      }
      if (callEdge.frame > decision.step) {
        failSchema(sourcePath, `decision ${decision.step} call_edges frame ${callEdge.frame} is a future frame`);
      }
      const frameDecision = decisions[callEdge.frame];
      if (frameDecision === undefined) {
        failSchema(sourcePath, `decision ${decision.step} call_edges frame ${callEdge.frame} is not a decision`);
      }
      if (callEdge.caller !== frameDecision.fn) {
        failSchema(sourcePath, `decision ${decision.step} call_edges caller ${callEdge.caller} must equal frame ${callEdge.frame} fn ${frameDecision.fn}`);
      }
    }
  }

  for (const settle of settles) {
    if (settle.frame >= 0) {
      const frameDecision = decisions[settle.frame];
      if (frameDecision === undefined) {
        failSchema(sourcePath, `settle ${settle.settleIndex} frame ${settle.frame} is not a decision`);
      }
      if (settle.kind === "fn" && frameDecision.fn !== settle.fn) {
        failSchema(sourcePath, `settle ${settle.settleIndex} frame ${settle.frame} belongs to fn ${frameDecision.fn}, not fn ${settle.fn}`);
      }
    }
    if (settle.promiseFrame >= 0 && settle.promiseFrame > lastDecisionStep) {
      failSchema(sourcePath, `settle ${settle.settleIndex} promise_frame ${settle.promiseFrame} is not a decision`);
    }
  }

  const failedAnchors = new Set<number>();
  for (const settle of settles) {
    if (settle.verdict !== "fail") {
      continue;
    }
    if (settle.frame >= 0) {
      failedAnchors.add(settle.frame);
    }
    if (settle.promiseFrame >= 0) {
      failedAnchors.add(settle.promiseFrame);
    }
  }

  for (const decision of decisions) {
    const anchors = new Set<number>();
    for (const anchor of decision.invalidatedBy) {
      if (anchors.has(anchor)) {
        failSchema(sourcePath, `decision ${decision.step} has duplicate invalidated_by anchor ${anchor}`);
      }
      anchors.add(anchor);
      if (!failedAnchors.has(anchor)) {
        failSchema(sourcePath, `decision ${decision.step} invalidated_by anchor ${anchor} is not a failed settle frame or promise_frame`);
      }
    }
    if (decision.invalidated !== decision.invalidatedBy.length > 0) {
      failSchema(sourcePath, `decision ${decision.step} invalidated must equal invalidated_by non-empty`);
    }
  }

  const nodes: DerivationNode[] = [{ id: "trace", kind: "trace" }];
  for (let fn = 0; fn < header.fnCount; fn += 1) {
    nodes.push({ id: `fn:${fn}`, kind: "fn", fn });
  }
  for (const root of header.roots) {
    nodes.push({ id: root, kind: "hole", hole: root, parent: -1 });
  }
  for (const decision of decisions) {
    for (const createdId of decision.created) {
      nodes.push({ id: createdId, kind: "hole", hole: createdId, parent: decision.step });
    }
  }
  for (const decision of decisions) {
    nodes.push({
      id: `frame:${decision.step}`, kind: "frame", step: decision.step, fn: decision.fn,
      hole: decision.hole, parent: decision.parent, invalidated: decision.invalidated,
      callEdges: decision.callEdges.map((callEdge) => ({ ...callEdge })),
    });
  }
  for (const settle of settles) {
    nodes.push({
      id: `settle:${settle.settleIndex}`, kind: "settle", fn: settle.fn,
      ...(settle.frame >= 0 ? { step: settle.frame } : {}),
    });
  }

  const edges: DerivationEdge[] = [];
  for (const root of header.roots) {
    edges.push({ from: "trace", to: root, kind: "roots" });
  }
  for (const decision of decisions) {
    edges.push({ from: `frame:${decision.step}`, to: `fn:${decision.fn}`, kind: "member" });
    edges.push({ from: `frame:${decision.step}`, to: decision.hole, kind: "fills" });
    for (const createdId of decision.created) {
      edges.push({ from: `frame:${decision.step}`, to: createdId, kind: "creates" });
    }
    for (const callEdge of decision.callEdges) {
      edges.push({ from: `frame:${callEdge.frame}`, to: `fn:${callEdge.callee}`, kind: "calls" });
    }
    for (const anchor of decision.invalidatedBy) {
      edges.push({ from: `frame:${anchor}`, to: `frame:${decision.step}`, kind: "invalidates" });
    }
  }
  for (const settle of settles) {
    if (settle.frame >= 0) {
      edges.push({
        from: `settle:${settle.settleIndex}`, to: `frame:${settle.frame}`, kind: "settles",
      });
    }
  }

  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.kind}|${edge.from}|${edge.to}`;
    if (edgeKeys.has(key)) {
      failSchema(sourcePath, `duplicate edge: ${key}`);
    }
    edgeKeys.add(key);
  }

  const result = DerivationGraphSchema.safeParse({
    kind: "derivation_graph",
    schema: "cheng.contract.derivation_graph.v1",
    task: header.task,
    taskId: header.taskId,
    tracePath: sourcePath,
    traceSha256: sourceSha256,
    roots: header.roots,
    nodes,
    edges,
  });
  if (!result.success) {
    failSchema(
      sourcePath,
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    );
  }
  return result.data;
}
