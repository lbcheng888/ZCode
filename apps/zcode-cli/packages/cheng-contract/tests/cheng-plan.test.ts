import { describe, expect, it } from "vitest";

import {
  ChengPlanSchema,
  parseChengPlanJson,
} from "../src/cheng-plan.js";
import { expectContractError } from "./helpers.js";

interface JsonObject {
  [key: string]: unknown;
}

function candidate(overrides: JsonObject = {}): JsonObject {
  return {
    action: "fix_spec",
    target: "p02_min2.spec",
    cost: { wallMs: 120_000, expansions: 2 },
    risk: "low",
    expectedGain: 0.8,
    evidence: ["spec gate: missing helper settle row"],
    ...overrides,
  };
}

function validPlan(): JsonObject {
  return {
    kind: "cheng_plan",
    schema: "cheng.contract.cheng_plan.v1",
    frontier: {
      stage: "spec",
      target: "p02_min2.spec",
      evidence: ["spec gate: expected 12 eval rows, got 11"],
    },
    candidates: [candidate()],
    recommended: { action: "fix_spec", target: "p02_min2.spec" },
    blockedBy: [],
    budget: { wallMs: 1_800_000, expansions: 20 },
  };
}

function issuePaths(value: unknown): string[] {
  const result = ChengPlanSchema.safeParse(value);
  if (result.success) {
    throw new Error("expected the plan to be rejected");
  }
  return result.error.issues.map((issue) =>
    issue.path.length === 0 ? "<root>" : issue.path.join("."),
  );
}

function expectRejected(value: unknown, path: string): void {
  expect(issuePaths(value)).toContain(path);
}

function candidatesOf(plan: JsonObject): JsonObject[] {
  return plan.candidates as JsonObject[];
}

