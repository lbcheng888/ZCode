import { describe, expect, it } from "vitest";

import { parseJudgeVerdictTsv, parseStrictTsv } from "../src/index.js";
import {
  expectContractError,
  fixture,
  mutateTsv,
  rowAt,
  setCell,
} from "./helpers.js";

const P02 = "run-p02/judge/judge.tsv";
const JUDGE_HEADER = [
  "task",
  "n_eval",
  "eval_ok",
  "n_props",
  "props_ok",
  "n_settle_diag",
  "settle_ok_diag",
  "status",
  "rc",
  "program_sha256",
  "note",
  "compile_rc",
  "run_rc",
] as const;

describe("strict TSV fail-closed behavior", () => {
  it("rejects a reordered header", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      const header = rowAt(rows, 0);
      const first = header[0];
      const second = header[1];
      if (first === undefined || second === undefined) {
        throw new Error("fixture header is too short");
      }
      setCell(header, 0, second);
      setCell(header, 1, first);
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a row with an extra column", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      rowAt(rows, 1).push("extra");
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a row with a missing column", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      rowAt(rows, 1).pop();
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a blank line", () => {
    const text = fixture(P02).replace("\n", "\n\n");
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a UTF-8 BOM", () => {
    expectContractError(
      () => parseJudgeVerdictTsv(`\uFEFF${fixture(P02)}`, P02),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects an empty file", () => {
    expectContractError(
      () => parseJudgeVerdictTsv("", P02),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("accepts CRLF line endings without weakening column checks", () => {
    const crlf = fixture(P02).replace(/\n/gu, "\r\n");
    const table = parseStrictTsv({
      text: crlf,
      expectedHeader: JUDGE_HEADER,
      sourcePath: P02,
    });
    expect(table.rows).toHaveLength(1);
  });
});
