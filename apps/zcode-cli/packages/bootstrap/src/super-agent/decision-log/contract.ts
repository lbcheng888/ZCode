/**
 * super-agent-decision-log 对外契约：decision_log 的唯一写入口（M12② / spec §1.7）。
 * 调用方只有两个——Intake 的 fast-path disposition、裁决驱动器的 verdict / would-accept 转化；
 * 不存在第二写者。eval 闭环（off-peak 导出）读本表，P2 只落行不交付导出。
 */

export type DecisionLogOrigin = "fast_path" | "adjudication" | "would_accept_convert";

/**
 * routed 仅 origin=fast_path（owned/human_explicit 直通行已路由，M12②）；
 * adjudication verdict 用 accept/reject/record_only，不用 routed。
 */
export type DecisionLogDisposition =
  | "accept"
  | "reject"
  | "record_only"
  | "would_accept"
  | "routed";

/** 滚动保留窗口（M9）：sweepRetention 删除早于 now − 90 天的行。 */
export const DECISION_LOG_RETENTION_DAYS = 90;

/**
 * M6 五字段方案卡（2026-11-02 用户裁定）。结构 = shared `schemeCardSchema` /
 * trigger.TriggerSchemeCard 的同一形状；模块间用结构子集，不 import 兄弟模块。
 */
export interface DecisionLogSchemeCard {
  currentEvidence: string;
  candidateOptions: readonly { option: string; cost: string }[];
  recommendation: string;
  impact: string;
  verification: string;
}

export interface DecisionLogEntryInput {
  workspaceIdentity: string;
  /** trigger_events.id；would_accept_convert 行可空（记 mandateId）。 */
  triggerId?: string | null;
  origin: DecisionLogOrigin;
  disposition: DecisionLogDisposition;
  /** 裁决批分组（同 workspace 一批，M3）。 */
  batchId?: string | null;
  /** 分档记录（M12③），如 "adjudicator"。 */
  modelTier?: string | null;
  reason?: string | null;
  /** verdict evidence 引用，JSON 数组落 evidence 列。 */
  evidence?: readonly string[];
  /** M6 方案卡：JSON 落 card_payload 列（收件箱出口据此呈现/校验）。 */
  card?: DecisionLogSchemeCard;
  /** 可选 ChengPlan 稳定引用（S2）；落 cheng_plan_id 列，可空。 */
  chengPlanId?: string | null;
  /** 落行时间（epoch ms）；缺省 Date.now()，测试/回填可注入。 */
  createdAt?: number;
}

export interface SuperAgentDecisionLogContract {
  /**
   * 落一行 decision_log。前置：origin × disposition 组合语义由调用方保证（fast_path 直通记
   * routed、快路径拒绝记 reject、candidate 记 record_only）。后置：行已可读。
   * 幂等性：每次调用新增一行（调用方按 triggerId+origin 自行去重，如需）。
   * 同步执行，返回即已持久化；不发事件。
   */
  record(entry: DecisionLogEntryInput): void;
  /**
   * 删除 created_at < now − DECISION_LOG_RETENTION_DAYS 的行（滚动窗口 TTL，M9），返回删除行数。
   * 幂等：窗口内无行时返回 0。同步执行，不发事件。
   */
  sweepRetention(now: number): number;
}
