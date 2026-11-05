/**
 * daemon 内 scheduler（B-SPEC §4.4，B3）。
 *
 * 职责（只做 Core 的 tasks-index 写面 + child 的审计/租约读面）：
 * 1. 按 enabled automation 的 workspace 逐个 `workspace.ensure`，让 child 建 plane 并抢租约；
 * 2. `lease.list` 门控：只认「未过期租约」的 workspace——这些 workspace 归 daemon scheduler；
 *    租约不可见（child 未 leader / 熔断 / 租约过期）= 不 claim，交回 Desktop Main fork 回退
 *    语义（B-SPEC §4.4.4）。
 * 3. `AutomationRepo.claimDue`（BEGIN IMMEDIATE 单飞）认领到期行；
 * 4. 认领成功经 `schedule.audit` RPC 落审计行（失败 → release claim，下一 tick 重试）；
 * 5. misfire 跳过（沿用 desktop scheduler 的 5 分钟宽限与一次性终态语义）；
 * 6. 写 `dispatch_requests.pending_dispatch`（session_id = targetTaskId）；未绑定会话的
 *    automation 不写桥行，按永久失败结算（host.worker.createTask 幂等面未接线）。
 * 7. manual run（`claimManualRuns`，崩溃恢复路径）：与定时 run 同走桥（manual 是
 *    automation_runs 的一种 trigger，spec 只把 off-peak 排除在桥外），写 pending 行、
 *    按同一 ACK 结算；
 * 8. off-peak（`OffPeakTaskRepo.claimDue`）：claim → `schedule.audit` → 顺延
 *    （releaseClaim 不记失败）。ticket 顺延语义 = 错过执行窗口不丢弃（D9），且
 *    off-peak 不进 dispatch_requests 桥（trigger-subsystem-spec §7-5）。
 *    本进程没有 off-peak host 派发面（见交付说明）：claim 只为审计与保持 queued 顺延，
 *    真正的 off-peak 执行仍归 host。
 *
 * 结算入口（替代 Desktop Main fork 的结算职责）：
 * - `settleDispatchResult`：派发 ACK（admission admitted|duplicate = dispatched）后回写
 *   run 台账（schedule → dispatched、next_run_at 推进；manual → dispatched 但 claim
 *   保留到 turn 终态；失败 → failed_to_dispatch + 退避/释放 manual claim）。与桥状态机
 *   对齐：ACK 即 settled，终态 `dispatch_requests` 的 CAS 仍只由 child 桥写（§4.5）。
 * - `settleRunTerminal`：worker 终态回写 → `automation_runs.outcome` + manual claim 释放。
 *   生产来源 = Core `IZCodeTaskService.onDynamicTaskTerminalOutcome`，按 ACK 的
 *   `inputAccepted.inputId` 精确匹配本次派发轮次（与 Desktop `trackCronRunOutcome` 同源）。
 * - 桥行终态对账：Core 每 tick 只读 `dispatch_requests`，把已 `dispatched`/`skipped`
 *   但 run 台账仍 `claimed` 的行收敛（覆盖回执丢失/崩溃重投，且不依赖 child 回调）。
 *
 * 与 Desktop Main fork 的关键差异（刻意如此，不是回退）：
 * - Desktop：有租约 → 释放跳过（归控制面）；无租约 = 回退期 → 照常 claim。
 * - daemon：有租约（child 已 leader）→ claim；无租约/租约过期 → 不 claim（fail-closed）。
 * - RPC 不可达：daemon 直接跳过本 tick，不做任何 claim；Desktop 的「心跳不可见」按回退
 *   继续 claim。daemon 不能制造「Core 以为自有调度权、child 实际不知情」的第三种运行态。
 *
 * 本模块不直接打开 `super-agent.sqlite`（§0.3）：租约与审计全部经 RPC。
 *
 * 生产启动门禁：本模块的 pending 写入只有与 child 派发桥 push/sweep 同批原子切换才成立
 * （B-SPEC §4.4.3）；桥循环与 Core `host.command` 未接线前 `core.ts` 不构造/不启动本模块，
 * 保持 Desktop Main fork 全权直派。模块本身在 `createDaemonScheduler` 单测中验证门控语义。
 *
 * 启用前还必须同批补齐 `claimManualRuns` / off-peak 认领（off-peak 只落审计、不进桥，
 * §4.4.5）：Desktop Main fork 对已租约 workspace 会把 manual run 与 off-peak 都释放让位，
 * 只认领 automation 会让这些任务在该 workspace 永久无人执行。
 *
 * 生产启停：`core.ts` 在部署门禁打开时构造并 start；启动失败（tasks-index 未迁移）
 * 原样上浮，不做「门禁开但调度器不在跑」的半状态。
 */
