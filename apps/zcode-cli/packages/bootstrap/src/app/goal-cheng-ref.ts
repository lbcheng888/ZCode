import type { ChengPlanResult } from "@zcode/cheng-host";
import type { GoalContinuationChengPlanCard, GoalChengRef, SessionGoal } from "@zcode/contracts";

import type { BackgroundRunRow } from "../super-agent/watchdog/contract.js";
import {
  toGoalContinuationChengPlanCard,
  type ChengGateVerdict,
} from "./workflow-cheng-world-read.js";

/**
 * S4：goal 的显式 Cheng plan/run 引用解析。
 *
 * 唯一的关联来源是 `SessionGoal.chengRef`（由 GoalChengBind 经 host inspect 写入）。
 * 这里不做“目标创建后最近 completed job”的时间推断：没有显式引用 = 该目标没有 Cheng
 * 证据，任何无关 job 都不会被借用。引用存在时按 registry 行复核 owner / state / runId，
 * 任一不符即 fail-closed（完成门返回 BLOCKED，路线卡不生成），错误不会被静默跳过。
 */
export interface GoalChengRegistryView {
  get(id: string): BackgroundRunRow | undefined;
}

export interface GoalChengRefResolverInput {
  /** 只信任本会话拥有的 cheng-job 行；跨会话/跨 workspace 的 jobId 不得借用。 */
  readonly ownerSession: string;
  readonly registry: GoalChengRegistryView;
  readonly verify: (jobId: string) => Promise<{ gate: ChengGateVerdict }>;
  readonly plan: (jobId: string, task: string) => Promise<ChengPlanResult>;
}

export interface GoalChengRefResolvers {
  gate(target: SessionGoal): Promise<ChengGateVerdict | undefined>;
  planCard(target: SessionGoal): Promise<GoalContinuationChengPlanCard | undefined>;
}

export function createGoalChengRefResolvers(
  input: GoalChengRefResolverInput,
): GoalChengRefResolvers {
  const gate = async (target: SessionGoal): Promise<ChengGateVerdict | undefined> => {
    const ref = target.chengRef;
    if (ref === undefined) return undefined;
    const checked = checkRef(input, ref);
    if (checked.ok === false) return blocked(checked.reason);
    return (await input.verify(ref.jobId)).gate;
  };

  const planCard = async (
    target: SessionGoal,
  ): Promise<GoalContinuationChengPlanCard | undefined> => {
    const ref = target.chengRef;
    if (ref === undefined) return undefined;
    const checked = checkRef(input, ref);
    if (checked.ok === false) return undefined;
    const result = await input.plan(ref.jobId, ref.task);
    const runId = ref.runId ?? runIdFromNarrowRef(checked.row.narrowResultRef);
    return toGoalContinuationChengPlanCard(
      result.plan,
      ref.planId,
      ...(runId === undefined ? [] : [runId]),
    );
  };

  return { gate, planCard };
}

type RefCheck =
  | { ok: true; row: BackgroundRunRow }
  | { ok: false; reason: string };

function checkRef(input: GoalChengRefResolverInput, ref: GoalChengRef): RefCheck {
  const row = input.registry.get(ref.jobId);
  if (row === undefined || row.kind !== "cheng-job") {
    return { ok: false, reason: "cheng_ref_not_tracked" };
  }
  if (row.ownerSession !== input.ownerSession) {
    return { ok: false, reason: "cheng_ref_owner_mismatch" };
  }
  if (row.state !== "completed") {
    return { ok: false, reason: `cheng_ref_${row.state}` };
  }
  const rowRunId = runIdFromNarrowRef(row.narrowResultRef);
  if (ref.runId !== undefined && rowRunId !== undefined && ref.runId !== rowRunId) {
    return { ok: false, reason: "cheng_ref_run_mismatch" };
  }
  return { ok: true, row };
}

function runIdFromNarrowRef(value: string | undefined): string | undefined {
  const prefix = "cheng-run://";
  if (value === undefined || !value.startsWith(prefix)) return undefined;
  const runId = value.slice(prefix.length);
  return runId.length === 0 ? undefined : runId;
}

function blocked(reason: string): ChengGateVerdict {
  return { ok: false, level: "BLOCKED", reasons: [reason] };
}
