import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ChengContractError } from "../errors.js";
import {
  DonorProvenanceRowSchema,
  ZeroCReceiptSchema,
  type DonorProvenanceRow,
  type ZeroCReceipt,
} from "../zero-c-receipt.js";
import { parseStrictTsv } from "./tsv.js";

const ZERO_C_HEADER = ["key", "value"] as const;
const RUN_DONORS_HEADER = [
  "index",
  "kind",
  "object_sha256",
  "source",
  "source_sha256",
  "compiler_sha256",
] as const;
const SLOT_DONORS_HEADER = [
  "object",
  "object_sha256",
  "kind",
  "source",
  "source_sha256",
  "compiler_sha256",
] as const;

function readUtf8File(path: string): string {
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath: resolved,
      detail: "file is not valid UTF-8",
      cause: error,
    });
  }
}

function parseNonNegInt(raw: string | undefined, key: string, sourcePath: string): number {
  if (raw === undefined || !/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      detail: `expected non-negative integer for ${key}, got ${JSON.stringify(raw ?? null)}`,
    });
  }
  return Number.parseInt(raw, 10);
}

export function parseZeroCTsv(text: string, sourcePath: string): Map<string, string> {
  const table = parseStrictTsv({
    text,
    expectedHeader: ZERO_C_HEADER,
    sourcePath,
  });
  const map = new Map<string, string>();
  table.rows.forEach((row, index) => {
    const lineNumber = table.lineNumbers[index] ?? index + 2;
    const key = row[0] ?? "";
    const value = row[1] ?? "";
    if (key.length === 0) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line: lineNumber,
        detail: "empty key in zero_c.tsv",
      });
    }
    if (map.has(key)) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line: lineNumber,
        detail: `duplicate key ${key} in zero_c.tsv`,
      });
    }
    map.set(key, value);
  });
  return map;
}

export function parseDonorsTsv(text: string, sourcePath: string): DonorProvenanceRow[] {
  const firstLine = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n")[0] ?? "";
  const isSlotFormat = firstLine.startsWith("object\t");
  const expectedHeader = isSlotFormat ? SLOT_DONORS_HEADER : RUN_DONORS_HEADER;
  const table = parseStrictTsv({
    text,
    expectedHeader,
    sourcePath,
  });
  return table.rows.map((row, index) => {
    const lineNumber = table.lineNumbers[index] ?? index + 2;
    let parsedIndex: number;
    let kind: string;
    let objectSha256: string;
    let source: string;
    let sourceSha256: string;
    let compilerSha256: string;

    if (isSlotFormat) {
      parsedIndex = index + 1;
      objectSha256 = row[1] ?? "";
      kind = row[2] ?? "";
      source = row[3] ?? "";
      sourceSha256 = row[4] ?? "";
      compilerSha256 = row[5] ?? "";
    } else {
      const rawIndex = row[0] ?? "";
      if (!/^[1-9][0-9]*$/u.test(rawIndex)) {
        throw new ChengContractError({
          code: "CHENG_CONTRACT_INVALID_TSV",
          sourcePath,
          line: lineNumber,
          detail: `invalid donor index: ${JSON.stringify(rawIndex)}`,
        });
      }
      parsedIndex = Number.parseInt(rawIndex, 10);
      kind = row[1] ?? "";
      objectSha256 = row[2] ?? "";
      source = row[3] ?? "";
      sourceSha256 = row[4] ?? "";
      compilerSha256 = row[5] ?? "";
    }

    const parsed = DonorProvenanceRowSchema.safeParse({
      index: parsedIndex,
      kind,
      objectSha256,
      source,
      sourceSha256,
      compilerSha256,
    });
    if (!parsed.success) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_SCHEMA_INVALID",
        sourcePath,
        line: lineNumber,
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
          .join("; "),
      });
    }
    return parsed.data;
  });
}

export interface ReadZeroCReceiptOptions {
  readonly expectedDriverSha256?: string | null;
  readonly donorsPath?: string;
}

export function readZeroCReceipt(
  runDir: string,
  options: ReadZeroCReceiptOptions = {},
): ZeroCReceipt {
  const resolvedRunDir = resolve(runDir);
  const zeroCPath = join(resolvedRunDir, "zero_c.tsv");
  const donorsPath = resolve(options.donorsPath ?? join(resolvedRunDir, "donors.tsv"));

  const kv = parseZeroCTsv(readUtf8File(zeroCPath), zeroCPath);
  const donors = parseDonorsTsv(readUtf8File(donorsPath), donorsPath);

  const coldProviderUsed = parseNonNegInt(kv.get("cold_provider_used"), "cold_provider_used", zeroCPath);
  const cBackendUsed = parseNonNegInt(kv.get("c_backend_used"), "c_backend_used", zeroCPath);
  const orcUsed = parseNonNegInt(kv.get("orc_used"), "orc_used", zeroCPath);
  const linkObjectCount = parseNonNegInt(kv.get("link_object_count"), "link_object_count", zeroCPath);
  const pureChengDonorCount = parseNonNegInt(kv.get("pure_cheng_donor_count"), "pure_cheng_donor_count", zeroCPath);
  const cProviderObjectCount = parseNonNegInt(kv.get("c_provider_object_count"), "c_provider_object_count", zeroCPath);
  const driverProviderObjectCount = kv.has("driver_provider_object_count")
    ? parseNonNegInt(kv.get("driver_provider_object_count"), "driver_provider_object_count", zeroCPath)
    : 0;
  const coldSystemLinkExec = kv.has("cold_system_link_exec")
    ? parseNonNegInt(kv.get("cold_system_link_exec"), "cold_system_link_exec", zeroCPath)
    : 0;
  const realBackendCodegen = kv.has("real_backend_codegen")
    ? parseNonNegInt(kv.get("real_backend_codegen"), "real_backend_codegen", zeroCPath)
    : 0;

  const expectedDriverSha256 = options.expectedDriverSha256 ?? null;

  const coldProviderZero = coldProviderUsed === 0;
  const cBackendZero = cBackendUsed === 0;
  const orcZero = orcUsed === 0;
  const cProviderObjectsZero = cProviderObjectCount === 0;
  const linkCountMatchesDonors =
    pureChengDonorCount > 0 && linkObjectCount === pureChengDonorCount;
  const donorsCompilerShaMatched =
    donors.length === pureChengDonorCount &&
    donors.length > 0 &&
    (expectedDriverSha256 === null ||
      donors.every((row) => row.compilerSha256 === expectedDriverSha256));

  const zeroCProductionOk =
    coldProviderZero &&
    cBackendZero &&
    orcZero &&
    cProviderObjectsZero &&
    linkCountMatchesDonors &&
    donorsCompilerShaMatched;

  const parsed = ZeroCReceiptSchema.safeParse({
    schema: "cheng.contract.zero_c.v1",
    coldProviderUsed,
    cBackendUsed,
    orcUsed,
    linkObjectCount,
    pureChengDonorCount,
    cProviderObjectCount,
    driverProviderObjectCount,
    coldSystemLinkExec,
    realBackendCodegen,
    expectedDriverSha256,
    donors,
    checks: {
      coldProviderZero,
      cBackendZero,
      orcZero,
      cProviderObjectsZero,
      linkCountMatchesDonors,
      donorsCompilerShaMatched,
      zeroCProductionOk,
    },
  });

  if (!parsed.success) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_SCHEMA_INVALID",
      sourcePath: zeroCPath,
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
        .join("; "),
    });
  }
  return parsed.data;
}
