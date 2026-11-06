import { describe, expect, it } from "vitest";

import { parseProgReceiptTsv } from "../src/index.js";
import {
  expectContractError,
  fixture,
  mutateTsv,
  rowAt,
  setCell,
  single,
} from "./helpers.js";

const P02 = "run-p02/prog_receipts.tsv";
const P16 = "p16.prog_receipts.tsv";

describe("ProgReceipt", () => {
  it("projects the p02 receipt and its judge backfill", () => {
    const receipt = single(parseProgReceiptTsv(fixture(P02), P02));
    expect(receipt).toMatchObject({
      kind: "prog_receipt",
      schema: "cheng.contract.prog_receipt.v1",
      task: "p02_min2",
      progSha256: "947631e19019189db5f3e24ff2c1378d6cb44d56ea7eac881f3907659311fa95",
      compileRc: 0,
      runRc: 0,
      judge: "semantic_pass",
      status: "judged",
    });
    expect(receipt.exeSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.reportSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("projects the p16 receipt", () => {
    const receipt = single(parseProgReceiptTsv(fixture(P16), P16));
    expect(receipt).toMatchObject({
      task: "p16_glue_len",
      progSha256: "cf90df8574e45325405dbe96fc7a8de400b9e595a5951ba5a868580df90937aa",
      judge: "semantic_pass",
      status: "judged",
    });
  });

  it("rejects semantic_pass without the judged status", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 7, "pending");
    });
    expectContractError(
      () => parseProgReceiptTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects semantic_pass with a nonzero compile_rc", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 4, "1");
    });
    expectContractError(
      () => parseProgReceiptTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects an unknown judge state", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 6, "probably_pass");
    });
    expectContractError(
      () => parseProgReceiptTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects semantic_pass with a missing program sha", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 1, "-");
    });
    expectContractError(
      () => parseProgReceiptTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects semantic_fail paired with judged", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      const row = rowAt(rows, 1);
      setCell(row, 6, "semantic_fail");
      setCell(row, 7, "judged");
    });
    expectContractError(
      () => parseProgReceiptTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a negative run_rc before schema validation", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 5, "-2");
    });
    expectContractError(
      () => parseProgReceiptTsv(text, P02),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });
});
