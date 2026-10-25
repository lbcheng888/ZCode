import { describe, expect, it } from "vitest";
import {
  parseGoalCompletionVerificationText,
  evaluateTargetBudgetPressure,
  findExhaustedTargetBudgetDimension,
  formatTargetAnchorPrompt,
  formatTargetBudgetOutcomePrompt,
  formatGoalContinuationPrompt,
  goalRoundLabel,
  DEFAULT_TARGET_TURN_BUDGET,
  type SessionGoal,
} from "../src/tools/target.js";

function budgetGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    sessionID: "s1" as never,
    targetID: "target-budget",
    objective: "Ship the budget goal",
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    turnBudget: null,
    turnsUsed: 0,
    wallClockBudgetSeconds: null,
    time: { created: 1, updated: 1 },
    ...overrides,
  };
}

describe("goal target budget evaluation", () => {
  it("returns null pressure when no budget dimension is configured", () => {
    const goal = budgetGoal();
    expect(evaluateTargetBudgetPressure(goal)).toBeNull();
    expect(findExhaustedTargetBudgetDimension(goal)).toBeNull();
  });

  it("tracks the strongest dimension and ignores unset ones", () => {
    const goal = budgetGoal({
      tokenBudget: 100,
      tokensUsed: 50,
      turnBudget: 10,
      turnsUsed: 9,
    });
    const pressure = evaluateTargetBudgetPressure(goal);
    expect(pressure).toMatchObject({ dimension: "turn", ratio: 0.9 });
    expect(findExhaustedTargetBudgetDimension(goal)).toBeNull();
  });

  it("reports the exhausted dimension at 100 percent including live deltas", () => {
    const goal = budgetGoal({ tokenBudget: 100, tokensUsed: 80 });
    const exhausted = findExhaustedTargetBudgetDimension(goal, { tokensUsedDelta: 25 });
    expect(exhausted).toMatchObject({
      dimension: "token",
      used: 105,
      budget: 100,
      ratio: 1.05,
    });
    const wallClock = findExhaustedTargetBudgetDimension(
      budgetGoal({ wallClockBudgetSeconds: 60, timeUsedSeconds: 30 }),
      { timeUsedSecondsDelta: 30 },
    );
    expect(wallClock).toMatchObject({ dimension: "wall-clock" });
    const turns = findExhaustedTargetBudgetDimension(
      budgetGoal({ turnBudget: DEFAULT_TARGET_TURN_BUDGET, turnsUsed: 256 }),
    );
    expect(turns).toMatchObject({ dimension: "turn", budget: 256 });
  });

  it("adds convergence guidance to prompts past the 75 percent threshold", () => {
    const nearLimit = budgetGoal({ tokenBudget: 100, tokensUsed: 76 });
    const anchor = formatTargetAnchorPrompt(nearLimit);
    expect(anchor).toContain("Active session goal anchor");
    expect(anchor).toContain("<untrusted_objective>");
    expect(anchor).toContain("token budget is at 76%");
    expect(anchor).toContain("Converge now");

    const continuation = formatGoalContinuationPrompt(nearLimit);
    expect(continuation).toContain("Converge now");
    expect(continuation).toContain("Goal turns used");

    const early = formatTargetAnchorPrompt(budgetGoal({ tokenBudget: 100, tokensUsed: 10 }));
    expect(early).not.toContain("Converge now");
  });

  it("formats the final outcome prompt for the exhausted dimension", () => {
    const goal = budgetGoal({ turnBudget: 4, turnsUsed: 4, status: "budget_limited" });
    const pressure = findExhaustedTargetBudgetDimension(goal);
    expect(pressure).toMatchObject({ dimension: "turn" });
    const outcome = formatTargetBudgetOutcomePrompt(goal, pressure!);
    expect(outcome).toContain("The session goal budget is exhausted.");
    expect(outcome).toContain("turn budget (4/4)");
    expect(outcome).toContain("budget-exhausted");
    expect(outcome).toContain("Write the final user-facing outcome summary now");
    expect(outcome).toContain("<untrusted_objective>");
  });
});

