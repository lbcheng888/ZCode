/**
 * super-agent-watchdog 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 *
 * 实施规格：docs/architecture/super-agent-watchdog-spec.md（M8 registry 投影 + M10 看门狗）。
 */
export type SuperAgentWatchdogId = string & { readonly __brand: "SuperAgentWatchdogId" };

/** registry 行的类别；异质状态机不合并，kind 只做观察面分桶。 */
export type BackgroundRunKind = "workflow" | "automation" | "offpeak" | "background_task" | "goal";

/** 行级 owner：register 时定死，终身不变；仅 owner 写本行。 */
export type BackgroundRunOwner =
  | "dynamic-workflow"
  | "runtime-background-task"
  | "automation"
  | "offpeak"
  | "goal";

/** 终态枚举；与各子系统既有状态机的映射见 spec §1.1。 */
export type BackgroundRunTerminalState =
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "lost"
  | "dropped";

/** registry 行（行形状 = 届时 daemon 聚合表形状，见 spec §7-1）。 */
export interface BackgroundRunRow {
  /** 稳定 id（runId / taskId / offPeakTaskId）；跨系统 cancel 键。 */
  id: string;
  kind: BackgroundRunKind;
  /** 注册时定死；异 owner 写入一律抛 BackgroundRunOwnershipError。 */
  owner: BackgroundRunOwner;
  ownerSession?: string;
  /** pause-automation 的定位键（automation / offpeak 行携带）。 */
  workspaceKey?: string;
  state: "running" | BackgroundRunTerminalState;
  /** 窄结果引用；owner 终态回写时补。 */
  narrowResultRef?: string;
  /** stall 时钟指针；在场 ⇒ 具备 cancel-stalled 资格（执行前程序复核）。 */
  stallClockRef?: string;
  /** owner 投影的 run-stalled 时刻（workflow 引擎 20min 钟，接缝见 spec §7-3）。 */
  stalledSince?: number;
  /**
   * owner 在 register 时声明的心跳承诺：运行期按 ≤stalenessCapMs 周期回写本行。
   * registry-stall 只判声明了心跳的行（spec §2）——事件驱动 owner 未接心跳前不声明，
   * 数据源缺席不造数，避免对健康长命行误报 stall。
   */
  heartbeat?: boolean;
  registeredAt: number;
  /** 最近一次 owner 写；registry-stall 探针的 staleness 判据。 */
  updatedAt: number;
  terminalAt?: number;
}

/** register 入参（时间戳由 registry 盖，调用方不传）。 */
export interface BackgroundRunRegistration {
  id: string;
  kind: BackgroundRunKind;
  owner: BackgroundRunOwner;
  ownerSession?: string;
  workspaceKey?: string;
  stallClockRef?: string;
  narrowResultRef?: string;
  stalledSince?: number;
  /** owner 心跳声明（spec §1.1）；仅 register 时定，touch 不改。 */
  heartbeat?: boolean;
}

/** touch 局部补丁；只允许 owner 面字段，不改 id/kind/owner/state。 */
export interface BackgroundRunTouchPatch {
  ownerSession?: string;
  workspaceKey?: string;
  narrowResultRef?: string;
  stallClockRef?: string;
  stalledSince?: number;
}

/**
 * 行级所有权被违反时抛出（行存在时的异 owner 写 = 第二写者）。响亮拒绝，不排队、不合并。
 * 行缺席的 settle/touch 是 no-op 不抛（投影不阻断业务路径）；register 撞异 owner 行才抛。
 * 前置：调用方自称 owner；后置：registry 状态不变。
 */
export class BackgroundRunOwnershipError extends Error {
  readonly code = "background_run_ownership_violation";
  constructor(
    readonly runId: string,
    readonly claimedOwner: BackgroundRunOwner,
    readonly actualOwner: BackgroundRunOwner | undefined,
    message?: string,
  ) {
    super(
      message ??
        `background_run_registry 所有权违例：run=${runId} 写者=${claimedOwner} 行 owner=${actualOwner ?? "<missing>"}`,
    );
    this.name = "BackgroundRunOwnershipError";
  }
}

/** list 过滤；缺省返回全部（只读聚合，调用方拿到的是快照数组）。 */
export interface BackgroundRunListFilter {
  owner?: BackgroundRunOwner;
  kind?: BackgroundRunKind;
  state?: "running" | BackgroundRunTerminalState;
}

/** M10 typed repair 枚举；LLM 提案与程序动作共用，未知值一律拒绝执行。 */
export const REPAIR_ACTIONS = ["cancel-stalled", "pause-automation", "notify-user"] as const;
export type RepairAction = (typeof REPAIR_ACTIONS)[number];

/** 组合根注入端口拆分至 ports.ts（契约行数/方法数上限）；此处转出保持单一契约入口。 */
export type {
  CommandResult,
  WatchdogRepairCommandSurface,
  GoalStateSnapshot,
  GoalStateSource,
  TriggerBacklogSnapshot,
  TriggerBacklogSource,
  GoalHintSource,
  NoProgressAdjudicator,
} from "./ports.js";