import {
  computeAutomationNextRunAt,
  createServiceLogger,
  isOneShotAutomation,
} from "@zcode/services/node";
import {
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunOutcome,
  type ZCodeAutomationTrigger,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import {
  controlPlaneOwnerId,
  type LeaseListResult,
  type ScheduleAuditParams,
} from "@zcode/shared/super-agent-control-plane-protocol";

import { createPendingDispatchWriter, type PendingDispatchWriter } from "./pendingDispatch.js";

const log = createServiceLogger("daemon-scheduler");

/** 轮询间隔：cron 最小粒度是分钟；20s 与 desktop scheduler 同值。 */
const DEFAULT_POLL_INTERVAL_MS = 20_000;
/** misfire 宽限：与 desktop scheduler 同值（5 分钟）。 */
const DEFAULT_MISFIRE_GRACE_MS = 5 * 60_000;

/** manual run 认领行（AutomationRepo.claimManualRuns 的结构子集）。 */
export interface DaemonSchedulerManualRun {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}

/** 派发 ACK：`ok` 等价桥的 `dispatched`（admission admitted|duplicate）。 */
export interface DaemonSchedulerDispatchResult {
  runId: string;
  ok: boolean;
  sessionId?: string | null;
  error?: string;
  failureKind?: "transient" | "permanent";
}

/** worker 终态回写（不含 running；running 由 outcome 台账自行维护）。 */
export interface DaemonSchedulerRunTerminal {
  runId: string;
  outcome: Exclude<ZCodeAutomationRunOutcome, "running">;
  error?: string;
}

/**
 * Core `host.command` 转发的 agent v4 回执（§3.3 CommandAck 的收敛形态）：
 * accepted/duplicate = ACK（桥与 run 台账都结算 dispatched）；其余状态 = 非 ACK，
 * 桥行保持 pushed 由派发桥续推，但 Core run 台账必须可见失败并进入退避（否则
 * failed_to_dispatch/retry_at 永远没有生产生产者）。
 */
export interface DaemonSchedulerHostCommandAck {
  commandId: string;
  status: "accepted" | "duplicate" | "rejected" | "stale" | "noop" | "failed";
  sessionId: string;
  reasonCode?: string;
}

/** 桥行快照（Core 只读 tasks-index；§4.5 允许 Core 读 dispatch_requests）。 */
export interface DaemonSchedulerDispatchRequestSnapshot {
  runId: string;
  sessionId: string | null;
  status: "pending_dispatch" | "pushed" | "dispatched" | "skipped";
  /** `automation_runs.dispatch_status`；行缺失为 null（不投递）。 */
  runDispatchStatus: string | null;
}

/** 已终态但仍未回写 run 台账的桥行（Core 对账用，替换 child→Core 的 skipped 回调）。 */
export interface DaemonSchedulerTerminalDispatch {
  runId: string;
  status: "dispatched" | "skipped";
  sessionId: string | null;
  skipReason: string | null;
}

export interface DaemonSchedulerAutomationRepo {
  ensureReady(): Promise<void>;
  list(): Promise<ZCodeAutomation[]>;
  claimDue(now: number): Promise<ZCodeAutomation[]>;
  /** 崩溃恢复：认领因进程退出而遗留的 manual run（runNow 直派路径不经过本方法）。 */
  claimManualRuns(now: number): Promise<DaemonSchedulerManualRun[]>;
  get(automationId: string): Promise<ZCodeAutomation | null>;
  getRun(runId: string): Promise<ZCodeAutomationRun | null>;
  releaseClaim(automationId: string): Promise<void>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
  /** manual claim 心跳（host 仍持有 queued/running run 时续租 claimed_at）。 */
  touchManualClaim(automationId: string, workspaceKey: string): Promise<void>;
  skipAndReschedule(params: {
    automationId: string;
    runId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    reason: string;
    nextRunAt: number | null;
    finalize?: boolean;
  }): Promise<void>;
  upsertRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    modelSelection?: ZCodeAutomation["modelSelection"];
  }): Promise<void>;
  markRunDispatch(params: {
    runId: string;
    dispatchStatus: ZCodeAutomationRun["dispatchStatus"];
    sessionId?: string | null;
    error?: string | null;
  }): Promise<void>;
  markDispatched(
    automationId: string,
    options: { dispatchedAt: number; nextRunAt: number | null },
  ): Promise<void>;
  markDispatchFailed(
    automationId: string,
    options: {
      failedAt: number;
      error: string;
      kind: "transient" | "permanent";
      nextRunAt?: number | null;
    },
  ): Promise<void>;
  markManualRunDispatched(params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }): Promise<boolean>;
  markRunOutcome(
    runId: string,
    outcome: ZCodeAutomationRunOutcome,
    error?: string,
  ): Promise<void>;
  close?(): void;
}

/**
 * off-peak 仓储窄面（§4.4.5）：daemon 只 claim/审计/顺延（release 不记失败），
 * 不写 dispatch_requests、不标记 running/terminal（执行归 host）。
 */
export interface DaemonSchedulerOffPeakRepo {
  ensureReady(): Promise<void>;
  listNonTerminal(): Promise<ZCodeOffPeakTask[]>;
  claimDue(now: number): Promise<ZCodeOffPeakTask[]>;
  releaseClaim(offPeakTaskId: string, options?: { error?: string; now?: number }): Promise<void>;
  close?(): void;
}

/** §3.2 `lease.list` 的窄读面（真实实现走 Core↔child RPC）。 */
export interface DaemonSchedulerLeasePort {
  list(): Promise<LeaseListResult>;
}

/** §4.4 审计窄端口（真实实现 = services RPC-backed schedule auditor）。 */
export interface DaemonSchedulerAuditPort {
  audit(input: {
    workspaceIdentity: string;
    domainKey: string;
    providerMessageId: string;
    payloadSummary: Record<string, unknown>;
    now: number;
  }): Promise<{ inserted: boolean }>;
}

/** pending_dispatch 写入端口（真实实现 = tasks-index 写入器）。 */
export interface DaemonSchedulerDispatchPort {
  /** 启动期校验写面可用（tasks-index 未迁移时响亮失败）。 */
  verify?(): void;
  insert(input: {
    runId: string;
    workspaceIdentity: string;
    sessionId: string | null;
    payload: string | null;
    now: number;
  }): { requestId: string; commandId: string; created: boolean };
  /**
   * 只读：按 commandId 找回桥行与 run 台账状态。`host.command` 回执/投递前守卫用它
   * 判定该命令是否属于派发桥（trigger 直通的 commandId 不命中 = 非桥命令）。
   * 真实写入器必须实现；测试替身可缺席（此时结算入口视为非桥命令）。
   */
  findByCommandId?(commandId: string): DaemonSchedulerDispatchRequestSnapshot | undefined;
  /**
   * 只读对账：`dispatch_requests` 已终态但 `automation_runs` 仍 claimed 的行。
   * child 桥的 sweepSkipped 不回调 Core；Core 每 tick 用此查询收敛台账，禁止
   * 派发行被跳过后台账永久卡在 claimed。
   */
  listTerminalClaimedRuns?(): DaemonSchedulerTerminalDispatch[];
  close(): void;
}

