import { describe, expect, it } from "vitest";

import {
  CHENG_EXPLAIN_TOOL_NAME,
  CHENG_INSPECT_TOOL_NAME,
  CHENG_PLAN_TOOL_NAME,
  CHENG_VERIFY_TOOL_NAME,
  ChengExplainInputSchema,
  ChengExplainOutputSchema,
  ChengInspectInputSchema,
  ChengInspectOutputSchema,
  ChengPlanInputSchema,
  ChengPlanOutputSchema,
  ChengVerifyOutputSchema,
  type ChengExplainInput,
} from "@zcode/contracts";

import {
  CHENG_READ_PORT_UNAVAILABLE_REASON,
  builtInTools,
  type ChengReadPort,
  type ToolEntry,
  type ToolExecutionContext,
} from "../src/index.js";

const JOB_ID = "a".repeat(64);

function entry(name: string): ToolEntry {
  const found = builtInTools.find((candidate) => candidate.metadata.name === name);
  if (found === undefined) {
    throw new Error(`tool not registered: ${name}`);
  }
  return found;
}

function fakePort(): ChengReadPort {
  return {
    async inspect(jobId) {
      return {
        status: "ok",
        jobId,
        state: "succeeded",
        runId: "m5-test",
        runDir: "/tmp/run",
        exitCode: 41,
        cancelRequested: false,
      };
    },
    async verify() {
      return {
        status: "ok",
        level: "DIAGNOSTIC_NOT_ACCEPTANCE",
        productionAcceptance: false,
        verdict: "DIAGNOSTIC_NOT_ACCEPTANCE",
        semanticPass: true,
        settlePassed: 2,
        settleTotal: 2,
        structureGateOk: null,
        gate: { ok: true, level: "DIAGNOSTIC_NOT_ACCEPTANCE", reasons: [] },
        artifactRef: "/tmp/run",
      };
    },
    async explain(input: ChengExplainInput) {
      return {
        status: "ok",
        available: true,
        reason: null,
        nodes: 31,
        edges: 40,
        roots: 6,
        gateOk: null,
        artifactRef: "/tmp/run/trace.jsonl",
        digest: "b".repeat(64),
      };
    },
    async plan(input) {
      return {
        status: "ok",
        gate: { ok: false, level: "BLOCKED", reasons: ["settle_not_solved"] },
        plan: {
          kind: "cheng_plan",
          schema: "cheng.contract.cheng_plan.v1",
          frontier: { stage: "spec", target: input.task, evidence: [`jobId:${input.jobId}`] },
          candidates: [
            {
              action: "stop",
              target: "task",
              cost: { wallMs: 0, expansions: 0 },
              risk: "low",
              expectedGain: 0,
              evidence: ["gate:blocked"],
            },
          ],
          recommended: { action: "stop", target: "task" },
          blockedBy: ["settle_not_solved"],
          budget: { wallMs: 0, expansions: 0 },
        },
      };
    },
  };
}

const context = (port?: ChengReadPort): ToolExecutionContext =>
  ({ toolCallId: "call-1", ...(port === undefined ? {} : { chengReadPort: port }) }) as unknown as ToolExecutionContext;

describe("Cheng read-only tools", () => {
  it("registers four deferred, read-only, approval-free tools", () => {
    for (const name of [
      CHENG_INSPECT_TOOL_NAME,
      CHENG_VERIFY_TOOL_NAME,
      CHENG_EXPLAIN_TOOL_NAME,
      CHENG_PLAN_TOOL_NAME,
    ]) {
      const tool = entry(name);
      expect(tool.metadata.readOnly).toBe(true);
      expect(tool.metadata.destructive).toBe(false);
      expect(tool.metadata.shouldDefer).toBe(true);
      expect(tool.metadata.alwaysLoad).toBeUndefined();
      expect(tool.metadata.sideEffectScope).toBe("none");
      expect(tool.metadata.needsApproval).toBe(false);
      expect(tool.metadata.riskLevel).toBe("low");
    }
    expect(entry(CHENG_INSPECT_TOOL_NAME).permission.permission).toBe("cheng.inspect");
    expect(entry(CHENG_VERIFY_TOOL_NAME).permission.permission).toBe("cheng.verify");
    expect(entry(CHENG_EXPLAIN_TOOL_NAME).permission.permission).toBe("cheng.explain");
    expect(entry(CHENG_EXPLAIN_TOOL_NAME).permission.alwaysAsk).toBeUndefined();
  });

  it("dispatches to the read port and echoes typed output", async () => {
    const port = fakePort();
    const inspect = await entry(CHENG_INSPECT_TOOL_NAME).handler({ jobId: JOB_ID }, context(port));
    expect(ChengInspectOutputSchema.parse(inspect)).toMatchObject({
      status: "ok",
      state: "succeeded",
      runId: "m5-test",
      exitCode: 41,
    });

    const verify = await entry(CHENG_VERIFY_TOOL_NAME).handler({ jobId: JOB_ID }, context(port));
    expect(ChengVerifyOutputSchema.parse(verify)).toMatchObject({
      status: "ok",
      level: "DIAGNOSTIC_NOT_ACCEPTANCE",
      productionAcceptance: false,
      settlePassed: 2,
      settleTotal: 2,
    });

    const explain = await entry(CHENG_EXPLAIN_TOOL_NAME).handler(
      { jobId: JOB_ID, task: "p02_min2" },
      context(port),
    );
    expect(ChengExplainOutputSchema.parse(explain)).toMatchObject({
      status: "ok",
      available: true,
      nodes: 31,
      edges: 40,
      digest: "b".repeat(64),
    });

    const plan = await entry(CHENG_PLAN_TOOL_NAME).handler(
      { jobId: JOB_ID, task: "p02_min2" },
      context(port),
    );
    expect(ChengPlanOutputSchema.parse(plan)).toMatchObject({
      status: "ok",
      gate: { ok: false, level: "BLOCKED" },
      plan: {
        kind: "cheng_plan",
        recommended: { action: "stop", target: "task" },
      },
    });
  });

  it("returns capability_absent instead of inventing a result when the host is unwired", async () => {
    for (const name of [
      CHENG_INSPECT_TOOL_NAME,
      CHENG_VERIFY_TOOL_NAME,
      CHENG_EXPLAIN_TOOL_NAME,
      CHENG_PLAN_TOOL_NAME,
    ]) {
      const input =
        name === CHENG_EXPLAIN_TOOL_NAME || name === CHENG_PLAN_TOOL_NAME
          ? { jobId: JOB_ID, task: "p02_min2" }
          : { jobId: JOB_ID };
      const output = await entry(name).handler(input, context());
      expect(output).toMatchObject({
        status: "capability_absent",
        reason: CHENG_READ_PORT_UNAVAILABLE_REASON,
      });
    }
  });

  it("rejects malformed job ids at the schema boundary", () => {
    expect(ChengInspectInputSchema.safeParse({ jobId: "short" }).success).toBe(false);
    expect(ChengInspectInputSchema.safeParse({ jobId: JOB_ID, extra: 1 }).success).toBe(false);
    expect(
      ChengExplainInputSchema.safeParse({ jobId: JOB_ID, task: "p02_min2", view: "nope" }).success,
    ).toBe(false);
  });
});
