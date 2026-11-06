import { describe, expect, it } from "vitest";

import { parseJudgeInputsTsv } from "../src/index.js";
import {
  expectContractError,
  fixture,
  mutateTsv,
  rowAt,
  setCell,
} from "./helpers.js";

const P02 = "run-p02/judge_inputs.tsv";
const P01 = "run-p01r5b/judge_inputs.tsv";

describe("JudgeInputsReceipt", () => {
  it("projects the p02 eval/property declarations", () => {
    const receipt = parseJudgeInputsTsv(fixture(P02), P02);
    expect(receipt).toMatchObject({
      kind: "judge_inputs",
      schema: "cheng.contract.judge_inputs.v1",
      sourcePath: P02,
    });
    expect(receipt.rows).toHaveLength(2);
    const evalRow = receipt.rows.find((row) => row.tier === "eval");
    const propertyRow = receipt.rows.find((row) => row.tier === "property");
    expect(evalRow).toMatchObject({
      task: "p02_min2",
      rows: 12,
      declaredRows: 12,
    });
    expect(propertyRow).toMatchObject({
      task: "p02_min2",
      rows: 42,
      declaredRows: 42,
    });
    expect(receipt.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("projects the production p01 property declaration", () => {
    const receipt = parseJudgeInputsTsv(fixture(P01), P01);
    const propertyRow = receipt.rows.find((row) => row.tier === "property");
    expect(propertyRow).toMatchObject({
      task: "p01_max2",
      rows: 49,
      declaredRows: 49,
    });
  });

  it("rejects a declared sha mismatch", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 4, "0".repeat(64));
    });
    expectContractError(
      () => parseJudgeInputsTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a rows/declared_rows mismatch", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 5, "11");
    });
    expectContractError(
      () => parseJudgeInputsTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects zero rows", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      const row = rowAt(rows, 1);
      setCell(row, 5, "0");
      setCell(row, 6, "0");
    });
    expectContractError(
      () => parseJudgeInputsTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a duplicate tier for one task", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      rows.push([...rowAt(rows, 1)]);
    });
    expectContractError(
      () => parseJudgeInputsTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a task missing its property row", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      rows.splice(2, 1);
    });
    expectContractError(
      () => parseJudgeInputsTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects an unknown tier", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 1, "settle");
    });
    expectContractError(
      () => parseJudgeInputsTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });
});
