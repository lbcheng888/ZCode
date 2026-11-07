import { describe, expect, it } from "vitest";

import type { ChengPlanResult } from "@zcode/cheng-host";
import type { GoalChengRef, SessionGoal } from "@zcode/contracts";

import {
  createGoalChengRefResolvers,
  type GoalChengRegistryView,
} from "../src/app/goal-cheng-ref.js";
import type { BackgroundRunRow } from "../src/super-agent/watchdog/contract.js";

const JOB_A = "a".repeat(64);
const JOB_B = "b".repeat(64);
const PLAN: ChengPlanResult["plan"] = {
  kind: "cheng_plan",
  schema: "cheng.contract.cheng_plan.v1",
  frontier: { stage: "spec", target: "p02_min2", evidence: ["jobId:job-a"] },
  candidates: [
    {
      action: "fix_spec",
      target: "p02_min2",
      cost: { wallMs: 0, expansions: 0 },
      risk: "low",
      expectedGain: 0.6,
      evidence: ["settle_not_solved"],
    },
  ],
  recommended: { action: "fix_spec", target: "p02_min2" },
  blockedBy: ["settle_not_solved"],
  budget: { wallMs: 0, expansions: 0 },
};

function goal(chengRef?: GoalChengRef, created = 1): SessionGoal {
  return {
    sessionID: "session-a" as never,
    targetID: "target-a",
    objective: "Ship Cheng",
    summaryTitle: null,
    status: "active",
    ...(chengRef === undefined ? {} : { chengRef }),
    revision: 1,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created, updated: created },
  };
}

function ref(jobId: string, runId?: string): GoalChengRef {
  return {
    jobId,
    task: "p02_min2",
    ...(runId === undefined ? {} : { runId }),
    planId: `cheng-plan://${jobId}`,
  };
}

function row(input: {
  id: string;
  state: BackgroundRunRow["state"];
  ownerSession?: string;
  runId?: string;
}): BackgroundRunRow {
  return {
    id: input.id,
    kind: "cheng-job",
    owner: "cheng-host",
    ownerSession: input.ownerSession ?? "session-a",
    state: input.state,
    ...(input.runId === undefined ? {} : { narrowResultRef: `cheng-run://${input.runId}` }),
    registeredAt: 1,
    updatedAt: 1,
  };
}

function fixture(rows: BackgroundRunRow[], target: SessionGoal) {
  const registry: GoalChengRegistryView = {
    get: (id) => rows.find((candidate) => candidate.id === id),
  };
  const verifyCalls: string[] = [];
  const planCalls: Array<{ jobId: string; task: string }> = [];
  const resolvers = createGoalChengRefResolvers({
    ownerSession: "session-a",
    registry,
    verify: async (jobId) => {
      verifyCalls.push(jobId);
      return {
        gate: { ok: true, level: "PRODUCTION", reasons: [] },
      };
    },
    plan: async (jobId, task) => {
      planCalls.push({ jobId, task });
      return { gate: { ok: true, level: "PRODUCTION", reasons: [] }, plan: PLAN };
    },
  });
  return { resolvers, target, verifyCalls, planCalls };
}

describe("explicit goal Cheng reference", () => {
  it("uses no Cheng evidence when the goal has no explicit reference", async () => {
    // 即使 registry 里有一个本会话 completed job，也不会被“最近 job”启发式借用。
    const { resolvers, target, verifyCalls, planCalls } = fixture(
      [row({ id: JOB_A, state: "completed", runId: "run-a" })],
      goal(),
    );

    await expect(resolvers.gate(target)).resolves.toBeUndefined();
    await expect(resolvers.planCard(target)).resolves.toBeUndefined();
    expect(verifyCalls).toEqual([]);
    expect(planCalls).toEqual([]);
  });

  it("resolves the bound job only, not a later completed job", async () => {
    const { resolvers, target, verifyCalls, planCalls } = fixture(
      [
        row({ id: JOB_A, state: "completed", runId: "run-a" }),
        row({ id: JOB_B, state: "completed", runId: "run-b" }),
      ],
      // 显式引用允许早于目标创建时间；旧实现按 target.time.created 过滤会漏掉它。
      goal(ref(JOB_A, "run-a"), 100),
    );

    await expect(resolvers.gate(target)).resolves.toEqual({
      ok: true,
      level: "PRODUCTION",
      reasons: [],
    });
    expect(verifyCalls).toEqual([JOB_A]);
    const card = await resolvers.planCard(target);
    expect(card).toMatchObject({
      planId: `cheng-plan://${JOB_A}`,
      runId: "run-a",
      recommended: { action: "fix_spec", target: "p02_min2" },
    });
    expect(planCalls).toEqual([{ jobId: JOB_A, task: "p02_min2" }]);
  });

  it("fills the run reference from the host-owned registry when binding preceded the run", async () => {
    const { resolvers, target } = fixture(
      [row({ id: JOB_A, state: "completed", runId: "run-a" })],
      goal(ref(JOB_A)),
    );

    await expect(resolvers.planCard(target)).resolves.toMatchObject({
      planId: `cheng-plan://${JOB_A}`,
      runId: "run-a",
    });
  });

  it("fails closed on missing, foreign, unfinished, or run-mismatched references", async () => {
    for (const [current, reason] of [
      [goal(ref(JOB_B, "run-b")), "cheng_ref_not_tracked"],
      [goal(ref(JOB_A, "run-a")), "cheng_ref_owner_mismatch"],
      [goal(ref(JOB_A, "run-a")), "cheng_ref_running"],
      [goal(ref(JOB_A, "run-other")), "cheng_ref_run_mismatch"],
    ] as const) {
      const rows =
        reason === "cheng_ref_not_tracked"
          ? []
          : [
              row({
                id: JOB_A,
                state: reason === "cheng_ref_running" ? "running" : "completed",
                ownerSession:
                  reason === "cheng_ref_owner_mismatch" ? "session-b" : "session-a",
                ...(reason === "cheng_ref_running" ? {} : { runId: "run-a" }),
              }),
              // 本会话另一个 completed job：显式引用无效时也绝不回退到它。
              row({ id: JOB_B, state: "completed", runId: "run-b" }),
            ];
      const { resolvers, verifyCalls } = fixture(rows, current);
      const gate = await resolvers.gate(current);
      expect(gate).toEqual({ ok: false, level: "BLOCKED", reasons: [reason] });
      expect(verifyCalls).toEqual([]);
      await expect(resolvers.planCard(current)).resolves.toBeUndefined();
    }
  });
});
