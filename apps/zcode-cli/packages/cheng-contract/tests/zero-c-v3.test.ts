import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ChengLeafProbeReceiptSchema,
  ChengSurfaceReportSchema,
  FourLayerCycleReceiptSchema,
  evaluateChengGate,
  parseDonorsTsv,
  parseZeroCTsv,
  readChengSpecRef,
  readRunVolume,
  readRuntimeManifest,
  readSettleReceipt,
  readZeroCReceipt,
} from "../src/index.js";

const REAL_PROD_RUN =
  "/Users/mac/cheng-lang/.c0run/four_layer_r2/csg_prod/prod_run/runs/m5-20261117T151901Z-40072";
const REAL_FOUR_LAYER_RECEIPT = "/Users/mac/cheng-lang/.c0run/four_layer_r2/RECEIPT.json";
const REAL_P02_SPEC = "/Users/mac/cheng-lang/data/spec_v2/tasks/p02_min2.spec.json";
const REAL_INDEX = "/Users/mac/cheng-lang/data/spec_v2/index.json";

describe("v3 zero-c & surface contracts", () => {
  it("validates ChengSurfaceReportSchema and ChengLeafProbeReceiptSchema", () => {
    const sha = "a".repeat(64);
    const surface = ChengSurfaceReportSchema.parse({
      schema: "cheng.contract.surface_report.v1",
      filePath: "/tmp/leaf.cheng",
      fileSha256: sha,
      v4Ok: false,
      budgetOk: true,
      lineCount: 12,
      lineCapOk: true,
      ok: false,
      violations: [
        {
          code: "ZD01",
          line: 3,
          column: 1,
          message: "zero-default var is forbidden in v4.0",
          source: "v4",
        },
      ],
      truncatedCount: 0,
    });
    expect(surface.ok).toBe(false);

    const probe = ChengLeafProbeReceiptSchema.parse({
      schema: "cheng.contract.leaf_probe.v1",
      filePath: "/tmp/leaf.cheng",
      driverSha256: sha,
      exitCode: 0,
      objPath: "/tmp/leaf.o",
      objBytes: 1024,
      compileMaxRssBytes: 24_000_000,
      wallMs: 250,
      admissionTicketId: "probe-1",
      ok: true,
      firstError: null,
    });
    expect(probe.ok).toBe(true);
  });

  it("parses zero_c.tsv and donors.tsv strictly", () => {
    const sha = "b".repeat(64);
    const kv = parseZeroCTsv(
      "key\tvalue\ncold_provider_used\t0\nc_backend_used\t0\norc_used\t0\n",
      "/tmp/zero_c.tsv",
    );
    expect(kv.get("cold_provider_used")).toBe("0");

    const donors = parseDonorsTsv(
      `index\tkind\tobject_sha256\tsource\tsource_sha256\tcompiler_sha256\n1\tpure_cheng\t${sha}\ta.cheng\t${sha}\t${sha}\n`,
      "/tmp/donors.tsv",
    );
    expect(donors).toHaveLength(1);
    expect(donors[0]?.compilerSha256).toBe(sha);
  });

  it.skipIf(!existsSync(REAL_FOUR_LAYER_RECEIPT))(
    "validates real FourLayerCycleReceipt from cheng-lang",
    () => {
      const raw = JSON.parse(readFileSync(REAL_FOUR_LAYER_RECEIPT, "utf8")) as unknown;
      const parsed = FourLayerCycleReceiptSchema.parse(raw);
      expect(parsed.verdict).toBe("PASS");
      expect(parsed.i1_counterexample_loop.forbidden_holdout_reads).toBe(0);
      expect(parsed.sleep_library.forbidden_holdout_reads).toBe(0);
    },
  );

  it.skipIf(!existsSync(REAL_PROD_RUN))(
    "passes real Stage 3 zero-C production run m5-20261117T151901Z-40072 through ChengGate as PRODUCTION",
    () => {
      const run = readRunVolume(REAL_PROD_RUN);
      const settle = readSettleReceipt(join(REAL_PROD_RUN, "tasks", "p02_min2", "replay.run1", "trace.jsonl"));
      const manifest = readRuntimeManifest(REAL_PROD_RUN);
      const specRef = readChengSpecRef(REAL_P02_SPEC, REAL_INDEX);
      const driverSha = manifest.runEnv.driverSha256 ?? undefined;
      const zeroC = readZeroCReceipt(REAL_PROD_RUN, {
        expectedDriverSha256: driverSha,
      });

      expect(manifest.checks.manifestComplete).toBe(true);
      expect(zeroC.checks.zeroCProductionOk).toBe(true);
      expect(zeroC.pureChengDonorCount).toBe(47);

      const gate = evaluateChengGate({
        error: null,
        run,
        settle,
        structure: null,
        mode: "production",
        runtimeManifestComplete: manifest.checks.manifestComplete,
        specRef,
        zeroC,
      });
      expect(gate).toEqual({ ok: true, level: "PRODUCTION", reasons: [] });

      // Fault injection: tampered zeroC -> BLOCKED with zero_c_violation
      const badZeroC = {
        ...zeroC,
        cProviderObjectCount: 1,
        checks: { ...zeroC.checks, cProviderObjectsZero: false, zeroCProductionOk: false },
      };
      const blockedZeroC = evaluateChengGate({
        error: null,
        run,
        settle,
        structure: null,
        mode: "production",
        runtimeManifestComplete: manifest.checks.manifestComplete,
        specRef,
        zeroC: badZeroC,
      });
      expect(blockedZeroC.ok).toBe(false);
      expect(blockedZeroC.level).toBe("BLOCKED");
      expect(blockedZeroC.reasons).toContain("zero_c_violation");

      // Fault injection: multi-module specRef with composes edge & structure: null -> structure_missing
      const multiSpec = {
        ...specRef,
        links: [{ id: "l1", from: "a", to: "b", type: "composes" as const }],
      };
      const blockedStructure = evaluateChengGate({
        error: null,
        run,
        settle,
        structure: null,
        mode: "production",
        runtimeManifestComplete: manifest.checks.manifestComplete,
        specRef: multiSpec,
        zeroC,
      });
      expect(blockedStructure.ok).toBe(false);
      expect(blockedStructure.reasons).toContain("structure_missing");
    },
  );
});
