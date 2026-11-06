import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

import { ChengContractError } from "../errors.js";
import { JudgeInputsReceiptSchema, type JudgeInputsReceipt } from "../judge-inputs.js";
import { JudgeVerdictSchema, type JudgeVerdict } from "../judge-verdict.js";
import { ModuleLedgerSchema, type ModuleLedger } from "../module-ledger.js";
import { ProgReceiptSchema, type ProgReceipt } from "../prog-receipt.js";
import {
  RunVolumeReceiptSchema,
  computeRunChecks,
  type ArtifactRef,
  type RunAcceptance,
  type RunVolumeReceipt,
} from "../run-volume.js";
import { parseStrictTsv } from "./tsv.js";

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

const PROG_HEADER = [
  "task",
  "prog_sha256",
  "exe_sha256",
  "report_sha256",
  "compile_rc",
  "run_rc",
  "judge",
  "status",
] as const;

const MODULE_HEADER = [
  "level",
  "fn",
  "name",
  "role",
  "decisions",
  "settles",
  "call_edges",
  "parent_roots",
  "parent_in_fn",
  "fn_examples",
  "fn_passed",
  "fn_verdict",
  "program_examples",
  "program_passed",
  "program_verdict",
  "segment_sha256",
  "projection_sha256",
] as const;

const JUDGE_INPUTS_HEADER = [
  "task",
  "tier",
  "path",
  "sha256",
  "declared_sha256",
  "rows",
  "declared_rows",
] as const;

export interface ReadRunVolumeOptions {
  runId?: string;
  /**
   * Explicit module ledger path. When omitted, the adapter probes
   * `<run>/evidence/modules.tsv` and then `<run>/modules.tsv`.
   */
  modulesPath?: string;
}

interface FileBytes {
  path: string;
  bytes: Buffer;
  text: string;
  sha256: string;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readFileBytes(path: string): FileBytes {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_MISSING_FILE",
        sourcePath: path,
        detail: "file not found",
        cause: error,
      });
    }
    throw new ChengContractError({
      code: "CHENG_CONTRACT_IO_ERROR",
      sourcePath: path,
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
      sourcePath: path,
      detail: "file is not valid UTF-8",
      cause: error,
    });
  }

  return { path, bytes, text, sha256: sha256Hex(bytes) };
}

function requireCell(
  row: readonly string[],
  index: number,
  sourcePath: string,
  line: number | null,
  column: string,
): string {
  const value = row[index];
  if (value === undefined) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line,
      detail: `missing column ${column}`,
    });
  }
  return value;
}

function requireInt(
  row: readonly string[],
  index: number,
  sourcePath: string,
  line: number | null,
  column: string,
): number {
  const raw = requireCell(row, index, sourcePath, line, column);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line,
      detail: `${column} must be a non-negative integer, got ${JSON.stringify(raw)}`,
    });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line,
      detail: `${column} is outside the safe integer range`,
    });
  }
  return value;
}

function parseWithSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  sourcePath: string,
  line: number | null,
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new ChengContractError({
    code: "CHENG_CONTRACT_SCHEMA_INVALID",
    sourcePath,
    line,
    detail,
    cause: result.error,
  });
}

function artifactRef(file: FileBytes): ArtifactRef {
  return { path: file.path, sha256: file.sha256, bytes: file.bytes.byteLength };
}

export function parseJudgeVerdictTsv(text: string, sourcePath = "<memory>"): JudgeVerdict[] {
  const table = parseStrictTsv({ text, expectedHeader: JUDGE_HEADER, sourcePath });
  return table.rows.map((row, index) => {
    const line = table.lineNumbers[index] ?? null;
    const value = {
      kind: "judge_verdict" as const,
      schema: "cheng.contract.judge_verdict.v1" as const,
      task: requireCell(row, 0, sourcePath, line, "task"),
      eval: {
        passed: requireInt(row, 2, sourcePath, line, "eval_ok"),
        total: requireInt(row, 1, sourcePath, line, "n_eval"),
      },
      props: {
        passed: requireInt(row, 4, sourcePath, line, "props_ok"),
        total: requireInt(row, 3, sourcePath, line, "n_props"),
      },
      settleDiag: {
        passed: requireInt(row, 6, sourcePath, line, "settle_ok_diag"),
        total: requireInt(row, 5, sourcePath, line, "n_settle_diag"),
      },
      status: requireCell(row, 7, sourcePath, line, "status"),
      rc: requireInt(row, 8, sourcePath, line, "rc"),
      programSha256: requireCell(row, 9, sourcePath, line, "program_sha256"),
      note: requireCell(row, 10, sourcePath, line, "note"),
      compileRc: requireInt(row, 11, sourcePath, line, "compile_rc"),
      runRc: requireInt(row, 12, sourcePath, line, "run_rc"),
    };
    return parseWithSchema(JudgeVerdictSchema, value, sourcePath, line);
  });
}

