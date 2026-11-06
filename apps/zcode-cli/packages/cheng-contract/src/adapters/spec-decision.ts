import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseChengSpecRef,
  type ChengSpecRef,
} from "../cheng-spec-ref.js";
import {
  parseDecisionFrameJsonl,
  type DecisionFrame,
} from "../decision-frame.js";
import { ChengContractError } from "../errors.js";

interface Utf8File {
  path: string;
  text: string;
  sha256: string;
}

function readUtf8File(filePath: string): Utf8File {
  const path = resolve(filePath);
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
      code: "CHENG_CONTRACT_SCHEMA_INVALID",
      sourcePath: path,
      detail: "file is not valid UTF-8",
      cause: error,
    });
  }
  return {
    path,
    text,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Read a real spec file and, when `indexPath` is given, its index file.
 * The projected SHAs come from the raw file bytes, so the `sha256` compared
 * against the index entry is the on-disk hash, not a re-encoded copy.
 */
export function readChengSpecRef(
  specPath: string,
  indexPath?: string,
): ChengSpecRef {
  const spec = readUtf8File(specPath);
  if (indexPath === undefined) {
    return parseChengSpecRef(spec.text, null, spec.path, {
      specSha256: spec.sha256,
    });
  }
  const index = readUtf8File(indexPath);
  return parseChengSpecRef(spec.text, index.text, spec.path, {
    specSha256: spec.sha256,
    indexSha256: index.sha256,
    indexPath: index.path,
  });
}

export function readDecisionFrames(jsonlPath: string): DecisionFrame[] {
  const file = readUtf8File(jsonlPath);
  return parseDecisionFrameJsonl(file.text, file.path);
}
