import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readModuleLedger,
  readRunVolume,
  readSettleReceipt,
} from "../src/index.js";

const realRoot = process.env.CHENG_REAL_RUN_ROOT;
const describeReal = realRoot ? describe : describe.skip;

const P02_RUN = join(
  ".c0run",
  "codegen-serial",
  "diagnostic",
  "p02_min2",
  "attempt2",
  "runs",
  "m5-20261104T230710Z-83815",
);
const P16_RUN = join(
  ".c0run",
  "codegen-serial",
  "diagnostic",
  "p16_glue_len",
  "attempt2",
  "runs",
  "m5-20261104T230212Z-77664",
);
const P01_RUN = join(
  ".c0run",
  "csg-m5-gate",
  "zero-c-production-m5-20261102T003843Z-53507",
);
const P02_TRACE = join(
  ".c0run",
  "csg_integration_r1",
  "evidence",
  "per_task",
  "p02_min2",
  "trace.jsonl",
);
const P16_TRACE = join(
  ".c0run",
  "csg_integration_r1",
  "evidence",
  "per_task",
  "p16_glue_len",
  "trace.jsonl",
);
const P01_TRACE = join(
  ".c0run",
  "csg_integration_r1",
  "evidence",
  "prod19b",
  "p01",
  "trace.jsonl",
);
const DAG3_MODULES = join(".c0run", "p3_dag3_gate", "k1", "evidence", "modules.tsv");

describeReal("real Cheng run volumes (CHENG_REAL_RUN_ROOT)", () => {
  const root = realRoot ?? "";
  const p02Run = join(root, P02_RUN);
  const p16Run = join(root, P16_RUN);
  const p01Run = join(root, P01_RUN);
  const p02Trace = join(root, P02_TRACE);
  const p16Trace = join(root, P16_TRACE);
  const p01Trace = join(root, P01_TRACE);
  const dag3Modules = join(root, DAG3_MODULES);

  if (existsSync(p02Run)) {
    it("reads the p02 diagnostic run volume", () => {
      const receipt = readRunVolume(p02Run);
      expect(receipt.runId).toBe("m5-20261104T230710Z-83815");
      expect(receipt.judge).toHaveLength(1);
      expect(receipt.judge[0]).toMatchObject({
        task: "p02_min2",
        eval: { passed: 12, total: 12 },
        props: { passed: 42, total: 42 },
        settleDiag: { passed: 20, total: 20 },
        status: "semantic_pass",
        compileRc: 0,
        runRc: 0,
        programSha256:
          "947631e19019189db5f3e24ff2c1378d6cb44d56ea7eac881f3907659311fa95",
      });
      expect(receipt.progReceipts[0]).toMatchObject({
        task: "p02_min2",
        judge: "semantic_pass",
        status: "judged",
      });
      expect(receipt.acceptance).toEqual({
        mode: "diagnostic",
        level: "DIAGNOSTIC_NOT_ACCEPTANCE",
        productionAcceptance: false,
        verdict: "DIAGNOSTIC_NOT_ACCEPTANCE",
      });
      expect(receipt.checks.judgeRowsDeclared).toBe(true);
      expect(receipt.checks.acceptanceClassified).toBe(true);
      expect(receipt.moduleLedger).toBeNull();
    });
  }

  if (existsSync(p16Run)) {
    it("reads the p16 diagnostic run volume", () => {
      const receipt = readRunVolume(p16Run);
      expect(receipt.judge[0]).toMatchObject({
        task: "p16_glue_len",
        eval: { passed: 12, total: 12 },
        props: { passed: 7, total: 7 },
        settleDiag: { passed: 20, total: 20 },
        status: "semantic_pass",
        programSha256:
          "cf90df8574e45325405dbe96fc7a8de400b9e595a5951ba5a868580df90937aa",
      });
      expect(receipt.progReceipts[0]).toMatchObject({
        task: "p16_glue_len",
        judge: "semantic_pass",
        status: "judged",
      });
      expect(receipt.acceptance.level).toBe("DIAGNOSTIC_NOT_ACCEPTANCE");
      expect(receipt.checks.judgeRowsDeclared).toBe(true);
    });
  }

  if (existsSync(p01Run)) {
    it("reads the production p01 run volume", () => {
      const receipt = readRunVolume(p01Run);
      expect(receipt.judge[0]).toMatchObject({
        task: "p01_max2",
        eval: { passed: 12, total: 12 },
        props: { passed: 49, total: 49 },
        status: "semantic_pass",
        programSha256:
          "9e3858786893943c0ebf4f2edf7d83476879b1810e78503ba0c8983885fc4554",
      });
      expect(receipt.acceptance).toEqual({
        mode: "production",
        level: "PRODUCTION",
        productionAcceptance: true,
        verdict: "PASS",
      });
      expect(receipt.checks).toEqual({
        judgeRowsDeclared: true,
        programShaPresent: true,
        programShaMatchesProg: true,
        acceptanceClassified: true,
      });
    });
  }

  if (existsSync(p02Trace)) {
    it("reads the real p02 settle trace", () => {
      const receipt = readSettleReceipt(p02Trace);
      expect(receipt.task).toBe("p02_min2");
      expect(receipt.settles).toHaveLength(2);
      expect(receipt.traceDone).toMatchObject({
        solved: true,
        finalPassed: 20,
        finalExamples: 20,
      });
    });
  }

  if (existsSync(p16Trace)) {
    it("reads the real p16 settle trace", () => {
      const receipt = readSettleReceipt(p16Trace);
      expect(receipt.task).toBe("p16_glue_len");
      expect(receipt.settles).toHaveLength(2);
      expect(receipt.traceDone.solved).toBe(true);
    });
  }

  if (existsSync(p01Trace)) {
    it("reads the real p01 settle trace", () => {
      const receipt = readSettleReceipt(p01Trace);
      expect(receipt.task).toBe("p01_max2");
      expect(receipt.settles).toHaveLength(2);
      expect(receipt.traceDone.solved).toBe(true);
    });
  }

  if (existsSync(dag3Modules)) {
    it("reads the dag3 module ledger and its call edges", () => {
      const ledger = readModuleLedger(dag3Modules);
      expect(ledger.modules).toHaveLength(5);
      const solve = ledger.modules.find((module) => module.name === "solve");
      const viaInc = ledger.modules.find((module) => module.name === "via_inc");
      const viaDbl = ledger.modules.find((module) => module.name === "via_dbl");
      expect(solve).toMatchObject({
        role: "entry",
        programExamples: 21,
        programPassed: 21,
        programVerdict: "pass",
      });
      expect(viaInc?.callEdges).toBe(1);
      expect(viaDbl?.callEdges).toBe(0);
    });
  }
});
