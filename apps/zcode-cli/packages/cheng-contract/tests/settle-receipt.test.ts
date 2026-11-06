import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseSettleReceiptJsonl, readSettleReceipt } from "../src/index.js";
import {
  FIXTURES,
  eventOf,
  expectContractError,
  fixture,
  mutateJsonl,
  setField,
} from "./helpers.js";

const P02 = "run-p02/trace.jsonl";
const P16 = "run-p16/trace.jsonl";
const P01 = "run-p01r5b/trace.jsonl";

function receipt(file: string) {
  return readSettleReceipt(join(FIXTURES, file));
}

describe("SettleReceipt", () => {
  it("projects the p02 settle phase", () => {
    const value = receipt(P02);
    expect(value).toMatchObject({
      kind: "settle_receipt",
      schema: "cheng.contract.settle_receipt.v1",
      task: "p02_min2",
      taskId: 1,
    });
    expect(value.settles).toHaveLength(2);
    expect(value.settles[0]).toMatchObject({
      kind: "fn",
      fn: 0,
      settleIndex: 0,
      scope: "fn_examples",
      examples: 20,
      passed: 20,
      verdict: "pass",
      failedFn: -1,
    });
    expect(value.settles[1]).toMatchObject({
      kind: "program",
      fn: -1,
      settleIndex: 1,
      scope: "program_examples",
      examples: 20,
      passed: 20,
      verdict: "pass",
    });
    expect(value.traceDone).toMatchObject({
      solved: true,
      invalidPath: false,
      settleFailed: false,
      finalPassed: 20,
      finalExamples: 20,
      programAuthenticated: true,
    });
    expect(value.traceSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("projects p16 and p01 settle phases", () => {
    const p16 = receipt(P16);
    const p01 = receipt(P01);
    expect(p16.task).toBe("p16_glue_len");
    expect(p16.settles).toHaveLength(2);
    expect(p16.traceDone.solved).toBe(true);
    expect(p01.task).toBe("p01_max2");
    expect(p01.settles).toHaveLength(2);
    expect(p01.traceDone.finalPassed).toBe(20);
  });

  it("rejects invalid JSON", () => {
    const lines = fixture(P02).trimEnd().split("\n");
    lines[1] = "{";
    const text = `${lines.join("\n")}\n`;
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects an unknown trace event", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      setField(eventOf(events, "settle", 0), "event", "settle_extra");
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a missing trace_begin", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      events.splice(0, 1);
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a missing trace_done", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      events.pop();
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a trace with no settle events", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.event === "settle") {
          events.splice(index, 1);
        }
      }
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects passed greater than examples", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      setField(eventOf(events, "settle", 0), "passed", 21);
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects verdict=pass with passed < examples", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      setField(eventOf(events, "settle", 0), "passed", 19);
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects verdict=fail with passed == examples", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      setField(eventOf(events, "settle", 0), "verdict", "fail");
      setField(eventOf(events, "settle", 0), "passed", 20);
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects kind=fn with fn=-1", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      setField(eventOf(events, "settle", 0), "fn", -1);
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects kind=program with fn >= 0", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      setField(eventOf(events, "settle", 1), "fn", 0);
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects duplicate fn settles", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      const fnSettle = eventOf(events, "settle", 0);
      events.splice(events.length - 1, 0, {
        ...fnSettle,
        settle_index: 2,
      });
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a non-increasing settle_index", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      setField(eventOf(events, "settle", 1), "settle_index", 0);
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects trace_done counts that disagree with the program settle", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      setField(eventOf(events, "trace_done"), "final_passed", 19);
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects solved with a fail settle", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      const fnSettle = eventOf(events, "settle", 0);
      setField(fnSettle, "verdict", "fail");
      setField(fnSettle, "passed", 19);
      setField(fnSettle, "failed_fn", 0);
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a settle task mismatch", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      setField(eventOf(events, "settle", 0), "task", "other_task");
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects settle_failed without a fail settle", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      const done = eventOf(events, "trace_done");
      setField(done, "solved", false);
      setField(done, "settle_failed", true);
      setField(done, "reason", "settle_failed");
      setField(done, "final_passed", 19);
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a blank line", () => {
    const text = fixture(P02).replace("\n", "\n\n");
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a BOM", () => {
    expectContractError(
      () => readSettleReceiptFromText(`\uFEFF${fixture(P02)}`),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });

  it("rejects a mixed schema", () => {
    const text = mutateJsonl(fixture(P02), (events) => {
      const begin = events[0];
      if (begin === undefined) {
        throw new Error("fixture has no trace_begin");
      }
      setField(begin, "schema", "other.schema");
    });
    expectContractError(
      () => readSettleReceiptFromText(text),
      "CHENG_CONTRACT_INVALID_TSV",
    );
  });
});

function readSettleReceiptFromText(text: string) {
  // The public reader takes a path; the pure parser is exported for tests.
  return parseSettleReceiptJsonl(text, "<memory>");
}