/** 模块配置；不进 contracts config（spec §7-4）。 */
export interface SuperAgentWatchdogConfig {
  /** 程序循环间隔（ms）。 */
  tickIntervalMs: number;
  /** staleness 上限 = 对账周期（ms）；registry-stall 判据。 */
  stalenessCapMs: number;
  /** workflow stall 钟（ms，默认 20min）。 */
  workflowStallMs: number;
  /** trigger 积压龄阈值（ms）。 */
  triggerBacklogAgeMs: number;
  /** 同 (probe, target) 重复修复抑制窗（ms）。 */
  repairCooldownMs: number;
  /** 熔断 N：连续 N 次已执行 repair 失败 ⇒ 升级。 */
  escalationFailureThreshold: number;
  /** 熔断冷却（ms）。 */
  escalationCooldownMs: number;
  /** progress-vs-objective 连续零进展轮数 K。 */
  zeroProgressRounds: number;
  /** 每轮参与关键词比较的近况行数。 */
  progressRecentRows: number;
  /** LLM 无进展裁决开关；缺省 false（OFF 时裁决器不被调用）。 */
  llmNoProgressAdjudication: boolean;
  /** 终态行 FIFO 保留上限。 */
  terminalRowRetention: number;
}

export interface WatchdogProbeResult {
  probe: string;
  status: "ok" | "hit" | "skipped";
  /** skipped 原因 / hit 目标摘要。 */
  detail?: string;
  targetId?: string;
  /** hit 时建议的 repair（程序按目录硬映射，不听 LLM）。 */
  repair?: RepairAction;
}

export interface WatchdogRepairRecord {
  probe: string;
  targetId: string;
  action: RepairAction;
  ok: boolean;
  error?: string;
  at: number;
}

export interface WatchdogEscalationRecord {
  at: number;
  consecutiveFailures: number;
  goalPaused: boolean;
  notified: boolean;
}

export interface TickReport {
  at: number;
  probes: WatchdogProbeResult[];
  repairs: WatchdogRepairRecord[];
  escalations: WatchdogEscalationRecord[];
  /** progress-vs-objective 快照（dormant 也可观测）。 */
  zeroProgressStreak: number;
  adjudicationFired: boolean;
  /** 本轮跳过 progress 比较的原因（goalHint 半边缺席，spec §5）；在场 ⇒ 未比较未自增。 */
  progressSkippedReason?: string;
}

export interface WatchdogStatus {
  running: boolean;
  consecutiveRepairFailures: number;
  lastEscalationAt?: number;
  zeroProgressStreak: number;
  /** 当前 streak 是否已裁决过（每 streak 峰一次）。 */
  adjudicationFiredForStreak: boolean;
  invalidProposalCount: number;
}

/**
 * super-agent-watchdog 对外契约（一个意图一个方法，≤8）。
 * 生命周期与探针轮次不等待持久化（里程碑 A 进程内投影）；registry 写不发事件，读为快照。
 */
export interface SuperAgentWatchdogContract {
  /**
   * 注册/重臂一行。前置：owner 由调用方声明且与既有行一致；后置：行进入 running（终态行上
   * register = 新生命周期，复位结算面）。幂等（同 owner 重复 register 为 upsert）。
   * 异 owner 撞既有行 ⇒ 抛 BackgroundRunOwnershipError。不发事件，不等待持久化。
   */
  registerRun(row: BackgroundRunRegistration): void;

  /**
   * owner 原子回写终态。前置：行存在时 owner 必须匹配（异 owner ⇒ 抛
   * BackgroundRunOwnershipError）；行缺席 = no-op。后置：state=终态（重复同态幂等）。
   * 不发事件，不等待持久化。
   */
  settleRun(
    id: string,
    owner: BackgroundRunOwner,
    state: BackgroundRunTerminalState,
    opts?: { narrowResultRef?: string },
  ): void;

  /**
   * owner 局部更新（stalledSince / narrowResultRef 等）。前置同 settleRun（异 owner 抛、
   * 行缺席 no-op）；后置：updatedAt 前移。不发事件，不等待持久化。
   */
  touchRun(id: string, owner: BackgroundRunOwner, patch: BackgroundRunTouchPatch): void;

  /**
   * 只读聚合。前置：无；后置：返回拷贝数组（对 registry 再写不影响已返回快照）。
   * 永不抛所有权错误。不等待持久化。
   */
  listRuns(filter?: BackgroundRunListFilter): readonly BackgroundRunRow[];

  /**
   * 启动程序循环。前置：未在跑；后置：tickIntervalMs 定时器在跑。重复 start 幂等（no-op）。
   * 不发事件，不等待持久化。
   */
  start(): void;

  /**
   * 停止循环。前置：任意状态（未启动时 no-op）；后置：定时器已清、在途 tick 已收尾。
   * 返回的 Promise 等待在途 tick 结束。不发事件。
   */
  stop(): Promise<void>;

  /**
   * 单轮探针 + repair + 熔断 + progress 检查。前置：无（start 与否均可手动调用）；
   * 后置：返回本轮 TickReport。并发 tick 由调用方保证串行（循环内自持单飞）。
   * 不等待持久化。
   */
  tick(now?: number): Promise<TickReport>;

  /**
   * 状态快照（观测面）。前置：无；后置：纯读拷贝。不等待持久化。
   */
  status(): WatchdogStatus;
}
