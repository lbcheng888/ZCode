import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ChengContractError } from "../errors.js";
import {
  HashesPinsSchema,
  RunEnvPinsSchema,
  buildRuntimeManifest,
  type HashesPins,
  type RunEnvPins,
  type RuntimeManifest,
} from "../runtime-manifest.js";
import { parseStrictTsv } from "./tsv.js";

const HASHES_HEADER = ["key", "path", "sha256", "scope"] as const;

interface RunEnvParse {
  runId: string;
  mode: "production" | "diagnostic" | "unknown";
  pins: RunEnvPins;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readFile(path: string): { text: string; sha256: string } {
  const resolved = resolve(path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_MISSING_FILE",
        sourcePath: resolved,
        detail: "file not found",
        cause: error,
      });
    }
    throw new ChengContractError({
      code: "CHENG_CONTRACT_IO_ERROR",
      sourcePath: resolved,
      detail: `cannot read file: ${(error as Error).message}`,
      cause: error,
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath: resolved,
      detail: "file is not valid UTF-8",
      cause: error,
    });
  }
  return { text, sha256: sha256Hex(bytes) };
}

function parseKeyValue(
  text: string,
  sourcePath: string,
): Map<string, string> {
  if (text.startsWith("\uFEFF")) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line: 1,
      detail: "UTF-8 BOM is not allowed",
    });
  }
  const lines = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const values = new Map<string, string>();
  lines.forEach((line, index) => {
    if (line.length === 0) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line: index + 1,
        detail: "blank line is not allowed",
      });
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line: index + 1,
        detail: "expected key=value",
      });
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length === 0) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line: index + 1,
        detail: "empty key",
      });
    }
    if (values.has(key)) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line: index + 1,
        detail: `duplicate key ${key}`,
      });
    }
    values.set(key, value);
  });
  return values;
}

function pinOrNull(values: Map<string, string>, key: string): string | null {
  const value = values.get(key);
  if (value === undefined || value === "-" || value.length === 0) {
    return null;
  }
  return value;
}

export function parseRunEnv(
  text: string,
  sourcePath = "<memory>",
): RunEnvParse {
  const values = parseKeyValue(text, sourcePath);
  const runId = values.get("run_id");
  if (runId === undefined || runId.length === 0) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_SCHEMA_INVALID",
      sourcePath,
      line: null,
      detail: "run.env missing run_id",
    });
  }
  const rawMode = values.get("mode");
  const mode =
    rawMode === "production" || rawMode === "diagnostic" ? rawMode : "unknown";
  const pins = {
    headSha: pinOrNull(values, "head_sha"),
    stdTree: pinOrNull(values, "std_tree"),
    driverSha256: pinOrNull(values, "driver_sha256"),
    m5BinSha256: pinOrNull(values, "m5_bin_sha256"),
    m5SrcSha256: pinOrNull(values, "m5_src_sha256"),
    specLibSrcSha256: pinOrNull(values, "spec_lib_src_sha256"),
    traceJudgeSrcSha256: pinOrNull(values, "trace_judge_src_sha256"),
    traceJudgeBinSha256: pinOrNull(values, "trace_judge_bin_sha256"),
    specIndexPath: pinOrNull(values, "spec_index"),
    oracleRoot: pinOrNull(values, "oracle_root"),
  };
  const parsed = RunEnvPinsSchema.safeParse(pins);
  if (!parsed.success) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_SCHEMA_INVALID",
      sourcePath,
      line: null,
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
      cause: parsed.error,
    });
  }
  return { runId, mode, pins: parsed.data };
}

interface HashRow {
  key: string;
  path: string;
  sha256: string;
  scope: string;
}

