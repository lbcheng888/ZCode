import { z } from "zod";

import { Sha256Schema } from "./primitives.js";

export const FortyHexSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/u, "expected a lowercase 40-hex commit/tree id");

export const RunEnvPinsSchema = z
  .object({
    headSha: FortyHexSchema.nullable(),
    stdTree: FortyHexSchema.nullable(),
    driverSha256: Sha256Schema.nullable(),
    m5BinSha256: Sha256Schema.nullable(),
    m5SrcSha256: Sha256Schema.nullable(),
    specLibSrcSha256: Sha256Schema.nullable(),
    traceJudgeSrcSha256: Sha256Schema.nullable(),
    traceJudgeBinSha256: Sha256Schema.nullable(),
    specIndexPath: z.string().min(1).nullable(),
    oracleRoot: z.string().min(1).nullable(),
  })
  .strict();

export type RunEnvPins = z.infer<typeof RunEnvPinsSchema>;

export const HashesPinsSchema = z
  .object({
    headSha: FortyHexSchema.nullable(),
    driverSha256: Sha256Schema.nullable(),
    m5BinSha256: Sha256Schema.nullable(),
    m5SrcSha256: Sha256Schema.nullable(),
    specLibSrcSha256: Sha256Schema.nullable(),
    traceJudgeSrcSha256: Sha256Schema.nullable(),
    judgePath: z.string().min(1).nullable(),
    judgeSha256: Sha256Schema.nullable(),
    specIndexPath: z.string().min(1).nullable(),
    specIndexSha256: Sha256Schema.nullable(),
  })
  .strict();

export type HashesPins = z.infer<typeof HashesPinsSchema>;

export const RuntimeChecksSchema = z
  .object({
    runEnvComplete: z.boolean(),
    hashesPresent: z.boolean(),
    hashesComplete: z.boolean(),
    pinsCrossChecked: z.boolean(),
    manifestComplete: z.boolean(),
  })
  .strict();

export type RuntimeChecks = z.infer<typeof RuntimeChecksSchema>;

type RuntimeMode = "production" | "diagnostic" | "unknown";

interface RuntimeCheckInput {
  runId: string;
  mode: RuntimeMode;
  runEnv: RunEnvPins;
  hashes: HashesPins | null;
}

interface RuntimeCheckResult {
  checks: RuntimeChecks;
  violations: string[];
}

function comparePin(
  violations: string[],
  name: string,
  envValue: string | null,
  hashesValue: string | null,
): void {
  if (envValue === null || hashesValue === null) {
    return;
  }
  if (envValue !== hashesValue) {
    violations.push(
      `hashes.${name}=${hashesValue} does not match run.env.${name}=${envValue}`,
    );
  }
}

/**
 * Compute RuntimeManifest completeness from `run.env` and optional `hashes.tsv`.
 *
 * `run.env` carries head/driver/m5 pins; `hashes.tsv` carries judge and
 * spec-index pins. A manifest without hashes is valid but incomplete: the
 * consumer must require `manifestComplete=true` for production.
 */