describe("ChengPlan", () => {
  it("accepts a complete plan and preserves the artifact fields", () => {
    const plan = ChengPlanSchema.parse(validPlan());
    expect(plan).toEqual(validPlan());
    expect(plan).toMatchObject({
      kind: "cheng_plan",
      schema: "cheng.contract.cheng_plan.v1",
      frontier: { stage: "spec", target: "p02_min2.spec" },
      recommended: { action: "fix_spec", target: "p02_min2.spec" },
      budget: { wallMs: 1_800_000, expansions: 20 },
    });
  });

  it("accepts a stop-only plan", () => {
    const plan = validPlan();
    plan.candidates = [
      candidate({
        action: "stop",
        target: "-",
        cost: { wallMs: 0, expansions: 0 },
        risk: "low",
        expectedGain: 0,
        evidence: ["negative gate: unsatisfiable precondition"],
      }),
    ];
    plan.recommended = { action: "stop", target: "-" };
    expect(ChengPlanSchema.parse(plan)).toEqual(plan);
  });

  it("allows stop beside other candidates and recommends a legal candidate", () => {
    const plan = validPlan();
    const stop = candidate({
      action: "stop",
      target: "-",
      cost: { wallMs: 0, expansions: 0 },
      risk: "low",
      expectedGain: 0,
      evidence: ["negative gate: unsatisfiable precondition"],
    });
    candidatesOf(plan).push(stop);
    plan.recommended = { action: "fix_spec", target: "p02_min2.spec" };
    expect(ChengPlanSchema.parse(plan)).toEqual(plan);
  });

  it("allows recommending stop when stop is listed with other candidates", () => {
    const plan = validPlan();
    const stop = candidate({
      action: "stop",
      target: "-",
      cost: { wallMs: 0, expansions: 0 },
      risk: "low",
      expectedGain: 0,
      evidence: ["negative gate: unsatisfiable precondition"],
    });
    candidatesOf(plan).push(stop);
    plan.recommended = { action: "stop", target: "-" };
    expect(ChengPlanSchema.parse(plan)).toEqual(plan);
  });

  it("identifies the recommended candidate by action and target", () => {
    const plan = validPlan();
    candidatesOf(plan).push(
      candidate({
        action: "fix_spec",
        target: "p16_glue_len.spec",
        evidence: ["spec gate: missing impl.plan"],
      }),
    );
    plan.recommended = { action: "fix_spec", target: "p16_glue_len.spec" };
    expect(ChengPlanSchema.parse(plan)).toEqual(plan);
  });

  it("rejects a plan without frontier", () => {
    const plan = validPlan();
    delete plan.frontier;
    expectRejected(plan, "frontier");
  });

  it("rejects empty candidates", () => {
    const plan = validPlan();
    plan.candidates = [];
    expectRejected(plan, "candidates");
  });

  it("rejects a recommended candidate that is not in candidates", () => {
    const plan = validPlan();
    plan.recommended = { action: "fix_codegen", target: "p02_min2.spec" };
    expectRejected(plan, "recommended");
  });

  it("rejects a recommended target that is not in candidates", () => {
    const plan = validPlan();
    plan.recommended = { action: "fix_spec", target: "p16_glue_len.spec" };
    expectRejected(plan, "recommended");
  });

  it("rejects a frontier without evidence", () => {
    const plan = validPlan();
    plan.frontier = {
      stage: "spec",
      target: "p02_min2.spec",
      evidence: [],
    };
    expectRejected(plan, "frontier.evidence");
  });

  it("rejects a candidate without evidence", () => {
    const plan = validPlan();
    plan.candidates = [candidate({ evidence: [] })];
    expectRejected(plan, "candidates.0.evidence");
  });

  it("rejects empty evidence elements, targets, and blockedBy entries", () => {
    const frontierPlan = validPlan();
    frontierPlan.frontier = { stage: "spec", target: "", evidence: [""] };
    expectRejected(frontierPlan, "frontier.target");
    expectRejected(frontierPlan, "frontier.evidence.0");

    const candidatePlan = validPlan();
    candidatePlan.candidates = [candidate({ evidence: [""] })];
    expectRejected(candidatePlan, "candidates.0.evidence.0");

    const recommendedPlan = validPlan();
    recommendedPlan.recommended = { action: "fix_spec", target: "" };
    expectRejected(recommendedPlan, "recommended.target");

    const blockedPlan = validPlan();
    blockedPlan.blockedBy = [""];
    expectRejected(blockedPlan, "blockedBy.0");
  });

  it("rejects duplicate (action,target) candidate pairs", () => {
    const plan = validPlan();
    candidatesOf(plan).push(
      candidate({ evidence: ["spec gate: duplicate of the same candidate"] }),
    );
    expectRejected(plan, "candidates.1");
  });

  it("rejects unknown stage, action, and risk values", () => {
    const plan = validPlan();
    plan.frontier = {
      stage: "generation",
      target: "p02_min2.spec",
      evidence: ["spec gate: red"],
    };
    expectRejected(plan, "frontier.stage");

    plan.frontier = {
      stage: "spec",
      target: "p02_min2.spec",
      evidence: ["spec gate: red"],
    };
    plan.candidates = [candidate({ action: "rewrite_everything" })];
    expectRejected(plan, "candidates.0.action");

    plan.candidates = [candidate({ risk: "extreme" })];
    expectRejected(plan, "candidates.0.risk");
  });

  it("rejects negative cost and budget values", () => {
    const plan = validPlan();
    plan.candidates = [candidate({ cost: { wallMs: -1, expansions: 2 } })];
    expectRejected(plan, "candidates.0.cost.wallMs");

    plan.candidates = [candidate({ cost: { wallMs: 120_000, expansions: -1 } })];
    expectRejected(plan, "candidates.0.cost.expansions");

    plan.candidates = [candidate()];
    plan.budget = { wallMs: -1, expansions: 20 };
    expectRejected(plan, "budget.wallMs");

    plan.budget = { wallMs: 1_800_000, expansions: -1 };
    expectRejected(plan, "budget.expansions");
  });

  it("rejects non-integer cost and budget values", () => {
    const plan = validPlan();
    plan.candidates = [candidate({ cost: { wallMs: 1.5, expansions: 2 } })];
    expectRejected(plan, "candidates.0.cost.wallMs");

    plan.candidates = [candidate()];
    plan.budget = { wallMs: 1_800_000, expansions: 1.5 };
    expectRejected(plan, "budget.expansions");
  });

  it("accepts expectedGain boundaries 0 and 1", () => {
    for (const expectedGain of [0, 1]) {
      const plan = validPlan();
      plan.candidates = [candidate({ expectedGain })];
      expect(ChengPlanSchema.parse(plan)).toEqual(plan);
    }
  });

  it("rejects expectedGain outside 0..1", () => {
    const plan = validPlan();
    plan.candidates = [candidate({ expectedGain: -0.1 })];
    expectRejected(plan, "candidates.0.expectedGain");

    plan.candidates = [candidate({ expectedGain: 1.1 })];
    expectRejected(plan, "candidates.0.expectedGain");
  });

  it("rejects NaN and Infinity expectedGain", () => {
    const plan = validPlan();
    plan.candidates = [candidate({ expectedGain: Number.NaN })];
    expectRejected(plan, "candidates.0.expectedGain");

    plan.candidates = [
      candidate({ expectedGain: Number.POSITIVE_INFINITY }),
    ];
    expectRejected(plan, "candidates.0.expectedGain");
  });

  it("rejects extra fields at every level", () => {
    const top = { ...validPlan(), note: "free text is not allowed" };
    expectRejected(top, "<root>");

    const frontier = validPlan();
    frontier.frontier = {
      stage: "spec",
      target: "p02_min2.spec",
      evidence: ["spec gate: red"],
      note: "extra",
    };
    expectRejected(frontier, "frontier");

    const candidateExtra = validPlan();
    candidateExtra.candidates = [candidate({ note: "extra" })];
    expectRejected(candidateExtra, "candidates.0");

    const candidateCostExtra = validPlan();
    candidateCostExtra.candidates = [
      candidate({ cost: { wallMs: 120_000, expansions: 2, note: "extra" } }),
    ];
    expectRejected(candidateCostExtra, "candidates.0.cost");

    const recommendedExtra = validPlan();
    recommendedExtra.recommended = {
      action: "fix_spec",
      target: "p02_min2.spec",
      note: "extra",
    };
    expectRejected(recommendedExtra, "recommended");

    const budgetExtra = validPlan();
    budgetExtra.budget = { wallMs: 1_800_000, expansions: 20, note: "extra" };
    expectRejected(budgetExtra, "budget");
  });

  it("rejects missing required top-level fields and wrong kind/schema", () => {
    for (const field of ["kind", "schema", "candidates", "recommended", "blockedBy", "budget"]) {
      const plan = validPlan();
      delete plan[field];
      expectRejected(plan, field);
    }

    const wrongKind = { ...validPlan(), kind: "plan" };
    expectRejected(wrongKind, "kind");

    const wrongSchema = {
      ...validPlan(),
      schema: "cheng.contract.cheng_plan.v2",
    };
    expectRejected(wrongSchema, "schema");
  });
});

