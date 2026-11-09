/**
 * super-agent-trigger 的公开载荷与数据类型。
 *
 * 从 contract.ts 拆出以避免公开契约超过 300 行上限；contract.ts 通过
 * `export * from "./types.js"` 保持同一公共面，调用方不需要改 import。
 */

export type TriggerSubscriptionLane = "followup" | "guide" | "inject";

export type TriggerSubscriptionOwnerKind = "session" | "goal" | "workflow";

export type TriggerSubscriptionStatus = "active" | "revoked";

/**
 * 订阅租约 TTL（§1.3：随 leader 心跳续期；启动清过期 + owner 终态宽限回收）。
 * 心跳周期 15s × 6 = 90s：leader 正常心跳下永不过期，leader 崩溃后 90s 内
 * 新 leader 可安全接管，订阅者侧无需等待更久。
 */
export const TRIGGER_SUBSCRIPTION_LEASE_TTL_MS = 90_000;

export interface TriggerSubscriptionRecord {
  id: string;
  workspaceIdentity: string;
  threadKey: string;
  sessionId: string;
  lane: TriggerSubscriptionLane;
  /** JSON 可选过滤面，原样存储。 */
  filters: string | null;
  ownerKind: TriggerSubscriptionOwnerKind;
  ownerRef: string | null;
  status: TriggerSubscriptionStatus;
  leaseExpiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertTriggerSubscriptionInput {
  workspaceIdentity: string;
  threadKey: string;
  /** 订阅者（目标会话）。 */
  sessionId: string;
  lane: TriggerSubscriptionLane;
  filters?: string | null;
  ownerKind: TriggerSubscriptionOwnerKind;
  /** goal id / workflow run id；ownerKind=session 时可空。 */
  ownerRef?: string | null;
  /** 缺省 now + TRIGGER_SUBSCRIPTION_LEASE_TTL_MS。 */
  leaseExpiresAt?: number;
  /** 落行时间；缺省 Date.now()。 */
  now?: number;
}

export type RevokeTriggerSubscriptionSelector =
  | { id: string; workspaceIdentity?: never; ownerKind?: never; ownerRef?: never }
  | {
      id?: never;
      workspaceIdentity: string;
      ownerKind: TriggerSubscriptionOwnerKind;
      ownerRef: string;
    };

/** host RPC CommandInbox 投递面（§2.2：super-agent-trigger 不直接 import host 实例）。 */
export interface TriggerDeliveryInput {
  sessionId: string;
  /** 投递幂等键 = triggerId + subscriberSessionId（§1.3 fan-out）。 */
  commandId: string;
  triggerId: string;
  /** 随 trigger_events.taint 透传；永不构成指令权威（§5）。 */
  taint: boolean;
  /** M1 车道语义（§3.1 车道表权威）：followup=idle 走 queue 并经 autoDrain 唤醒；
   * guide=busy 步边界行内；inject=不唤醒（watch 类），落 next-step 收件箱。 */
  lane: TriggerSubscriptionLane;
  text: string;
  workspaceIdentity: string;
}

export type TriggerDeliveryReceipt =
  | { status: "admitted" | "duplicate" }
  | { status: "rejected"; reasonCode?: string };

/** M2 上下文装配（目标摘要 + 最近窄结果 + 未决问题 + recall 种子 ID），内容有上限。 */
export interface TriggerWorkerContext {
  goalSummary?: string;
  recentNarrowResults?: readonly string[];
  openQuestions?: readonly string[];
  recallSeedIds?: readonly string[];
}

export interface FindWorkerByThreadKeyInput {
  workspaceIdentity: string;
  threadKey: string;
}

export interface ResumableWorker {
  sessionId: string;
  /** worker 已到终态（回合结束、可接新输入）。 */
  terminal: boolean;
  /** 人为停止（用户 cancel/stop）→ 不 resume，改 createTask（spec §2.1 决策矩阵）。 */
  stoppedByHuman: boolean;
  context?: TriggerWorkerContext;
}

export interface ResumeWorkerInput {
  sessionId: string;
  triggerId: string;
  text: string;
  context?: TriggerWorkerContext;
}

export interface CreateTaskInput {
  workspaceIdentity: string;
  threadKey: string;
  triggerId: string;
  text: string;
  context?: TriggerWorkerContext;
}

/** M6 五字段方案卡：现状证据/候选方案(≥2带代价)/最佳推荐/影响面/验证方案；一句话摘要不构成「最佳方案」，缺字段出站被拦。 */
export interface TriggerSchemeCard {
  currentEvidence: string;
  candidateOptions: readonly { option: string; cost: string }[];
  recommendation: string;
  impact: string;
  verification: string;
}

/** mandate 档位（结构 = super-agent-mandate 的 MandateTier 子集）。 */
export type TriggerMandateTier = "record_only" | "speculative" | "auto";

/** M4 mandate 查询端口：组合根注入真契约，缺省缺席=恒 record_only（P2 字节兼容）。 */
export interface TriggerMandatePort {
  resolveFor(
    triggerClass: string,
    options?: { workspaceIdentity?: string; now?: number },
  ): { tier: TriggerMandateTier; source?: "implicit" | "explicit"; mandateId?: string };
}

/** 真实 ChengGate 结果的最小结构（= cheng-contract ChengGateResult，结构对称避免跨模块依赖）。 */
export interface TriggerChengGateVerdict {
  ok: boolean;
  level: "PRODUCTION" | "DIAGNOSTIC_NOT_ACCEPTANCE" | "BLOCKED";
  reasons: readonly string[];
}

/** 投机/自动档执行载荷（M5 spec lane：无凭据受限 profile 的静默复现-修复）。 */
export interface TriggerSpecRunInput {
  triggerId: string;
  workspaceIdentity: string;
  threadKey: string;
  source: string;
  tier: "speculative" | "auto";
  reason?: string;
  evidence?: readonly string[];
  /** M6 方案卡内容（auto/speculative 档没有卡可展示时也必须携带完整方案）。 */
  card?: TriggerSchemeCard;
  /** trigger payload 携带的 Cheng job 引用；分发前用真实 host verify 求 gate。 */
  chengJobId?: string;
  /** 程序求得的 gate 结果；红 gate 在 dispatch 阶段静默丢弃，不进 spec run。 */
  chengGate?: TriggerChengGateVerdict;
}

/** M5 spec run 启动端口：Phase 3 唯一合法形态=subagent（workflow child runtime 不接受受限档案）。 */
export interface TriggerSpecRunPort {
  start(input: TriggerSpecRunInput): Promise<void>;
}

/** decision_log 写入口的结构子集（= super-agent-decision-log contract 的 record 面）。 */
export interface TriggerDecisionLogEntryInput {
  workspaceIdentity: string;
  triggerId?: string | null;
  origin: "fast_path" | "adjudication" | "would_accept_convert";
  disposition: "accept" | "reject" | "record_only" | "would_accept" | "routed";
  batchId?: string | null;
  modelTier?: string | null;
  reason?: string | null;
  evidence?: readonly string[];
  /** M6 方案卡（落 decision_log.card_payload）；缺席 = 旧行/非方案类。 */
  card?: TriggerSchemeCard;
  /** ChengPlan 引用（落 decision_log.cheng_plan_id）；缺席 = 无 plan。 */
  chengPlanId?: string | null;
  createdAt?: number;
}

export type RouteOwnedOutcome =
  | { kind: "routed"; triggerId: string; deliveries: TriggerDeliveryReceipt[] }
  /** 部分/全部投递被拒：final_disposition 保持未决（NULL），供启动重放与告警覆盖。 */
  | { kind: "delivery_failed"; triggerId: string; deliveries: TriggerDeliveryReceipt[] }
  /** Cheng gate 红：静默丢弃回复，final_disposition=record_only。 */
  | { kind: "gate_blocked"; triggerId: string; reason: string }
  | { kind: "orphaned"; triggerId: string }
  | { kind: "not_found"; triggerId: string };

export type DispatchHumanExplicitOutcome =
  | { kind: "resumed"; triggerId: string; sessionId: string }
  | { kind: "created_task"; triggerId: string; sessionId: string }
  /** worker 在跑：lane=guide 行内投递成功（M1 busy 语义，不建平行会话）。 */
  | { kind: "delivered"; triggerId: string; sessionId: string }
  /** 在跑会话行内投递被拒（宿主不可达/会话未 hydrate）：不静默吞，原样暴露。 */
  | {
      kind: "delivery_failed";
      triggerId: string;
      sessionId: string;
      reasonCode?: string;
    }
  | { kind: "not_found"; triggerId: string };

/** M3 verdict schema 的 per-candidate 决议（disposition 用连字符，与裁决会话输出一致）。 */
export interface TriggerVerdictDecision {
  triggerId: string;
  disposition: "accept" | "reject" | "record-only";
  reason?: string;
  evidence?: readonly string[];
  /** M6 方案卡（accept 必需，出口门校验）；reject/record-only 不需要。 */
  scheme?: TriggerSchemeCard;
  /** 可选 ChengPlan 稳定引用（S2）；同事务落 trigger_events 与 decision_log 的 cheng_plan_id。 */
  chengPlanId?: string;
}

export interface LeaderClaimInput {
  workspaceIdentity: string;
  /** daemon / 控制面进程实例 id。 */
  ownerId: string;
  /** 落租时间（epoch ms）；缺省 Date.now()。 */
  now?: number;
}

export type LeaderClaimResult =
  | { kind: "leader"; workspaceIdentity: string; ownerId: string; expiresAt: number }
  | { kind: "follower"; workspaceIdentity: string; ownerId: string; expiresAt: number };