export interface DaemonSchedulerOptions {
  repo: DaemonSchedulerAutomationRepo;
  leases: DaemonSchedulerLeasePort;
  auditor: DaemonSchedulerAuditPort;
  dispatch: DaemonSchedulerDispatchPort;
  /**
   * off-peak 仓储。缺省 = 本进程不认领 off-peak（fail-closed，交回 Desktop 回退语义）；
   * 生产装配总是注入真实 `OffPeakTaskRepo`。
   */
  offPeakRepo?: DaemonSchedulerOffPeakRepo;
  /** 让 child 为候选 workspace 建 plane/抢租约（§4.4.4 eager ensure）。 */
  ensureWorkspace(workspaceIdentity: string, workspacePath?: string): Promise<unknown>;
  /**
   * 本 child 对该 workspace 的稳定 ownerId（§2.5 `controlPlaneOwnerId`）。
   * `lease.list` 只认 ownerId 匹配的未过期租约：仅按 expires_at 过滤会在租约易主后
   * （旧 child 心跳未到、新 owner 已持租）仍 claim，造成双 leader 写域库（§0.3/§4.4.4）。
   */
  ownerId(workspaceIdentity: string): string;
  now?: () => number;
  pollIntervalMs?: number;
  misfireGraceMs?: number;
  /**
   * manual claim 心跳间隔；缺省 60s（与 desktop `startManualClaimHeartbeat` 同值）。
   * 必须显著小于 `CLAIM_STALE_MS`（10 分钟），否则长回合会被当僵尸 claim 回收。
   */
  manualClaimHeartbeatMs?: number;
}

export interface DaemonScheduler {
  /** 初始化 repo 并开始轮询；失败原样上浮（不得带病启动）。 */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 单 tick（测试/诊断用）；受 ticking 单飞保护。 */
  tick(now?: number): Promise<void>;
  /**
   * 派发 ACK 结算（桥 `host ACK = dispatched` 语义）。迟到/重复回执按 run 台账
   * `claimed` 状态幂等短路；仓储错误原样抛给上游回执通道（可重投），不吞。
   */
  settleDispatchResult(result: DaemonSchedulerDispatchResult): Promise<void>;
  /**
   * 桥宽限跳过（`skipped`）→ run 台账收敛：scheduled 走 misfire skip（推进 next_run_at），
   * manual 记 failed 并释放 claim。幂等；对账与显式上报共用。
   */
  settleDispatchSkipped(input: { runId: string; reason: string }): Promise<void>;
  /** worker 终态回写：outcome 台账 + manual claim 释放（幂等）。 */
  settleRunTerminal(terminal: DaemonSchedulerRunTerminal): Promise<void>;
  /**
   * `host.command` 投递前守卫：commandId 未命中桥行（trigger 直通）= 恒可投递；
   * 命中时只允许 run 台账 `claimed`（在途重试）或 `dispatched`（幂等重放）。
   * failed_to_dispatch/permanent 后仍留在 pushed 的迟到行不得再执行。
   */
  isHostCommandDeliverable(commandId: string): boolean;
  /**
   * `host.command` 回执 → run 台账结算（ACK=dispatched；非 ACK=failed_to_dispatch 退避）。
   * 非桥命令（commandId 不在 dispatch_requests）返回 null，不做任何写入。
   */
  settleHostCommand(
    ack: DaemonSchedulerHostCommandAck,
  ): Promise<{ runId: string } | null>;
}

function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
  return automation.nextRunAt ?? now;
}

