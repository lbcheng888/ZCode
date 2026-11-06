import { describe, expect, it } from "vitest";

import {
  parseModuleLedgerTsv,
  type ModuleLedger,
  type ModuleRow,
} from "../src/index.js";
import {
  expectContractError,
  fixture,
  mutateTsv,
  rowAt,
  setCell,
} from "./helpers.js";

const DAG3 = "dag3/evidence/modules.tsv";

function moduleByName(ledger: ModuleLedger, name: string): ModuleRow {
  const module = ledger.modules.find((candidate) => candidate.name === name);
  if (module === undefined) {
    throw new Error(`missing module ${name}`);
  }
  return module;
}

describe("ModuleLedger", () => {
  it("projects all five dag3 modules", () => {
    const ledger = parseModuleLedgerTsv(fixture(DAG3), DAG3);
    expect(ledger).toMatchObject({
      kind: "module_ledger",
      schema: "cheng.contract.module_ledger.v1",
      sourcePath: DAG3,
    });
    expect(ledger.modules).toHaveLength(5);
    expect(ledger.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);

    const solve = moduleByName(ledger, "solve");
    expect(solve).toMatchObject({
      role: "entry",
      level: 2,
      fn: 4,
      decisions: 13,
      callEdges: 0,
      fnExamples: 9,
      fnPassed: 9,
      fnVerdict: "pass",
      programExamples: 21,
      programPassed: 21,
      programVerdict: "pass",
    });

    expect(moduleByName(ledger, "via_inc").callEdges).toBe(1);
    expect(moduleByName(ledger, "via_dbl").callEdges).toBe(0);
    expect(moduleByName(ledger, "inc").role).toBe("helper");
    expect(moduleByName(ledger, "dbl").role).toBe("helper");
  });

  it("rejects fn_passed greater than fn_examples", () => {
    const text = mutateTsv(fixture(DAG3), (rows) => {
      setCell(rowAt(rows, 5), 10, "10");
    });
    expectContractError(
      () => parseModuleLedgerTsv(text, DAG3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects fn_verdict=pass with a short count", () => {
    const text = mutateTsv(fixture(DAG3), (rows) => {
      setCell(rowAt(rows, 5), 10, "8");
    });
    expectContractError(
      () => parseModuleLedgerTsv(text, DAG3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects program_verdict=pass with a short count", () => {
    const text = mutateTsv(fixture(DAG3), (rows) => {
      setCell(rowAt(rows, 5), 13, "20");
    });
    expectContractError(
      () => parseModuleLedgerTsv(text, DAG3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects '-' program verdict with a nonzero example count", () => {
    const text = mutateTsv(fixture(DAG3), (rows) => {
      setCell(rowAt(rows, 4), 12, "1");
    });
    expectContractError(
      () => parseModuleLedgerTsv(text, DAG3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects an unknown role", () => {
    const text = mutateTsv(fixture(DAG3), (rows) => {
      setCell(rowAt(rows, 1), 3, "worker");
    });
    expectContractError(
      () => parseModuleLedgerTsv(text, DAG3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects duplicate module fn values", () => {
    const text = mutateTsv(fixture(DAG3), (rows) => {
      const clone = [...rowAt(rows, 5)];
      setCell(clone, 2, "solve_dup");
      rows.push(clone);
    });
    expectContractError(
      () => parseModuleLedgerTsv(text, DAG3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects duplicate module names", () => {
    const text = mutateTsv(fixture(DAG3), (rows) => {
      const clone = [...rowAt(rows, 1)];
      setCell(clone, 1, "99");
      rows.push(clone);
    });
    expectContractError(
      () => parseModuleLedgerTsv(text, DAG3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a malformed segment sha256", () => {
    const text = mutateTsv(fixture(DAG3), (rows) => {
      setCell(rowAt(rows, 1), 15, "abc");
    });
    expectContractError(
      () => parseModuleLedgerTsv(text, DAG3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects an empty ledger", () => {
    const header = fixture(DAG3).split("\n")[0] ?? "";
    expectContractError(
      () => parseModuleLedgerTsv(`${header}\n`, DAG3),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a negative level before schema validation", () => {
    const text = mutateTsv(fixture(DAG3), (rows) => {
      setCell(rowAt(rows, 1), 0, "-1");
    });
    expectContractError(
      () => parseModuleLedgerTsv(text, DAG3),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });
});
