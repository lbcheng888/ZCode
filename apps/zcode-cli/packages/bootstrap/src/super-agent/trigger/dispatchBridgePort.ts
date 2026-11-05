/**
 * super-agent 派发桥端口（spec super-agent-trigger-subsystem-spec §1.6 / §2.1 /
 * §3.2，M7② exactly-once）。本文件只放类型：状态机实现在 dispatchBridge.ts，
 * 组合根按此端口注入 push 实现。
 *
 * 进程边界：scheduler（packages/desktop，Main fork / 未来 daemon 内 scheduler）
 * 只在 claim 成功后写 pending_dispatch 行与 trigger_events 审计行（§5.2），不 import
 * 本模块；push / ACK / 宽限跳过 / 启动续推由控制面（bootstrap 侧，§7-7）驱动本桥。
 * milestone A 的 push 实现 = host 进程内 CommandInbox 直推的生产适配器（真实代码，
 * 非 mock）；测试注入的脚本化端口仅存在于测试代码。
 */

/** dispatch_requests.status（§1.6 状态机）。 */
export type DispatchRequestStatus = "pending_dispatch" | "pushed" | "dispatched" | "skipped";

/** dispatch_policy（§1.6）：缺省 in-window；durable-wait 为 opt-in（features.durableSchedulerDispatch）。 */
export type DispatchPolicy = "in_window" | "durable_wait";

/** skip_reason（§1.6 / §3.2）：no_dispatcher=宽限内无 dispatcher；stale=durable-wait 超最大陈旧期。 */
export type DispatchSkipReason = "no_dispatcher" | "stale";

/**
 * push 到 host CommandInbox 的命令。commandId = hash(runId)（稳定键）：崩溃重投
 * 复用同 commandId，由 CommandInbox 幂等吸收不双跑（M7② kill-point ②）。
 */
export interface DispatchPushCommand {
  requestId: string;
  commandId: string;
  runId: string;
  workspaceIdentity: string;
  sessionId: string | null;
  /** 派发载荷（prompt/摘要；§1.6），scheduler claim 时落行，桥不再回读 automations。 */
  payload: string | null;
}

/**
 * CommandInbox admission 回执（§1.6：admitted 或 duplicate 都算 ACK，裁定 4「ACK 即
 * settled」）。rejected 不是 ACK：行保持 pushed，按崩溃重投规则续推。
 */
export type DispatchPushOutcome =
  | { status: "admitted" }
  | { status: "duplicate" }
  | { status: "rejected"; reasonCode?: string };

/** 组合根注入的推送端：把命令投到在线 host attachment 的 CommandInbox，admission 回执即 ACK。 */
export interface DispatchPushPort {
  push(command: DispatchPushCommand): Promise<DispatchPushOutcome>;
  /**
   * 宿主 attachment 是否在线（milestone A 进程内适配器按 attachment 挂载态实现）。
   * 缺省视为在线——端口已注入即视为可达；不可达判定只影响 resume 的推/留决策。
   */
  isHostReachable?(): boolean;
}

