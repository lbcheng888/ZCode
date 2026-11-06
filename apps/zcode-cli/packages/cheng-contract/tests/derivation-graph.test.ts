import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readDerivationGraph } from "../src/adapters/trace-graph.js";
import {
  DerivationEdgeSchema,
  DerivationGraphSchema,
  DerivationNodeSchema,
  parseDerivationGraphJsonl,
  type DerivationGraph,
  type DerivationNode,
  type DerivationNodeKind,
} from "../src/derivation-graph.js";
import type { ChengContractErrorCode } from "../src/errors.js";
import {
  FIXTURES,
  eventOf,
  expectContractError,
  fixture,
  mutateJsonl,
  setField,
} from "./helpers.js";

const P02 = "run-p02/trace.jsonl";
const P16 = "run-p16/trace.jsonl";
const P01 = "run-p01r5b/trace.jsonl";
const P17_SUCCESS = "derivation-graph/p17_success.trace.jsonl";
const P17_SETTLE_FAILED = "derivation-graph/p17_settle_failed.trace.jsonl";
const P17_INVALID_PATH = "derivation-graph/p17_invalid_path.trace.jsonl";

function read(file: string): DerivationGraph {
  return readDerivationGraph(join(FIXTURES, file));
}

function requireNode(graph: DerivationGraph, id: string): DerivationNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`graph has no node ${id}`);
  }
  return node;
}

function edgesOf(graph: DerivationGraph, kind: string): DerivationGraph["edges"] {
  return graph.edges.filter((edge) => edge.kind === kind);
}

function edgeCount(graph: DerivationGraph, kind: string): number {
  return edgesOf(graph, kind).length;
}

function kindCounts(graph: DerivationGraph): Record<DerivationNodeKind, number> {
  const counts: Record<DerivationNodeKind, number> = {
    trace: 0,
    frame: 0,
    hole: 0,
    fn: 0,
    settle: 0,
  };
  for (const node of graph.nodes) {
    counts[node.kind] += 1;
  }
  return counts;
}

function decisionAt(
  events: Record<string, unknown>[],
  step: number,
): Record<string, unknown> {
  const decision = events.find((event) => event.event === "decision" && event.step === step);
  if (decision === undefined) {
    throw new Error(`fixture has no decision step ${step}`);
  }
  return decision;
}

function callEdgeAt(
  events: Record<string, unknown>[],
  step: number,
  index = 0,
): Record<string, unknown> {
  const decision = decisionAt(events, step);
  const callEdges = decision.call_edges;
  if (!Array.isArray(callEdges)) {
    throw new Error(`decision ${step} has no call_edges array`);
  }
  const entry: unknown = callEdges[index];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`decision ${step} has no call_edges[${index}] object`);
  }
  return entry as Record<string, unknown>;
}

function parseText(text: string): DerivationGraph {
  return parseDerivationGraphJsonl(text, "<memory>");
}

function expectGraphError(
  file: string,
  mutate: (events: Record<string, unknown>[]) => void,
  code: ChengContractErrorCode,
): void {
  expectContractError(() => parseText(mutateJsonl(fixture(file), mutate)), code);
}

function jsonlWithLine(file: string, lineIndex: number, replacement: string): string {
  const lines = fixture(file).trimEnd().split("\n");
  lines[lineIndex] = replacement;
  return `${lines.join("\n")}\n`;
}

