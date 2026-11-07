import { describe, expect, it } from "vitest";

import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";
import { WorkflowError } from "@zcode/dynamic-workflow";

import {
  CHENG_DEFAULT_BUDGET,
  executeChengWorldRead,
  toGoalContinuationChengPlanCard,
  type ChengHostPort,
} from "../src/app/workflow-cheng-world-read.js";
import { executeWorldRead } from "../src/app/workflow-world-read.js";

function deps(port?: ChengHostPort) {
  return {
    fileSystemPort: {} as FileSystemPort,
    executionPort: {} as ExecutionPort,
    cwd: "/workspace",
    ...(port === undefined ? {} : { chengHostPort: port }),
  };
}

function fakePort() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const port: ChengHostPort = {
    async generate(input) {
      calls.push({ method: "generate", args: [input] });
      return {
        jobId: "a".repeat(64),
        runId: "m5-test",
        state: "succeeded",
        exitCode: 41,
        verdict: "DIAGNOSTIC_NOT_ACCEPTANCE",
      };
    },
    async verify(jobId) {
      calls.push({ method: "verify", args: [jobId] });
      return {
        level: "DIAGNOSTIC_NOT_ACCEPTANCE",
        productionAcceptance: false,
        verdict: "DIAGNOSTIC_NOT_ACCEPTANCE",
        semanticPass: true,
        settlePassed: 2,
        settleTotal: 2,
        structureGateOk: null,
        gate: { ok: true, level: "DIAGNOSTIC_NOT_ACCEPTANCE", reasons: [] },
        artifactRef: "/runs/m5-test",
      };
    },
    async plan(jobId, task) {
      calls.push({ method: "plan", args: [jobId, task] });
      return {
        gate: { ok: false, level: "BLOCKED" as const, reasons: ["settle_not_solved"] },
        plan: {
          kind: "cheng_plan" as const,
          schema: "cheng.contract.cheng_plan.v1" as const,
          frontier: { stage: "spec" as const, target: task, evidence: [`jobId:${jobId}`] },
          candidates: [
            {
              action: "stop" as const,
              target: "task",
              cost: { wallMs: 0, expansions: 0 },
              risk: "low" as const,
              expectedGain: 0,
              evidence: ["gate:blocked"],
            },
          ],
          recommended: { action: "stop" as const, target: "task" },
          blockedBy: ["settle_not_solved"],
          budget: { wallMs: 0, expansions: 0 },
        },
      };
    },
    async graph(jobId, task, view) {
      calls.push({ method: "graph", args: [jobId, task, view] });
      return {
        available: true,
        reason: null,
        nodes: 3,
        edges: 2,
        roots: 1,
        gateOk: null,
        artifactRef: "/runs/m5-test/trace.jsonl",
        digest: "b".repeat(64),
      };
    },
  };
  return { port, calls };
}

describe("cheng world-read execution", () => {
  it("defaults the budget, validates args and dispatches the three ops", async () => {
    const { port, calls } = fakePort();
    const d = deps(port);

    await executeWorldRead(d, "cheng-generate", [
      { specPath: "/spec/p02.json", task: "p02_min2" },
    ]);
    expect(calls[0]).toEqual({
      method: "generate",
      args: [
        {
          specPath: "/spec/p02.json",
          task: "p02_min2",
          budget: CHENG_DEFAULT_BUDGET,
        },
      ],
    });

    await executeWorldRead(d, "cheng-verify", ["a".repeat(64)]);
    expect(calls[1]).toEqual({ method: "verify", args: ["a".repeat(64)] });

    await executeWorldRead(d, "cheng-graph", ["a".repeat(64), "p02_min2"]);
    expect(calls[2]).toEqual({
      method: "graph",
      args: ["a".repeat(64), "p02_min2", "decision"],
    });

    await executeWorldRead(d, "cheng-graph", ["a".repeat(64), "p02_min2", "structure"]);
    expect(calls[3]).toEqual({
      method: "graph",
      args: ["a".repeat(64), "p02_min2", "structure"],
    });
  });

  it("rejects a missing port with the named ChengHostUnavailable code", async () => {
    await expect(
      executeChengWorldRead(undefined, "cheng-generate", [
        { specPath: "/spec/p02.json", task: "p02_min2" },
      ]),
    ).rejects.toMatchObject({ code: "ChengHostUnavailable" });
  });

  it("rejects malformed arguments instead of coercing them", async () => {
    const { port } = fakePort();
    for (const args of [
      [],
      [{ task: "p02_min2" }],
      [{ specPath: "/spec", task: "p02_min2", budget: 0 }],
      [{ specPath: "/spec", task: "p02_min2", attempt: "bad space" }],
      [{ specPath: "/spec", task: "p02_min2", extra: true }],
    ]) {
      await expect(
        executeChengWorldRead(port, "cheng-generate", args),
      ).rejects.toMatchObject({ code: "DriverError" });
    }
    await expect(
      executeChengWorldRead(port, "cheng-graph", ["a".repeat(64), "p02_min2", "nope"]),
    ).rejects.toMatchObject({ code: "DriverError" });
  });

  it("keeps the dispatch table exhaustive", async () => {
    const { port } = fakePort();
    await expect(
      executeWorldRead(deps(port), "cheng-verify", ["a".repeat(64)]),
    ).resolves.toMatchObject({ level: "DIAGNOSTIC_NOT_ACCEPTANCE" });
    await expect(
      executeChengWorldRead(port, "cheng-generate" as never, []),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it("projects a real ChengPlan into a compact goal route card", () => {
    const card = toGoalContinuationChengPlanCard(
      {
        kind: "cheng_plan",
        schema: "cheng.contract.cheng_plan.v1",
        frontier: {
          stage: "spec",
          target: "p02_min2",
          evidence: ["jobId:job-1", "settle_not_solved"],
        },
        candidates: [
          {
            action: "fix_spec",
            target: "p02_min2",
            cost: { wallMs: 0, expansions: 0 },
            risk: "low",
            expectedGain: 0.6,
            evidence: ["settle_not_solved", "gate:blocked"],
          },
        ],
        recommended: { action: "fix_spec", target: "p02_min2" },
        blockedBy: ["settle_not_solved"],
        budget: { wallMs: 0, expansions: 0 },
      },
      "cheng-plan://job-1",
      "run-1",
    );

    expect(card).toEqual({
      planId: "cheng-plan://job-1",
      runId: "run-1",
      frontier: {
        stage: "spec",
        target: "p02_min2",
        evidence: ["jobId:job-1", "settle_not_solved"],
      },
      recommended: { action: "fix_spec", target: "p02_min2" },
      evidenceRefs: ["jobId:job-1", "settle_not_solved", "gate:blocked"],
    });
    expect(card).not.toHaveProperty("candidates");
    expect(card).not.toHaveProperty("budget");
  });
});