describe("goal target contracts", () => {
  it("parses completion verification from fenced json responses", () => {
    expect(
      parseGoalCompletionVerificationText(
        '```json\n{"nextAction":"Run pnpm test","passed":false,"reason":"Missing evidence"}\n```',
      ),
    ).toEqual({
      nextAction: "Run pnpm test",
      passed: false,
      reason: "Missing evidence",
    });
  });

  it("parses completion verification when a fenced response is json-string encoded", () => {
    expect(
      parseGoalCompletionVerificationText(
        JSON.stringify(
          '```json\n{"nextAction":"","passed":true,"reason":"All requirements are complete."}\n```',
        ),
      ),
    ).toEqual({
      passed: true,
      reason: "All requirements are complete.",
    });
  });

  it("treats malformed verifier json as passed fail-open", () => {
    expect(
      parseGoalCompletionVerificationText(
        '```json\n{"passed": true, "reason": "目标"继续修环境和做完所有开发"已全部完成。", "nextAction": ""}\n```',
      ),
    ).toEqual({
      passed: true,
      reason: "The completion verifier did not return valid JSON.",
    });
  });

  it("treats non-json verifier text as passed fail-open", () => {
    expect(parseGoalCompletionVerificationText("done")).toEqual({
      passed: true,
      reason: "The completion verifier did not return valid JSON.",
    });
  });
});

describe("goal round prompt (Phase 2 idle driver)", () => {
  it("labels the reserved round from turnsUsed and includes max rounds when bounded", () => {
    const goal = budgetGoal({ turnBudget: 8, turnsUsed: 2 });
    expect(goalRoundLabel(goal)).toBe("round 3 of at most 8");
    const prompt = formatGoalContinuationPrompt(goal);
    expect(prompt).toContain('<goal_round round="3" max_rounds="8">');
    expect(prompt).toContain("This is goal round 3 of at most 8.");
  });

  it("omits max_rounds when the turn budget is unbounded", () => {
    const goal = budgetGoal({ turnBudget: null, turnsUsed: 0 });
    expect(goalRoundLabel(goal)).toBe("round 1");
    const prompt = formatGoalContinuationPrompt(goal);
    expect(prompt).toContain('<goal_round round="1">');
    expect(prompt).not.toContain("max_rounds=");
  });

  it("requires one bounded slice of work per round", () => {
    const prompt = formatGoalContinuationPrompt(budgetGoal({ turnBudget: 256, turnsUsed: 41 }));
    expect(prompt).toContain("Work in one bounded slice this round");
    expect(prompt).toContain("Do not try to complete the entire objective in a single round.");
    expect(prompt).toContain('<goal_round round="42" max_rounds="256">');
  });

  // Phase 3 workflow 桥(设计 §3.3):判定权阶梯与委派指引只在工具面在场时进入续跑提示。
  it("omits the workflow delegation ladder when the bridge is unavailable", () => {
    const prompt = formatGoalContinuationPrompt(budgetGoal({ turnBudget: 256, turnsUsed: 0 }));
    expect(prompt).not.toContain("Workflow delegation");
    expect(prompt).not.toContain("Adjudication ladder");
  });

  it("adds the workflow delegation ladder when the bridge is enabled", () => {
    const prompt = formatGoalContinuationPrompt(
      budgetGoal({ turnBudget: 256, turnsUsed: 0 }),
      null,
      { workflowDelegation: true },
    );
    expect(prompt).toContain(
      "launch it as a dynamic workflow run with CreateWorkflow instead of grinding through it inline",
    );
    // 发起后本回合收尾:workflow 在途目标 disarm,回填后自动续跑(§3.3 双重驱动消除的模型面)。
    expect(prompt).toContain("the goal stands down while the run is in flight");
    expect(prompt).toContain("resumes automatically when the run's narrow result returns");
    // 判定权阶梯:确定性命令退出码 > workflow 内机器检查 > 模型自身判断。
    expect(prompt).toContain(
      "deterministic command exit codes, then machine checks inside the workflow run, then your own judgment",
    );
    expect(prompt).toContain("Enumerable verification work belongs in the workflow run");
    // 桥段落不进 goal_round 轮次元数据标签,保持标签只承载 round 语义。
    const goalRoundBlock = prompt.slice(
      prompt.indexOf("<goal_round"),
      prompt.indexOf("</goal_round>") + "</goal_round>".length,
    );
    expect(goalRoundBlock).not.toContain("Workflow delegation");
  });
});
