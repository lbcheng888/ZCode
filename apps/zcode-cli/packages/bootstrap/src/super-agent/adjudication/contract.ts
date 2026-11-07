/**
 * super-agent-adjudication 对外契约（spec super-agent-trigger-subsystem-spec §2.1 /
 * design M3 短命批量裁决回合）：unowned 环境候选的攒批裁决驱动器。
 *
 * trigger_events 的 pending 行即事实队列（无内存队列，崩溃/重启天然恢复）；
 * notifyCandidate 是唤醒信号，驱动器内部唤醒三选一（backlog≥N / 最老年龄≥T /
 * 定时评估点）；短命 model-only 会话产出 per-candidate verdict JSON（schema 校验，
 * fail-closed）；解释执行经 delivery 端口（spec §2.1 applyVerdicts 的精确接缝）落
 * decision_log / would-accept 卡片。与 goal 存在性完全解耦（A3）；前台永不排队
 * （低优先槽，M3）；独立每日微预算（与 goal 三维预算分账，M12③）。
 */

/** 唤醒阈值 N（M3 默认 8）：backlog ≥ N 立即攒批。 */
export const ADJUDICATION_BACKLOG_THRESHOLD = 8;

/** 唤醒阈值 T（M3 默认 60s）：最老 candidate 年龄 ≥ T 攒批（延迟上限，非均值）。 */
export const ADJUDICATION_OLDEST_AGE_MS = 60_000;

/** 定时评估点（M3 默认 5min）：无视 N/T，flush 全部 pending workspace（三选一兜底）。 */
export const ADJUDICATION_EVALUATION_TICK_MS = 5 * 60_000;

/** 短窗 KV 复用窗（M3 默认 5min）：同 workspace 窗内复用同一短命会话，窗末销毁。 */
export const ADJUDICATION_KV_WINDOW_MS = 5 * 60_000;

/** 单批 candidate 上限：prompt 资源预算；超出部分留下一批（下一次唤醒继续）。 */
export const ADJUDICATION_MAX_BATCH_SIZE = 32;

/** prompt 内单 candidate payload 摘录上限（列本体仍 64KB，§1.2）。 */
export const ADJUDICATION_PROMPT_PAYLOAD_MAX_CHARS = 2_000;

/**
 * 每 workspace 每日裁决 token 微预算（M3「独立微预算」；初值，待真实负载标定——
 * design 开放问题①）。耗尽 → 不调模型、候选保持 pending（下个 UTC 日重试）。
 */
export const ADJUDICATION_DAILY_TOKEN_BUDGET = 500_000;

/** M3 per-candidate verdict 的 disposition（连字符记法与 spec §2.1 一致）。 */
export type AdjudicationDisposition = "accept" | "reject" | "record-only";

/**
 * M6 五字段方案卡（2026-11-02 用户裁定）：现状证据 / 候选方案（≥2，各带代价）/
 * 最佳推荐 / 影响面 / 验证方案。accept 决议必须携带；一句话摘要不构成「最佳方案」。
 * 结构 = shared `schemeCardSchema` 的同一形状（模块间结构子集，不 import 兄弟模块）。
 */
export interface AdjudicationSchemeCard {
  currentEvidence: string;
  candidateOptions: readonly { option: string; cost: string }[];
  recommendation: string;
  impact: string;
  verification: string;
}

/** verdict schema 的单条决议（spec §2.1；triggerId 外键回 trigger_events 行）。 */
export interface AdjudicationVerdictDecision {
  triggerId: string;
  disposition: AdjudicationDisposition;
  reason?: string;
  evidence?: readonly string[];
  /** M6 方案卡（accept 必需；出口门校验缺字段不外发）。 */
  scheme?: AdjudicationSchemeCard;
  /**
   * 可选 ChengPlan 稳定引用（S2）：裁决引用只读 ChengPlan 工具产出的 plan id。
   * 非空字符串才合法；且必须命中本批工具回执（见 {@link AdjudicationChengPlanReceipt}），
   * 否则整批降级 record-only。
   */
  chengPlanId?: string;
}

/**
 * 本批真实 ChengPlan 工具回执的稳定摘要。planId 从工具入参 jobId 派生
 * （`cheng-plan://<jobId>`），不读模型自由文本；驱动器只用它交叉校验 verdict 引用。
 */
export interface AdjudicationChengPlanReceipt {
  planId: string;
  jobId: string;
  task: string;
}

/** mandate 档位（结构 = super-agent-mandate 的 MandateVerdict 子集，不 import 兄弟模块）。 */
export type AdjudicationMandateTier = "record_only" | "speculative" | "auto";

