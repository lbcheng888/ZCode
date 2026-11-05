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
 * 6. 写 `dispatch_requests.pending_dispatch`（session_id = targetTaskId；未绑定会话为 null）。
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
 */
import {
  computeAutomationNextRunAt,
  createServiceLogger,
  isOneShotAutomation,
} from "@zcode/services/node";
import {
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationTrigger,
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

export interface DaemonSchedulerAutomationRepo {
  ensureReady(): Promise<void>;
  list(): Promise<ZCodeAutomation[]>;
  claimDue(now: number): Promise<ZCodeAutomation[]>;
  releaseClaim(automationId: string): Promise<void>;
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
  close(): void;
}

export interface DaemonSchedulerOptions {
  repo: DaemonSchedulerAutomationRepo;
  leases: DaemonSchedulerLeasePort;
  auditor: DaemonSchedulerAuditPort;
  dispatch: DaemonSchedulerDispatchPort;
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
}

export interface DaemonScheduler {
  /** 初始化 repo 并开始轮询；失败原样上浮（不得带病启动）。 */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 单 tick（测试/诊断用）；受 ticking 单飞保护。 */
  tick(now?: number): Promise<void>;
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

export function createDaemonScheduler(options: DaemonSchedulerOptions): DaemonScheduler {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const misfireGraceMs = options.misfireGraceMs ?? DEFAULT_MISFIRE_GRACE_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let stopped = false;
  let ticking = false;
  /** 门控失败日志去重：同一错误只在状态翻转时打一次，避免 20s 刷屏。 */
  let lastGateError: string | null = null;
  /** per-workspace ensure 失败日志去重（§2.6 per-plane 故障隔离）。 */
  const workspaceErrorMessages = new Map<string, string>();

  /** 返回 child 自报 leader 的 workspace 集合（§4.4.4：只对这些 workspace claim）。 */
  async function ensureCandidateWorkspaces(): Promise<Set<string>> {
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

    try {
      options.dispatch.insert({
        runId,
        workspaceIdentity: workspaceKey,
        // taskId 即 v4 sessionId（task index 与 v4 snapshot 的唯一映射）；未绑定会话的
        // createTask 面尚未接线，null 行由 bridge 响亮拒绝，不做猜测。
        sessionId: automation.targetTaskId ?? null,
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

  async function runTick(nowMs: number): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
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
      // 等在途 tick 收尾后关闭句柄，避免关库后仍有 INSERT。
      while (ticking) await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        options.repo.close?.();
      } catch {
        // 收口路径尽力而为；未关闭由进程退出兜底。
      }
      options.dispatch.close();
    },
    async tick(nowMs?: number) {
      await runTick(nowMs ?? now());
    },
  };
}

export interface ProductionDaemonSchedulerOptions {
  repo: DaemonSchedulerAutomationRepo;
  leases: DaemonSchedulerLeasePort;
  auditor: DaemonSchedulerAuditPort;
  tasksIndexDatabasePath: string;
  /** child 的 serverRoot：稳定 ownerId 的输入（§2.5 `controlPlaneOwnerId`）。 */
  serverRoot: string;
  ensureWorkspace(workspaceIdentity: string, workspacePath?: string): Promise<unknown>;
  now?: () => number;
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
    ensureWorkspace: options.ensureWorkspace,
    ownerId: (workspaceIdentity) => controlPlaneOwnerId(options.serverRoot, workspaceIdentity),
    dispatch: {
      verify: () => writer.verify(),
      insert: (input) => writer.insert(input),
      close: () => writer.close(),
    },
    ...(options.now ? { now: options.now } : {}),
  });
}
