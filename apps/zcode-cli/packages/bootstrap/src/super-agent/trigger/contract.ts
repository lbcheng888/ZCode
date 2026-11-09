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
import type {
  DispatchHumanExplicitOutcome,
  LeaderClaimInput,
  LeaderClaimResult,
  RevokeTriggerSubscriptionSelector,
  RouteOwnedOutcome,
  TriggerSubscriptionRecord,
  TriggerVerdictDecision,
  UpsertTriggerSubscriptionInput,
} from "./types.js";
export * from "./types.js";

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
  applyVerdicts(batchId: string, decisions: readonly TriggerVerdictDecision[]): Promise<void>;
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