export interface AdjudicationMandateVerdict {
  tier: AdjudicationMandateTier;
  source: "implicit" | "explicit";
  mandateId?: string;
}

/** 每日微预算计量入参（M3：usage 事件经组合根喂入本模块的计量点）。 */
export interface AdjudicationUsageInput {
  workspaceIdentity: string;
  tokens: number;
  /**
   * 落账时间（epoch ms）；缺省 Date.now。按 UTC 日换桶，跨日自动清零；
   * 早于当前 UTC 日的迟到 `at` 直接丢弃（日桶只朝前滚，不回退当日已耗）。
   */
  at?: number;
}

/** 驱动器累计计数（T2 schema-fail 计数等观测面）。 */
export interface AdjudicationStats {
  /** 已交付批次数（applied；含 schema 降级交付）。 */
  batchesRun: number;
  /** verdict 解析/校验失败整批降级次数（T2 计数器）。 */
  schemaFailures: number;
  /** chengPlanId 未命中本批真实 ChengPlan 工具回执的降级次数。 */
  planReferenceFailures: number;
  /** 微预算耗尽跳过批次数。 */
  budgetTrips: number;
  /** model-only 会话故障次数（留 pending 重试）。 */
  sessionFaults: number;
}

/**
 * 一批裁决的执行结果。
 * - applied：已交付 delivery 端口（verdictDegraded 在场 = 整批 record-only 降级交付）；
 * - empty：无 pending 候选，未调模型未交付；
 * - budget_exhausted：微预算耗尽，未调模型未交付，候选留 pending（下个 UTC 日重试）；
 * - session_error：会话故障，未交付，候选留 pending（下个评估点/通知重试）。
 */
export interface BatchOutcome {
  batchId: string;
  workspaceIdentity: string;
  /** 本批 candidate 数（0 = 无 pending）。 */
  candidateCount: number;
  /** 是否调用了 model-only 会话（session_error 时已尝试但失败 → true；budget → false）。 */
  modelCalled: boolean;
  status: "applied" | "empty" | "budget_exhausted" | "session_error";
  /** status=applied 且 verdict 校验失败 → 整批 record-only 降级（fail-closed，T2）。 */
  verdictDegraded?: "json" | "schema" | "coverage" | "cheng_plan";
  decisions: readonly AdjudicationVerdictDecision[];
  /** 本批 mandate 裁定（spec §1.4「被分派器调用」锚点；P2 恒 implicit record_only，M4）。 */
  mandateTier?: AdjudicationMandateTier;
}

/**
 * trigger_events 只读句柄（node:sqlite DatabaseSync 的结构子集；不 import
 * super-agent-storage / super-agent-intake——本模块对该表零写入，写入点仍是 Intake，
 * 终态列经 delivery 端口由 trigger.applyVerdicts 更新）。
 */
