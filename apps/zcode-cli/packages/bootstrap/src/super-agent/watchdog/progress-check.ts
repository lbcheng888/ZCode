import type {
  BackgroundRunRow,
  GoalHintSource,
  GoalStateSource,
  NoProgressAdjudicator,
  RepairAction,
  SuperAgentWatchdogConfig,
} from "./contract.js";
import { isWorkflowStallCandidate } from "./probes.js";
import { validateRepairAction } from "./repair.js";

/** progress-vs-objective 每轮输入（只读；spec §5）。 */
export interface ProgressCheckContext {
  now: number;
  rows: readonly BackgroundRunRow[];
  config: SuperAgentWatchdogConfig;
  goalState?: GoalStateSource;
  goalHint?: GoalHintSource;
  adjudicator?: NoProgressAdjudicator;
}

export interface ProgressCheckState {
  zeroProgressStreak: number;
  /** 当前 streak 峰是否已裁决过（每峰一次）。 */
  adjudicationFired: boolean;
  invalidProposalCount: number;
}

export interface ProgressCheckOutcome {
  streak: number;
  adjudicationFired: boolean;
  /** 本轮跳过比较的原因（goalHint 半边缺席；在场 ⇒ streak 未动、未进裁决）。 */
  skippedReason?: string;
  /** 裁决产出且两级校验（枚举 + 目标）通过时的提案（由调用方执行）。 */
  approvedProposal?: { action: RepairAction; raw: string; targetId?: string };
}

/**
 * M10 偏离检测最低配（spec §5）：goal 在途时每轮只读比较 goal 续跑提示与 registry 近况。
 * 连续 K 轮零进展/关键词零命中 ⇒（按档）开启一次 LLM 无进展裁决；flag OFF 时裁决器
 * 一次都不会被调用（dormant，streak 仍可观测）。模块永不修改 prompt/策略。
 */
export async function runProgressCheck(
  ctx: ProgressCheckContext,
  state: ProgressCheckState,
): Promise<ProgressCheckOutcome> {
  const goal = ctx.goalState?.read();
  if (!goal || goal.status !== "active") {
    // goal 不在途：进度条归零，下个在途周期从头计。
    state.zeroProgressStreak = 0;
    state.adjudicationFired = false;
    return { streak: 0, adjudicationFired: false };
  }

  const hint = ctx.goalHint?.read();
  if (hint === undefined) {
    // objective 半边缺席 ⇒ 跳过比较（spec §0/§5）：streak 保持，不自增、不进裁决。
    return {
      streak: state.zeroProgressStreak,
      adjudicationFired: state.adjudicationFired,
      skippedReason: "goalHint 端口缺席或未返回提示",
    };
  }
  const keywords = extractKeywords(hint);
  if (keywords.length === 0) {
    // 空提示没有可比对的 objective 文本：零命中是分词空集的逻辑假象，不是进展事实。
    return {
      streak: state.zeroProgressStreak,
      adjudicationFired: state.adjudicationFired,
      skippedReason: "goalHint 无关键词（objective 半边不可比）",
    };
  }

  const recent = recentActivityText(ctx.rows, ctx.now, ctx.config);
  const hit = keywords.some((keyword) => recent.toLowerCase().includes(keyword));

  if (hit) {
    state.zeroProgressStreak = 0;
    state.adjudicationFired = false;
    return { streak: 0, adjudicationFired: false };
  }

  state.zeroProgressStreak += 1;
  const streak = state.zeroProgressStreak;
  if (streak < ctx.config.zeroProgressRounds || state.adjudicationFired) {
    return { streak, adjudicationFired: false };
  }
  // 连续 K 轮零进展：缺省 OFF——裁决器不被调用，只记录 streak（dormant）。
  if (!ctx.config.llmNoProgressAdjudication || !ctx.adjudicator) {
    return { streak, adjudicationFired: false };
  }

  state.adjudicationFired = true;
  const { proposal, targetId } = await ctx.adjudicator.adjudicate({
    objectiveHint: hint,
    recentActivity: recent,
    zeroProgressStreak: streak,
  });
  const action = validateRepairAction(proposal);
  if (!action) {
    // 枚举不过：拒绝执行、不计入熔断失败（没执行过的东西没有失败）。
    state.invalidProposalCount += 1;
    return { streak, adjudicationFired: true };
  }
  // 目标通道校验（spec §5）：需要目标的动作必须解析到真实可执行的 registry 行。
  // 目标缺失/不可解析/不合格同样按 invalidProposal 处理——不执行、不计入熔断。
  const resolvedTarget = resolveProgressTarget(action, targetId, ctx);
  if (!resolvedTarget.ok) {
    state.invalidProposalCount += 1;
    return { streak, adjudicationFired: true };
  }
  return {
    streak,
    adjudicationFired: true,
    approvedProposal: {
      action,
      raw: proposal,
      ...(resolvedTarget.targetId !== undefined ? { targetId: resolvedTarget.targetId } : {}),
    },
  };
}

/**
 * 裁决提案的目标解析（程序、确定性，spec §5）。
 * notify-user 无目标（targetId 保持缺席，调用方用 progress:<streak> 作记录键）；
 * cancel-stalled 复用探针 stall 资格；pause-automation 要求行携带 workspaceKey。
 */
function resolveProgressTarget(
  action: RepairAction,
  targetId: string | undefined,
  ctx: ProgressCheckContext,
): { ok: true; targetId?: string } | { ok: false } {
  if (action === "notify-user") return { ok: true };
  if (!targetId) return { ok: false };
  const row = ctx.rows.find((candidate) => candidate.id === targetId);
  if (!row) return { ok: false };
  if (action === "cancel-stalled") {
    return isWorkflowStallCandidate(row, ctx.now, ctx.config) ? { ok: true, targetId } : { ok: false };
  }
  // pause-automation：workspaceKey 是命令面的定位键（spec §1.1）。
  return row.workspaceKey !== undefined ? { ok: true, targetId } : { ok: false };
}

/**
 * 关键词抽取（程序、确定性）：小写、按非字母数字/CJK 边界分词、长度 ≥2。
 * 这是设计 M10「关键词零命中」的最低配判据，不是启发式兜底——零命中只触发（按档）
 * 裁决或记录，不产生任何自动状态写。
 */
export function extractKeywords(hint: string): string[] {
  const lowered = hint.toLowerCase();
  const tokens = lowered.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
  return [...new Set(tokens)];
}

function recentActivityText(
  rows: readonly BackgroundRunRow[],
  now: number,
  config: SuperAgentWatchdogConfig,
): string {
  const recent = [...rows].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, config.progressRecentRows);
  return recent
    .map((row) => {
      // 事实字段直出：workspaceKey 供 pause-automation 目标选择，stall-qualified 是
      // 与探针同判据的程序标记（spec §5）——裁决器据此挑真实可执行的 targetId。
      const flags = [
        row.workspaceKey !== undefined ? `ws:${row.workspaceKey}` : "",
        isWorkflowStallCandidate(row, now, config) ? "stall-qualified" : "",
      ].filter(Boolean);
      return [`${row.kind} ${row.id} ${row.state}`, row.narrowResultRef ?? "", ...flags]
        .filter(Boolean)
        .join(" ");
    })
    .join(" ");
}
