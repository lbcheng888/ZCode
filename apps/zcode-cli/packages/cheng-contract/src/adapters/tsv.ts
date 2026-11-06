import { ChengContractError } from "../errors.js";

export interface TsvTable {
  header: readonly string[];
  rows: readonly (readonly string[])[];
  lineNumbers: readonly number[];
}

export interface ParseStrictTsvInput {
  text: string;
  expectedHeader: readonly string[];
  sourcePath: string;
}

/**
 * Strict TSV parser for pipeline artifacts.
 *
 * The header must match exactly (names and order); every data row must have the
 * same number of columns as the header; blank lines and a UTF-8 BOM are rejected.
 * There is no trimming and no column reordering: drift fails closed.
 */
export function parseStrictTsv(input: ParseStrictTsvInput): TsvTable {
  const { text, expectedHeader, sourcePath } = input;

  if (text.startsWith("\uFEFF")) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line: 1,
      detail: "UTF-8 BOM is not allowed",
    });
  }

  const normalized = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line: null,
      detail: "file is empty",
    });
  }

  const headerLine = lines[0] ?? "";
  const header = headerLine.split("\t");
  if (header.length !== expectedHeader.length) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_INVALID_TSV",
      sourcePath,
      line: 1,
      detail: `header has ${header.length} columns, expected ${expectedHeader.length}`,
    });
  }
  for (let index = 0; index < expectedHeader.length; index += 1) {
    if (header[index] !== expectedHeader[index]) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line: 1,
        detail: `header column ${index + 1} is ${JSON.stringify(header[index])}, expected ${JSON.stringify(expectedHeader[index])}`,
      });
    }
  }

  const rows: string[][] = [];
  const lineNumbers: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    if (line.length === 0) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line: lineNumber,
        detail: "blank line is not allowed",
      });
    }
    const cells = line.split("\t");
    if (cells.length !== header.length) {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_INVALID_TSV",
        sourcePath,
        line: lineNumber,
        detail: `row has ${cells.length} columns, expected ${header.length}`,
      });
    }
    rows.push(cells);
    lineNumbers.push(lineNumber);
  }

  return { header, rows, lineNumbers };
}
