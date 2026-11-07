import { describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@zcode/contracts";
import type { ChengReadPort } from "@zcode/core";

import { createHeadlessAdjudicationSession } from "../../src/super-agent/daemon/adjudicationSession.js";
import { createTestModelFactory, createTestModelSelection } from "../helpers/test-agent-runtime.js";

const JOB_ID = "a".repeat(64);
const PLAN_ID = `cheng-plan://${JOB_ID}`;

const PLAN = {
  kind: "cheng_plan" as const,
  schema: "cheng.contract.cheng_plan.v1" as const,
  frontier: { stage: "spec", target: "p02_min2", evidence: ["jobId:job-1"] },
  candidates: [
    {
      action: "fix_spec" as const,
      target: "p02_min2",
      cost: { wallMs: 0, expansions: 0 },
      risk: "low" as const,
      expectedGain: 0.6,
      evidence: ["settle_not_solved"],
    },
  ],
  recommended: { action: "fix_spec" as const, target: "p02_min2" },
  blockedBy: ["settle_not_solved"],
  budget: { wallMs: 0, expansions: 0 },
};

function chengReadPort() {
  const planCalls: Array<{ jobId: string; task: string }> = [];
  const port: ChengReadPort = {
    async inspect() {
      throw new Error("ChengInspect is not used in this test");
    },
    async verify() {
      throw new Error("ChengVerify is not used in this test");
    },
    async explain() {
      throw new Error("ChengExplain is not used in this test");
    },
    async plan(input) {
      planCalls.push(input);
      return {
        status: "ok",
        gate: { ok: true, level: "PRODUCTION", reasons: [] },
        plan: PLAN,
      };
    },
  };
  return { port, planCalls };
}

describe("headless adjudication Cheng tool path", () => {
  it("executes the real ChengPlan tool and returns a receipt for planId cross-check", async () => {
    const { port, planCalls } = chengReadPort();
    const seenTools: string[][] = [];
    let calls = 0;
    const modelFactory = createTestModelFactory({
      async generateText(request: ModelRequest) {
        seenTools.push((request.tools ?? []).map((tool) => tool.name));
        calls += 1;
        if (calls === 1) {
          return {
            finishReason: "tool_calls",
            text: "",
            toolCalls: [
              {
                id: "call-plan",
                name: "ChengPlan",
                input: { jobId: JOB_ID, task: "p02_min2" },
              },
            ],
            usage: { inputTokens: 10, outputTokens: 2 },
          };
        }
        return {
          finishReason: "stop",
          text: JSON.stringify({
            decisions: [
              {
                triggerId: "candidate-1",
                disposition: "record-only",
                chengPlanId: PLAN_ID,
              },
            ],
          }),
          usage: { inputTokens: 20, outputTokens: 5 },
        };
      },
    });
    const session = createHeadlessAdjudicationSession({
      modelSource: {
        modelFactory,
        resolveSelection: () => createTestModelSelection("test/default-runtime-model"),
        dispose: () => undefined,
      },
      abortSignal: new AbortController().signal,
      workingDirectory: "/tmp/zcode-headless-adjudication-cheng",
      chengReadPort: port,
    });

    const result = await session.run({
      workspaceIdentity: "ws-a",
      sessionKey: "ws-a",
      prompt: "adjudicate",
      candidateCount: 1,
      toolAllowlist: ["Recall", "GoalRead", "ChengInspect", "ChengPlan"],
      toolDisallowlist: ["ChengGenerate", "ChengVerify", "ChengExplain"],
      modelTier: "adjudicator",
      scheduling: "background-low-priority",
    });

    expect(seenTools[0]).toContain("ChengPlan");
    expect(seenTools[0]).toContain("ChengInspect");
    expect(seenTools[0]).not.toContain("ChengGenerate");
    expect(planCalls).toEqual([{ jobId: JOB_ID, task: "p02_min2" }]);
    expect(result.chengPlanReceipts).toEqual([
      { planId: PLAN_ID, jobId: JOB_ID, task: "p02_min2" },
    ]);
    expect(result.outputText).toContain(PLAN_ID);
  });

  it("keeps the zero-tool model-only path when no Cheng host port is wired", async () => {
    const seenTools: string[][] = [];
    const modelFactory = createTestModelFactory({
      async generateText(request: ModelRequest) {
        seenTools.push((request.tools ?? []).map((tool) => tool.name));
        return { finishReason: "stop", text: '{"decisions":[]}' };
      },
    });
    const session = createHeadlessAdjudicationSession({
      modelSource: {
        modelFactory,
        resolveSelection: () => createTestModelSelection("test/default-runtime-model"),
        dispose: vi.fn(),
      },
      abortSignal: new AbortController().signal,
      workingDirectory: "/tmp/zcode-headless-adjudication-cheng",
    });

    const result = await session.run({
      workspaceIdentity: "ws-a",
      sessionKey: "ws-a",
      prompt: "adjudicate",
      candidateCount: 1,
      toolAllowlist: ["Recall", "GoalRead", "ChengInspect", "ChengPlan"],
      toolDisallowlist: ["ChengGenerate", "ChengVerify", "ChengExplain"],
      modelTier: "adjudicator",
      scheduling: "background-low-priority",
    });

    expect(seenTools).toEqual([[]]);
    expect(result.chengPlanReceipts).toBeUndefined();
  });
});
