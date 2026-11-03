// 常驻 cron scheduler 进程：由 desktop main 通过 electronUtilityProcess.fork 拉起。
// 职责（tasks-index 属主方案）：
//   - 轮询 tasks-index 的 automations，事务认领到期任务（AutomationRepo.claimDue：BEGIN IMMEDIATE + running 0→1）
//   - 轮询 automation_runs 里的 manual run，手动触发累计 run_count，但不推进 next_run_at / max_runs / lifecycle
//   - 维护派发状态机：misfire 跳过、single-flight 认领、成功结算、失败退避重试
//   - §5.3 仲裁门控：按 workspace 检查 control_plane_leases 未过期租约——本 workspace
//     有租约则释放认领跳过（归控制面 scheduler），无租约照常认领（不再任一租约全局暂停）
//   - §5.2：非回退（心跳可见）时认领成功幂等落 trigger_events 审计行（cron + off-peak）；
//     回退期（心跳不可见）纯 legacy 不落。桥行（dispatch_requests pending）在桥循环
//     生产接线前不写（spec §5.2 实施偏差，禁 pending+直派双写）；off-peak 不进桥（裁定 5）
//   - 把到期任务的派发请求发回 main（main 再翻译成 CronRun 转给 workspace host 执行 createTask+sendPrompt）
//   - 收到 main 回报后结算 automation + automation_runs
//   - 闲时任务（off_peak_tasks）：启动回收中断任务，认领 schedulable=1 的 queued 任务派发；
//     与 automation 表/消息/常量全部独立，⚠ 无 misfire-skip 语义（顺延不丢弃）
// 本进程只读写 tasks-index，不碰 UI / agent runtime；createTask 由 host 域执行。
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AutomationRepo,
  computeAutomationNextRunAt,
  getAppConfigDir,
  isOneShotAutomation,
  OffPeakTaskRepo,
} from "@zcode/services/node";
import {
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationRun,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import type { MainToSchedulerMessage, SchedulerToMainMessage } from "./schedulerProtocol.js";
import { settleManualClaimForDispatchResult } from "./manualClaimRelease.js";
import { settleOffPeakDispatchResult } from "./offPeakDispatchSettlement.js";
import {
  startSchedulerResourceTelemetry,
  type SchedulerResourceTelemetry,
} from "./schedulerResourceTelemetry.js";

// tsup/esbuild 会把动态 import("node:sqlite") 改写成 import("sqlite")（同
// chromeCookieManager 注释）；与 services 的 Repo 一样经 createRequire 拿内置驱动。
const sqliteRequire = createRequire(import.meta.url);
const { DatabaseSync } = sqliteRequire("node:sqlite") as typeof import("node:sqlite");
type SqliteDatabase = InstanceType<typeof DatabaseSync>;

/** 轮询间隔：cron 最小粒度是分钟，20s 轮询足以按时命中且开销低。 */
const POLL_INTERVAL_MS = 20_000;
/**
 * misfire 宽限：next_run_at 早于 now 超过该值，视为「关机/休眠/退出期间错过的窗口」→ 记 skipped 不补跑。
 * 取值需明显大于一次正常轮询延迟（避免把正常到点误判成 misfire），又能覆盖短暂卡顿。
 */
const MISFIRE_GRACE_MS = 5 * 60_000;

/** 租约/审计读写的第二连接忙等上限（与 AutomationRepo 启动缺省一致）。 */
const BRIDGE_STORE_BUSY_TIMEOUT_MS = 5_000;

const { parentPort } = process;

type InFlight = {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
};

const repo = new AutomationRepo();
/** runId → 在途派发上下文；等 main 回报后结算。scheduler 重启丢失时靠 claimDue 的僵尸回收兜底。 */
const inFlight = new Map<string, InFlight>();

// ---- 闲时任务（off-peak）----
const offPeakRepo = new OffPeakTaskRepo();
/** 进程内退避表：offPeakTaskId → 下次允许派发时间/已失败次数。scheduler 重启即重置，无害。 */
const offPeakRetryAt = new Map<string, number>();
const offPeakRetryAttempts = new Map<string, number>();
/** 在途派发集合：仅用于退出时释放认领；迟到结果凭 offPeakTaskId 即可结算，不依赖它。 */
const offPeakInFlight = new Set<string>();

let ticking = false;
let tickRequested = false;
let schedulerReady = false;
let disposed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** 资源遥测：本进程唯一的自采定时器。 */
let resourceTelemetry: SchedulerResourceTelemetry | null = null;
/** §5.3 门控态签名（排序后的已租约 workspace 集合）：仅在翻转时打日志，避免 20s 轮询刷屏。 */
let lastGateSignature = "";

function log(level: "info" | "warn" | "error", message: string): void {
  const msg: SchedulerToMainMessage = { type: "scheduler-log", level, message };
  parentPort?.postMessage(msg);
  // 兜底：parentPort 不可用（非 utilityProcess 调试运行）时仍留痕。
  if (!parentPort) {
    // eslint-disable-next-line no-console -- scheduler 调试兜底
    console[level === "error" ? "error" : "log"](`[scheduler] ${message}`);
  }
}

// ---- spec §5.3 per-workspace 仲裁门控 + §5.2 审计落行（ws7-dispatch-bridge）----

/**
 * super-agent 域库路径：{dataBaseDir}/.zcode/v2/super-agent.sqlite（spec §1.1/§7-6）。
 * 与 bootstrap getSuperAgentDatabasePath(getDataBaseDir()) 同语义：Desktop 生产启动
 * 必经 setDataBaseDir，本进程经 services getAppConfigDir()（= setDataBaseDir → env →
 * HOME）解析即同根。@zcode/desktop 不依赖 @zcode/bootstrap，不能直接 import 那个
 * getter——跨包路径收口接缝登记在 ws7 交付说明（不改对方文件）。
 */
function resolveSuperAgentDatabasePath(): string {
  return join(getAppConfigDir(), "super-agent.sqlite");
}

/** 按路径缓存的第二连接（AutomationRepo / OffPeakTaskRepo 各自持有自己的句柄，不暴露）。 */
const superAgentStores = new Map<string, SqliteDatabase>();

function openCachedStore(cache: Map<string, SqliteDatabase>, path: string): SqliteDatabase {
  let db = cache.get(path);
  if (!db) {
    db = new DatabaseSync(path);
    db.exec(`pragma busy_timeout = ${BRIDGE_STORE_BUSY_TIMEOUT_MS}`);
    cache.set(path, db);
  }
  return db;
}

/**
 * 探测控制面域库：文件不存在或 trigger_events 表未建（首迁未跑）= 控制面从未运行，
 * 返回 null。**不创建空库**：缺文件时直接返回，避免凭空造出无表的 super-agent.sqlite。
 * 回退/非回退的判定不在这里——由 readControlPlaneGate 的租约集合给出（与 §5.3 心跳同源）。
 */
function probeSuperAgentDomainStore(path: string): SqliteDatabase | null {
  if (!existsSync(path)) return null;
  const db = openCachedStore(superAgentStores, path);
  const table = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'trigger_events'")
    .get();
  return table ? db : null;
}

export interface SchedulerControlPlaneGate {
  /** 域库连接；null = 控制面从未运行（域库/首迁缺失）。 */
  store: SqliteDatabase | null;
  /** 未过期 control_plane_leases 的 workspace_identity 集合（§1.8 per-workspace 主键）。 */
  leasedWorkspaces: Set<string>;
}

/**
 * §5.3 仲裁门控读取：一次范围查返回全部未过期租约的 workspace（供 tick 每轮调用，
 * 路径存在性检查 + 小表扫描，开销可忽略）。两个用途同源（spec §5.2 实施偏差）：
 * - leasedWorkspaces 非空 = daemon leader 心跳可见 = 非回退期 → 可落 trigger_events 审计行；
 * - 集合内的 workspace 认领归控制面 scheduler，Main fork 逐行释放跳过（不再任一租约
 *   全局暂停——租约按 workspace 主键，全局暂停会把控制面未领导的 workspace 一起冻结）。
 * 空集（含域库不可用）= 心跳不可见 = 回退期：纯 legacy（不落审计、照常认领）。
 * 注：本进程只作为 Main fork 运行；daemon 内 scheduler（里程碑 B 迁入本文件）接线时
 * 需按 owner_id 跳过自身租约，该接缝随迁移批处理（spec §5.3 实施偏差）。
 */
export function readControlPlaneGate(options?: {
  now?: number;
  databasePath?: string;
}): SchedulerControlPlaneGate {
  const now = options?.now ?? Date.now();
  const store = probeSuperAgentDomainStore(options?.databasePath ?? resolveSuperAgentDatabasePath());
  if (!store) return { store: null, leasedWorkspaces: new Set() };
  const rows = store
    .prepare("select workspace_identity from control_plane_leases where expires_at > ?")
    .all(now) as Array<{ workspace_identity: string }>;
  return { store, leasedWorkspaces: new Set(rows.map((row) => row.workspace_identity)) };
}

/**
 * §5.2 审计门（与 §5.3 心跳同源）：非回退（任一未过期租约可见）才落 trigger_events
 * 审计行；回退期（心跳不可见，含控制面曾运行后崩溃、租约过期）纯 legacy 不落。
 * 类型谓词：通过后 gate.store 可直接当连接用。
 */
export function shouldWriteScheduleAudit(
  gate: SchedulerControlPlaneGate,
): gate is SchedulerControlPlaneGate & { store: SqliteDatabase } {
  return gate.store !== null && gate.leasedWorkspaces.size > 0;
}

/** 门控翻转日志用：workspace 集合摘要（最多列 5 个，避免多 workspace 时刷屏）。 */
function describeWorkspaceSet(workspaces: Set<string>): string {
  const names = [...workspaces].sort();
  const shown = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${shown} +${names.length - 5} more` : shown;
}

export interface ScheduleTriggerAuditInput {
  workspaceIdentity: string;
  /** §1.2 schedule 域键 → thread_key = schedule:<domainKey>（cron=automationId；off-peak=offPeakTaskId）。 */
  domainKey: string;
  /** provider_message_id 幂等键（§5.2）：cron=runId；off-peak=offPeakTaskId（任务稳定键，重试收敛单行）。 */
  providerMessageId: string;
  /** payload 结构摘要（不落 prompt；trigger=schedule 由函数补，§0：原文不落日志/库面）。 */
  payloadSummary: Record<string, string | number>;
  now: number;
}

/**
 * trigger_events 审计行（spec §5.2，audit-only）：source=schedule、provider=scheduler、
 * provider_message_id=providerMessageId（幂等键，UNIQUE(provider, provider_message_id) 权威）、
 * thread_key=schedule:<domainKey>、fast_path=NULL、adjudication_status=NULL——仅
 * intake/审计层，不进三边路由、不进攒批、不产 would-accept。payload 只落结构摘要，
 * 不落 prompt 原文。返回 true=新行；false=同幂等键已有行（幂等短路，零新增）。
 * 落行门 = shouldWriteScheduleAudit（§5.2 实施偏差：回退期纯 legacy 不落）。
 *
 * 注：intake 是 trigger_events 唯一 ingest 写入点，schedule 审计行按 §5.2 由 scheduler
 * 落；intake 侧窄审计函数（若后续收敛为单一 import）就位前，本函数按 spec 行形状直写，
 * 接缝登记在 ws7 交付说明。
 */
export function recordScheduleTriggerAudit(
  db: SqliteDatabase,
  input: ScheduleTriggerAuditInput,
): boolean {
  const payload = JSON.stringify({
    ...input.payloadSummary,
    trigger: "schedule",
  });
  const digest = createHash("sha256").update(payload).digest("hex");
  const result = db
    .prepare(
      `insert into trigger_events (
        id, workspace_identity, source, thread_key, actor_kind, actor_id,
        payload, payload_digest, taint, provider, provider_message_id,
        fast_path, adjudication_status, final_disposition, settled_at, created_at, updated_at
      ) values (?, ?, 'schedule', ?, 'system', 'scheduler', ?, ?, 1, 'scheduler', ?,
        NULL, NULL, NULL, NULL, ?, ?)
      on conflict do nothing`,
    )
    .run(
      randomUUID(),
      input.workspaceIdentity,
      `schedule:${input.domainKey}`,
      payload,
      digest,
      input.providerMessageId,
      input.now,
      input.now,
    );
  return Number(result.changes) > 0;
}

export interface PendingDispatchInsertInput {
  runId: string;
  workspaceIdentity: string;
  /** 派发载荷（prompt/摘要，§1.6）；桥 push 用它，不回读 automations。 */
  payload: string | null;
  now: number;
}

/**
 * 认领成功后写 dispatch_requests pending_dispatch 行（spec §1.6/§3.2）：
 * commandId = hash(runId)（崩溃重投同键，CommandInbox 幂等吸收）。幂等：同 runId
 * 重复写返回既有行（created=false），零新增。写入方 = scheduler claim 侧；状态机
 * 转移（push/ACK/skipped）唯一写者 = super-agent-trigger 派发桥（跨进程 CAS）。
 *
 * 【spec §5.2 实施偏差 ws7】桥循环（push/sweep/resumePendingAfterBoot）生产接线前，
 * 本函数不在 tick 生产路径调用：无 push/ACK/sweeper 的 pending 行只会无限堆积，
 * 且日后接 push 不停用直派 = 同 run 双执行。桥批接线时原子切换（停直派 + 调本函数
 * + push/sweep），禁止长期双写。dispatch_policy 缺省 in_window；durable_wait 读点
 * （features.durableSchedulerDispatch）随该接线批接入 fork env，见交付 outOfScopeNotes。
 */
export function insertPendingDispatchRequest(
  db: SqliteDatabase,
  input: PendingDispatchInsertInput,
): { requestId: string; commandId: string; created: boolean } {
  const commandId = createHash("sha256").update(input.runId).digest("hex");
  const requestId = randomUUID();
  const result = db
    .prepare(
      `insert into dispatch_requests (
        id, run_id, command_id, workspace_identity, session_id, payload,
        status, skip_reason, dispatch_policy, attempts,
        claimed_at, pushed_at, acked_at, settled_at, created_at, updated_at
      ) values (?, ?, ?, ?, NULL, ?, 'pending_dispatch', NULL, 'in_window', 0, ?, NULL, NULL, NULL, ?, ?)
      on conflict do nothing`,
    )
    .run(requestId, input.runId, commandId, input.workspaceIdentity, input.payload, input.now, input.now, input.now);
  if (Number(result.changes) > 0) return { requestId, commandId, created: true };
  const existing = db
    .prepare("select id, command_id from dispatch_requests where run_id = ?")
    .get(input.runId) as { id: string; command_id: string } | undefined;
  if (!existing) {
    // on conflict do nothing 后必须能回读；回读不到 = 驱动/约束异常，响亮失败。
    throw new Error(`dispatch_requests 行在幂等短路后消失: ${input.runId}`);
  }
  return { requestId: existing.id, commandId: String(existing.command_id), created: false };
}

/** 派发时间戳：优先用 next_run_at（重试期间不变，保证 runId 稳定），退到 retry_at / now。 */
function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
  return automation.nextRunAt ?? automation.retryAt ?? now;
}

function buildRunId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${scheduledAt}`;
}

async function tick(): Promise<void> {
  if (disposed || !schedulerReady || ticking) return;
  ticking = true;
  try {
    do {
      tickRequested = false;
      try {
        const now = Date.now();
        // §5.3 per-workspace 仲裁门控：读未过期租约集合（与 §5.2 审计门同源）。不再
        // 「任一租约全局暂停」——租约按 workspace 主键，全局暂停会连带冻结控制面未领导
        // 的 workspace；集合内 workspace 的认领在各 handler 里释放跳过，其余照常认领。
        const gate = readControlPlaneGate({ now });
        const gateSignature = [...gate.leasedWorkspaces].sort().join("\n");
        if (gateSignature !== lastGateSignature) {
          lastGateSignature = gateSignature;
          log(
            "info",
            gate.leasedWorkspaces.size > 0
              ? `claim gated per workspace (spec §5.3): control-plane lease held for ${describeWorkspaceSet(gate.leasedWorkspaces)}`
              : "claim gate cleared: no control-plane lease, fallback semantics = current behavior",
          );
        }
        const claimed = await repo.claimDue(now);
        for (const automation of claimed) {
          await handleClaimed(automation, now, gate);
        }
        const manualRuns = await repo.claimManualRuns(now);
        for (const manualRun of manualRuns) {
          await handleClaimedManual(manualRun.automation, manualRun.run, gate);
        }
        const offPeakClaimed = await offPeakRepo.claimDue(now);
        for (const task of offPeakClaimed) {
          await handleOffPeakClaimed(task, now, gate);
        }
        // keep-awake：上报执行中计数，main 据此 + 设置决定 powerSaveBlocker。
        await reportOffPeakActiveCount();
      } catch (error) {
        log("error", `tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // manual run 的唤醒可能与当前 tick 重叠；因 ticking=true 直接丢弃会让
      // 用户仍需等待下一轮 20 秒轮询。记录 pending，并在本轮完成后立即补跑。
    } while (tickRequested && !disposed);
  } finally {
    ticking = false;
  }
}

function requestTick(): void {
  if (disposed) return;
  if (!schedulerReady || ticking) {
    tickRequested = true;
    return;
  }
  void tick();
}

async function handleClaimed(
  automation: ZCodeAutomation,
  now: number,
  gate: SchedulerControlPlaneGate,
): Promise<void> {
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: automation.workspacePath,
    workspaceIdentity: automation.workspaceIdentity,
  });

  // §5.3 per-workspace 仲裁：本 workspace 有未过期控制面租约 → 认领归控制面 scheduler，
  // 释放 single-flight 错开（不落审计、不派发）。控制面 scheduler 未接线的窗口内该
  // workspace 暂停执行，租约过期后自动恢复认领（回退语义 = 现状）。
  if (gate.leasedWorkspaces.has(workspaceKey)) {
    await repo.releaseClaim(automation.automationId);
    return;
  }

  const scheduledAt = resolveScheduledAt(automation, now);
  const runId = buildRunId(automation.automationId, scheduledAt);
  const isRetry = automation.dispatchAttempts > 0;

  // spec §5.2：非回退（心跳可见）时认领成功幂等落 trigger_events 审计行（source=schedule、
  // provider=scheduler、provider_message_id=runId 幂等键、thread_key=schedule:automationId、
  // fast_path=NULL——仅审计/intake 层，不进三边路由/攒批/不产 would-accept）。回退期
  // （心跳不可见，含控制面曾运行后崩溃、租约过期）纯 legacy 不落（§5.2 实施偏差）。
  // 审计失败不吞：原样上浮进 tick 告警，认领行留给僵尸回收重试。
  if (shouldWriteScheduleAudit(gate)) {
    recordScheduleTriggerAudit(gate.store, {
      workspaceIdentity: workspaceKey,
      domainKey: automation.automationId,
      providerMessageId: runId,
      payloadSummary: { automationId: automation.automationId, runId, scheduledAt },
      now,
    });
  }

  // misfire：首轮（非重试）且计划触发时间已远早于 now → 认定错过窗口，跳过不补跑。
  const missed =
    !isRetry && automation.nextRunAt != null && automation.nextRunAt <= now - MISFIRE_GRACE_MS;
  if (missed) {
    // 纯一次性任务（如 delayMinutes 落成的 minute scheduleRule）错过窗口后，
    // 通用重算会给出 anchorAt + k*interval 的下一周期，让“只跑一次”的提醒在后续周期
    // 继续执行。一次性语义是确定的目标时刻，错过即终态，不得再排程新的执行承诺。
    const finalize = isOneShotAutomation(automation);
    const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, now);
    await repo.skipAndReschedule({
      automationId: automation.automationId,
      runId,
      workspaceKey,
      scheduledAt,
      reason: "computer_asleep_or_app_not_running",
      nextRunAt,
      finalize,
    });
    log(
      "info",
      `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
    );
    return;
  }

  // 【spec §5.2 实施偏差 ws7】桥循环（push/sweep/resumePendingAfterBoot）生产接线前
  // 不写 dispatch_requests pending 行：无 push/ACK/sweeper 的 pending 行只会无限堆积，
  // 且日后接 push 不停用直派 = 同 run 双执行。执行保持 legacy 直派；接线时原子切换
  // （停直派 + 写 pending + push/sweep），禁止长期双写。insertPendingDispatchRequest
  // 就位待桥批接入（其 doc 有同名偏差登记）。

  // 正常派发：先落/更新 run 台账（claimed），再把请求发回 main。
  await repo.upsertRunClaimed({
    runId,
    automationId: automation.automationId,
    workspaceKey,
    scheduledAt,
    trigger: "schedule",
    // 原意图在 dispatch request 中传递，首次有效选择由目标 Host 固定；此处不提前冻结。
  });
  inFlight.set(runId, {
    automationId: automation.automationId,
    workspaceKey,
    trigger: "schedule",
  });
  const run = await repo.getRun(runId);
  postDispatchRequest(automation, runId, run?.modelSelection);
}

function postDispatchRequest(
  automation: ZCodeAutomation,
  runId: string,
  fixedSelection?: ZCodeAutomationRun["modelSelection"],
): void {
  const request: SchedulerToMainMessage = {
    type: "cron-dispatch-request",
    automationId: automation.automationId,
    runId,
    prompt: automation.prompt,
    ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
    ...((fixedSelection ?? automation.modelSelection)
      ? { modelSelection: fixedSelection ?? automation.modelSelection }
      : {}),
    ...(automation.mode ? { mode: automation.mode } : {}),
    workspacePath: automation.workspacePath,
    projectId: automation.projectId,
    hostId: automation.hostId,
    additionalDirectories: automation.additionalDirectories,
    ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
}

async function handleClaimedManual(
  automation: ZCodeAutomation,
  run: ZCodeAutomationRun,
  gate: SchedulerControlPlaneGate,
): Promise<void> {
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: automation.workspacePath,
    workspaceIdentity: automation.workspaceIdentity,
  });
  // §5.3 per-workspace：控制面领导的 workspace 不由 Main fork 派发 manual run。
  // 释放 automation single-flight；run 行保持 claimed（attempts 已在认领时 +1），
  // 控制面接线或租约过期后按 stale 序（CLAIM_STALE_MS）再认领，不丢不双跑。
  if (gate.leasedWorkspaces.has(workspaceKey)) {
    await repo.releaseManualClaim(automation.automationId, workspaceKey);
    return;
  }
  inFlight.set(run.runId, {
    automationId: automation.automationId,
    workspaceKey,
    trigger: "manual",
  });
  postDispatchRequest(automation, run.runId, run.modelSelection);
}

/** 执行中计数上报（keep-awake）：仅在值变化时发消息，减噪。 */
let lastOffPeakActiveCount = -1;
async function reportOffPeakActiveCount(): Promise<void> {
  try {
    const count = await offPeakRepo.countActive();
    if (count === lastOffPeakActiveCount) return;
    lastOffPeakActiveCount = count;
    const msg: SchedulerToMainMessage = { type: "offpeak-active-count", count };
    parentPort?.postMessage(msg);
  } catch (error) {
    log(
      "warn",
      `off-peak active count report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---- 闲时任务派发 ----

/**
 * 认领后派发闲时任务。退避中的任务立即释放认领等下轮（进程内退避表；每轮 claim+release
 * 两次写，任务数小、WAL 下开销可忽略——若退避任务成规模再把退避下沉进 claimDue）。
 */
async function handleOffPeakClaimed(
  task: ZCodeOffPeakTask,
  now: number,
  gate: SchedulerControlPlaneGate,
): Promise<void> {
  // §5.3 per-workspace：控制面领导的 workspace 由控制面认领 off-peak，释放错开。
  if (gate.leasedWorkspaces.has(task.workspaceKey)) {
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now });
    return;
  }

  // §5.2：cron/off-peak 出口认领成功即幂等落审计（裁定 5 只豁免进桥、不豁免审计）；
  // 回退期（心跳不可见）纯 legacy 不落。provider_message_id=offPeakTaskId（任务稳定键，
  // 重试幂等收敛单行）；thread_key=schedule:<offPeakTaskId>（§1.2 域键规范扩展，
  // off-peak 无 automationId，见 spec §5.2 实施偏差）。审计失败不吞，上浮 tick 告警。
  if (shouldWriteScheduleAudit(gate)) {
    recordScheduleTriggerAudit(gate.store, {
      workspaceIdentity: task.workspaceKey,
      domainKey: task.offPeakTaskId,
      providerMessageId: task.offPeakTaskId,
      payloadSummary: { offPeakTaskId: task.offPeakTaskId, claimedAt: now },
      now,
    });
  }

  const retryAt = offPeakRetryAt.get(task.offPeakTaskId) ?? 0;
  if (retryAt > now) {
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now });
    return;
  }
  if (!task.modelSelection) {
    // 仓库只认领 schedulable=1 的任务，而清空 Selection 时会同步写 schedulable=0，
    // 所以这里理论上不可达；保留守卫是为了不把"待修复"任务派发成无模型的 run。
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now });
    log(
      "warn",
      `off-peak task claimed without model selection, released task=${task.offPeakTaskId}`,
    );
    return;
  }
  offPeakInFlight.add(task.offPeakTaskId);
  const request: SchedulerToMainMessage = {
    type: "offpeak-dispatch-request",
    offPeakTaskId: task.offPeakTaskId,
    prompt: task.prompt,
    permissionMode: task.permissionMode,
    modelSelection: task.modelSelection,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.serverTicketId ? { serverTicketId: task.serverTicketId } : {}),
    workspacePath: task.workspacePath,
    projectId: task.projectId,
    hostId: task.hostId,
    additionalDirectories: task.additionalDirectories,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
  log("info", `off-peak dispatch requested task=${task.offPeakTaskId}`);
}

async function settleDispatchResult(
  msg: Extract<MainToSchedulerMessage, { type: "cron-dispatch-result" }>,
): Promise<void> {
  const context = inFlight.get(msg.runId);
  inFlight.delete(msg.runId);
  const now = Date.now();
  // 从 runId 还原 automationId（context 丢失时兜底，如 scheduler 重启后收到迟到回报）。
  const automationId = context?.automationId ?? msg.runId.split(":")[0]!;
  const workspaceKey = context?.workspaceKey;
  const trigger: ZCodeAutomationTrigger =
    context?.trigger ?? (msg.runId.includes(":manual:") ? "manual" : "schedule");
  const settleManualClaim = async (ok: boolean): Promise<void> => {
    await settleManualClaimForDispatchResult({
      repo,
      automationId,
      runId: msg.runId,
      workspaceKey,
      ok,
      logError: (message) => log("error", message),
    });
  };

  if (msg.ok) {
    if (trigger === "manual") {
      await repo.markManualRunDispatched({
        runId: msg.runId,
        sessionId: msg.sessionId ?? null,
        dispatchedAt: now,
      });
      await settleManualClaim(true);
      return;
    }
    await repo.markRunDispatch({
      runId: msg.runId,
      dispatchStatus: "dispatched",
      sessionId: msg.sessionId ?? null,
    });
    const automation = await repo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, now) : null;
    await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt });
    return;
  }

  await repo.markRunDispatch({
    runId: msg.runId,
    dispatchStatus: "failed_to_dispatch",
    error: msg.error ?? "dispatch failed",
  });
  if (trigger === "manual") {
    await settleManualClaim(false);
    return;
  }
  const kind = msg.failureKind ?? "transient";
  await repo.markDispatchFailed(automationId, {
    failedAt: now,
    error: msg.error ?? "dispatch failed",
    kind,
    // transient 达上限后循环任务跳下一个正常 next_run_at。
    nextRunAt: await repo
      .get(automationId)
      .then((automation) => (automation ? computeAutomationNextRunAt(automation, now) : null)),
  });
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  resourceTelemetry?.stop();
  resourceTelemetry = null;
  // 释放本进程仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。
  for (const [, context] of inFlight) {
    try {
      if (context.trigger === "manual") {
        await repo.releaseManualClaim(context.automationId, context.workspaceKey);
      } else {
        await repo.releaseClaim(context.automationId);
      }
    } catch {
      // 忽略：退出路径尽力而为。
    }
  }
  inFlight.clear();
  for (const offPeakTaskId of offPeakInFlight) {
    try {
      await offPeakRepo.releaseClaim(offPeakTaskId);
    } catch {
      // 忽略：退出路径尽力而为。
    }
  }
  offPeakInFlight.clear();
  try {
    repo.close();
  } catch {
    // 忽略。
  }
  try {
    offPeakRepo.close();
  } catch {
    // 忽略。
  }
  // 租约/审计探测的第二连接一并收口（同库 WAL，关闭无跨进程影响）。
  for (const db of superAgentStores.values()) {
    try {
      db.close();
    } catch {
      // 忽略：退出路径尽力而为。
    }
  }
  superAgentStores.clear();
  process.exit(0);
}

parentPort?.on("message", (event: Electron.MessageEvent) => {
  const msg = event.data as MainToSchedulerMessage;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "scheduler-dispose") {
    void dispose();
    return;
  }
  if (msg.type === "cron-dispatch-result") {
    void settleDispatchResult(msg)
      .then(() => {
        // manual run 可能因同一 automation 已有派发在途而暂时无法认领。
        // 前一轮结算释放 single-flight 锁后主动 tick，避免再次等待 20 秒轮询。
        requestTick();
      })
      .catch((error) => {
        log(
          "error",
          `settle dispatch result failed runId=${msg.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return;
  }
  if (msg.type === "offpeak-dispatch-result") {
    offPeakInFlight.delete(msg.offPeakTaskId);
    void settleOffPeakDispatchResult(
      {
        repo: offPeakRepo,
        retryAt: offPeakRetryAt,
        retryAttempts: offPeakRetryAttempts,
        now: Date.now,
        log,
      },
      msg,
    ).catch((error) => {
      log(
        "error",
        `settle off-peak dispatch result failed task=${msg.offPeakTaskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return;
  }
  if (msg.type === "scheduler-wake") {
    log("info", `manual run wake requested automation=${msg.automationId}`);
    requestTick();
  }
});

async function main(): Promise<void> {
  await repo.ensureReady();
  // 闲时任务中断恢复：scheduler 是 app 单例、先于任何派发启动——此刻 DB 里的
  // running 必属上一个 app 实例残留，安全置回 queued（session 保留供 resume 续跑）。
  try {
    const recovered = await offPeakRepo.recoverInterrupted(Date.now());
    if (recovered > 0) {
      log("info", `off-peak recovered ${recovered} interrupted task(s) back to queued`);
    }
  } catch (error) {
    log(
      "error",
      `off-peak recoverInterrupted failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  schedulerReady = true;
  log("info", "cron scheduler started");
  requestTick();
  pollTimer = setInterval(requestTick, POLL_INTERVAL_MS);
  // 资源遥测：60 秒自采一次 CPU / 内存发给 main（heap 只有本进程读得到）。
  resourceTelemetry = startSchedulerResourceTelemetry({
    postMessage: (message) => parentPort?.postMessage(message),
  });
}

// 调度循环只在 utilityProcess fork（parentPort 存在）中自启：被测试/工具 import 本模块
// 时不自启，避免 import 副作用打开真实 tasks-index / 启动轮询。生产唯一入口仍是
// desktopCronScheduler 的 fork（parentPort 恒在）。
if (parentPort) {
  void main().catch((error) => {
    log(
      "error",
      `scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
