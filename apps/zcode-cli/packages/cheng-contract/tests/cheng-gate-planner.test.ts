import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyRunnerExit } from "../src/cheng-error.js";
import { evaluateChengGate } from "../src/cheng-gate.js";
import { planChengNextAction } from "../src/cheng-planner.js";
import { readRunVolume } from "../src/adapters/run-volume.js";
import { readSettleReceipt } from "../src/adapters/trace.js";
import { readStructureReceipt } from "../src/adapters/spec.js";
import type { RunVolumeReceipt } from "../src/run-volume.js";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixture = (...segments: string[]): string => join(FIXTURES, ...segments);

const P02_RUN = readRunVolume(fixture("run-p02"));
const P02_SETTLE = readSettleReceipt(fixture("run-p02", "trace.jsonl"));
const P01_RUN = readRunVolume(fixture("run-p01r5b"));
const P01_SETTLE = readSettleReceipt(fixture("run-p01r5b", "trace.jsonl"));
const DAG3_STRUCTURE = readStructureReceipt(
  fixture("specs", "c01_dag3_par.spec.json"),
  fixture("dag3", "evidence", "modules.tsv"),
);

function p06Error() {
  const report = readFileSync(fixture("run-p06", "report.txt"), "utf8")
    .trim()
    .split("\n");
  const error = classifyRunnerExit(31, report);
  if (error === null) throw new Error("p06 contract returned PASS");
  return error;
}

describe("ChengGate", () => {
  it("passes a real p02 diagnostic run and never calls it production", () => {
    const gate = evaluateChengGate({
      error: null,
      run: P02_RUN,
      settle: P02_SETTLE,
      structure: null,
      mode: "diagnostic",
    });
    expect(gate).toEqual({ ok: true, level: "DIAGNOSTIC_NOT_ACCEPTANCE", reasons: [] });
  });

  it("blocks a real p06 red run from its structured ChengError", () => {
    const error = p06Error();
    expect(error).toMatchObject({ code: 31, class: "unsolved", retryable: false });
    const gate = evaluateChengGate({
      error,
      run: null,
      settle: null,
      structure: null,
      mode: "diagnostic",
    });
    expect(gate.ok).toBe(false);
    expect(gate.level).toBe("BLOCKED");
    expect(gate.reasons).toEqual(
      expect.arrayContaining(["runner_rc=31", "error_class=unsolved", "run_volume_missing"]),
    );
  });

  it("blocks a structure-gate red receipt", () => {
    const gate = evaluateChengGate({
      error: null,
      run: P02_RUN,
      settle: P02_SETTLE,
      structure: DAG3_STRUCTURE,
      mode: "diagnostic",
    });
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toContain("structure_gate_false");
  });

  it("blocks when a judge row is not semantic_pass", () => {
    const judge = P02_RUN.judge[0];
    if (judge === undefined) throw new Error("p02 fixture has no judge row");
    const tampered: RunVolumeReceipt = {
      ...P02_RUN,
      judge: [{ ...judge, status: "semantic_fail" }],
    };
    const gate = evaluateChengGate({
      error: null,
      run: tampered,
      settle: P02_SETTLE,
      structure: null,
      mode: "diagnostic",
    });
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toContain("judge_not_semantic_pass:p02_min2");
  });

  it("requires production acceptance, manifest and structure for production mode", () => {
    const diagnosticAsProduction = evaluateChengGate({
      error: null,
      run: P02_RUN,
      settle: P02_SETTLE,
      structure: null,
      mode: "production",
      runtimeManifestComplete: true,
    });
    expect(diagnosticAsProduction.ok).toBe(false);
    expect(diagnosticAsProduction.reasons).toEqual(
      expect.arrayContaining([
        "acceptance_level:DIAGNOSTIC_NOT_ACCEPTANCE",
        "production_acceptance_false",
        "structure_missing",
      ]),
    );

    const productionWithoutStructure = evaluateChengGate({
      error: null,
      run: P01_RUN,
      settle: P01_SETTLE,
      structure: null,
      mode: "production",
      runtimeManifestComplete: true,
    });
    expect(productionWithoutStructure.ok).toBe(false);
    expect(productionWithoutStructure.reasons).toContain("structure_missing");
  });
});

describe("deterministic Cheng planner", () => {
  it("plans fix_spec for the real p06 red run", () => {
    const result = planChengNextAction({
      error: p06Error(),
      run: null,
      settle: null,
      structure: null,
      mode: "diagnostic",
      task: "p06_fib",
    });
    expect(result.gate.ok).toBe(false);
    expect(result.plan.frontier.stage).toBe("spec");
    expect(result.plan.frontier.target).toBe("p06_fib");
    expect(result.plan.recommended).toEqual({ action: "fix_spec", target: "p06_fib" });
    expect(result.plan.blockedBy).toEqual(
      expect.arrayContaining(["runner_rc=31", "error_class=unsolved"]),
    );
    const raiseBudget = result.plan.candidates.find((candidate) => candidate.action === "raise_budget");
    expect(raiseBudget?.cost.expansions).toBe(11_044_292);
    expect(result.plan.frontier.evidence.length).toBeGreaterThan(0);
  });

  it("stops a diagnostic-green p02 run and keeps production blocked", () => {
    const result = planChengNextAction({
      error: null,
      run: P02_RUN,
      settle: P02_SETTLE,
      structure: null,
      mode: "diagnostic",
      task: "p02_min2",
    });
    expect(result.gate.ok).toBe(true);
    expect(result.gate.level).toBe("DIAGNOSTIC_NOT_ACCEPTANCE");
    expect(result.plan.recommended).toEqual({
      action: "stop",
      target: "diagnostic_acceptance",
    });
    expect(result.plan.blockedBy).toContain("production_requires_provenance");
    expect(result.plan.candidates.some((candidate) => candidate.action === "stop")).toBe(true);
  });

  it("does not recommend stop/production when the production gate is red", () => {
    const result = planChengNextAction({
      error: null,
      run: P02_RUN,
      settle: P02_SETTLE,
      structure: null,
      mode: "production",
      task: "p02_min2",
      runtimeManifestComplete: true,
    });
    expect(result.gate.ok).toBe(false);
    expect(result.plan.recommended.action).not.toBe("stop");
    expect(result.plan.blockedBy.length).toBeGreaterThan(0);
  });
});
