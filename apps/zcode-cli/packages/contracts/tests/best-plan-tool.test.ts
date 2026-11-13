import { describe, expect, it } from "vitest";
import {
  BEST_PLAN_BODY_MAX_CHARS,
  BEST_PLAN_MAX_CANDIDATE_OPTIONS,
  BEST_PLAN_OPTION_MAX_CHARS,
  BEST_PLAN_SUMMARY_MAX_CHARS,
  BEST_PLAN_TOOL_NAME,
  BestPlanInputJsonSchema,
  BestPlanInputSchema,
  BestPlanOutputJsonSchema,
  BestPlanOutputSchema,
} from "../src/tools/best-plan.js";

const validInput = {
  summary: "Normalize the tool result before the card renders it",
  currentEvidence:
    "packages/core/src/tool/handlers/list-models.ts:172 returns a ToolHandlerFailure instead of an empty list.",
  candidateOptions: [
    {
      option: "Normalize inside the handler before returning",
      cost: "One extra pass over the parsed input; no schema change.",
    },
    {
      option: "Normalize in the UI projection",
      cost: "Every host would have to repeat the same normalization.",
    },
  ],
  recommendation:
    "Normalize in the handler: one owner, and the model sees the same bytes the card does.",
  impact: "Touches packages/core only; no protocol or storage change; revert is a single file.",
  verification:
    "pnpm --dir apps/zcode-cli exec vitest run packages/core/tests/best-plan-tool.test.ts",
};

describe("ProposeBestPlan contracts", () => {
  it("accepts a complete six-field plan", () => {
    const parsed = BestPlanInputSchema.parse(validInput);

    expect(parsed).toEqual(validInput);
    expect(BEST_PLAN_TOOL_NAME).toBe("ProposeBestPlan");
  });

  it("rejects fewer than two candidate options", () => {
    const result = BestPlanInputSchema.safeParse({
      ...validInput,
      candidateOptions: [validInput.candidateOptions[0]],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["candidateOptions"]);
  });

  it("rejects more candidate options than the card can show", () => {
    const option = validInput.candidateOptions[0]!;
    const result = BestPlanInputSchema.safeParse({
      ...validInput,
      candidateOptions: Array.from({ length: BEST_PLAN_MAX_CANDIDATE_OPTIONS + 1 }, () => option),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["candidateOptions"]);
  });

  it("rejects an empty field instead of recording a hollow plan", () => {
    for (const field of [
      "summary",
      "currentEvidence",
      "recommendation",
      "impact",
      "verification",
    ] as const) {
      const result = BestPlanInputSchema.safeParse({ ...validInput, [field]: "" });
      expect(result.success, field).toBe(false);
      expect(result.error?.issues[0]?.path, field).toEqual([field]);
    }

    const emptyOption = BestPlanInputSchema.safeParse({
      ...validInput,
      candidateOptions: [{ option: "", cost: "cheap" }, validInput.candidateOptions[1]],
    });
    expect(emptyOption.success).toBe(false);
  });

  it("rejects overlong fields at their declared bounds", () => {
    const cases = [
      { field: "summary", value: "s".repeat(BEST_PLAN_SUMMARY_MAX_CHARS + 1) },
      { field: "currentEvidence", value: "e".repeat(BEST_PLAN_BODY_MAX_CHARS + 1) },
      { field: "recommendation", value: "r".repeat(BEST_PLAN_BODY_MAX_CHARS + 1) },
      { field: "impact", value: "i".repeat(BEST_PLAN_BODY_MAX_CHARS + 1) },
      { field: "verification", value: "v".repeat(BEST_PLAN_BODY_MAX_CHARS + 1) },
    ] as const;

    for (const { field, value } of cases) {
      const result = BestPlanInputSchema.safeParse({ ...validInput, [field]: value });
      expect(result.success, field).toBe(false);
      expect(result.error?.issues[0]?.path, field).toEqual([field]);
    }

    const overlongOption = BestPlanInputSchema.safeParse({
      ...validInput,
      candidateOptions: [
        { option: "o".repeat(BEST_PLAN_OPTION_MAX_CHARS + 1), cost: "cheap" },
        validInput.candidateOptions[1],
      ],
    });
    expect(overlongOption.success).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    const result = BestPlanInputSchema.safeParse({ ...validInput, extra: "not part of the card" });

    expect(result.success).toBe(false);
  });

  it("publishes a strict provider schema with the frozen field bounds", () => {
    const properties = BestPlanInputJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(BestPlanInputJsonSchema.additionalProperties).toBe(false);
    expect(BestPlanInputJsonSchema.required).toEqual([
      "summary",
      "currentEvidence",
      "candidateOptions",
      "recommendation",
      "impact",
      "verification",
    ]);
    expect(properties.summary).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: BEST_PLAN_SUMMARY_MAX_CHARS,
    });
    expect(properties.recommendation).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: BEST_PLAN_BODY_MAX_CHARS,
    });
    expect(properties.candidateOptions).toMatchObject({
      type: "array",
      minItems: 2,
      maxItems: BEST_PLAN_MAX_CANDIDATE_OPTIONS,
    });
    expect(properties.candidateOptions?.items).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["option", "cost"],
    });
  });

  it("freezes the output to ok/planId/message", () => {
    const output = { ok: true, planId: "0123456789ab", message: "Best plan recorded." };

    expect(BestPlanOutputSchema.parse(output)).toEqual(output);
    expect(BestPlanOutputSchema.safeParse({ ...output, ok: false }).success).toBe(false);
    expect(BestPlanOutputJsonSchema.additionalProperties).toBe(false);
    expect(BestPlanOutputJsonSchema.required).toEqual(["ok", "planId", "message"]);
  });
});
