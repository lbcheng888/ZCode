import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseDerivationGraphJsonl, type DerivationGraph } from "../derivation-graph.js";
import { ChengContractError } from "../errors.js";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readTraceFile(tracePath: string): { text: string; sha256: string } {
  const path = resolve(tracePath);
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
  return { text, sha256: sha256Hex(bytes) };
}

/**
 * Read a `csg.decision_trace.v1` trace from disk and project it into a
 * DerivationGraph. Missing files, invalid UTF-8, and malformed traces fail
 * closed; there is no partial graph.
 */
export function readDerivationGraph(tracePath: string): DerivationGraph {
  const file = readTraceFile(tracePath);
  return parseDerivationGraphJsonl(file.text, resolve(tracePath), file.sha256);
}