describe("parseChengPlanJson", () => {
  it("parses a valid plan document", () => {
    const text = JSON.stringify(validPlan());
    expect(parseChengPlanJson(text)).toEqual(validPlan());
  });

  it("fails closed on malformed JSON", () => {
    const error = expectContractError(
      () => parseChengPlanJson("{ \"kind\": ", "plan.json"),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expect(error.sourcePath).toBe("plan.json");
    expect(error.detail).toContain("invalid JSON");
    expect(error.line).toBeNull();
  });

  it("fails closed on empty text and non-object roots", () => {
    expectContractError(
      () => parseChengPlanJson("", "plan.json"),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expectContractError(
      () => parseChengPlanJson("[]", "plan.json"),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("fails closed on schema-invalid JSON and reports the offending path", () => {
    const plan = validPlan();
    delete plan.frontier;
    const error = expectContractError(
      () => parseChengPlanJson(JSON.stringify(plan), "plan.json"),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expect(error.detail).toContain("frontier");
  });

  it("fails closed on extra fields and reports unrecognized keys", () => {
    const error = expectContractError(
      () =>
        parseChengPlanJson(
          JSON.stringify({ ...validPlan(), note: "extra" }),
          "plan.json",
        ),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expect(error.detail).toContain("Unrecognized key");
    expect(error.detail).toContain("note");
  });

  it("uses <memory> as the default source path", () => {
    const error = expectContractError(
      () => parseChengPlanJson("{"),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
    expect(error.sourcePath).toBe("<memory>");
    expect(error.message).toContain("<memory>");
  });
});