export interface AdjudicationDatabaseHandle {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

/**
 * 短命 model-only 裁决会话端口（组合根接缝：复用 automation/off-peak 的
 * sendPrompt + toolDisallowlist model-only 路径 + create-app 短命会话；
 * dynamic-workflow driver 是工作流协议专用，不可复用——design M3 zcode 落点）。
 * toolAllowlist/toolDisallowlist 由宿主双闸强制：白名单兜未知新工具（fail-closed
 * 主闸），黑名单兜已知执行工具（sendPrompt turn 级纵深，T1 零副作用锚点）。
 */
export interface AdjudicationModelSessionPort {
  run(request: AdjudicationModelSessionRequest): Promise<AdjudicationModelSessionResult>;
  /** 窗末销毁短命会话（KV 窗口结束 / 驱动器 stop）。宿主必须容忍在途回合后的销毁调用。 */
  destroySession(sessionKey: string): void;
}

export interface AdjudicationModelSessionRequest {
  workspaceIdentity: string;
  /** 短窗 KV 复用键：同 workspace 窗口内所有批次复用同一短命会话（共享 prefill）。 */
  sessionKey: string;
  prompt: string;
  /**
   * 本批候选数（prompt 已包含同样数量的候选块）。宿主的 verdict 输出预算必须按此
   * 推导——固定上限会在满批（32 个 accept × M6 五字段卡）下截断 JSON，整批降级。
   */
  candidateCount: number;
  /**
   * 会话级只读工具白名单（M3 工具面：trigger/订阅/目标摘要/recall 只读）。
   * 空数组 = 零内置工具；未知未来工具默认排除（fail-closed 主闸）。
   */
  toolAllowlist: readonly string[];
  /** turn 级执行工具黑名单（automation/off-peak 同型纵深；T1 零副作用锚点）。 */
  toolDisallowlist: readonly string[];
  /** 轻量档 pin（M12③ adjudicator=轻量档；宿主经 ListModels 机制解析为具体 provider/model）。 */
  modelTier: "adjudicator";
  /** 前台隔离（M3）：低优先/错峰槽，前台首 token 延迟不受裁决批影响（A6）。 */
  scheduling: "background-low-priority";
}

export interface AdjudicationModelSessionResult {
  outputText: string;
  /** 会话回合 usage（可选）：在场时驱动器自动计量入微预算；宿主勿对同一 usage 重复 recordUsage。 */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * 本批实际执行的 ChengPlan 只读工具回执。verdict 里的 chengPlanId 必须命中这里；
   * 缺席 = 本会话未执行任何 ChengPlan（或 model-only 会话没有工具面）。
   */
  chengPlanReceipts?: readonly AdjudicationChengPlanReceipt[];
}

/**
 * delivery 端口 = spec §2.1 super-agent-trigger.applyVerdicts 的精确接缝：
 * P2 mandate 恒隐式 record_only → 非 reject 收敛 would-accept 卡片（decision_log
 * disposition=would_accept + adjudication_status=record_only）；reject 落
 * decision_log(disposition=reject) + adjudication_status=rejected，不产卡片。
 * decision_log 写入经 super-agent-decision-log 仓储 API（裁定 8，唯一写者），
 * 由该 seam 的实现方（trigger.applyVerdicts）持有端口——本模块零直写。
 * 签名与 trigger.SuperAgentTriggerContract.applyVerdicts 结构一致，组合根直接接线。
 */
export interface AdjudicationDeliveryPort {
  applyVerdicts(batchId: string, decisions: readonly AdjudicationVerdictDecision[]): Promise<void>;
}

/** mandate 查询端口（结构 = super-agent-mandate.resolveFor；P2 恒隐式 record_only）。 */
export interface AdjudicationMandatePort {
  resolveFor(triggerClass: string): AdjudicationMandateVerdict;
}

export interface SuperAgentAdjudicationContract {
  /**
   * 唤醒一个 unowned candidate（intake 路由 unowned_candidate 后由组合根调用）。
   * 前置：trigger_events 行存在——否则抛错（装配错误，响亮失败）；行已收敛或非
   * candidate（fast_path/adjudication_status 不符）则忽略（幂等重通知）。
   * 后置：按唤醒三选一评估是否立即攒批；未 start()（非 leader）时仅校验不唤醒。
   * 同步执行，永不等待模型；不发事件。
   */
  notifyCandidate(triggerId: string): void;
  /**
   * 对 workspace 跑一批裁决：读 pending 行 → 短命 model-only 会话 → verdict schema
   * 校验（fail-closed）→ mandate 裁定 → delivery 端口交付。无 pending 返回 empty。
   * 同 workspace 在途批合流（返回同一 Promise），不并发双跑。
   * 可在未 start() 时直接调用（测试/手动）；自动唤醒路径受 start/stop 门控。
   * 失败路径：delivery/DB 错误原样 reject（调用方处理）；会话故障/预算耗尽转
   * outcome 状态（见 BatchOutcome）并经 onError 告警。
   */
  runBatch(workspaceIdentity: string): Promise<BatchOutcome>;
  /** 启动定时评估点循环并立即补扫全部 pending workspace（leader 获得租约后调用）；幂等。 */
  start(): void;
  /**
   * 停止评估点与全部唤醒/短窗定时器、销毁在窗短命会话（leader 失锁时调用）；幂等。
   * 在途批不取消（自然收尾，收尾后的唤醒被 running 门控拦下）。
   */
  stop(): void;
  /**
   * 微预算计量点（M3）：usage 事件经组合根喂入；同 workspace 同 UTC 日累加，
   * 跨日换桶自动清零；迟到（早于当前 UTC 日）的 `at` 丢弃，不回退当日已耗。
   * 会话结果自带的 usage 由驱动器自动计量，宿主勿重复上报。
   */
  recordUsage(input: AdjudicationUsageInput): void;
  /** 累计计数快照（T2 schema-fail 计数等观测面）。 */
  stats(): AdjudicationStats;
}

export interface CreateAdjudicationDriverOptions {
  db: AdjudicationDatabaseHandle;
  session: AdjudicationModelSessionPort;
  delivery: AdjudicationDeliveryPort;
  mandate: AdjudicationMandatePort;
  /** A10 告警缝：会话故障 / delivery 未结算 / 自动唤醒 reject 必经此上报，不静默吞。必填。 */
  onError: (error: unknown, context: string) => void;
  /** 覆盖每日微预算帽（测试/标定）。 */
  dailyTokenBudget?: number;
}
