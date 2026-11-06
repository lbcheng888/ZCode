import { describe, expect, it } from "vitest";

import {
  ChengErrorSchema,
  classifyRunnerExit,
  runnerExitMeaning,
} from "../src/index.js";
import { expectContractError } from "./helpers.js";

const EVIDENCE = ["stderr: runner failed"];

const EXPECTED: ReadonlyArray<readonly [number, string, boolean]> = [
  [10, "input", false],
  [20, "infra", false],
  [21, "input", false],
  [22, "infra", false],
  [23, "structure_fail", false],
  [30, "unsolved", false],
  [31, "unsolved", false],
  [32, "judge_fail", false],
  [33, "infra", true],
  [40, "provenance_fail", false],
  [41, "provenance_fail", false],
  [50, "judge_fail", false],
  [51, "judge_fail", false],
];

function classify(code: number) {
  const error = classifyRunnerExit(code, EVIDENCE);
  if (error === null) {
    throw new Error(`expected an error for exit ${code}`);
  }
  return error;
}

describe("ChengError", () => {
  it("maps every CSG v2 runner exit code to its class and retryable flag", () => {
    for (const [code, className, retryable] of EXPECTED) {
      const error = classify(code);
      expect(error).toMatchObject({
        kind: "cheng_error",
        schema: "cheng.contract.cheng_error.v1",
        code,
        class: className,
        retryable,
        evidence: EVIDENCE,
      });
      expect(error.message).toContain(String(code));
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("treats 0 as PASS, not an error", () => {
    expect(classifyRunnerExit(0, EVIDENCE)).toBeNull();
    expect(runnerExitMeaning(0)).toBe("PASS");
  });

  it("only marks the judge infrastructure code as retryable", () => {
    const retryable = EXPECTED.filter(([, , canRetry]) => canRetry).map(
      ([code]) => code,
    );
    expect(retryable).toEqual([33]);
  });

  it("fails closed on v1 modgen and signal codes", () => {
    for (const code of [1, 12, 13, 34, 35, 42, 124, 129, 130, 143, 255]) {
      expectContractError(
        () => classifyRunnerExit(code, EVIDENCE),
        "CHENG_CONTRACT_UNKNOWN_EXIT_CODE",
      );
    }
  });

  it("fails closed on a non-integer or negative code", () => {
    expectContractError(
      () => classifyRunnerExit(10.5, EVIDENCE),
      "CHENG_CONTRACT_UNKNOWN_EXIT_CODE",
    );
    expectContractError(
      () => classifyRunnerExit(-1, EVIDENCE),
      "CHENG_CONTRACT_UNKNOWN_EXIT_CODE",
    );
  });

  it("requires evidence", () => {
    expectContractError(
      () => classifyRunnerExit(31, []),
      "CHENG_CONTRACT_MISSING_EVIDENCE",
    );
  });

  it("honors a custom message", () => {
    const error = classifyRunnerExit(31, ["gap.txt: exhausted"], {
      message: "custom gap message",
    });
    expect(error?.message).toBe("custom gap message");
  });

  it("returns a copy of the evidence array", () => {
    const evidence = ["first"];
    const error = classifyRunnerExit(32, evidence);
    evidence.push("second");
    expect(error?.evidence).toEqual(["first"]);
  });

  it("rejects malformed ChengError values", () => {
    const valid = {
      kind: "cheng_error",
      schema: "cheng.contract.cheng_error.v1",
      code: 31,
      class: "unsolved",
      retryable: false,
      message: "gap",
      evidence: ["gap.txt"],
    };
    expect(ChengErrorSchema.safeParse(valid).success).toBe(true);

    for (const malformed of [
      { ...valid, code: 0 },
      { ...valid, message: "" },
      { ...valid, evidence: [] },
      { ...valid, evidence: [""] },
      { ...valid, class: "unknown_class" },
      { ...valid, extra: true },
    ]) {
      expect(ChengErrorSchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("returns null meaning for an unknown code", () => {
    expect(runnerExitMeaning(42)).toBeNull();
  });
});
