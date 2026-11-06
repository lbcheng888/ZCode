import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { readRunVolume } from "../src/index.js";
import {
  FIXTURES,
  expectContractError,
  fixture,
  mutateTsv,
  rowAt,
  setCell,
} from "./helpers.js";

const P02_RUN = "run-p02";
const P02_JUDGE = "run-p02/judge/judge.tsv";
const P02_PROG = "run-p02/prog_receipts.tsv";
const P02_INPUTS = "run-p02/judge_inputs.tsv";
const P02_REPORT = "run-p02/report.txt";
const P02_ENV = "run-p02/run.env";
const P16_RUN = "run-p16";
const P16_PROG = "p16.prog_receipts.tsv";
const P01_RUN = "run-p01r5b";
const P01_JUDGE = "run-p01r5b/judge/judge.tsv";
const P01_PROG = "run-p01r5b/prog_receipts.tsv";
const P01_INPUTS = "run-p01r5b/judge_inputs.tsv";
const P01_REPORT = "run-p01r5b/report.txt";
const DAG3_MODULES = "dag3/evidence/modules.tsv";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cheng-contract-"));
}

function writeRun(
  dir: string,
  judge: string,
  prog: string,
  extras: Record<string, string> = {},
): void {
  mkdirSync(join(dir, "judge"), { recursive: true });
  writeFileSync(join(dir, "judge", "judge.tsv"), judge);
  writeFileSync(join(dir, "prog_receipts.tsv"), prog);
  for (const [relative, content] of Object.entries(extras)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function remove(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("RunVolumeReceipt", () => {
  it("projects the p02 run volume and binds artifact hashes", () => {
    const receipt = readRunVolume(join(FIXTURES, P02_RUN));
    expect(receipt).toMatchObject({
      kind: "run_volume",
      schema: "cheng.contract.run_volume.v1",
      runId: P02_RUN,
    });
    expect(receipt.judge).toHaveLength(1);
    expect(receipt.progReceipts).toHaveLength(1);
    expect(receipt.judgeInputs?.rows).toHaveLength(2);
    expect(receipt.acceptance).toEqual({
      mode: "diagnostic",
      level: "DIAGNOSTIC_NOT_ACCEPTANCE",
      productionAcceptance: false,
      verdict: "DIAGNOSTIC_NOT_ACCEPTANCE",
    });
    expect(receipt.checks).toEqual({
      judgeRowsDeclared: true,
      programShaPresent: true,
      programShaMatchesProg: true,
      acceptanceClassified: true,
    });
    expect(receipt.moduleLedger).toBeNull();
    expect(receipt.artifacts.modulesTsv).toBeNull();
    expect(receipt.artifacts.judgeTsv.sha256).toBe(
      sha256(readFileSync(join(FIXTURES, P02_JUDGE))),
    );
    expect(receipt.artifacts.progReceiptsTsv.sha256).toBe(
      sha256(readFileSync(join(FIXTURES, P02_PROG))),
    );
    expect(receipt.artifacts.judgeInputsTsv?.sha256).toBe(
      sha256(readFileSync(join(FIXTURES, P02_INPUTS))),
    );
    expect(receipt.artifacts.reportTxt?.sha256).toBe(
      sha256(readFileSync(join(FIXTURES, P02_REPORT))),
    );
    expect(receipt.artifacts.runEnv?.sha256).toBe(
      sha256(readFileSync(join(FIXTURES, P02_ENV))),
    );
  });

  it("projects the p16 diagnostic run volume", () => {
    const receipt = readRunVolume(join(FIXTURES, P16_RUN));
    expect(receipt.acceptance.level).toBe("DIAGNOSTIC_NOT_ACCEPTANCE");
    expect(receipt.judge[0]?.props).toEqual({ passed: 7, total: 7 });
    expect(receipt.checks.judgeRowsDeclared).toBe(true);
    expect(receipt.checks.acceptanceClassified).toBe(true);
  });

  it("projects the production p01 run volume", () => {
    const receipt = readRunVolume(join(FIXTURES, P01_RUN));
    expect(receipt.acceptance).toEqual({
      mode: "production",
      level: "PRODUCTION",
      productionAcceptance: true,
      verdict: "PASS",
    });
    expect(receipt.judge[0]?.props).toEqual({ passed: 49, total: 49 });
    expect(receipt.checks).toEqual({
      judgeRowsDeclared: true,
      programShaPresent: true,
      programShaMatchesProg: true,
      acceptanceClassified: true,
    });
  });

  it("rejects judge rows that disagree with judge_inputs declared_rows", () => {
    const dir = tempDir();
    try {
      const judge = mutateTsv(fixture(P02_JUDGE), (rows) => {
        const row = rowAt(rows, 1);
        setCell(row, 1, "1");
        setCell(row, 2, "1");
        setCell(row, 3, "1");
        setCell(row, 4, "1");
      });
      writeRun(dir, judge, fixture(P02_PROG), {
        "judge_inputs.tsv": fixture(P02_INPUTS),
        "report.txt": fixture(P02_REPORT),
        "run.env": fixture(P02_ENV),
      });
      expectContractError(
        () => readRunVolume(dir),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    } finally {
      remove(dir);
    }
  });

  it("marks a receipt without judge_inputs as unverified", () => {
    const dir = tempDir();
    try {
      writeRun(dir, fixture(P02_JUDGE), fixture(P02_PROG), {
        "report.txt": fixture(P02_REPORT),
        "run.env": fixture(P02_ENV),
      });
      const receipt = readRunVolume(dir);
      expect(receipt.judgeInputs).toBeNull();
      expect(receipt.checks.judgeRowsDeclared).toBe(false);
      expect(receipt.acceptance.level).toBe("DIAGNOSTIC_NOT_ACCEPTANCE");
    } finally {
      remove(dir);
    }
  });

  it("marks a receipt without report.txt as acceptance-unknown", () => {
    const dir = tempDir();
    try {
      writeRun(dir, fixture(P02_JUDGE), fixture(P02_PROG), {
        "judge_inputs.tsv": fixture(P02_INPUTS),
        "run.env": fixture(P02_ENV),
      });
      const receipt = readRunVolume(dir);
      expect(receipt.acceptance).toEqual({
        mode: "diagnostic",
        level: "UNKNOWN",
        productionAcceptance: null,
        verdict: null,
      });
      expect(receipt.checks.acceptanceClassified).toBe(false);
    } finally {
      remove(dir);
    }
  });

  it("rejects a PRODUCTION claim paired with diagnostic mode", () => {
    const dir = tempDir();
    try {
      writeRun(dir, fixture(P01_JUDGE), fixture(P01_PROG), {
        "judge_inputs.tsv": fixture(P01_INPUTS),
        "report.txt": fixture(P01_REPORT),
        "run.env": fixture(P02_ENV),
      });
      expectContractError(
        () => readRunVolume(dir),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    } finally {
      remove(dir);
    }
  });

  it("honors an explicit runId", () => {
    const receipt = readRunVolume(join(FIXTURES, P02_RUN), { runId: "p02_min2" });
    expect(receipt.runId).toBe("p02_min2");
  });

  it("attaches an explicit module ledger", () => {
    const receipt = readRunVolume(join(FIXTURES, P02_RUN), {
      modulesPath: join(FIXTURES, DAG3_MODULES),
    });
    expect(receipt.moduleLedger?.modules).toHaveLength(5);
    expect(receipt.artifacts.modulesTsv?.sha256).toBe(
      sha256(readFileSync(join(FIXTURES, DAG3_MODULES))),
    );
  });

  it("auto-discovers evidence/modules.tsv", () => {
    const dir = tempDir();
    try {
      writeRun(dir, fixture(P02_JUDGE), fixture(P02_PROG));
      mkdirSync(join(dir, "evidence"), { recursive: true });
      writeFileSync(join(dir, "evidence", "modules.tsv"), fixture(DAG3_MODULES));
      const receipt = readRunVolume(dir);
      expect(receipt.moduleLedger?.modules).toHaveLength(5);
    } finally {
      remove(dir);
    }
  });

  it("fails closed when judge.tsv is missing", () => {
    const dir = tempDir();
    try {
      expectContractError(
        () => readRunVolume(dir),
        "CHENG_CONTRACT_MISSING_FILE",
      );
    } finally {
      remove(dir);
    }
  });

  it("fails closed when prog_receipts.tsv is missing", () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, "judge"), { recursive: true });
      writeFileSync(join(dir, "judge", "judge.tsv"), fixture(P02_JUDGE));
      expectContractError(
        () => readRunVolume(dir),
        "CHENG_CONTRACT_MISSING_FILE",
      );
    } finally {
      remove(dir);
    }
  });

  it("fails closed when judge and prog task sets disagree", () => {
    const dir = tempDir();
    try {
      writeRun(dir, fixture(P02_JUDGE), fixture(P16_PROG));
      expectContractError(
        () => readRunVolume(dir),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    } finally {
      remove(dir);
    }
  });

  it("fails closed when judge and prog program hashes disagree", () => {
    const dir = tempDir();
    try {
      const prog = mutateTsv(fixture(P02_PROG), (rows) => {
        setCell(rowAt(rows, 1), 1, "0".repeat(64));
      });
      writeRun(dir, fixture(P02_JUDGE), prog);
      expectContractError(
        () => readRunVolume(dir),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    } finally {
      remove(dir);
    }
  });

  it("fails closed on duplicate judge tasks", () => {
    const dir = tempDir();
    try {
      const judge = mutateTsv(fixture(P02_JUDGE), (rows) => {
        rows.push([...rowAt(rows, 1)]);
      });
      writeRun(dir, judge, fixture(P02_PROG));
      expectContractError(
        () => readRunVolume(dir),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    } finally {
      remove(dir);
    }
  });

  it("fails closed when an explicit module ledger is missing", () => {
    expectContractError(
      () =>
        readRunVolume(join(FIXTURES, P02_RUN), {
          modulesPath: join(FIXTURES, "does-not-exist.tsv"),
        }),
      "CHENG_CONTRACT_MISSING_FILE",
    );
  });
});