/** dispatch_requests 行（§1.6 列面；未发生的时间戳为 null）。 */
export interface DispatchRequestRecord {
  id: string;
  runId: string;
  commandId: string;
  workspaceIdentity: string;
  sessionId: string | null;
  payload: string | null;
  status: DispatchRequestStatus;
  skipReason: string | null;
  dispatchPolicy: DispatchPolicy;
  attempts: number;
  claimedAt: number | null;
  pushedAt: number | null;
  ackedAt: number | null;
  settledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DispatchClaimInput {
  /** automation run / off-peak ticket 稳定 id（off-peak 不进桥，裁定 5）。 */
  runId: string;
  workspaceIdentity: string;
  sessionId?: string | null;
  payload?: string | null;
  /** 缺省 in_window（§1.6）。 */
  dispatchPolicy?: DispatchPolicy;
  /** 落行时间；缺省 Date.now()。 */
  now?: number;
}

export interface DispatchClaimResult {
  requestId: string;
  runId: string;
  commandId: string;
  status: DispatchRequestStatus;
  /** false = runId 已有行（幂等短路，零新增行）。 */
  created: boolean;
}

export type DispatchPushResult =
  | { kind: "pushed"; requestId: string; commandId: string; receipt: DispatchPushOutcome }
  | {
      kind: "already_terminal";
      requestId: string;
      status: "dispatched" | "skipped";
      skipReason: string | null;
    }
  | { kind: "not_found"; requestId: string };

export type DispatchAckResult =
  | { kind: "settled"; requestId: string }
  | { kind: "noop"; requestId: string; status: DispatchRequestStatus };

export interface ResumePushedEntry {
  requestId: string;
  commandId: string;
}

export interface ResumePendingAfterBootResult {
  /** 本轮成功推过的行（含崩溃后重推，commandId 不变）。 */
  pushed: ResumePushedEntry[];
  /** 仍未推的行 id（宿主不可达，或推失败见 failures；行状态保持可续推）。 */
  pending: string[];
  /** 推失败的行：错误原样带出不吞，行留在 pushed/pending 由下轮续推（无 failed 终态，§1.6）。 */
  failures: { requestId: string; message: string }[];
}

/**
 * 宽限跳过选项：durable-wait 行只在超过最大陈旧期时 settle skipped(stale)（T3④）。
 * `workspaceIdentity`：单 child 多 plane 时把扫描收窄到本 plane 的 workspace——
 * 同一 tasks-index 由多个 plane 桥共用，不收窄会让每个 plane 各自扫描/推送他 plane 的行
 * （CAS 虽能去重终态，但会产生并发重复 push）。
 */
export interface SweepSkippedOptions {
  durableMaxStaleMs?: number;
  workspaceIdentity?: string;
}

export interface ResumePendingAfterBootOptions {
  /** 落时间；缺省 Date.now()。 */
  now?: number;
  /** 只扫描本 plane 的 workspace（单 child 多 plane 时避免跨 plane 重复 push）。 */
  workspaceIdentity?: string;
  /**
   * 宿主是否在线；缺省取 push.isHostReachable?.() ?? true。
   * 不在线：不推任何行（重推/新推都留待回连），由调用方随后 sweepSkipped(grace)
   * 按 in-window 结算（kill-point ①）。
   */
  hostAvailable?: boolean;
}

/**
 * 派发桥契约（spec §2.1 五方法）。唯一写者 = 本桥（§1.6）；全部状态转移用单条
 * `UPDATE … WHERE id=? AND status=?` CAS，push 与 skipped 互斥（裁定 M7②）。
 * 同步方法返回即已持久化（node:sqlite 同步写）；push 端口为异步。
 */
export interface SuperAgentDispatchBridgeContract {
  /**
   * claim 后写 pending_dispatch 行（commandId=hash(runId)）。
   * 幂等：同 runId 重复 claim 返回既有行（created=false），零新增。
   * 前置：tasks-index 已迁移出 dispatch_requests 表。同步；不发事件。
   */
  claimDue(input: DispatchClaimInput): DispatchClaimResult;
  /**
   * pending→pushed（CAS，attempts+1）后调 push 端口；已是 pushed 的行 = 续推
   * （attempts+1，同 commandId）。终态行返回 already_terminal（零推送）。
   * 端口异常原样上浮：行保持 pushed，由 resume/下轮续推（无 failed 终态）。
   * 等待 push 回执；不写 ACK（ACK 走 onHostAck）。
   */
  pushDispatch(requestId: string): Promise<DispatchPushResult>;
  /**
   * host ACK（CommandInbox admission 回执 admitted|duplicate）→ pushed→dispatched
   * （CAS）。幂等：重复 ACK 返回 noop；commandId 未命中 = 调用方错误，原样抛出。
   * 同步；返回即已 settle（裁定 4：ACK 即 settled）。
   */
  onHostAck(commandId: string, outcome: "admitted" | "duplicate"): DispatchAckResult;
  /**
   * 宽限定时器：in_window 的 pending_dispatch 停留超过 grace → skipped(no_dispatcher)
   * （CAS：WHERE status='pending_dispatch'，与 push 互斥，pushed 永不被跳过）。
   * durable-wait 行仅在 options.durableMaxStaleMs 超龄时 skipped(stale)。
   * 返回结算行数；幂等：无到期行返回 0。同步。
   */
  sweepSkipped(now: number, graceMs: number, options?: SweepSkippedOptions): number;
  /**
   * 启动/崩溃恢复扫描（§3.2 kill-point ①②④）：pushed 停滞行重推同 commandId；
   * pending 行在宿主可达时补推、不可达时留待回连（调用方随后 sweep 按 in-window
   * 结算）。终态行零动作。等待 push 回执；失败行原样带在 failures。
   */
  resumePendingAfterBoot(options?: ResumePendingAfterBootOptions): Promise<ResumePendingAfterBootResult>;
}