export function computeRuntimeChecks(
  value: RuntimeCheckInput,
): RuntimeCheckResult {
  const violations: string[] = [];
  const env = value.runEnv;

  if (value.runId.length === 0) {
    violations.push("run.env missing run_id");
  }
  if (value.mode === "unknown") {
    violations.push("run.env mode is unknown");
  }
  for (const [name, pin] of [
    ["head_sha", env.headSha],
    ["std_tree", env.stdTree],
    ["driver_sha256", env.driverSha256],
    ["m5_bin_sha256", env.m5BinSha256],
    ["m5_src_sha256", env.m5SrcSha256],
    ["spec_lib_src_sha256", env.specLibSrcSha256],
    ["spec_index", env.specIndexPath],
    ["oracle_root", env.oracleRoot],
  ] as const) {
    if (pin === null) {
      violations.push(`run.env missing ${name}`);
    }
  }
  const runEnvComplete = violations.length === 0;

  const hashes = value.hashes;
  const hashesPresent = hashes !== null;
  let hashesComplete = false;
  if (hashes === null) {
    violations.push(
      "hashes.tsv missing (judge sha and spec index sha unavailable)",
    );
  } else {
    if (hashes.headSha === null) {
      violations.push("hashes.tsv missing head");
    }
    if (hashes.driverSha256 === null) {
      violations.push("hashes.tsv missing driver");
    }
    if (hashes.judgePath === null || hashes.judgeSha256 === null) {
      violations.push("hashes.tsv missing judge");
    }
    if (hashes.specIndexPath === null || hashes.specIndexSha256 === null) {
      violations.push("hashes.tsv missing spec_index");
    }
    hashesComplete =
      hashes.headSha !== null &&
      hashes.driverSha256 !== null &&
      hashes.judgePath !== null &&
      hashes.judgeSha256 !== null &&
      hashes.specIndexPath !== null &&
      hashes.specIndexSha256 !== null;

    comparePin(violations, "head", env.headSha, hashes.headSha);
    comparePin(violations, "driver_sha256", env.driverSha256, hashes.driverSha256);
    comparePin(violations, "m5_bin_sha256", env.m5BinSha256, hashes.m5BinSha256);
    comparePin(violations, "m5_src_sha256", env.m5SrcSha256, hashes.m5SrcSha256);
    comparePin(
      violations,
      "spec_lib_src_sha256",
      env.specLibSrcSha256,
      hashes.specLibSrcSha256,
    );
    comparePin(
      violations,
      "trace_judge_src_sha256",
      env.traceJudgeSrcSha256,
      hashes.traceJudgeSrcSha256,
    );
  }

  const pinsCrossChecked = hashes !== null && !violations.some((violation) =>
    violation.startsWith("hashes.") && violation.includes("does not match"),
  );
  const manifestComplete =
    runEnvComplete && hashesPresent && hashesComplete && pinsCrossChecked;

  if (manifestComplete !== (violations.length === 0)) {
    // A complete manifest has no violations; an incomplete one names at least
    // one missing or mismatched pin.
    if (manifestComplete) {
      violations.push("internal: manifestComplete with violations");
    }
  }

  return {
    checks: {
      runEnvComplete,
      hashesPresent,
      hashesComplete,
      pinsCrossChecked,
      manifestComplete,
    },
    violations,
  };
}

export const RuntimeManifestSchema = z
  .object({
    kind: z.literal("runtime_manifest"),
    schema: z.literal("cheng.contract.runtime_manifest.v1"),
    runId: z.string().min(1),
    mode: z.enum(["production", "diagnostic", "unknown"]),
    runEnvPath: z.string().min(1),
    runEnvSha256: Sha256Schema,
    hashesPath: z.string().min(1).nullable(),
    hashesSha256: Sha256Schema.nullable(),
    runEnv: RunEnvPinsSchema,
    hashes: HashesPinsSchema.nullable(),
    checks: RuntimeChecksSchema,
    violations: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    const computed = computeRuntimeChecks({
      runId: value.runId,
      mode: value.mode,
      runEnv: value.runEnv,
      hashes: value.hashes,
    });
    for (const field of [
      "runEnvComplete",
      "hashesPresent",
      "hashesComplete",
      "pinsCrossChecked",
      "manifestComplete",
    ] as const) {
      if (value.checks[field] !== computed.checks[field]) {
        issue(`checks.${field} does not match the artifact-derived value`, [
          "checks",
          field,
        ]);
      }
    }
    if (
      value.violations.length !== computed.violations.length ||
      value.violations.some((violation, index) => violation !== computed.violations[index])
    ) {
      issue("violations do not match the artifact-derived violations", [
        "violations",
      ]);
    }
    if (value.hashes === null && (value.hashesPath !== null || value.hashesSha256 !== null)) {
      issue("hashes path/sha must be null when hashes are absent", [
        "hashesPath",
      ]);
    }
    if (value.hashes !== null && (value.hashesPath === null || value.hashesSha256 === null)) {
      issue("hashes path/sha are required when hashes are present", [
        "hashesPath",
      ]);
    }
  });

export type RuntimeManifest = z.infer<typeof RuntimeManifestSchema>;

export interface RuntimeManifestInput {
  runId: string;
  mode: RuntimeMode;
  runEnvPath: string;
  runEnvSha256: string;
  hashesPath: string | null;
  hashesSha256: string | null;
  runEnv: RunEnvPins;
  hashes: HashesPins | null;
}

export function buildRuntimeManifest(input: RuntimeManifestInput): RuntimeManifest {
  const computed = computeRuntimeChecks({
    runId: input.runId,
    mode: input.mode,
    runEnv: input.runEnv,
    hashes: input.hashes,
  });
  return RuntimeManifestSchema.parse({
    kind: "runtime_manifest",
    schema: "cheng.contract.runtime_manifest.v1",
    runId: input.runId,
    mode: input.mode,
    runEnvPath: input.runEnvPath,
    runEnvSha256: input.runEnvSha256,
    hashesPath: input.hashesPath,
    hashesSha256: input.hashesSha256,
    runEnv: input.runEnv,
    hashes: input.hashes,
    checks: computed.checks,
    violations: computed.violations,
  });
}
