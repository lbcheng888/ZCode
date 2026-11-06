import { describe, expect, it } from "vitest";

import { parseJudgeVerdictTsv } from "../src/index.js";
import {
  expectContractError,
  fixture,
  mutateTsv,
  rowAt,
  setCell,
  single,
} from "./helpers.js";

const P02 = "run-p02/judge/judge.tsv";
const P16 = "p16.judge.tsv";

describe("JudgeVerdict", () => {
  it("projects the p02 judge row as a typed verdict", () => {
    const verdict = single(parseJudgeVerdictTsv(fixture(P02), P02));
    expect(verdict).toMatchObject({
      kind: "judge_verdict",
      schema: "cheng.contract.judge_verdict.v1",
      task: "p02_min2",
      eval: { passed: 12, total: 12 },
      props: { passed: 42, total: 42 },
      settleDiag: { passed: 20, total: 20 },
      status: "semantic_pass",
      rc: 0,
      compileRc: 0,
      runRc: 0,
    });
    expect(verdict.programSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("projects the p16 judge row", () => {
    const verdict = single(parseJudgeVerdictTsv(fixture(P16), P16));
    expect(verdict).toMatchObject({
      task: "p16_glue_len",
      eval: { passed: 12, total: 12 },
      props: { passed: 7, total: 7 },
      settleDiag: { passed: 20, total: 20 },
      status: "semantic_pass",
    });
  });

  it("rejects semantic_pass when one eval row fails", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 2, "11");
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects semantic_pass when compile_rc is nonzero", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 11, "1");
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects semantic_fail that contradicts fully passing counts", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 7, "semantic_fail");
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects semantic_pass with an empty eval set", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      const row = rowAt(rows, 1);
      setCell(row, 1, "0");
      setCell(row, 2, "0");
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects settle diagnostics whose passed count exceeds total", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 6, "21");
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects an unknown status", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 7, "maybe_pass");
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects an uppercase or truncated sha256", () => {
    const uppercase = mutateTsv(fixture(P02), (rows) => {
      const row = rowAt(rows, 1);
      const current = row[9];
      if (current === undefined) {
        throw new Error("fixture has no program sha");
      }
      setCell(row, 9, current.toUpperCase());
    });
    expectContractError(
      () => parseJudgeVerdictTsv(uppercase, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );

    const truncated = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 9, "abc");
    });
    expectContractError(
      () => parseJudgeVerdictTsv(truncated, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects semantic_pass with a missing program sha", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 9, "-");
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a negative integer cell before schema validation", () => {
    const text = mutateTsv(fixture(P02), (rows) => {
      setCell(rowAt(rows, 1), 1, "-1");
    });
    expectContractError(
      () => parseJudgeVerdictTsv(text, P02),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });
});
