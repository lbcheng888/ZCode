import { ChengPlanSchema, type ChengPlan, type ChengPlanAction, type ChengPlanStage } from "./cheng-plan.js";
import { evaluateChengGate, type ChengGateInput, type ChengGateResult } from "./cheng-gate.js";

/**
 * 确定性 planner（P4）：固定动作枚举 + 固定成本桶 + 只读回执。
 *
 * 不调用模型；输入与 ChengGate 相同（ChengError/RunVolumeReceipt/SettleReceipt/StructureReceipt）。
 * 成本是初始实测桶（p06 的 expansions 直接来自真实 run），后续可换 p50 表而不改形状。
 * 推荐动作必须出现在 candidates；证据非空；stop 只用于“本档已到终点”。
 */
export interface ChengPlannerInput extends ChengGateInput {
  readonly task: string;
  readonly jobId?: string;
}

export interface ChengPlanResult {
  readonly gate: ChengGateResult;
  readonly plan: ChengPlan;
}

const COSTS = {
  fixSpec: { wallMs: 0, expansions: 0 },
  raiseBudget: { wallMs: 0, expansions: 11_044_292 },
  fixCodegen: { wallMs: 60_000, expansions: 0 },
  fixOracle: { wallMs: 30_000, expansions: 0 },
  regenerate: { wallMs: 30_000, expansions: 0 },
  split: { wallMs: 40_000, expansions: 0 },
  stop: { wallMs: 0, expansions: 0 },
} as const;

type Candidate = {
  action: ChengPlanAction;
  target: string;
  cost: { wallMs: number; expansions: number };
  risk: "low" | "medium" | "high";
  expectedGain: number;
  evidence: string[];
};

export function planChengNextAction(input: ChengPlannerInput): ChengPlanResult {
  const gate = evaluateChengGate(input);
  const frontier = frontierOf(input, gate);
  const candidates = candidatesOf(input, gate, frontier.target, frontier.evidence);
  const recommended = recommendOf(input, gate, candidates);
  const plan = ChengPlanSchema.parse({
    kind: "cheng_plan",
    schema: "cheng.contract.cheng_plan.v1",
    frontier,
    candidates,
    recommended,
    blockedBy: blockedByOf(input, gate),
    budget: { wallMs: 0, expansions: 0 },
  });
  return { gate, plan };
}

function frontierOf(input: ChengPlannerInput, gate: ChengGateResult): {
  stage: ChengPlanStage;
  target: string;
  evidence: string[];
} {
  const baseEvidence = [
    ...(input.jobId === undefined ? [] : [`jobId:${input.jobId}`]),
    ...gate.reasons.slice(0, 5),
    ...(input.error === null ? [] : input.error.evidence.slice(0, 4).map((item) => `error:${item}`)),
  ];
  const evidence =
    baseEvidence.length > 0
      ? baseEvidence
      : [
          `mode:${input.mode}`,
          `acceptance:${input.run?.acceptance.level ?? "missing"}`,
        ];
  if (input.error === null) {
    return { stage: "provenance", target: input.task, evidence };
  }
  const stage: ChengPlanStage =
    input.error.class === "structure_fail"
      ? "structure"
      : input.error.class === "judge_fail"
        ? "judge"
        : input.error.class === "provenance_fail"
          ? "provenance"
          : "spec";
  return { stage, target: input.task, evidence };
}

function candidatesOf(
  input: ChengPlannerInput,
  gate: ChengGateResult,
  target: string,
  evidence: string[],
): Candidate[] {
  const base = { evidence: evidence.length > 0 ? evidence : ["gate:blocked"] };
  if (input.error !== null) {
    switch (input.error.class) {
      case "unsolved":
        return [
          { action: "fix_spec", target, cost: COSTS.fixSpec, risk: "low", expectedGain: 0.6, ...base },
          { action: "raise_budget", target, cost: COSTS.raiseBudget, risk: "medium", expectedGain: 0.4, ...base },
          { action: "stop", target: "task", cost: COSTS.stop, risk: "low", expectedGain: 0, ...base },
        ];
      case "judge_fail":
        return [
          { action: "fix_codegen", target, cost: COSTS.fixCodegen, risk: "medium", expectedGain: 0.6, ...base },
          { action: "fix_oracle", target, cost: COSTS.fixOracle, risk: "medium", expectedGain: 0.4, ...base },
          { action: "stop", target: "task", cost: COSTS.stop, risk: "low", expectedGain: 0, ...base },
        ];
      case "structure_fail":
        return [
          { action: "regenerate_module", target, cost: COSTS.regenerate, risk: "medium", expectedGain: 0.6, ...base },
          { action: "split_module", target, cost: COSTS.split, risk: "high", expectedGain: 0.3, ...base },
          { action: "stop", target: "task", cost: COSTS.stop, risk: "low", expectedGain: 0, ...base },
        ];
      case "provenance_fail":
        return [
          { action: "fix_codegen", target, cost: COSTS.fixCodegen, risk: "high", expectedGain: 0.2, ...base },
          { action: "raise_budget", target, cost: COSTS.raiseBudget, risk: "high", expectedGain: 0.2, ...base },
          { action: "stop", target: "production", cost: COSTS.stop, risk: "low", expectedGain: 0, ...base },
        ];
      default:
        return [
          { action: "fix_spec", target, cost: COSTS.fixSpec, risk: "medium", expectedGain: 0.4, ...base },
          { action: "stop", target: "task", cost: COSTS.stop, risk: "low", expectedGain: 0, ...base },
        ];
    }
  }
  if (!gate.ok) {
    return [
      { action: "fix_spec", target, cost: COSTS.fixSpec, risk: "medium", expectedGain: 0.4, ...base },
      { action: "stop", target: "task", cost: COSTS.stop, risk: "low", expectedGain: 0, ...base },
    ];
  }
  // 本档已到终点：诊断绿停在该档，绝不把 stop 说成生产完成。
  return [
    { action: "stop", target: input.mode === "production" ? "production" : "diagnostic_acceptance", cost: COSTS.stop, risk: "low", expectedGain: 1, ...base },
  ];
}

function recommendOf(
  input: ChengPlannerInput,
  gate: ChengGateResult,
  candidates: Candidate[],
): { action: ChengPlanAction; target: string } {
  if (!gate.ok && input.error === null) {
    const first = candidates[0];
    return first === undefined
      ? { action: "stop", target: "task" }
      : { action: first.action, target: first.target };
  }
  if (input.error !== null && input.error.class === "provenance_fail") {
    const stop = candidates.find((candidate) => candidate.action === "stop");
    if (stop !== undefined) {
      return { action: stop.action, target: stop.target };
    }
  }
  if (input.error !== null) {
    const first = candidates[0];
    if (first !== undefined) {
      return { action: first.action, target: first.target };
    }
  }
  const stop = candidates.find((candidate) => candidate.action === "stop");
  if (stop !== undefined) {
    return { action: stop.action, target: stop.target };
  }
  const first = candidates[0];
  if (first === undefined) {
    throw new Error("planner produced no candidates");
  }
  return { action: first.action, target: first.target };
}

function blockedByOf(input: ChengPlannerInput, gate: ChengGateResult): string[] {
  const blocked: string[] = [];
  if (input.error !== null) {
    blocked.push(`runner_rc=${String(input.error.code)}`, `error_class=${input.error.class}`);
  }
  if (!gate.ok) blocked.push(...gate.reasons);
  if (input.mode === "diagnostic" && gate.ok) {
    blocked.push("production_requires_provenance");
  }
  return blocked;
}
