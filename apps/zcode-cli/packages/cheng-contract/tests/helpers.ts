import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import {
  ChengContractError,
  type ChengContractErrorCode,
} from "../src/index.js";

export const FIXTURES = join(import.meta.dirname, "fixtures");

export function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), "utf8");
}

export function expectContractError(
  fn: () => unknown,
  code: ChengContractErrorCode,
): ChengContractError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ChengContractError);
    const typed = error as ChengContractError;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`expected ChengContractError(${code})`);
}

/**
 * Mutate a TSV by rows so tests can express a single-cell drift without
 * hand-editing the whole fixture.
 */
export function mutateTsv(text: string, mutate: (rows: string[][]) => void): string {
  const rows = text.replace(/\n$/u, "").split("\n").map((line) => line.split("\t"));
  mutate(rows);
  return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
}

export function rowAt(rows: string[][], index: number): string[] {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`fixture has no row ${index}`);
  }
  return row;
}

export function cellAt(row: string[], index: number): string {
  const value = row[index];
  if (value === undefined) {
    throw new Error(`fixture has no cell ${index}`);
  }
  return value;
}

export function setCell(row: string[], index: number, value: string): void {
  if (index < 0 || index >= row.length) {
    throw new Error(`cell ${index} is out of range`);
  }
  row[index] = value;
}

export function single<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected one item");
  }
  return item;
}

export function mutateJsonl(
  text: string,
  mutate: (events: Record<string, unknown>[]) => void,
): string {
  const events = text
    .replace(/\n$/u, "")
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("fixture line is not a JSON object");
      }
      return value as Record<string, unknown>;
    });
  mutate(events);
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function eventOf(
  events: Record<string, unknown>[],
  eventName: string,
  index = 0,
): Record<string, unknown> {
  const matches = events.filter((event) => event.event === eventName);
  const event = matches[index];
  if (event === undefined) {
    throw new Error(`fixture has no ${eventName} event at index ${index}`);
  }
  return event;
}

export function setField(
  event: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!(key in event)) {
    throw new Error(`fixture event has no field ${key}`);
  }
  event[key] = value;
}
