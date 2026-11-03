/**
 * super-agent-trigger 对外契约（spec super-agent-trigger-subsystem-spec §2.1 /
 * §3.3）：trigger_subscriptions 仓储、EventRouter owned 直通、human-explicit 分派器、
 * verdict 解释执行、leader 租约门控。调用方 = Intake（routeOwned / dispatchHumanExplicit）、
 * 裁决驱动器（applyVerdicts）、组合根（订阅 / 租约 / 心跳）。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 *
 * 仓储方法为同步返回（node:sqlite DatabaseSync 同步 API，与兄弟模块仓储一致，
 * 见 spec §1.3 实施偏差）；routeOwned / dispatchHumanExplicit 为 Promise（经 host RPC /
 * worker port 异步）。热路径零 LLM：本模块任何方法都不构造模型调用。
 *
 * 组合根注入的三个行为端口（delivery / worker / decisionLog）定义在 ports.ts
 * （与 dispatchBridgePort.ts 同惯例）：本文件只保留载荷数据类型与模块契约面，
 * 使契约方法计数与 spec §2.1 声明序一致。
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
  createdAt?: number;
}

export type RouteOwnedOutcome =
  | { kind: "routed"; triggerId: string; deliveries: TriggerDeliveryReceipt[] }
  /** 部分/全部投递被拒：final_disposition 保持未决（NULL），供启动重放与告警覆盖。 */
  | { kind: "delivery_failed"; triggerId: string; deliveries: TriggerDeliveryReceipt[] }
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

export interface SuperAgentTriggerContract {
  /**
   * 幂等写入 active 订阅（partial unique (workspace, threadKey, sessionId) WHERE active）：
   * 首写者胜 = INSERT OR IGNORE（§1.3 明文语义，与 §5.1 回填一致）——冲突时零更新、
   * 原样返回既有行，不覆盖 lane/owner（防止 followup 回写把 guide/inject 车道降级）；
   * lane/owner 变更需显式 update API（暂未提供），lease 刷新走 renewActiveLeases。
   * 同步执行，返回即已持久化；不发事件。
   */
  upsertSubscription(input: UpsertTriggerSubscriptionInput): TriggerSubscriptionRecord;
  /**
   * 撤销订阅（status=revoked，保留审计行）：按 id，或按 (workspace, ownerKind, ownerRef)
   * 批量（owner 终态注销依据，§1.3）。返回撤销行数；幂等：无 active 行返回 0。同步执行。
   */
  revokeSubscription(selector: RevokeTriggerSubscriptionSelector): number;
  /**
   * 回收 lease_expires_at < now 的 active 订阅（启动清过期 + 定期巡检，M1），
   * 返回回收数；幂等：无过期行返回 0。同步执行。
   */
  sweepExpiredLeases(now: number): number;
  /**
   * leader 心跳续期：把 active 订阅 lease_expires_at 推到 now + TTL。
   * 可按 workspaceIdentity 过滤（per-workspace leader 只续自己的）；缺省续全部。
   * 返回续期行数。同步执行；仅 leader 控制面循环调用。
   */
  renewActiveLeases(now: number, workspaceIdentity?: string): number;
  /**
   * owned 直通（§3.1，零 LLM）：查 trigger_events 行 → active 订阅 fan-out →
   * 逐订阅者经 host RPC 投 CommandInbox（lane 语义见 §3.1 车道表）。
   * 无订阅者 = orphaned（final_disposition=orphaned，计数告警由调用方记）；
   * 任一投递回执 rejected = delivery_failed（final_disposition 保持 NULL 未决，
   * 供启动重放扫描与告警覆盖，调用方按 outcome 计数，不得当已路由消费）。
   * 幂等：重复调用产生相同 commandId（triggerId+sessionId），由 CommandInbox 幂等吸收。
   * 前置：行存在且 fast_path=owned。等待持久化（final_disposition 更新）+ 投递回执。
   */
  routeOwned(triggerId: string): Promise<RouteOwnedOutcome>;
  /**
   * human-explicit 直通（§3.1）【免 Mandate、免攒批】。决策矩阵：
   * worker 终态且非人为停止 → resume；无对象或已人为停止 → createTask + M2 上下文装配；
   * worker 非终态（在跑）→ 经 TriggerHostDeliveryPort lane=guide 行内投递到在跑会话
   * （M1 busy 语义，不新建同 threadKey 平行会话）。随后 upsert 订阅（lane=followup，
   * 首写者胜不覆盖既有车道）。fast_path decision_log 行由 Intake 在 ingest 时落
   * （§3.1 步 2），本方法不重复落行。
   * 前置：trigger_events 行存在。等待 worker port / delivery 异步 + 订阅持久化。
   */
  dispatchHumanExplicit(triggerId: string): Promise<DispatchHumanExplicitOutcome>;
  /**
   * 解释执行 per-candidate verdict（M3 / §2.1）。
   * - 未注入 mandate 端口（flag 关 / P2）：accept/record-only 收敛为
   *   decision_log(would_accept) + adjudication_status=record_only；reject →
   *   decision_log(reject) + rejected，不产卡片、不建订阅（字节兼容）。
   * - 注入 mandate 端口（M4 flag 开）：accept 按 `resolveFor(triggerClass)` 三档分派——
   *   record_only → would-accept 卡片；speculative/auto → 事务内落
   *   adjudication_status=accepted + decision_log(accept)，**commit 后**异步经 specRun
   *   端口启动受限 spec run（两阶段：同步事务不 await 执行）。record-only 决议不执行。
   * - M6 方案门（proposalGate 开）：accept 必须携带五字段 scheme；缺失/不完整 ⇒
   *   降级 record_only（不产卡、不执行）并在 decision_log 留 `scheme_card_incomplete:`
   *   计数行——一句话摘要不构成「最佳方案」。
   * - 档位要求执行但未注入 specRun 端口 = 装配错误：事务前响亮抛错、零写入。
   * 前置：全部 decision.triggerId 命中 trigger_events 行（FK 不命中整批抛错、零写入）。
   * 同步返回；校验 + 写入整段包在 BEGIN IMMEDIATE 事务内，任一步失败整体 ROLLBACK
   * 后上浮——「零部分执行」对写路径同样成立（decisionLog 端口须与仓储同库句柄）。
   */
  applyVerdicts(batchId: string, decisions: readonly TriggerVerdictDecision[]): void;
  /**
   * leader 租约竞争（§3.3）：BEGIN IMMEDIATE + upsert 带 WHERE 守卫 + changes()>0 断言。
   * 断言不过 = follower（本事务回滚，不启动任何控制面循环）；断言过 = leader。
   * 幂等：同 ownerId 续约恒 leader（owner_id=me 守卫）。同步执行。
   */
  tryClaimLeadership(input: LeaderClaimInput): LeaderClaimResult;
  /**
   * leader 心跳续期：仅 owner 本人可续（owner_id 匹配）。返回 true=仍持有；
   * false=租约被他人夺走或已清除，调用方必须主动降级 follower 并停循环（§3.3）。
   * 同步执行。
   */
  heartbeatLeadership(input: LeaderClaimInput): boolean;
}