function parseHashesRows(text: string, sourcePath: string): Map<string, HashRow> {
  const table = parseStrictTsv({ text, expectedHeader: HASHES_HEADER, sourcePath });
  const rows = new Map<string, HashRow>();
  table.rows.forEach((row, index) => {
    const line = table.lineNumbers[index] ?? null;
    const key = row[0];
    const path = row[1];
    const sha256 = row[2];
    const scope = row[3];
    if (key === undefined || key.length === 0) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line,
        detail: "hashes.tsv row is missing key",
      });
    }
    if (path === undefined || path.length === 0) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line,
        detail: `hashes.tsv row ${key} is missing path`,
      });
    }
    if (sha256 === undefined || sha256.length === 0) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line,
        detail: `hashes.tsv row ${key} is missing its value column`,
      });
    }
    if (scope === undefined || scope.length === 0) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line,
        detail: `hashes.tsv row ${key} is missing scope`,
      });
    }
    if (rows.has(key)) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line,
        detail: `duplicate hashes key ${key}`,
      });
    }
    rows.set(key, { key, path, sha256, scope });
  });
  return rows;
}

function pathOrNull(row: HashRow | undefined): string | null {
  if (row === undefined || row.path === "-" || row.path.length === 0) {
    return null;
  }
  return row.path;
}

function shaOrNull(row: HashRow | undefined): string | null {
  return row === undefined ? null : row.sha256;
}

export function parseHashesTsv(
  text: string,
  sourcePath = "<memory>",
): HashesPins {
  const rows = parseHashesRows(text, sourcePath);
  const pins = {
    headSha: shaOrNull(rows.get("head")),
    driverSha256: shaOrNull(rows.get("driver")),
    m5BinSha256: shaOrNull(rows.get("m5_bin")),
    m5SrcSha256: shaOrNull(rows.get("m5_src")),
    specLibSrcSha256: shaOrNull(rows.get("spec_lib_src")),
    traceJudgeSrcSha256: shaOrNull(rows.get("trace_judge_src")),
    judgePath: pathOrNull(rows.get("judge")),
    judgeSha256: shaOrNull(rows.get("judge")),
    specIndexPath: pathOrNull(rows.get("spec_index")),
    specIndexSha256: shaOrNull(rows.get("spec_index")),
  };
  const parsed = HashesPinsSchema.safeParse(pins);
  if (!parsed.success) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_SCHEMA_INVALID",
      sourcePath,
      line: null,
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export interface ReadRuntimeManifestOptions {
  /** Explicit hashes.tsv path; when omitted, `<runDir>/hashes.tsv` is probed. */
  hashesPath?: string;
}

/**
 * Read `<runDir>/run.env` (required) and `<runDir>/hashes.tsv` (optional).
 * Missing hashes does not throw: the manifest records
 * `manifestComplete=false` and names the missing judge/spec-index pins.
 */
export function readRuntimeManifest(
  runDir: string,
  options: ReadRuntimeManifestOptions = {},
): RuntimeManifest {
  const dir = resolve(runDir);
  const runEnvPath = join(dir, "run.env");
  const runEnvFile = readFile(runEnvPath);
  const runEnv = parseRunEnv(runEnvFile.text, runEnvPath);

  const hashesPath =
    options.hashesPath !== undefined
      ? resolve(options.hashesPath)
      : join(dir, "hashes.tsv");
  let hashesFile: { text: string; sha256: string } | null = null;
  if (options.hashesPath !== undefined) {
    hashesFile = readFile(hashesPath);
  } else if (existsSync(hashesPath)) {
    hashesFile = readFile(hashesPath);
  }
  const hashes = hashesFile === null ? null : parseHashesTsv(hashesFile.text, hashesPath);

  return buildRuntimeManifest({
    runId: runEnv.runId,
    mode: runEnv.mode,
    runEnvPath,
    runEnvSha256: runEnvFile.sha256,
    hashesPath: hashesFile === null ? null : hashesPath,
    hashesSha256: hashesFile === null ? null : hashesFile.sha256,
    runEnv: runEnv.pins,
    hashes,
  });
}
