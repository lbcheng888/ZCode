import {
  type GoalHintSource,
  type GoalStateSource,
  type NoProgressAdjudicator,
  type SuperAgentWatchdogConfig,
  type SuperAgentWatchdogContract,
  type TickReport,
  type TriggerBacklogSource,
  type WatchdogEscalationRecord,
  type WatchdogProbeResult,
  type WatchdogRepairCommandSurface,
  type WatchdogRepairRecord,
  type WatchdogStatus,
} from "./contract.js";
import { runProbes } from "./probes.js";
import { runProgressCheck, type ProgressCheckState } from "./progress-check.js";
import { executeRepair } from "./repair.js";
import { BackgroundRunRegistry } from "./registry.js";

/** 缺省配置（spec §4/§5 熔断与零进展参数；开关不进 contracts config）。 */
export const DEFAULT_WATCHDOG_CONFIG: SuperAgentWatchdogConfig = {
  tickIntervalMs: 30_000,
  stalenessCapMs: 60_000,
  workflowStallMs: 20 * 60_000,
  triggerBacklogAgeMs: 10 * 60_000,
  repairCooldownMs: 5 * 60_000,
  escalationFailureThreshold: 3,
  escalationCooldownMs: 10 * 60_000,
  zeroProgressRounds: 3,
  progressRecentRows: 20,
  // LLM 无进展裁决缺省 OFF（M10 按档开启；组合根按 workspace 档位打开）。
  llmNoProgressAdjudication: false,
  terminalRowRetention: 500,
};

export interface WatchdogDeps {
  config?: Partial<SuperAgentWatchdogConfig>;
  commands: WatchdogRepairCommandSurface;
  registry: BackgroundRunRegistry;
  goalState?: GoalStateSource;
  triggerBacklog?: TriggerBacklogSource;
  goalHint?: GoalHintSource;
  adjudicator?: NoProgressAdjudicator;
  /** 注入时钟（测试用）。 */
  now?: () => number;
  /** 观测钩子（组合根挂日志/遥测；不承载状态）。 */
  onTick?: (report: TickReport) => void;
}

/**
 * 看门狗（M10）：程序循环 = 探针 → typed repair → 熔断升级 → progress-vs-objective。
 *
 * 宿主无关（spec §6）：不 import 任何宿主 API，生命周期只经 start/stop 端口；迁 daemon
 * 只动组合根。所有状态写只经 WatchdogRepairCommandSurface（既有命令面），模块内不存在
 * 业务状态直写路径。
 */
export class SuperAgentWatchdog implements SuperAgentWatchdogContract {
  readonly registry: BackgroundRunRegistry;
  private readonly config: SuperAgentWatchdogConfig;
  private readonly deps: WatchdogDeps;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<TickReport> | undefined;
  private consecutiveRepairFailures = 0;
  private lastEscalationAt: number | undefined;
  private readonly repairLastFiredAt = new Map<string, number>();
  private readonly progressState: ProgressCheckState = {
    zeroProgressStreak: 0,
    adjudicationFired: false,
    invalidProposalCount: 0,
  };
  private invalidProposalCount = 0;

  constructor(deps: WatchdogDeps) {
    this.deps = deps;
    this.config = { ...DEFAULT_WATCHDOG_CONFIG, ...deps.config };
    this.registry = deps.registry;
  }

  registerRun(row: Parameters<SuperAgentWatchdogContract["registerRun"]>[0]): void {
    this.registry.register(row, this.now());
  }

  settleRun(
    id: string,
    owner: Parameters<SuperAgentWatchdogContract["settleRun"]>[1],
    state: Parameters<SuperAgentWatchdogContract["settleRun"]>[2],
    opts?: { narrowResultRef?: string },
  ): void {
    this.registry.settle(id, owner, state, this.now(), opts);
  }

  touchRun(
    id: string,
    owner: Parameters<SuperAgentWatchdogContract["touchRun"]>[1],
    patch: Parameters<SuperAgentWatchdogContract["touchRun"]>[2],
  ): void {
    this.registry.touch(id, owner, patch, this.now());
  }