describe("DerivationGraph positive projection", () => {
  it("projects the p02 trace with roots, creator parents and settle nodes", () => {
    const graph = read(P02);
    expect(graph).toMatchObject({
      kind: "derivation_graph",
      schema: "cheng.contract.derivation_graph.v1",
      task: "p02_min2",
      taskId: 1,
    });
    expect(graph.tracePath).toBe(join(FIXTURES, P02));
    expect(graph.traceSha256).toBe(
      "25d12b56eab6e332bee8a2afd86215059fceaafb29e1147b985130b496be6933",
    );
    expect(graph.roots).toEqual(["b:0", "s:0:0", "s:0:1", "s:0:2", "s:0:3", "e:0"]);
    expect(kindCounts(graph)).toEqual({
      trace: 1,
      frame: 7,
      hole: 11,
      fn: 1,
      settle: 2,
    });
    expect(edgeCount(graph, "roots")).toBe(6);
    expect(edgeCount(graph, "member")).toBe(7);
    expect(edgeCount(graph, "fills")).toBe(7);
    expect(edgeCount(graph, "creates")).toBe(5);
    expect(edgeCount(graph, "calls")).toBe(0);
    expect(edgeCount(graph, "settles")).toBe(2);
    expect(edgeCount(graph, "invalidates")).toBe(0);

    expect(requireNode(graph, "e:0")).toMatchObject({ kind: "hole", parent: -1 });
    expect(requireNode(graph, "e:5")).toMatchObject({ kind: "hole", parent: 2 });
    expect(requireNode(graph, "frame:4")).toMatchObject({
      kind: "frame",
      step: 4,
      fn: 0,
      hole: "e:5",
      parent: 2,
      callEdges: [],
      invalidated: false,
    });
    expect(requireNode(graph, "settle:0")).toMatchObject({
      kind: "settle",
      fn: 0,
      step: 6,
    });
    expect(requireNode(graph, "settle:1")).toMatchObject({
      kind: "settle",
      fn: -1,
      step: 6,
    });

    expect(graph.edges).toContainEqual({ from: "trace", to: "e:0", kind: "roots" });
    expect(graph.edges).toContainEqual({ from: "frame:2", to: "e:5", kind: "creates" });
    expect(graph.edges).toContainEqual({ from: "frame:1", to: "e:0", kind: "fills" });
    expect(graph.edges).toContainEqual({ from: "frame:4", to: "fn:0", kind: "member" });
    expect(graph.edges).toContainEqual({ from: "settle:0", to: "frame:6", kind: "settles" });
    expect(graph.edges).toContainEqual({ from: "settle:1", to: "frame:6", kind: "settles" });
  });

  it("projects p16 and p01 without inventing fields", () => {
    const p16 = read(P16);
    const p01 = read(P01);
    expect(p16.task).toBe("p16_glue_len");
    expect(p16.taskId).toBe(15);
    expect(p01.task).toBe("p01_max2");
    expect(p01.taskId).toBe(0);
    expect(kindCounts(p16)).toEqual({
      trace: 1,
      frame: 5,
      hole: 9,
      fn: 1,
      settle: 2,
    });
    expect(kindCounts(p01)).toEqual({
      trace: 1,
      frame: 7,
      hole: 11,
      fn: 1,
      settle: 2,
    });
    expect(requireNode(p16, "frame:4")).toMatchObject({ hole: "e:3", parent: 2 });
    expect(requireNode(p16, "e:3")).toMatchObject({ parent: 2 });

    const allowedKeys: Record<DerivationNodeKind, string[]> = {
      trace: ["id", "kind"],
      frame: ["callEdges", "fn", "hole", "id", "invalidated", "kind", "parent", "step"],
      hole: ["hole", "id", "kind", "parent"],
      fn: ["fn", "id", "kind"],
      settle: ["fn", "id", "kind"],
    };
    for (const graph of [p16, p01]) {
      const serialized = JSON.stringify(graph);
      expect(serialized).not.toContain('"level"');
      expect(serialized).not.toContain('"cid"');
      expect(serialized).not.toContain("program_cid");
      expect(serialized).not.toContain("model_version");
      for (const node of graph.nodes) {
        const allowed =
          node.kind === "settle" && node.step !== undefined
            ? [...allowedKeys.settle, "step"]
            : allowedKeys[node.kind];
        expect(Object.keys(node).sort()).toEqual(allowed);
      }
    }
  });

  it("projects p17_success call_edges and settle nodes", () => {
    const graph = read(P17_SUCCESS);
    expect(graph.task).toBe("p17_import_call");
    expect(graph.taskId).toBe(16);
    expect(kindCounts(graph)).toEqual({
      trace: 1,
      frame: 9,
      hole: 17,
      fn: 2,
      settle: 3,
    });
    expect(edgeCount(graph, "roots")).toBe(12);
    expect(edgeCount(graph, "member")).toBe(9);
    expect(edgeCount(graph, "fills")).toBe(9);
    expect(edgeCount(graph, "creates")).toBe(5);
    expect(edgeCount(graph, "calls")).toBe(1);
    expect(edgeCount(graph, "settles")).toBe(3);
    expect(edgeCount(graph, "invalidates")).toBe(0);

    expect(requireNode(graph, "fn:0")).toMatchObject({ kind: "fn", fn: 0 });
    expect(requireNode(graph, "fn:1")).toMatchObject({ kind: "fn", fn: 1 });
    expect(requireNode(graph, "frame:7")).toMatchObject({
      fn: 1,
      hole: "e:5",
      parent: 5,
      callEdges: [{ caller: 1, callee: 0, frame: 7 }],
      invalidated: false,
    });
    expect(graph.edges).toContainEqual({ from: "frame:7", to: "fn:0", kind: "calls" });
    expect(graph.edges).toContainEqual({ from: "settle:0", to: "frame:3", kind: "settles" });
    expect(graph.edges).toContainEqual({ from: "settle:1", to: "frame:8", kind: "settles" });
    expect(graph.edges).toContainEqual({ from: "settle:2", to: "frame:8", kind: "settles" });
  });

  it("projects invalidated_by as invalidates edges only", () => {
    const graph = read(P17_SETTLE_FAILED);
    expect(edgeCount(graph, "invalidates")).toBe(8);
    expect(edgeCount(graph, "calls")).toBe(1);
    const invalidatedFrames = graph.nodes.filter(
      (node) => node.kind === "frame" && node.invalidated,
    );
    expect(invalidatedFrames.map((node) => node.step)).toEqual([1, 3, 5, 7, 8]);

    expect(graph.edges).toContainEqual({
      from: "frame:3",
      to: "frame:3",
      kind: "invalidates",
    });
    expect(graph.edges).toContainEqual({
      from: "frame:3",
      to: "frame:5",
      kind: "invalidates",
    });
    expect(graph.edges).toContainEqual({
      from: "frame:8",
      to: "frame:5",
      kind: "invalidates",
    });
    expect(graph.edges).toContainEqual({
      from: "frame:8",
      to: "frame:8",
      kind: "invalidates",
    });
    expect(graph.edges).toContainEqual({
      from: "frame:3",
      to: "frame:8",
      kind: "invalidates",
    });

    expect(requireNode(graph, "settle:0")).toMatchObject({ fn: 0, step: 3 });
    expect(requireNode(graph, "settle:1")).toMatchObject({ fn: 1, step: 8 });
    expect(requireNode(graph, "settle:2")).toMatchObject({ fn: -1, step: 8 });
  });

  it("accepts an invalid_path trace with no settle events", () => {
    const graph = read(P17_INVALID_PATH);
    expect(graph.task).toBe("p17_import_call");
    expect(kindCounts(graph)).toEqual({
      trace: 1,
      frame: 1,
      hole: 12,
      fn: 2,
      settle: 0,
    });
    expect(edgeCount(graph, "roots")).toBe(12);
    expect(edgeCount(graph, "member")).toBe(1);
    expect(edgeCount(graph, "fills")).toBe(1);
    expect(edgeCount(graph, "creates")).toBe(0);
    expect(edgeCount(graph, "settles")).toBe(0);
    expect(edgeCount(graph, "invalidates")).toBe(0);
    expect(requireNode(graph, "frame:0")).toMatchObject({ hole: "s:0:0", parent: -1 });
  });

  it("keeps caller-supplied path and sha and defaults them", () => {
    const customSha = "a".repeat(64);
    const custom = parseDerivationGraphJsonl(fixture(P02), "custom/trace.jsonl", customSha);
    expect(custom.tracePath).toBe("custom/trace.jsonl");
    expect(custom.traceSha256).toBe(customSha);
    const defaults = parseText(fixture(P02));
    expect(defaults.tracePath).toBe("<memory>");
    expect(defaults.traceSha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("DerivationGraph fail-closed", () => {
  it("rejects invalid JSONL and non-object lines", () => {
    expectContractError(
      () => parseText(jsonlWithLine(P02, 1, "{")),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectContractError(
      () => parseText(jsonlWithLine(P02, 1, "[]")),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectContractError(() => parseText(""), "CHENG_CONTRACT_INVALID_TSV");
    expectContractError(
      () => parseText(fixture(P02).replace("\n", "\n\n")),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectContractError(
      () => parseText(`\uFEFF${fixture(P02)}`),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects unknown events and unknown schemas", () => {
    expectGraphError(
      P02,
      (events) => setField(eventOf(events, "decision", 0), "event", "decision_extra"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => setField(eventOf(events, "trace_begin"), "schema", "other.schema"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects missing or duplicate trace_begin/trace_done", () => {
    expectGraphError(
      P02,
      (events) => {
        events.splice(0, 1);
      },
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => {
        events.pop();
      },
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => {
        const begin = events[0];
        if (begin === undefined) {
          throw new Error("fixture has no trace_begin");
        }
        events.splice(1, 0, { ...begin });
      },
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => {
        const done = events[events.length - 1];
        if (done === undefined) {
          throw new Error("fixture has no trace_done");
        }
        events.splice(events.length - 1, 0, { ...done });
      },
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => {
        const decision = eventOf(events, "decision", 0);
        events.push({ ...decision });
      },
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects wrong field types and envelopes", () => {
    expectGraphError(
      P02,
      (events) => setField(eventOf(events, "settle", 0), "task", "other_task"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => setField(eventOf(events, "trace_begin"), "roots", "b:0"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => setField(eventOf(events, "trace_begin"), "fn_count", "1"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 0), "step", "0"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 2), "parent", "1"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 2), "created", "e:4"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 2), "invalidated", 0),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects parent that does not equal the hole creator", () => {
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 2), "parent", 0),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 0), "parent", 0),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects unknown, future and self-created holes", () => {
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 3), "hole", "e:99"),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P02,
      (events) => {
        const decision = decisionAt(events, 2);
        setField(decision, "hole", "e:4");
        setField(decision, "parent", 2);
      },
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P02,
      (events) => {
        const decision = decisionAt(events, 0);
        setField(decision, "hole", "s:0:1");
        setField(decision, "parent", 0);
      },
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects duplicate created ids, root collisions and double fills", () => {
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 2), "created", ["e:4", "e:4"]),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 3), "created", ["e:4"]),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 3), "created", ["s:0:1"]),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P02,
      (events) => {
        const decision = decisionAt(events, 3);
        setField(decision, "hole", "e:5");
        setField(decision, "parent", 2);
      },
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects unknown call_edges fn, frame and caller", () => {
    expectGraphError(
      P17_SUCCESS,
      (events) => setField(callEdgeAt(events, 7), "callee", 3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P17_SUCCESS,
      (events) => setField(callEdgeAt(events, 7), "caller", 3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P17_SUCCESS,
      (events) => setField(callEdgeAt(events, 7), "frame", 99),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P17_SUCCESS,
      (events) => setField(callEdgeAt(events, 7), "caller", 0),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P17_SUCCESS,
      (events) => {
        delete callEdgeAt(events, 7).caller;
      },
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P17_SUCCESS,
      (events) => {
        callEdgeAt(events, 7).weight = 1;
      },
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects invalidated_by that is not a failed settle projection", () => {
    expectGraphError(
      P02,
      (events) => {
        const decision = decisionAt(events, 3);
        setField(decision, "invalidated", true);
        setField(decision, "invalidated_by", [3]);
      },
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P02,
      (events) => setField(decisionAt(events, 3), "invalidated", true),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P17_SETTLE_FAILED,
      (events) => setField(decisionAt(events, 1), "invalidated", false),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P17_SETTLE_FAILED,
      (events) => setField(decisionAt(events, 5), "invalidated_by", [3, 3, 8]),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects settle frames and settle identities that do not fit the trace", () => {
    expectGraphError(
      P02,
      (events) => setField(eventOf(events, "settle", 0), "frame", 99),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P02,
      (events) => setField(eventOf(events, "settle", 0), "fn", -1),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P02,
      (events) => setField(eventOf(events, "settle", 1), "settle_index", 0),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P17_SUCCESS,
      (events) => setField(eventOf(events, "settle", 0), "frame", 8),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectGraphError(
      P02,
      (events) => setField(eventOf(events, "settle", 0), "kind", "fnx"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
    expectGraphError(
      P02,
      (events) => setField(eventOf(events, "settle", 0), "verdict", "maybe"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a malformed graph that references missing nodes", () => {
    const graph = read(P02);
    const clone = JSON.parse(JSON.stringify(graph)) as DerivationGraph;
    const first = clone.edges[0];
    if (first === undefined) {
      throw new Error("graph has no edges");
    }
    first.to = "missing:hole";
    expect(DerivationGraphSchema.safeParse(clone).success).toBe(false);
  });

  it("rejects duplicated node ids and fabricated node fields", () => {
    const graph = read(P02);
    const clone = JSON.parse(JSON.stringify(graph)) as DerivationGraph;
    const duplicate = clone.nodes[0];
    if (duplicate === undefined) {
      throw new Error("graph has no nodes");
    }
    clone.nodes.push({ ...duplicate });
    expect(DerivationGraphSchema.safeParse(clone).success).toBe(false);

    const frame = requireNode(graph, "frame:0");
    expect(DerivationNodeSchema.safeParse({ ...frame, level: "decision" }).success).toBe(
      false,
    );
    expect(
      DerivationNodeSchema.safeParse({ ...frame, cid: "a".repeat(64) }).success,
    ).toBe(false);
    const edge = graph.edges[0];
    if (edge === undefined) {
      throw new Error("graph has no edges");
    }
    expect(DerivationEdgeSchema.safeParse({ ...edge, cid: "a".repeat(64) }).success).toBe(
      false,
    );
  });

  it("rejects a non-sha source sha and a missing file", () => {
    expectContractError(
      () => parseDerivationGraphJsonl(fixture(P02), "<memory>", "not-a-sha"),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectContractError(
      () => readDerivationGraph(join(FIXTURES, "derivation-graph/missing.trace.jsonl")),
      "CHENG_CONTRACT_MISSING_FILE",
    );
  });
});