export function parseProgReceiptTsv(text: string, sourcePath = "<memory>"): ProgReceipt[] {
  const table = parseStrictTsv({ text, expectedHeader: PROG_HEADER, sourcePath });
  return table.rows.map((row, index) => {
    const line = table.lineNumbers[index] ?? null;
    const value = {
      kind: "prog_receipt" as const,
      schema: "cheng.contract.prog_receipt.v1" as const,
      task: requireCell(row, 0, sourcePath, line, "task"),
      progSha256: requireCell(row, 1, sourcePath, line, "prog_sha256"),
      exeSha256: requireCell(row, 2, sourcePath, line, "exe_sha256"),
      reportSha256: requireCell(row, 3, sourcePath, line, "report_sha256"),
      compileRc: requireInt(row, 4, sourcePath, line, "compile_rc"),
      runRc: requireInt(row, 5, sourcePath, line, "run_rc"),
      judge: requireCell(row, 6, sourcePath, line, "judge"),
      status: requireCell(row, 7, sourcePath, line, "status"),
    };
    return parseWithSchema(ProgReceiptSchema, value, sourcePath, line);
  });
}

export function parseJudgeInputsTsv(
  text: string,
  sourcePath = "<memory>",
  sourceSha256 = sha256Hex(Buffer.from(text, "utf8")),
): JudgeInputsReceipt {
  const table = parseStrictTsv({ text, expectedHeader: JUDGE_INPUTS_HEADER, sourcePath });
  const rows = table.rows.map((row, index) => {
    const line = table.lineNumbers[index] ?? null;
    return {
      task: requireCell(row, 0, sourcePath, line, "task"),
      tier: requireCell(row, 1, sourcePath, line, "tier"),
      path: requireCell(row, 2, sourcePath, line, "path"),
      sha256: requireCell(row, 3, sourcePath, line, "sha256"),
      declaredSha256: requireCell(row, 4, sourcePath, line, "declared_sha256"),
      rows: requireInt(row, 5, sourcePath, line, "rows"),
      declaredRows: requireInt(row, 6, sourcePath, line, "declared_rows"),
    };
  });

  return parseWithSchema(
    JudgeInputsReceiptSchema,
    {
      kind: "judge_inputs" as const,
      schema: "cheng.contract.judge_inputs.v1" as const,
      sourcePath,
      sourceSha256,
      rows,
    },
    sourcePath,
    null,
  );
}

export function parseModuleLedgerTsv(
  text: string,
  sourcePath = "<memory>",
  sourceSha256 = sha256Hex(Buffer.from(text, "utf8")),
): ModuleLedger {
  const table = parseStrictTsv({ text, expectedHeader: MODULE_HEADER, sourcePath });
  const modules = table.rows.map((row, index) => {
    const line = table.lineNumbers[index] ?? null;
    return {
      level: requireInt(row, 0, sourcePath, line, "level"),
      fn: requireInt(row, 1, sourcePath, line, "fn"),
      name: requireCell(row, 2, sourcePath, line, "name"),
      role: requireCell(row, 3, sourcePath, line, "role"),
      decisions: requireInt(row, 4, sourcePath, line, "decisions"),
      settles: requireInt(row, 5, sourcePath, line, "settles"),
      callEdges: requireInt(row, 6, sourcePath, line, "call_edges"),
      parentRoots: requireInt(row, 7, sourcePath, line, "parent_roots"),
      parentInFn: requireInt(row, 8, sourcePath, line, "parent_in_fn"),
      fnExamples: requireInt(row, 9, sourcePath, line, "fn_examples"),
      fnPassed: requireInt(row, 10, sourcePath, line, "fn_passed"),
      fnVerdict: requireCell(row, 11, sourcePath, line, "fn_verdict"),
      programExamples: requireInt(row, 12, sourcePath, line, "program_examples"),
      programPassed: requireInt(row, 13, sourcePath, line, "program_passed"),
      programVerdict: requireCell(row, 14, sourcePath, line, "program_verdict"),
      segmentSha256: requireCell(row, 15, sourcePath, line, "segment_sha256"),
      projectionSha256: requireCell(row, 16, sourcePath, line, "projection_sha256"),
    };
  });

  return parseWithSchema(
    ModuleLedgerSchema,
    {
      kind: "module_ledger" as const,
      schema: "cheng.contract.module_ledger.v1" as const,
      sourcePath,
      sourceSha256,
      modules,
    },
    sourcePath,
    null,
  );
}

export function readJudgeVerdicts(runDir: string): JudgeVerdict[] {
  const file = readFileBytes(join(resolve(runDir), "judge", "judge.tsv"));
  return parseJudgeVerdictTsv(file.text, file.path);
}

export function readProgReceipts(runDir: string): ProgReceipt[] {
  const file = readFileBytes(join(resolve(runDir), "prog_receipts.tsv"));
  return parseProgReceiptTsv(file.text, file.path);
}

export function readModuleLedger(modulesPath: string): ModuleLedger {
  const file = readFileBytes(resolve(modulesPath));
  return parseModuleLedgerTsv(file.text, file.path, file.sha256);
}

function readOptionalFile(path: string): FileBytes | null {
  if (!existsSync(path)) {
    return null;
  }
  return readFileBytes(path);
}

