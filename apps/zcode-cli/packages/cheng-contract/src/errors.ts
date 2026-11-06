export type ChengContractErrorCode =
  | "CHENG_CONTRACT_MISSING_FILE"
  | "CHENG_CONTRACT_IO_ERROR"
  | "CHENG_CONTRACT_INVALID_TSV"
  | "CHENG_CONTRACT_SCHEMA_INVALID"
  | "CHENG_CONTRACT_UNKNOWN_EXIT_CODE"
  | "CHENG_CONTRACT_MISSING_EVIDENCE";

export interface ChengContractErrorInput {
  code: ChengContractErrorCode;
  sourcePath: string;
  detail: string;
  line?: number | null;
  cause?: unknown;
}

/**
 * Every failure in this package is typed and thrown. There is no partial result,
 * no default value, and no best-effort recovery: callers must handle or fail.
 */
export class ChengContractError extends Error {
  readonly code: ChengContractErrorCode;
  readonly sourcePath: string;
  readonly line: number | null;
  readonly detail: string;

  constructor(input: ChengContractErrorInput) {
    const location = input.line === null || input.line === undefined
      ? input.sourcePath
      : `${input.sourcePath}:${input.line}`;
    super(`${input.code}: ${location}: ${input.detail}`, { cause: input.cause });
    this.name = "ChengContractError";
    this.code = input.code;
    this.sourcePath = input.sourcePath;
    this.line = input.line ?? null;
    this.detail = input.detail;
  }
}