  listRuns(filter?: Parameters<SuperAgentWatchdogContract["listRuns"]>[0]) {
    return this.registry.list(filter);
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tickSafely();
    }, this.config.tickIntervalMs);
    // 循环不阻塞宿主退出；宿主关窗时显式 stop（组合根职责）。
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  async tick(now?: number): Promise<TickReport> {
    // 单飞：循环触发与手动 tick 串行，避免并发轮次重复发 repair。
    while (this.inFlight) await this.inFlight;
    const pending = this.tickOnce(now ?? this.now());
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      this.inFlight = undefined;
    }
  }

  status(): WatchdogStatus {
    return {
      running: this.timer !== undefined,
      consecutiveRepairFailures: this.consecutiveRepairFailures,
      lastEscalationAt: this.lastEscalationAt,
      zeroProgressStreak: this.progressState.zeroProgressStreak,
      adjudicationFiredForStreak: this.progressState.adjudicationFired,
      invalidProposalCount: this.invalidProposalCount,
    };
  }

  private async tickSafely(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      // 探针/端口异常原样上浮到观测钩子；循环不因单轮异常死亡。
      this.deps.onTick?.({
        at: this.now(),
        probes: [{ probe: "tick", status: "skipped", detail: String(error) }],
        repairs: [],
        escalations: [],
        zeroProgressStreak: this.progressState.zeroProgressStreak,
        adjudicationFired: false,
      });
    }
  }

  private async tickOnce(at: number): Promise<TickReport> {
    const rows = this.registry.list();
    const probes = runProbes({
      now: at,
      rows,
      goalState: this.deps.goalState,
      triggerBacklog: this.deps.triggerBacklog,
      config: this.config,
    });

    const repairs: WatchdogRepairRecord[] = [];
    for (const probe of probes) {
      const record = await this.dispatchProbeRepair(probe, at);
      if (record) repairs.push(record);
    }

    const progress = await runProgressCheck(
      {
        now: at,
        rows,
        config: this.config,
        goalState: this.deps.goalState,
        goalHint: this.deps.goalHint,
        adjudicator: this.deps.adjudicator,
      },
      this.progressState,
    );
    this.invalidProposalCount = this.progressState.invalidProposalCount;
    if (progress.approvedProposal) {
      const proposal = progress.approvedProposal;
      // 目标通道（spec §5）：需要目标的提案按 targetId 取真实 registry 行执行；
      // notify-user 无目标，progress:<streak> 只是记录键，不参与行解析。
      const targetId = proposal.targetId ?? `progress:${progress.streak}`;
      const record = await this.dispatchAction(proposal.action, {
        id: targetId,
        probe: "progress-vs-objective",
        at,
        message: `goal 连续 ${progress.streak} 轮零进展，裁决提案：${proposal.raw}${
          proposal.targetId !== undefined ? ` → ${proposal.targetId}` : ""
        }`,
      });
      if (record) repairs.push(record);
    }

    const escalations: WatchdogEscalationRecord[] = [];
    const escalation = await this.maybeEscalate(at);
    if (escalation) escalations.push(escalation);

    const report: TickReport = {
      at,
      probes,
      repairs,
      escalations,
      zeroProgressStreak: progress.streak,
      adjudicationFired: progress.adjudicationFired,
      ...(progress.skippedReason !== undefined
        ? { progressSkippedReason: progress.skippedReason }
        : {}),
    };
    this.deps.onTick?.(report);
    return report;
  }

  private async dispatchProbeRepair(
    probe: WatchdogProbeResult,
    at: number,
  ): Promise<WatchdogRepairRecord | undefined> {
    if (probe.status !== "hit" || !probe.repair || !probe.targetId) return undefined;
    const cooldownKey = `${probe.probe}:${probe.targetId}`;
    const lastFired = this.repairLastFiredAt.get(cooldownKey);
    if (lastFired !== undefined && at - lastFired < this.config.repairCooldownMs) {
      return undefined; // 冷却窗内不重发（spec §3），避免逐 tick 轰炸
    }
    const record = await this.dispatchAction(probe.repair, {
      id: probe.targetId,
      probe: probe.probe,
      at,
      message: `watchdog ${probe.probe}：${probe.detail ?? probe.targetId}`,
    });
    if (record) this.repairLastFiredAt.set(cooldownKey, at);
    return record;
  }

  private async dispatchAction(
    action: Parameters<typeof executeRepair>[1],
    target: { id: string; probe: string; at: number; message?: string },
  ): Promise<WatchdogRepairRecord | undefined> {
    const row = this.registry.get(target.id);
    const workspaceKey = row?.workspaceKey;
    const result = await executeRepair(this.deps.commands, action, {
      id: target.id,
      row,
      workspaceKey,
      message: target.message,
    });
    // 熔断只统计状态变更类 repair（spec §0/§4）：notify-user 是观察信道，其成功不得
    // 清零 cancel/pause 的失败累积（否则同轮 notify 成功会压住真正的熔断信号），
    // 其失败也不累加（告警信道故障不构成暂停 goal 的理由）。
    if (action !== "notify-user") {
      if (result.ok) this.consecutiveRepairFailures = 0;
      else this.consecutiveRepairFailures += 1;
    }
    return {
      probe: target.probe,
      targetId: target.id,
      action,
      ok: result.ok,
      error: result.error,
      at: target.at,
    };
  }

  private async maybeEscalate(at: number): Promise<WatchdogEscalationRecord | undefined> {
    if (this.consecutiveRepairFailures < this.config.escalationFailureThreshold) return undefined;
    if (
      this.lastEscalationAt !== undefined &&
      at - this.lastEscalationAt < this.config.escalationCooldownMs
    ) {
      return undefined; // 熔断冷却窗（spec §4）
    }
    // 升级 = pause goal（既有 goal 命令面）+ notify 升级信道。
    const failureCount = this.consecutiveRepairFailures;
    const goalId = this.deps.goalState?.read()?.goalId;
    let goalPaused = false;
    let notified = false;
    if (goalId) {
      const pauseResult = await this.deps.commands.pauseGoal(goalId);
      goalPaused = pauseResult.ok;
      // 升级失败（pauseGoal ok=false）计入连续失败，留待下轮重试升级。
      if (pauseResult.ok) this.consecutiveRepairFailures = 0;
      else this.consecutiveRepairFailures += 1;
    }
    const notifyResult = await this.deps.commands.notifyUser(
      goalId
        ? `看门狗升级：连续 ${failureCount} 次 repair 失败，已暂停 goal ${goalId}`
        : `看门狗升级：连续 ${failureCount} 次 repair 失败（goal 状态端口缺席，无法定位 goal）`,
    );
    notified = notifyResult.ok;
    this.lastEscalationAt = at;
    return {
      at,
      consecutiveFailures: failureCount,
      goalPaused,
      notified,
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** 工厂：组合根用它装配看门狗（spec §7-2 接缝的一半；另一半是投影/端口绑定）。 */
export function createSuperAgentWatchdog(deps: WatchdogDeps): SuperAgentWatchdog {
  return new SuperAgentWatchdog(deps);
}