function parseKeyValueLines(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0 && !values.has(key)) {
      values.set(key, value);
    }
  }
  return values;
}

function parseReportLines(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const prefix = "csg_spec_v2_cli_run: ";
  for (const line of text.split(/\r?\n/u)) {
    const body = line.startsWith(prefix) ? line.slice(prefix.length) : line;
    for (const token of body.split(/\s+/u)) {
      const separator = token.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = token.slice(0, separator);
      const value = token.slice(separator + 1);
      if (key.length > 0 && !values.has(key)) {
        values.set(key, value);
      }
    }
  }
  return values;
}

interface RunAcceptanceFiles {
  acceptance: RunAcceptance;
  reportFile: FileBytes | null;
  runEnvFile: FileBytes | null;
}

function readAcceptance(dir: string): RunAcceptanceFiles {
  const reportFile = readOptionalFile(join(dir, "report.txt"));
  const runEnvFile = readOptionalFile(join(dir, "run.env"));
  const reportValues = reportFile === null ? new Map<string, string>() : parseReportLines(reportFile.text);
  const envValues = runEnvFile === null ? new Map<string, string>() : parseKeyValueLines(runEnvFile.text);
  const rawMode = envValues.get("mode") ?? reportValues.get("mode") ?? "unknown";
  const mode: RunAcceptance["mode"] =
    rawMode === "production" || rawMode === "diagnostic" ? rawMode : "unknown";

  const rawAcceptance = reportValues.get("production_acceptance");
  const productionAcceptance =
    rawAcceptance === "0" ? false : rawAcceptance === "1" ? true : null;
  const verdict = reportValues.get("verdict") ?? null;

  let level: RunAcceptance["level"] = "UNKNOWN";
  if (productionAcceptance === true && verdict === "PASS") {
    level = "PRODUCTION";
  } else if (
    productionAcceptance === false &&
    verdict !== null &&
    verdict.startsWith("DIAGNOSTIC")
  ) {
    level = "DIAGNOSTIC_NOT_ACCEPTANCE";
  }

  return {
    acceptance: { mode, level, productionAcceptance, verdict },
    reportFile,
    runEnvFile,
  };
}

/**
 * Read a run volume and cross-check its artifacts. Missing files, column drift,
 * type drift, count contradictions, judge/prog disagreement, and judge rows
 * that disagree with judge_inputs declared_rows all throw a typed
 * ChengContractError. Module evidence is optional because single-module runs
 * (p02/p16) do not produce modules.tsv.
 */
export function readRunVolume(
  runDir: string,
  options: ReadRunVolumeOptions = {},
): RunVolumeReceipt {
  const dir = resolve(runDir);
  const judgeFile = readFileBytes(join(dir, "judge", "judge.tsv"));
  const progFile = readFileBytes(join(dir, "prog_receipts.tsv"));
  const judge = parseJudgeVerdictTsv(judgeFile.text, judgeFile.path);
  const progReceipts = parseProgReceiptTsv(progFile.text, progFile.path);

  const judgeInputsFile = readOptionalFile(join(dir, "judge_inputs.tsv"));
  const judgeInputs =
    judgeInputsFile === null
      ? null
      : parseJudgeInputsTsv(
          judgeInputsFile.text,
          judgeInputsFile.path,
          judgeInputsFile.sha256,
        );

  const { acceptance, reportFile, runEnvFile } = readAcceptance(dir);
  const checks = computeRunChecks({ judge, progReceipts, judgeInputs, acceptance });

  let modulesPath: string | undefined;
  if (options.modulesPath !== undefined) {
    modulesPath = resolve(options.modulesPath);
  } else {
    const candidates = [join(dir, "evidence", "modules.tsv"), join(dir, "modules.tsv")];
    modulesPath = candidates.find((candidate) => existsSync(candidate));
  }

  let moduleLedger: ModuleLedger | null = null;
  let modulesArtifact: ArtifactRef | null = null;
  if (modulesPath !== undefined) {
    const modulesFile = readFileBytes(modulesPath);
    moduleLedger = parseModuleLedgerTsv(
      modulesFile.text,
      modulesFile.path,
      modulesFile.sha256,
    );
    modulesArtifact = artifactRef(modulesFile);
  }

  const value = {
    kind: "run_volume" as const,
    schema: "cheng.contract.run_volume.v1" as const,
    runId: options.runId ?? basename(dir),
    runDir: dir,
    judge,
    progReceipts,
    judgeInputs,
    acceptance,
    checks,
    moduleLedger,
    artifacts: {
      judgeTsv: artifactRef(judgeFile),
      progReceiptsTsv: artifactRef(progFile),
      judgeInputsTsv: judgeInputsFile === null ? null : artifactRef(judgeInputsFile),
      reportTxt: reportFile === null ? null : artifactRef(reportFile),
      runEnv: runEnvFile === null ? null : artifactRef(runEnvFile),
      modulesTsv: modulesArtifact,
    },
  };

  return parseWithSchema(RunVolumeReceiptSchema, value, dir, null);
}
