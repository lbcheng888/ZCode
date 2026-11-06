import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readDecisionFrames } from "../src/adapters/spec-decision.js";
import { parseDecisionFrameJsonl } from "../src/decision-frame.js";
import {
  expectContractError,
  FIXTURES,
  fixture,
  mutateJsonl,
} from "./helpers.js";

const M5_SAMPLE = fixture(
  "spec-decision",
  "decision_traj",
  "v0",
  "decisions.sample.jsonl",
);
const PRECEDENT_SAMPLE = fixture(
  "spec-decision",
  "decision_traj",
  "precedents",
  "precedents.sample.jsonl",
);

function fixturePath(...parts: string[]): string {
  return join(FIXTURES, "spec-decision", ...parts);
}

function lineAt(text: string, index: number): string {
  const line = text.split("\n")[index];
  if (line === undefined) {
    throw new Error(`text has no line ${index}`);
  }
  return line;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where} is not an array`);
  }
  return value;
}

function candidateAt(
  value: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  return asRecord(asArray(value.candidates, "candidates")[index], `candidates[${index}]`);
}

function frameAt(
  events: Record<string, unknown>[],
  index: number,
): Record<string, unknown> {
  return asRecord(events[index], `record ${index}`);
}

describe("DecisionFrame", () => {
  it("parses real M5 decision frames with candidate dispatch scores", () => {
    const frames = parseDecisionFrameJsonl(M5_SAMPLE);
    expect(frames).toHaveLength(2);
    const first = frames[0];
    expect(first).toBeDefined();
    expect(first).toMatchObject({
      schema: "csg.decision_data/v0",
      hole_id: "p04_sum_to/r1/s:0:0@0",
      chosen: "var:0",
      score: 218750,
      judge_verdict: "not_judged",
      context_cid: "15691be21bf5f61ebc1f6890ed479f448dc79e81d6922c2df55255176b00d7fd",
      hole_type: { kind: "stmt", gate: -1 },
    });
    expect(first?.candidates).toHaveLength(5);
    expect(first?.candidates).toContainEqual({
      id: "var:0",
      legal: true,
      score: 218750,
      hit: 0,
    });
    expect(first?.provenance.source_trace).toBe(
      "data/reach/out/p04_sum_to.r1.trace.jsonl",
    );
    expect(first?.settle_rc).toMatchObject({ solved: true, reason: "solved" });
  });

  it("parses the real precedent frames including hole_ctx", () => {
    const frames = parseDecisionFrameJsonl(PRECEDENT_SAMPLE);
    expect(frames).toHaveLength(2);
    const first = frames[0];
    expect(first).toBeDefined();
    expect(first).toMatchObject({
      schema: "csg.decision_data/v0.precedent",
      hole_id: "prec/001",
      chosen: "migration:borrows_param",
      score: null,
      judge_verdict: "verdict_confirmed",
      hole_type: {
        kind: "source_migration",
        family: "F-ov8-managed-field-byval",
        verdict_class: "ov8",
      },
      hole_ctx: {
        family: "F-ov8-managed-field-byval",
        site: "src/libp2p/crypto/crypto.cheng:75:11",
      },
    });
  });

  it("accepts a single trailing newline and records, but rejects blank lines", () => {
    expect(parseDecisionFrameJsonl(`${lineAt(M5_SAMPLE, 0)}\n`)).toHaveLength(1);
    expect(parseDecisionFrameJsonl(lineAt(M5_SAMPLE, 0))).toHaveLength(1);
    expectContractError(
      () =>
        parseDecisionFrameJsonl(
          `${lineAt(M5_SAMPLE, 0)}\n\n${lineAt(M5_SAMPLE, 1)}\n`,
        ),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("accepts an M5 frame carrying the schema-declared provenance pair", () => {
    const text = mutateJsonl(M5_SAMPLE, (events) => {
      const provenance = asRecord(frameAt(events, 0).provenance, "provenance");
      delete provenance.source_trace;
      delete provenance.source_sha256;
      provenance.source = "findings.md:1";
      provenance.sha256_or_commit = "abc";
    });
    const frames = parseDecisionFrameJsonl(text);
    expect(frames[0]?.provenance).toMatchObject({
      source: "findings.md:1",
      sha256_or_commit: "abc",
    });
  });

  it("reads a real sample file", () => {
    const frames = readDecisionFrames(
      fixturePath("decision_traj", "v0", "decisions.sample.jsonl"),
    );
    expect(frames.map((frame) => frame.hole_id)).toEqual([
      "p04_sum_to/r1/s:0:0@0",
      "p04_sum_to/r1/e:1@1",
    ]);
  });

  describe("fail-closed", () => {
    it("rejects empty input and invalid JSON with the line number", () => {
      expectContractError(
        () => parseDecisionFrameJsonl(""),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
      const error = expectContractError(
        () => parseDecisionFrameJsonl(`${lineAt(M5_SAMPLE, 0)}\n{broken}\n`),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
      expect(error.line).toBe(2);
    });

    it("rejects a JSONL line that is not an object", () => {
      expectContractError(
        () => parseDecisionFrameJsonl("[]\n"),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects a missing required field", () => {
      const missing = mutateJsonl(M5_SAMPLE, (events) => {
        delete frameAt(events, 0).judge_verdict;
      });
      expectContractError(
        () => parseDecisionFrameJsonl(missing),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects a fabricated frame_id", () => {
      const fabricated = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).frame_id = "frame-001";
      });
      expectContractError(
        () => parseDecisionFrameJsonl(fabricated),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects a fabricated model_version", () => {
      const fabricated = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).model_version = "m5";
      });
      expectContractError(
        () => parseDecisionFrameJsonl(fabricated),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects chosen outside candidates", () => {
      const text = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).chosen = "missing:0";
      });
      expectContractError(
        () => parseDecisionFrameJsonl(text),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects duplicate hole_id within one file", () => {
      const text = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 1).hole_id = frameAt(events, 0).hole_id;
      });
      const error = expectContractError(
        () => parseDecisionFrameJsonl(text),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
      expect(error.line).toBe(2);
    });

    it("rejects an unknown judge_verdict", () => {
      const text = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).judge_verdict = "maybe_pass";
      });
      expectContractError(
        () => parseDecisionFrameJsonl(text),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects a malformed context_cid and non-boolean legal", () => {
      const badCid = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).context_cid = "a".repeat(63);
      });
      expectContractError(
        () => parseDecisionFrameJsonl(badCid),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const badLegal = mutateJsonl(M5_SAMPLE, (events) => {
        candidateAt(frameAt(events, 0), 0).legal = "true";
      });
      expectContractError(
        () => parseDecisionFrameJsonl(badLegal),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects non-integer score, non-object settle_rc and empty candidates", () => {
      const badScore = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).score = "218750";
      });
      expectContractError(
        () => parseDecisionFrameJsonl(badScore),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const badSettle = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).settle_rc = [];
      });
      expectContractError(
        () => parseDecisionFrameJsonl(badSettle),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const noCandidates = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).candidates = [];
      });
      expectContractError(
        () => parseDecisionFrameJsonl(noCandidates),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects malformed candidate identity and hole_id shape", () => {
      const emptyId = mutateJsonl(M5_SAMPLE, (events) => {
        candidateAt(frameAt(events, 0), 0).id = "";
      });
      expectContractError(
        () => parseDecisionFrameJsonl(emptyId),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const missingLegal = mutateJsonl(M5_SAMPLE, (events) => {
        delete candidateAt(frameAt(events, 0), 0).legal;
      });
      expectContractError(
        () => parseDecisionFrameJsonl(missingLegal),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const badHoleId = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).hole_id = "p04_sum_to@0";
      });
      expectContractError(
        () => parseDecisionFrameJsonl(badHoleId),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const badPrecedentId = mutateJsonl(PRECEDENT_SAMPLE, (events) => {
        frameAt(events, 0).hole_id = "prec/01";
      });
      expectContractError(
        () => parseDecisionFrameJsonl(badPrecedentId),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects unknown or cross-form hole_type shapes", () => {
      const unknown = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).hole_type = { kind: "bogus" };
      });
      expectContractError(
        () => parseDecisionFrameJsonl(unknown),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const extraM5 = mutateJsonl(M5_SAMPLE, (events) => {
        const holeType = asRecord(frameAt(events, 0).hole_type, "hole_type");
        holeType.unexpected = 1;
      });
      expectContractError(
        () => parseDecisionFrameJsonl(extraM5),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const m5FieldOnPrecedent = mutateJsonl(PRECEDENT_SAMPLE, (events) => {
        const holeType = asRecord(frameAt(events, 0).hole_type, "hole_type");
        holeType.depth = 0;
      });
      expectContractError(
        () => parseDecisionFrameJsonl(m5FieldOnPrecedent),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects hole_ctx on M5 frames and the precedent schema on M5 holes", () => {
      const m5WithCtx = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).hole_ctx = {
          family: "F-x",
          verdict_class: "x",
          error_verdict: "x",
          site: "x",
          code_shape: "x",
        };
      });
      expectContractError(
        () => parseDecisionFrameJsonl(m5WithCtx),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const precedentSchema = mutateJsonl(M5_SAMPLE, (events) => {
        frameAt(events, 0).schema = "csg.decision_data/v0.precedent";
      });
      expectContractError(
        () => parseDecisionFrameJsonl(precedentSchema),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects provenance missing its per-form source anchor", () => {
      const noTrace = mutateJsonl(M5_SAMPLE, (events) => {
        const provenance = asRecord(frameAt(events, 0).provenance, "provenance");
        delete provenance.source_trace;
      });
      expectContractError(
        () => parseDecisionFrameJsonl(noTrace),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const noSha = mutateJsonl(M5_SAMPLE, (events) => {
        const provenance = asRecord(frameAt(events, 0).provenance, "provenance");
        delete provenance.source_sha256;
      });
      expectContractError(
        () => parseDecisionFrameJsonl(noSha),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const noPrecedentSource = mutateJsonl(PRECEDENT_SAMPLE, (events) => {
        const provenance = asRecord(frameAt(events, 0).provenance, "provenance");
        delete provenance.source;
      });
      expectContractError(
        () => parseDecisionFrameJsonl(noPrecedentSource),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("fails on a missing JSONL file", () => {
      expectContractError(
        () => readDecisionFrames(fixturePath("decision_traj", "missing.jsonl")),
        "CHENG_CONTRACT_MISSING_FILE",
      );
    });
  });
});
