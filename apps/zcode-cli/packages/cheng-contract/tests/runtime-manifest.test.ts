import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseHashesTsv,
  parseRunEnv,
  readRuntimeManifest,
} from "../src/index.js";
import {
  FIXTURES,
  expectContractError,
  fixture,
  mutateTsv,
  rowAt,
  setCell,
} from "./helpers.js";

const P02_RUN = "run-p02";
const P16_RUN = "run-p16";
const P01_RUN = "run-p01r5b";
const SYNTHETIC_HASHES = "hashes/p02.synthetic.hashes.tsv";
const REAL_HASHES = "hashes/p01_max2.hashes.tsv";

function tempRun(runEnv: string, hashes?: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cheng-runtime-"));
  writeFileSync(join(dir, "run.env"), runEnv);
  if (hashes !== undefined) {
    writeFileSync(join(dir, "hashes.tsv"), hashes);
  }
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("RuntimeManifest", () => {
  it("projects p02 run.env pins and marks hashes missing", () => {
    const manifest = readRuntimeManifest(join(FIXTURES, P02_RUN));
    expect(manifest).toMatchObject({
      kind: "runtime_manifest",
      schema: "cheng.contract.runtime_manifest.v1",
      runId: "m5-20261104T230710Z-83815",
      mode: "diagnostic",
      runEnv: {
        headSha: "cbffde93e1f039cc2017d9045b35564b43da1605",
        stdTree: "58379900d30bf3ed71df4da045c1340016d22c1c",
        driverSha256:
          "7a16e4aceaeba600284e15ab9681d35c144ba37f2485969e3e0f6c1d21f4f464",
        m5BinSha256:
          "10811a174f21f7600c1ee01a71bbe5e572c7920d46cf6c3c46d50794ab4dbc30",
        m5SrcSha256:
          "08f6dbccbdaf9508f323e21fb9fab66fb236f8c3e0abc09c330bb1913b9fadd2",
      },
      hashes: null,
    });
    expect(manifest.checks).toEqual({
      runEnvComplete: true,
      hashesPresent: false,
      hashesComplete: false,
      pinsCrossChecked: false,
      manifestComplete: false,
    });
    expect(manifest.violations).toContain(
      "hashes.tsv missing (judge sha and spec index sha unavailable)",
    );
    expect(manifest.runEnvSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.hashesPath).toBeNull();
    expect(manifest.hashesSha256).toBeNull();
  });

  it("projects p16 and p01 run.env pins", () => {
    const p16 = readRuntimeManifest(join(FIXTURES, P16_RUN));
    const p01 = readRuntimeManifest(join(FIXTURES, P01_RUN));
    expect(p16.runId).toBe("m5-20261104T230212Z-77664");
    expect(p16.mode).toBe("diagnostic");
    expect(p01.runId).toBe("m5-20261102T003843Z-53507");
    expect(p01.mode).toBe("production");
    expect(p01.runEnv.driverSha256).toBe(
      "258b7ffa9cadec5df2c974e2b96babc384d7073801772f9eba1641a20b45bd82",
    );
  });

  it("completes the manifest with matching hashes", () => {
    const manifest = readRuntimeManifest(join(FIXTURES, P02_RUN), {
      hashesPath: join(FIXTURES, SYNTHETIC_HASHES),
    });
    expect(manifest.hashes).toMatchObject({
      headSha: "cbffde93e1f039cc2017d9045b35564b43da1605",
      driverSha256:
        "7a16e4aceaeba600284e15ab9681d35c144ba37f2485969e3e0f6c1d21f4f464",
      m5BinSha256:
        "10811a174f21f7600c1ee01a71bbe5e572c7920d46cf6c3c46d50794ab4dbc30",
      judgePath: "/Users/mac/cheng-lang/data/semantic_cli/semantic_judge.py",
      judgeSha256:
        "5b9bc9131b1f8815982d5ad25e9d14044edc4c493cb03c9108b6d1aee1168519",
      specIndexPath: "/Users/mac/cheng-lang/data/spec_v2/index.json",
      specIndexSha256:
        "6936717412a74351c21aab8f22692e9cacff5d2d84426ecca725cc1286b3c9ae",
    });
    expect(manifest.checks).toEqual({
      runEnvComplete: true,
      hashesPresent: true,
      hashesComplete: true,
      pinsCrossChecked: true,
      manifestComplete: true,
    });
    expect(manifest.violations).toEqual([]);
    expect(manifest.hashesPath).toContain("p02.synthetic.hashes.tsv");
    expect(manifest.hashesSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("fails closed when real p01 run.env is paired with a different run's hashes", () => {
    const manifest = readRuntimeManifest(join(FIXTURES, P01_RUN), {
      hashesPath: join(FIXTURES, REAL_HASHES),
    });
    expect(manifest.checks).toMatchObject({
      runEnvComplete: true,
      hashesPresent: true,
      hashesComplete: true,
      pinsCrossChecked: false,
      manifestComplete: false,
    });
    expect(manifest.violations).toContain(
      "hashes.head=226855bf20e2ee573c701531a439bbca459b1a51 does not match run.env.head=4449dc5e1e7a3086811e12c3d669c1756346a200",
    );
    expect(manifest.violations).toContain(
      "hashes.m5_src_sha256=7aab5a4e6f6b005d89d1c966a30bbfc93bec270b01c2c5025b0c3e784a6cc424 does not match run.env.m5_src_sha256=9e2e47440eda75a4c7d9d3864f3555e9cdb1d8a498550fb633d177bb1700ecdb",
    );
  });

  it("parses the real p01 hashes pins", () => {
    const pins = parseHashesTsv(fixture(REAL_HASHES), REAL_HASHES);
    expect(pins).toMatchObject({
      headSha: "226855bf20e2ee573c701531a439bbca459b1a51",
      driverSha256:
        "7a16e4aceaeba600284e15ab9681d35c144ba37f2485969e3e0f6c1d21f4f464",
      m5BinSha256: null,
      judgeSha256:
        "5b9bc9131b1f8815982d5ad25e9d14044edc4c493cb03c9108b6d1aee1168519",
      specIndexSha256:
        "6936717412a74351c21aab8f22692e9cacff5d2d84426ecca725cc1286b3c9ae",
    });
  });

  it("fails closed when run.env is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cheng-runtime-"));
    try {
      expectContractError(
        () => readRuntimeManifest(dir),
        "CHENG_CONTRACT_MISSING_FILE",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate run.env keys", () => {
    const text = `${fixture(`${P02_RUN}/run.env`)}head_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`;
    expectContractError(
      () => parseRunEnv(text, "run.env"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("marks a missing head_sha as incomplete", () => {
    const text = fixture(`${P02_RUN}/run.env`)
      .split("\n")
      .filter((line) => !line.startsWith("head_sha="))
      .join("\n");
    const temp = tempRun(text);
    try {
      const manifest = readRuntimeManifest(temp.dir);
      expect(manifest.runEnv.headSha).toBeNull();
      expect(manifest.checks.runEnvComplete).toBe(false);
      expect(manifest.checks.manifestComplete).toBe(false);
      expect(manifest.violations).toContain("run.env missing head_sha");
    } finally {
      temp.remove();
    }
  });

  it("rejects a malformed head_sha", () => {
    const text = fixture(`${P02_RUN}/run.env`).replace(
      "head_sha=cbffde93e1f039cc2017d9045b35564b43da1605",
      "head_sha=abc",
    );
    expectContractError(
      () => parseRunEnv(text, "run.env"),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("marks hashes missing judge/spec_index as incomplete", () => {
    const hashes = mutateTsv(fixture(SYNTHETIC_HASHES), (rows) => {
      rows.splice(3, 2);
    });
    const temp = tempRun(fixture(`${P02_RUN}/run.env`), hashes);
    try {
      const manifest = readRuntimeManifest(temp.dir);
      expect(manifest.checks.hashesComplete).toBe(false);
      expect(manifest.checks.manifestComplete).toBe(false);
      expect(manifest.violations).toContain("hashes.tsv missing judge");
      expect(manifest.violations).toContain("hashes.tsv missing spec_index");
    } finally {
      temp.remove();
    }
  });

  it("rejects duplicate hashes keys", () => {
    const hashes = mutateTsv(fixture(SYNTHETIC_HASHES), (rows) => {
      rows.push([...rowAt(rows, 1)]);
    });
    expectContractError(
      () => parseHashesTsv(hashes, "hashes.tsv"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a hashes row with a wrong column count", () => {
    const hashes = mutateTsv(fixture(SYNTHETIC_HASHES), (rows) => {
      rowAt(rows, 1).pop();
    });
    expectContractError(
      () => parseHashesTsv(hashes, "hashes.tsv"),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a malformed hashes sha", () => {
    const hashes = mutateTsv(fixture(SYNTHETIC_HASHES), (rows) => {
      setCell(rowAt(rows, 3), 2, "abc");
    });
    expectContractError(
      () => parseHashesTsv(hashes, "hashes.tsv"),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("fails closed when an explicit hashes path is missing", () => {
    expectContractError(
      () =>
        readRuntimeManifest(join(FIXTURES, P02_RUN), {
          hashesPath: join(FIXTURES, "hashes/does-not-exist.tsv"),
        }),
      "CHENG_CONTRACT_MISSING_FILE",
    );
  });
});
