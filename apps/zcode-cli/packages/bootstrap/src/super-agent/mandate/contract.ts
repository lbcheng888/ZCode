/**
 * super-agent-mandate 对外契约：mandate 查询语义（spec §1.4 / M4）。
 * P2 只保证查询 API 与隐式 record-only 缺省存在且被分派器调用；解析契约
 * （prompt admission 异步解析 + checkPermission 最前端同步 fail-closed）与执行档 Phase 3 启用。
 */

export type MandateTier = "record_only" | "speculative" | "auto";

export type MandateStatus = "active" | "revoked";

/** 分派器看到的裁定。P2 恒为隐式 record_only（无 Mandate 行为，spec §0 硬不变量）。 */
export interface MandateVerdict {
  tier: MandateTier;
  /** implicit = 隐式缺省（不写表）；explicit = 命中显式 mandate 行（Phase 3 起才可能出现）。 */
  source: "implicit" | "explicit";
  /** 命中的显式 mandateId；隐式缺省时缺省。 */
  mandateId?: string;
}

export interface MandateRecord {
  id: string;
  workspaceIdentity: string;
  /** 如 bot:<botId> / cron:<automationId> / webhook:<routeId>。 */
  triggerClass: string;
  tier: MandateTier;
  /** JSON 文本（信道/路径/成员范围）。 */
  scope: string | null;
  policyVersion: number;
  resumeAfterRestart: boolean;
  expiresAt: number | null;
  status: MandateStatus;
  createdAt: number;
  updatedAt: number;
}

export interface InsertMandateInput {
  workspaceIdentity: string;
  triggerClass: string;
  tier: MandateTier;
  scope?: string | null;
  policyVersion: number;
  resumeAfterRestart?: boolean;
  expiresAt?: number | null;
  now?: number;
}

/** mandate 表仓储（P2 建表启用；would-accept 一键批转 auto 的写行入口留给收件箱侧调用）。 */
export interface SuperAgentMandateRepo {
  /**
   * 插入一条 active mandate 行。前置：同 (workspace, triggerClass) 无其它 active 行
   * （表上 partial unique index 保证，冲突时 SQLite 原样抛错）。同步执行，返回即已持久化。
   */
  insert(input: InsertMandateInput): MandateRecord;
  /**
   * 读当前有效 active 行（未过期）；无则 undefined。同步执行，只读。
   */
  getActive(workspaceIdentity: string, triggerClass: string, now?: number): MandateRecord | undefined;
  /**
   * 撤销（status=revoked）。幂等：id 不存在或已撤销时返回 false。同步执行。
   */
  revoke(id: string, now?: number): boolean;
  /**
   * 回收 expires_at < now 的 active 行（转 revoked，保留审计），返回回收数。同步执行。
   */
  sweepExpired(now: number): number;
}

/** resolveFor 的可选注入面：缺省（不注入）= 恒隐式 record_only（flag 关字节兼容，spec §0）。 */
export interface MandateResolveOptions {
  /** 域库仓储句柄；注入后启用「显式 active 行 UNION 隐式缺省」三档解析（M4，Phase 3）。 */
  repo?: SuperAgentMandateRepo;
  /** 解析作用域键（workspaceIdentity）；与 repo 配对注入，缺一即回退隐式。 */
  workspaceIdentity?: string;
  /** 落点时间（epoch ms），缺省 Date.now；注入 repo 时用于 expires_at 判定。 */
  now?: number;
}

export interface SuperAgentMandateContract {
  /**
   * 按 triggerClass 解析执行档（M4 三档）。
   *
   * - 不注入 repo（flag 关 / P2 缺省）：恒返回 { tier: "record_only", source: "implicit" }——
   *   即便 mandate 表已有显式行也按隐式缺省收敛，全部 candidate 进 would-accept（spec §0/§8-14③）。
   * - 注入 repo + workspaceIdentity（features.mandateGate 开，Phase 3）：查 (workspaceIdentity,
   *   trigger_class) 的 active 未过期行（getActive 已含 expires_at 过滤）——命中返回显式
   *   { tier, source: "explicit", mandateId }，未命中回退隐式 record_only（查询层 UNION 缺省）。
   *
   * 同步（checkPermission 最前端同步 fail-closed 依赖）；无副作用、不写表。
   */
  resolveFor(triggerClass: string, options?: MandateResolveOptions): MandateVerdict;
}
