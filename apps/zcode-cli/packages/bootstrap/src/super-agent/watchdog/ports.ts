/**
 * super-agent-watchdog 组合根注入端口（与 trigger/ports.ts 同惯例）：
 * 契约面的可插拔依赖集中在此，contract.ts 只留数据形状与主契约。
 */

/** 组合根绑定的既有命令面；watchdog 不直写业务状态，只经这里执行。 */
export type CommandResult = { ok: boolean; error?: string };

export interface WatchdogRepairCommandSurface {
  /** 仅 cancel 带 stall 时钟的 run；程序执行前复核 stallClockRef。 */
  cancelStalledRun(runId: string): Promise<CommandResult>;
  pauseWorkspaceAutomation(workspaceKey: string): Promise<CommandResult>;
  notifyUser(message: string): Promise<CommandResult>;
  /** 升级信道：连续 N 次 repair 失败后经既有 goal 命令面 pause。 */
  pauseGoal(goalId: string): Promise<CommandResult>;
}

/** goal 状态端口（缺席 ⇒ goal 探针 skipped；progress 检查休眠）。 */
export interface GoalStateSnapshot {
  goalId: string;
  status: "active" | "budget_limited" | "paused" | "blocked" | "completed";
  /** 未决问题数（budget_limited 探针判据）。 */
  openQuestionCount: number;
}

export interface GoalStateSource {
  read(): GoalStateSnapshot | undefined;
}

/** trigger 积压端口（trigger 子系统未落地前缺席 ⇒ 探针 skipped）。 */
export interface TriggerBacklogSnapshot {
  /** 最老 env candidate 年龄（ms）。 */
  oldestAgeMs: number;
  pendingCount: number;
}

export interface TriggerBacklogSource {
  read(): TriggerBacklogSnapshot | undefined;
}

/** goal 续跑提示端口（只读；progress-vs-objective 的 objective 半边）。 */
export interface GoalHintSource {
  read(): string | undefined;
}

/**
 * LLM 无进展裁决器（短命只读会话；缺省不挂载，flag OFF 时永不调用）。
 * 输出 = repair 枚举提案 + 可选目标行 id（spec §5 目标通道）：需要目标的动作
 * （cancel-stalled / pause-automation）必须给出近况里真实存在的 registry 行 id，
 * 程序按行复核资格后才执行；目标缺失/不可解析/不合格 ⇒ invalidProposal（不执行、不计熔断）。
 */
export interface NoProgressAdjudicator {
  adjudicate(input: {
    objectiveHint: string;
    recentActivity: string;
    zeroProgressStreak: number;
  }): Promise<{ proposal: string; targetId?: string }>;
}