function buildRunId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${scheduledAt}`;
}

/**
 * 本 child 自有的未过期租约集合：既要求 `expiresAt > now`，也要求 `ownerId` 与稳定
 * ownerId 一致。只按过期时间过滤会在租约易主后（旧 child 心跳未到、新 owner 已持租）
 * 继续 claim，违反 §0.3「唯一 leader 写域库」。
 */
function unexpiredWorkspaces(
  leases: LeaseListResult,
  now: number,
  ownerIdOf: (workspaceIdentity: string) => string,
): Set<string> {
  const owned = new Set<string>();
  for (const lease of leases.workspaces) {
    if (lease.expiresAt <= now) continue;
    if (lease.ownerId !== ownerIdOf(lease.workspaceIdentity)) continue;
    owned.add(lease.workspaceIdentity);
  }
  return owned;
}

/**
 * §3.2 `schedule.audit` 幂等键 = runId；payload 只落结构摘要（不落 prompt 原文）。
 * `audit` 失败原样抛给调用方——不得吞掉后继续派发（§4.4「不得无审计直派」）。
 */
function auditInputFor(
  workspaceIdentity: string,
  automation: ZCodeAutomation,
  runId: string,
  scheduledAt: number,
  now: number,
): ScheduleAuditParams {
  return {
    workspaceIdentity,
    domainKey: automation.automationId,
    providerMessageId: runId,
    payloadSummary: { automationId: automation.automationId, runId, scheduledAt },
    now,
  };
}

/**
 * off-peak 审计沿用 §1.2 域键规范的扩展（spec §5.2 实施偏差）：threadKey 域键为
 * `schedule:<offPeakTaskId>`、幂等键为任务稳定 id（重试/再认领收敛单行）。
 */
function offPeakAuditInputFor(
  task: ZCodeOffPeakTask,
  now: number,
): ScheduleAuditParams {
  return {
    workspaceIdentity: task.workspaceKey,
    domainKey: task.offPeakTaskId,
    providerMessageId: task.offPeakTaskId,
    payloadSummary: { offPeakTaskId: task.offPeakTaskId, claimedAt: now },
    now,
  };
}

/** manual claim 心跳间隔缺省（与 desktop `startManualClaimHeartbeat` 同值）。 */
const DEFAULT_MANUAL_CLAIM_HEARTBEAT_MS = 60_000;

export function createDaemonScheduler(options: DaemonSchedulerOptions): DaemonScheduler {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const misfireGraceMs = options.misfireGraceMs ?? DEFAULT_MISFIRE_GRACE_MS;
  const manualClaimHeartbeatMs =
    options.manualClaimHeartbeatMs ?? DEFAULT_MANUAL_CLAIM_HEARTBEAT_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let stopped = false;
  let ticking = false;
  /** 门控失败日志去重：同一错误只在状态翻转时打一次，避免 20s 刷屏。 */
  let lastGateError: string | null = null;
  /** per-workspace ensure 失败日志去重（§2.6 per-plane 故障隔离）。 */
  const workspaceErrorMessages = new Map<string, string>();
  /**
   * manual run 的 claim 心跳：manual ACK 只表示 accepted/queued，claim 要保留到 turn
   * 终态；不续租 claimed_at 会在 CLAIM_STALE_MS（10 分钟）后被僵尸回收，长回合期间
   * 同一 automation 的下一次 cron 可被认领 → single-flight 破坏。键 = automationId +
   * workspaceKey（与 AutomationRepo 的 CAS 维度一致）。
   */
  const manualClaimHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

  function manualClaimKey(automationId: string, workspaceKey: string): string {
    return `${automationId}\u0000${workspaceKey}`;
  }

  function startManualClaimHeartbeat(automationId: string, workspaceKey: string, runId: string): void {
    const key = manualClaimKey(automationId, workspaceKey);
    if (manualClaimHeartbeats.has(key)) return;
    const heartbeat = setInterval(() => {
      void options.repo.touchManualClaim(automationId, workspaceKey).catch((error: unknown) => {
        log.warn("manual claim heartbeat failed", {
          automationId,
          workspaceKey,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, manualClaimHeartbeatMs);
    heartbeat.unref?.();
    manualClaimHeartbeats.set(key, heartbeat);
  }

  function stopManualClaimHeartbeat(automationId: string, workspaceKey: string): void {
    const key = manualClaimKey(automationId, workspaceKey);
    const heartbeat = manualClaimHeartbeats.get(key);
    if (!heartbeat) return;
    clearInterval(heartbeat);
    manualClaimHeartbeats.delete(key);
  }

  /** 返回 child 自报 leader 的 workspace 集合（§4.4.4：只对这些 workspace claim）。 */
  async function ensureCandidateWorkspaces(): Promise<Set<string>> {
    // §4.4.4 workspace 集合两个来源：tasks-index 的 automation + off-peak。bot 绑定
    // 涉及但域库无行的 workspace 由 child 启动期自枚举，不在此处重复。
    const automations = await options.repo.list();
    const workspaces = new Map<string, string | undefined>();
    for (const automation of automations) {
      if (!automation.enabled) continue;
      const workspaceKey = resolveWorkspaceKey({
        workspacePath: automation.workspacePath,
        workspaceIdentity: automation.workspaceIdentity,
      });
      if (!workspaces.has(workspaceKey)) workspaces.set(workspaceKey, automation.workspacePath);
    }
    if (options.offPeakRepo) {
      // 只有 queued 任务可能被 claim；paused/running 不需要为认领做 ensure。
      const offPeakTasks = (await options.offPeakRepo.listNonTerminal()).filter(
        (task) => task.status === "queued",
      );
      for (const task of offPeakTasks) {
        if (!workspaces.has(task.workspaceKey)) {
          workspaces.set(task.workspaceKey, task.workspacePath);
        }
      }
    }
    if (workspaces.size === 0) return new Set();
    const leaders = new Set<string>();
    // §2.6 per-plane 故障隔离：单个 workspace 的 ensure 失败只跳过该 workspace，
    // 其余已证明 leader 的 workspace 继续 claim。只有 repo.list/lease.list 这类全局
    // 读面失败才整 tick 放弃（见 runTick）。
    for (const [workspaceIdentity, workspacePath] of workspaces) {
      try {
        const state = (await options.ensureWorkspace(workspaceIdentity, workspacePath)) as
          | { state?: unknown }
          | undefined;
        if (state?.state === "leader") leaders.add(workspaceIdentity);
        workspaceErrorMessages.delete(workspaceIdentity);
      } catch (error) {
        reportWorkspaceFailure(workspaceIdentity, error);
      }
    }
    return leaders;
  }

  async function handleClaimed(automation: ZCodeAutomation, nowMs: number, leaderWorkspaces: Set<string>): Promise<void> {
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    });
    // §4.4.4：daemon 只 claim child 已 leader 的 workspace；其余释放错开，交给 Desktop
    // Main fork 回退语义（租约过期/child 未就绪时 Desktop 照常 claim）。
    if (!leaderWorkspaces.has(workspaceKey)) {
      await options.repo.releaseClaim(automation.automationId);
      return;
    }

    const scheduledAt = resolveScheduledAt(automation, nowMs);
    const runId = buildRunId(automation.automationId, scheduledAt);
    const isRetry = automation.dispatchAttempts > 0;

    try {
      await options.auditor.audit(auditInputFor(workspaceKey, automation, runId, scheduledAt, nowMs));
    } catch (error) {
      // §4.4：审计失败释放本轮 claim，下一 tick 重试；禁止无审计直派。
      await options.repo.releaseClaim(automation.automationId);
      log.error("schedule audit failed, claim released", {
        automationId: automation.automationId,
        workspaceIdentity: workspaceKey,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // misfire 语义与 desktop scheduler 逐行一致（§4.4.1 沿用）。
    const missed =
      !isRetry && automation.nextRunAt != null && automation.nextRunAt <= nowMs - misfireGraceMs;
    if (missed) {
      const finalize = isOneShotAutomation(automation);
      const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, nowMs);
      await options.repo.skipAndReschedule({
        automationId: automation.automationId,
        runId,
        workspaceKey,
        scheduledAt,
        reason: "computer_asleep_or_app_not_running",
        nextRunAt,
        finalize,
      });
      log.info("skip missed window automation", {
        automationId: automation.automationId,
        scheduledAt,
        finalize,
      });
      return;
    }

    await options.repo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey,
      scheduledAt,
      trigger: "schedule",
      ...(automation.modelSelection ? { modelSelection: automation.modelSelection } : {}),
    });

    // taskId 即 v4 sessionId（task index 与 v4 snapshot 的唯一映射）。未绑定会话的
    // createTask 幂等面尚未接线：这类 run 不能写 pending 行（桥会以
    // dispatch.sessionRequired 拒绝，行停在 pushed 被永续重推），按永久失败结算并暴露。
    const sessionId = automation.targetTaskId ?? null;
    if (sessionId === null) {
      const error =
        "dispatch.sessionRequired: automation 未绑定目标会话（host.worker.createTask 幂等面未接线）";
      await options.repo.markRunDispatch({ runId, dispatchStatus: "failed_to_dispatch", error });
      await options.repo.markDispatchFailed(automation.automationId, {
        failedAt: nowMs,
        error,
        kind: "permanent",
      });
      log.error("automation has no target session; dispatch failed permanently", {
        automationId: automation.automationId,
        workspaceIdentity: workspaceKey,
        runId,
      });
      return;
    }

    try {
      options.dispatch.insert({
        runId,
        workspaceIdentity: workspaceKey,
        sessionId,
        payload: automation.prompt || null,
        now: nowMs,
      });
    } catch (error) {
      // pending 行写不进去 = 本轮没有可消费的派发请求：释放 claim，下一 tick 重试。
      await options.repo.releaseClaim(automation.automationId);
      log.error("pending dispatch insert failed, claim released", {
        automationId: automation.automationId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * manual run（`claimManualRuns` 的崩溃恢复路径）：与定时 run 同走桥。
   * manual 是 automation_runs 的一种 trigger；spec 只把 off-peak 排除在桥外（§7-5），
   * 因此 manual 写 `dispatch_requests.pending_dispatch`，由同一 ACK 结算。
   * 不落 `schedule.audit`：manual 不是 schedule 来源（Desktop manual 路径同样不审计）。
   */
  async function handleClaimedManual(
    claimed: DaemonSchedulerManualRun,
    nowMs: number,
    leaderWorkspaces: Set<string>,
  ): Promise<void> {
    const automation = claimed.automation;
    const runId = claimed.run.runId;
    const workspaceKey = claimed.run.workspaceKey;
    if (!leaderWorkspaces.has(workspaceKey)) {
      // §4.4.4：非 leader 的 workspace 释放 single-flight，交回 Desktop 回退语义
      // （租约过期后 Desktop 按 CLAIM_STALE_MS 再认领，不丢单）。
      await options.repo.releaseManualClaim(automation.automationId, workspaceKey);
      return;
    }
    const sessionId = automation.targetTaskId ?? null;
    if (sessionId === null) {
      const error =
        "dispatch.sessionRequired: manual run 未绑定目标会话（host.worker.createTask 幂等面未接线）";
      await options.repo.markRunDispatch({ runId, dispatchStatus: "failed_to_dispatch", error });
      await options.repo.releaseManualClaim(automation.automationId, workspaceKey);
      log.error("manual run has no target session; dispatch failed", {
        automationId: automation.automationId,
        workspaceKey,
        runId,
      });
      return;
    }
    try {
      options.dispatch.insert({
        runId,
        workspaceIdentity: workspaceKey,
        sessionId,
        payload: automation.prompt || null,
        now: nowMs,
      });
    } catch (error) {
      await options.repo.releaseManualClaim(automation.automationId, workspaceKey);
      log.error("manual pending dispatch insert failed, claim released", {
        automationId: automation.automationId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * off-peak（§4.4.5）：claim → `schedule.audit` → 顺延（releaseClaim，不记失败）。
   * - 不进 `dispatch_requests` 桥（trigger-subsystem-spec §7-5 已裁决）。
   * - ticket 顺延语义 = 错过窗口不丢弃（off-peak decisions D9）：释放认领后任务仍
   *   `queued`，attempt_count 不增，下一 tick / Desktop 回退可再认领。
   * - 本进程不标记 running/terminal：off-peak 执行（ticket 鉴权 + 会话派发）在本 daemon
   *   没有 host 派发面，claim 只承担审计与顺延；执行仍归 host（见交付说明）。
   */
  async function handleOffPeakClaimed(
    task: ZCodeOffPeakTask,
    nowMs: number,
    leaderWorkspaces: Set<string>,
  ): Promise<void> {
    const offPeakRepo = options.offPeakRepo;
    if (!offPeakRepo) return;
    if (!leaderWorkspaces.has(task.workspaceKey)) {
      await offPeakRepo.releaseClaim(task.offPeakTaskId, { now: nowMs });
      return;
    }
    try {
      // 审计失败也必须释放认领：§4.4「不得无审计直派」，下一 tick 重试。
      await options.auditor.audit(offPeakAuditInputFor(task, nowMs));
    } catch (error) {
      await offPeakRepo.releaseClaim(task.offPeakTaskId, { now: nowMs });
      log.error("off-peak schedule audit failed, claim released", {
        offPeakTaskId: task.offPeakTaskId,
        workspaceIdentity: task.workspaceKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    // 顺延：ticket/queued 序保持，不写 skip、不计失败、不进桥。
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now: nowMs });
  }

  /** 结算正在处理的 runId → 共享 promise：同 run 的并发/重复回执只走一次台账写入。 */
  const settlingRuns = new Map<string, Promise<void>>();

  /**
   * 派发 ACK 结算（桥状态机 `host ACK → dispatched` 的 Core 台账对应面）。
   *
   * 幂等边界 = run 台账 `dispatch_status === "claimed"`：`dispatched`（重复 ACK）与
   * `failed_to_dispatch`（重复失败）都短路；重试认领会把同一 runId 重置回 `claimed`，
   * 因此不会误吞下一轮的回执。run 已删除（清理/迟到）不复活，只记日志。
   *
   * 仓储错误原样抛给上游回执通道（可重投），不吞、不猜。
   */
  async function settleDispatchResult(result: DaemonSchedulerDispatchResult): Promise<void> {
    const runId = result.runId;
    if (!runId) throw new Error("dispatch result requires runId");
    // 重复回执与首次结算并发时共享同一 promise：两个调用方看到同一结果，
    // 不会出现「先到的失败、后到的返回成功」导致台账丢失。
    const inFlight = settlingRuns.get(runId);
    if (inFlight) {
      await inFlight;
      return;
    }
    const settlement = settleDispatchResultOnce(result);
    settlingRuns.set(runId, settlement);
    try {
      await settlement;
    } finally {
      settlingRuns.delete(runId);
    }
  }

  async function settleDispatchResultOnce(result: DaemonSchedulerDispatchResult): Promise<void> {
    const runId = result.runId;
    const run = await options.repo.getRun(runId);
    if (!run) {
      log.warn("dispatch result ignored: run not found (deleted or cleaned up)", { runId });
      return;
    }
    if (run.dispatchStatus !== "claimed") {
      log.info("dispatch result ignored: run already settled (late/duplicate ACK)", {
        runId,
        dispatchStatus: run.dispatchStatus,
      });
      return;
    }
    // trigger 以 run 台账为准（runId 唯一映射一行；不接受回执侧覆盖）。
    const trigger = run.trigger;
    const automationId = run.automationId;
    const workspaceKey = run.workspaceKey;
    const settledAt = now();
    if (result.ok) {
      if (trigger === "manual") {
        const marked = await options.repo.markManualRunDispatched({
          runId,
          sessionId: result.sessionId ?? null,
          dispatchedAt: settledAt,
        });
        // manual claim 保留到 turn 终态（host ACK 只表示 accepted/queued）。
        // 长回合期间必须续租 claimed_at，否则 CLAIM_STALE_MS 回收后同一 automation
        // 的下一次 cron 会与在跑回合并发。
        if (marked) startManualClaimHeartbeat(automationId, workspaceKey, runId);
        return;
      }
      await options.repo.markRunDispatch({
        runId,
        dispatchStatus: "dispatched",
        sessionId: result.sessionId ?? null,
      });
      const automation = await options.repo.get(automationId);
      const nextRunAt = automation ? computeAutomationNextRunAt(automation, settledAt) : null;
      await options.repo.markDispatched(automationId, {
        dispatchedAt: settledAt,
        nextRunAt,
      });
      return;
    }

    const error = result.error ?? "dispatch failed";
    await options.repo.markRunDispatch({
      runId,
      dispatchStatus: "failed_to_dispatch",
      error,
    });
    if (trigger === "manual") {
      stopManualClaimHeartbeat(automationId, workspaceKey);
      await options.repo.releaseManualClaim(automationId, workspaceKey);
      return;
    }
    const automation = await options.repo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, settledAt) : null;
    await options.repo.markDispatchFailed(automationId, {
      failedAt: settledAt,
      error,
      kind: result.failureKind ?? "transient",
      nextRunAt,
    });
  }

  /**
   * 桥宽限跳过（`dispatch_requests.status = 'skipped'`）→ run 台账收敛。
   * 桥的 sweep 只 CAS 桥行，不回调 Core（§1.6 skipped 由宽限定时器触发）；若不收敛：
   * run 永久 claimed，下一 tick 仍以同 runId 重认领，audit 幂等空转、insert 命中
   * skipped 行 no-op —— 与 host 是否在线无关的永久停摆。
   */
  async function settleDispatchSkipped(input: {
    runId: string;
    reason: string;
  }): Promise<void> {
    const run = await options.repo.getRun(input.runId);
    if (!run) {
      log.warn("skipped dispatch ignored: run not found (deleted or cleaned up)", {
        runId: input.runId,
      });
      return;
    }
    if (run.dispatchStatus !== "claimed") {
      // dispatched / failed / skipped 的重放幂等短路。
      return;
    }
    const settledAt = now();
    if (run.trigger === "manual") {
      const error = `dispatch skipped: ${input.reason}`;
      await options.repo.markRunDispatch({
        runId: run.runId,
        dispatchStatus: "failed_to_dispatch",
        error,
      });
      stopManualClaimHeartbeat(run.automationId, run.workspaceKey);
      await options.repo.releaseManualClaim(run.automationId, run.workspaceKey);
      return;
    }
    const automation = await options.repo.get(run.automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, settledAt) : null;
    await options.repo.skipAndReschedule({
      automationId: run.automationId,
      runId: run.runId,
      workspaceKey: run.workspaceKey,
      scheduledAt: run.scheduledAt ?? null,
      reason: `dispatch_skipped:${input.reason}`,
      nextRunAt,
      finalize: automation ? isOneShotAutomation(automation) : false,
    });
  }

  /**
   * `host.command` 投递前守卫。桥行存在时，run 只有处于 claimed（在途交付/重试）或
   * dispatched（重复 ACK 幂等重放）才允许投递；permanent 失败后桥仍会以同 commandId
   * 续推 pushed 行，若不拒绝，迟到的 host 接受会让已放弃的 automation 执行。
   * 非桥命令（trigger 直通）没有行，恒可投递。
   */
  function isHostCommandDeliverable(commandId: string): boolean {
    const row = options.dispatch.findByCommandId?.(commandId);
    if (!row) return true;
    return row.runDispatchStatus === "claimed" || row.runDispatchStatus === "dispatched";
  }

  /**
   * `host.command` 回执 → run 台账。ACK（accepted/duplicate）结算 dispatched；
   * 其余状态（rejected/stale/noop/failed）不是桥 ACK（桥行保持 pushed 续推），但
   * run 台账必须记 failed_to_dispatch 并进入退避——否则失败路径没有生产生产者。
   * 非桥命令（trigger 直通）不命中 dispatch_requests，返回 null 零写入。
   */
  async function settleHostCommand(
    ack: DaemonSchedulerHostCommandAck,
  ): Promise<{ runId: string } | null> {
    const row = options.dispatch.findByCommandId?.(ack.commandId);
    if (!row) return null;
    if (ack.status === "accepted" || ack.status === "duplicate") {
      await settleDispatchResult({ runId: row.runId, ok: true, sessionId: ack.sessionId });
      return { runId: row.runId };
    }
    await settleDispatchResult({
      runId: row.runId,
      ok: false,
      error: `host.command ${ack.status}${ack.reasonCode ? `: ${ack.reasonCode}` : ""}`,
    });
    return { runId: row.runId };
  }

  /**
   * worker 终态回写：`automation_runs.outcome` + manual claim 释放。
   * 重复/迟到终态幂等（markRunOutcome 覆写同值、releaseManualClaim CAS running=1）。
   */
  async function settleRunTerminal(terminal: DaemonSchedulerRunTerminal): Promise<void> {
    const run = await options.repo.getRun(terminal.runId);
    if (!run) {
      log.warn("run terminal ignored: run not found (deleted or cleaned up)", {
        runId: terminal.runId,
      });
      return;
    }
    await options.repo.markRunOutcome(terminal.runId, terminal.outcome, terminal.error);
    if (run.trigger === "manual") {
      stopManualClaimHeartbeat(run.automationId, run.workspaceKey);
      await options.repo.releaseManualClaim(run.automationId, run.workspaceKey);
    }
  }

  /**
   * 对账：桥行已终态但 run 台账仍 claimed。`dispatched` 行由 host ACK 直接结算（本路径
   * 覆盖 Core 崩溃/回执丢失后的收敛）；`skipped` 行由此收敛（见 settleDispatchSkipped）。
   * 逐行错误隔离：单行失败不阻塞同 tick 其他行，下一 tick 重试。
   */
  async function reconcileDispatchTerminals(): Promise<void> {
    const rows = options.dispatch.listTerminalClaimedRuns?.() ?? [];
    for (const row of rows) {
      try {
        if (row.status === "dispatched") {
          await settleDispatchResult({
            runId: row.runId,
            ok: true,
            sessionId: row.sessionId,
          });
        } else {
          await settleDispatchSkipped({
            runId: row.runId,
            reason: row.skipReason ?? "no_dispatcher",
          });
        }
      } catch (error) {
        log.error("dispatch terminal reconciliation failed", {
          runId: row.runId,
          status: row.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function runTick(nowMs: number): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      // 桥行终态对账不依赖租约/RPC：Core 崩溃后重启也要收敛（dispatched/skipped），
      // 因此放在 gate 读取之前，避免 RPC 不可达时 run 台账永久卡在 claimed。
      await reconcileDispatchTerminals();
      let ensuredLeaders: Set<string>;
      try {
        ensuredLeaders = await ensureCandidateWorkspaces();
      } catch (error) {
        // 只剩 repo.list（tasks-index 全局读面）会走到这里；per-workspace ensure 已隔离。
        reportGateFailure("automation.list", error);
        return;
      }
      let leases: LeaseListResult;
      try {
        leases = await options.leases.list();
      } catch (error) {
        // RPC 不可达/child 未 ready：daemon 内 fail-closed，本 tick 不 claim（与 Desktop
        // 回退语义不同：Desktop 在心跳不可见时照常 claim，daemon 不能）。
        reportGateFailure("lease.list", error);
        return;
      }
      lastGateError = null;
      // 两道证据同时成立才 claim：child 自报 leader（ensure 结果）+ 未过期租约可见。
      // 任一缺失都可能是 follower/熔断/过期，交回 Desktop Main fork。
      const leasedWorkspaces = unexpiredWorkspaces(leases, nowMs, options.ownerId);
      const leaderWorkspaces = new Set(
        [...ensuredLeaders].filter((workspace) => leasedWorkspaces.has(workspace)),
      );
      const claimed = await options.repo.claimDue(nowMs);
      for (const automation of claimed) {
        try {
          await handleClaimed(automation, nowMs, leaderWorkspaces);
        } catch (error) {
          // 单行处理异常不得阻塞同 tick 的其他 automation；释放 claim，下一 tick 重试。
          // （audit/insert 已在 handleClaimed 内部释放；这里覆盖 upsert/skip 异常。）
          await options.repo.releaseClaim(automation.automationId).catch(() => undefined);
          log.error("daemon scheduler claim handling failed, claim released", {
            automationId: automation.automationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // manual run 的唤醒可能与当前 tick 重叠；单飞 claim 已由 DB running 锁吸收。
      const manualRuns = await options.repo.claimManualRuns(nowMs);
      for (const manualRun of manualRuns) {
        try {
          await handleClaimedManual(manualRun, nowMs, leaderWorkspaces);
        } catch (error) {
          await options.repo
            .releaseManualClaim(manualRun.automation.automationId, manualRun.run.workspaceKey)
            .catch(() => undefined);
          log.error("daemon scheduler manual claim handling failed, claim released", {
            automationId: manualRun.automation.automationId,
            runId: manualRun.run.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // off-peak：只 claim + 审计 + 顺延，不进桥（§4.4.5）。
      if (options.offPeakRepo) {
        const offPeakClaimed = await options.offPeakRepo.claimDue(nowMs);
        for (const task of offPeakClaimed) {
          try {
            await handleOffPeakClaimed(task, nowMs, leaderWorkspaces);
          } catch (error) {
            await options.offPeakRepo
              .releaseClaim(task.offPeakTaskId, { now: nowMs })
              .catch(() => undefined);
            log.error("daemon scheduler off-peak claim handling failed, claim released", {
              offPeakTaskId: task.offPeakTaskId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } finally {
      ticking = false;
    }
  }

  function reportGateFailure(stage: string, error: unknown): void {
    const message = `${stage}: ${error instanceof Error ? error.message : String(error)}`;
    if (message === lastGateError) return;
    lastGateError = message;
    log.warn("daemon scheduler gate unavailable; skipping claim (fail-closed)", { message });
  }

  function reportWorkspaceFailure(workspaceIdentity: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (workspaceErrorMessages.get(workspaceIdentity) === message) return;
    workspaceErrorMessages.set(workspaceIdentity, message);
    log.warn("workspace.ensure failed; skipping this workspace only (per-plane isolation)", {
      workspaceIdentity,
      message,
    });
  }

  return {
    async start() {
      if (started) return;
      await options.repo.ensureReady();
      await options.offPeakRepo?.ensureReady();
      // 写面可用性在启动期校验：tasks-index 未迁移 = 响亮失败，不带病进入轮询。
      options.dispatch.verify?.();
      started = true;
      // 立即 tick 一次（与 desktop scheduler 一致），随后按间隔轮询。
      void runTick(now()).catch((error: unknown) => {
        log.error("daemon scheduler initial tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      timer = setInterval(() => {
        void runTick(now()).catch((error: unknown) => {
          log.error("daemon scheduler tick failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, pollIntervalMs);
      // Core 进程还有 HTTP/heartbeat 句柄；scheduler 定时器不应单独阻止进程收口。
      timer.unref?.();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      started = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const heartbeat of manualClaimHeartbeats.values()) clearInterval(heartbeat);
      manualClaimHeartbeats.clear();
      // 等在途 tick / ACK 结算收尾后关闭句柄，避免关库后仍有 INSERT/UPDATE。
      while (ticking || settlingRuns.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      try {
        options.repo.close?.();
      } catch {
        // 收口路径尽力而为；未关闭由进程退出兜底。
      }
      try {
        options.offPeakRepo?.close?.();
      } catch {
        // 同上，尽力而为。
      }
      options.dispatch.close();
    },
    async tick(nowMs?: number) {
      await runTick(nowMs ?? now());
    },
    settleDispatchResult,
    settleDispatchSkipped,
    settleRunTerminal,
    isHostCommandDeliverable,
    settleHostCommand,
  };
}

export interface ProductionDaemonSchedulerOptions {
  repo: DaemonSchedulerAutomationRepo;
  leases: DaemonSchedulerLeasePort;
  auditor: DaemonSchedulerAuditPort;
  /** off-peak 仓储（真实 OffPeakTaskRepo）；缺省 = 不认领 off-peak。 */
  offPeakRepo?: DaemonSchedulerOffPeakRepo;
  tasksIndexDatabasePath: string;
  /** child 的 serverRoot：稳定 ownerId 的输入（§2.5 `controlPlaneOwnerId`）。 */
  serverRoot: string;
  ensureWorkspace(workspaceIdentity: string, workspacePath?: string): Promise<unknown>;
  now?: () => number;
  manualClaimHeartbeatMs?: number;
}

/** 真实文件端口的装配（core.ts 只在部署门禁打开时调用）。 */
export function createProductionDaemonScheduler(
  options: ProductionDaemonSchedulerOptions,
): DaemonScheduler {
  const writer: PendingDispatchWriter = createPendingDispatchWriter({
    databasePath: options.tasksIndexDatabasePath,
    ...(options.now ? { now: options.now } : {}),
  });
  return createDaemonScheduler({
    repo: options.repo,
    leases: options.leases,
    auditor: options.auditor,
    ...(options.offPeakRepo ? { offPeakRepo: options.offPeakRepo } : {}),
    ensureWorkspace: options.ensureWorkspace,
    ownerId: (workspaceIdentity) => controlPlaneOwnerId(options.serverRoot, workspaceIdentity),
    dispatch: {
      verify: () => writer.verify(),
      insert: (input) => writer.insert(input),
      findByCommandId: (commandId) => writer.findByCommandId(commandId),
      listTerminalClaimedRuns: () => writer.listTerminalClaimedRuns(),
      close: () => writer.close(),
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.manualClaimHeartbeatMs !== undefined
      ? { manualClaimHeartbeatMs: options.manualClaimHeartbeatMs }
      : {}),
  });
}
