import type {
  BackgroundRunKind,
  BackgroundRunRow,
  GoalStateSource,
  SuperAgentWatchdogConfig,
  TriggerBacklogSource,
  WatchdogProbeResult,
} from "./contract.js";

/** 具备独立 stall 钟的 kind：workflow run 与 cheng-host job。 */
const STALL_CANDIDATE_KINDS: ReadonlySet<BackgroundRunKind> = new Set([
  "workflow",
  "cheng-job",
]);

/** 探针读依赖（spec §2）。registry 恒在；goal / trigger 端口缺席 ⇒ 对应探针显式 skipped。 */
export interface ProbeReadContext {
  now: number;
  rows: readonly BackgroundRunRow[];
  goalState?: GoalStateSource;
  triggerBacklog?: TriggerBacklogSource;
  config: SuperAgentWatchdogConfig;
}

/**
 * M10 程序探针目录（spec §2）。全部只读；数据源缺席 = skipped（带原因），不猜不兜底。
 * hit 时返回建议 repair——程序按目录硬映射，不听任何 LLM。
 */
export function runProbes(ctx: ProbeReadContext): WatchdogProbeResult[] {
  return [
    probeRegistryStall(ctx),
    probeWorkflowRunStalled(ctx),
    probeGoalBudgetLimitedOpenQuestions(ctx),
    probeTriggerBacklogAge(ctx),
    // 数据源未落地的四个探针：恒 skipped，接缝登记在 spec §7-3。
    skippedProbe("dispatch-pending-overage", "数据源未落地（dispatch_requests 桥）"),
    skippedProbe("daemon-heartbeat", "数据源未落地（daemon 心跳）"),
    skippedProbe("permission-pending-overage", "数据源未落地（权限 pending）"),
    skippedProbe("restart-storm", "数据源未落地（连续重启计数）"),
  ];
}

function skippedProbe(probe: string, detail: string): WatchdogProbeResult {
  return { probe, status: "skipped", detail };
}

function probeRegistryStall(ctx: ProbeReadContext): WatchdogProbeResult {
  const running = ctx.rows.filter((row) => row.state === "running");
  // 只判声明了心跳的行（spec §1.1/§2）：事件驱动 owner 未接心跳前，其行没有
  // 「应有周期回写」这一数据源，缺席 ⇒ skipped，不拿 updatedAt 冷热当 stall 造数。
  // 分工写死（spec §9 实施偏差 2026-11-02）：声明心跳的只有 runtime-background-task 行
  // （core background-tasks.ts 周期 touch，周期严格 < stalenessCapMs）；workflow 行**禁止**
  // 声明心跳——它的 updatedAt 同时是 isWorkflowStallCandidate 的 20min cancel-stalled
  // 独立时钟，心跳刷新会把 liveness 双计成 progress，stalledSince 接缝落地前永久失效。
  // cheng-job 有独立的 run-stalled 探针 + cancel-stalled repair；同一行不再由 registry-stall
  // 重复判 notify-user，避免一个 stall 生成两个 repair（notify 面已接，但同行走 cancel）。
  const judged = running.filter((row) => row.heartbeat === true && row.kind !== "cheng-job");
  if (judged.length === 0) {
    return running.length > 0
      ? skippedProbe("registry-stall", "running 行均未声明 owner 心跳（数据源缺席）")
      : { probe: "registry-stall", status: "ok" };
  }
  const stale = judged.filter((row) => ctx.now - row.updatedAt > ctx.config.stalenessCapMs);
  if (stale.length === 0) return { probe: "registry-stall", status: "ok" };
  // 取最陈旧行作为代表目标；其余同轮由冷却窗抑制逐个补齐。
  const worst = stale.reduce((a, b) => (a.updatedAt <= b.updatedAt ? a : b));
  return {
    probe: "registry-stall",
    status: "hit",
    targetId: worst.id,
    detail: `声明心跳的 running 行 ${stale.length} 条超 staleness 上限（最老 ${ctx.now - worst.updatedAt}ms）`,
    repair: "notify-user",
  };
}

/**
 * stall 资格（spec §2）：探针命中与 LLM 裁决的 cancel-stalled 目标复核共用同一判据。
 * `workflow` 与 `cheng-job` 都带独立 `stallClockRef`；仅凭它不足以区分健康行与 stall 行，
 * 还要求 running +（引擎 run-stalled / cheng host stall 投影在场，或独立钟按进度指针命中）。
 */
export function isWorkflowStallCandidate(
  row: BackgroundRunRow,
  now: number,
  config: SuperAgentWatchdogConfig,
): boolean {
  return (
    STALL_CANDIDATE_KINDS.has(row.kind) &&
    row.state === "running" &&
    row.stallClockRef !== undefined &&
    // 独立钟按 registry 进度指针命中（spec §2）。
    (row.stalledSince !== undefined || now - row.updatedAt >= config.workflowStallMs)
  );
}

function probeWorkflowRunStalled(ctx: ProbeReadContext): WatchdogProbeResult {
  const stalled = ctx.rows.filter((row) => isWorkflowStallCandidate(row, ctx.now, ctx.config));
  if (stalled.length === 0) return { probe: "workflow-run-stalled", status: "ok" };
  const worst = stalled.reduce((a, b) => (a.updatedAt <= b.updatedAt ? a : b));
  return {
    probe: "workflow-run-stalled",
    status: "hit",
    targetId: worst.id,
    detail:
      worst.stalledSince !== undefined
        ? `run-stalled 已投影 stalledSince=${worst.stalledSince}`
        : `stall 钟满 ${ctx.config.workflowStallMs}ms 且无进度回写`,
    repair: "cancel-stalled",
  };
}

function probeGoalBudgetLimitedOpenQuestions(ctx: ProbeReadContext): WatchdogProbeResult {
  const goal = ctx.goalState?.read();
  if (!goal) {
    return skippedProbe("goal-budget-limited-open-questions", "goalState 端口未挂载");
  }
  if (goal.status === "budget_limited" && goal.openQuestionCount > 0) {
    return {
      probe: "goal-budget-limited-open-questions",
      status: "hit",
      targetId: goal.goalId,
      detail: `budget_limited 且未决问题 ${goal.openQuestionCount} 个`,
      repair: "notify-user",
    };
  }
  return { probe: "goal-budget-limited-open-questions", status: "ok" };
}

function probeTriggerBacklogAge(ctx: ProbeReadContext): WatchdogProbeResult {
  const backlog = ctx.triggerBacklog?.read();
  if (!backlog) return skippedProbe("trigger-backlog-age", "triggerBacklog 端口未挂载");
  if (backlog.oldestAgeMs > ctx.config.triggerBacklogAgeMs) {
    return {
      probe: "trigger-backlog-age",
      status: "hit",
      targetId: `backlog:${backlog.pendingCount}`,
      detail: `最老 candidate ${backlog.oldestAgeMs}ms > ${ctx.config.triggerBacklogAgeMs}ms`,
      repair: "notify-user",
    };
  }
  return { probe: "trigger-backlog-age", status: "ok" };
}
