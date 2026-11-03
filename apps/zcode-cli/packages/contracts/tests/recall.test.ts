import { describe, expect, it } from "vitest";

import {
  RECALL_RESOURCE_KINDS,
  RecallInputSchema,
  RecallOutputSchema,
  formatRecallResourceId,
  normalizeRecallResourceId,
  parseRecallResourceId,
  recallArtifactIdFromUri,
  recallArtifactUriFromId,
} from "../src/tools/recall.js";
import {
  compactBoundaryPayloadSchema,
  compactRecoveryPointerSchema,
  parseCompactBoundaryPayload,
} from "../src/compact/index.js";
import { CompactPhase, CompactReason, CompactTrigger } from "../src/compact/index.js";
import type { MessageId, TraceId } from "../src/interfaces/shared.js";

describe("recall resource ids", () => {
  it("round-trips every kind through parse and format", () => {
    const cases = [
      "session:sess_abc-123",
      "target:target_17lz0p0_0f9a",
      "target-event:target_17lz0p0_0f9a/7",
      "wf-run:dwfrun-0199abcd",
      "wf-event:dwfrun-0199abcd/12",
      "artifact:sess_abc-123/art_9",
      "trigger:trg_1",
      "subscription:sub_1",
    ] as const;
    for (const id of cases) {
      const parsed = parseRecallResourceId(id);
      expect(parsed, id).toBeDefined();
      expect(formatRecallResourceId(parsed!.kind, parsed!.segments)).toBe(id);
      expect(RECALL_RESOURCE_KINDS).toContain(parsed!.kind);
    }
  });

  it("rejects malformed ids instead of guessing a kind", () => {
    for (const bad of [
      "",
      "nosplit",
      ":missing-kind",
      "session:not-sess",
      "target:wrong-prefix",
      "target-event:target_x/nope",
      "wf-run:has space",
      "wf-event:dwfrun-x/nope",
      "artifact:sess_x",
      "artifact:missing-slash/art",
      "unknown:thing",
    ]) {
      expect(parseRecallResourceId(bad), bad).toBeUndefined();
    }
  });

  it("treats a zcode-artifact URI as the same artifact recall id", () => {
    const uri = "zcode-artifact://sess_abc/art_9";
    expect(recallArtifactIdFromUri(uri)).toBe("sess_abc/art_9");
    expect(normalizeRecallResourceId(uri)).toBe("artifact:sess_abc/art_9");
    expect(parseRecallResourceId(normalizeRecallResourceId(uri))?.kind).toBe("artifact");
    expect(recallArtifactUriFromId("artifact:sess_abc/art_9")).toBe(uri);
  });
});

describe("recall input contract", () => {
  it("requires exactly one of ids or kind", () => {
    expect(RecallInputSchema.safeParse({ ids: ["session:sess_a"] }).success).toBe(true);
    expect(RecallInputSchema.safeParse({ kind: "target-event" }).success).toBe(true);
    expect(RecallInputSchema.safeParse({}).success).toBe(false);
    expect(
      RecallInputSchema.safeParse({ ids: ["session:sess_a"], kind: "session" }).success,
    ).toBe(false);
  });

  it("rejects malformed ids at the schema boundary", () => {
    expect(RecallInputSchema.safeParse({ ids: ["not-an-id"] }).success).toBe(false);
    expect(RecallInputSchema.safeParse({ ids: ["zcode-artifact://sess_a/art_1"] }).success).toBe(
      true,
    );
    expect(RecallInputSchema.safeParse({ ids: ["session:sess_a"], limit: 51 }).success).toBe(false);
  });

  it("scopes cursor to listings or a single artifact id", () => {
    expect(
      RecallInputSchema.safeParse({ kind: "session", cursor: "20" }).success,
    ).toBe(true);
    expect(
      RecallInputSchema.safeParse({ ids: ["artifact:sess_a/art_1"], cursor: "4000" }).success,
    ).toBe(true);
    expect(
      RecallInputSchema.safeParse({ ids: ["session:sess_a"], cursor: "1" }).success,
    ).toBe(false);
    expect(
      RecallInputSchema.safeParse({
        ids: ["artifact:sess_a/art_1", "artifact:sess_a/art_2"],
        cursor: "1",
      }).success,
    ).toBe(false);
  });

  it("defaults output collections and rejects unknown fields", () => {
    const parsed = RecallOutputSchema.parse({
      status: "success",
      items: [
        { id: "target:target_x", kind: "target", summary: "objective" },
      ],
    });
    expect(parsed.missing).toEqual([]);
    expect(parsed.truncated).toBe(false);
    expect(parsed.items[0].refs).toEqual([]);
    expect(
      RecallOutputSchema.safeParse({ status: "success", items: [], extra: 1 }).success,
    ).toBe(false);
  });
});

describe("compact recovery pointer contract", () => {
  const pointer = {
    objective: "Ship the recall tool",
    criterion: "green targeted vitest",
    fileMap: ["apps/zcode-cli/packages/core/src/tool/handlers/recall.ts"],
    openQuestions: ["trigger port seam"],
    recallSeedIds: ["target:target_17lz0p0_0f9a", "zcode-artifact://sess_a/art_1"],
  };

  it("accepts a full pointer and rejects invented seed ids", () => {
    expect(compactRecoveryPointerSchema.parse(pointer)).toMatchObject({
      objective: "Ship the recall tool",
      fileMap: ["apps/zcode-cli/packages/core/src/tool/handlers/recall.ts"],
    });
    expect(
      compactRecoveryPointerSchema.safeParse({
        ...pointer,
        recallSeedIds: ["i-just-made-this-up"],
      }).success,
    ).toBe(false);
    expect(
      compactRecoveryPointerSchema.safeParse({ ...pointer, objective: "" }).success,
    ).toBe(false);
    expect(
      compactRecoveryPointerSchema.safeParse({ ...pointer, extra: true }).success,
    ).toBe(false);
  });

  it("keeps boundaries without a pointer parseable and preserves one when present", () => {
    const base = {
      boundaryId: "compact_rp",
      trigger: CompactTrigger.Manual,
      phase: CompactPhase.StandaloneTurn,
      compactReason: CompactReason.UserRequested,
      preCompactTokenCount: 1_000,
      summarizedMessageCount: 3,
      summaryMessageIds: ["msg_summary" as MessageId],
      traceId: "trace_rp" as TraceId,
    };
    const without = parseCompactBoundaryPayload(base);
    expect(without.recoveryPointer).toBeUndefined();

    const withPointer = compactBoundaryPayloadSchema.parse({
      ...base,
      recoveryPointer: pointer,
    });
    expect(withPointer.recoveryPointer?.objective).toBe("Ship the recall tool");
    expect(
      compactBoundaryPayloadSchema.safeParse({
        ...base,
        recoveryPointer: { objective: "no criterion" },
      }).success,
    ).toBe(false);
  });
});
