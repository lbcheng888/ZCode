/**
 * 裁决驱动器（design M3）：unowned 候选的攒批 → model-only 会话 → fail-closed
 * 校验 → mandate 裁定 → delivery 端口交付。
 *
 * 队列即事实：trigger_events 的 pending 行是唯一事实源（candidates.ts 只读），
 * 驱动器零内存队列状态——崩溃/重启天然恢复，启动扫描 = start() 对 pending
 * workspace 补评估（spec §1.2 索引）。唤醒三选一（N / T / 定时评估点）由
 * notifyCandidate、T 单发定时器、start() 的评估点循环各自驱动。
 */
import { randomUUID } from "node:crypto";

import {
  listPendingBatch,
  listPendingWorkspaces,
  countStillPending,
  readPendingStats,
  readTriggerRow,
  type PendingCandidateRow,
} from "./candidates.js";
import {
  ADJUDICATION_BACKLOG_THRESHOLD,
  ADJUDICATION_DAILY_TOKEN_BUDGET,
  ADJUDICATION_EVALUATION_TICK_MS,
  ADJUDICATION_KV_WINDOW_MS,
  ADJUDICATION_MAX_BATCH_SIZE,
  ADJUDICATION_OLDEST_AGE_MS,
  type AdjudicationMandateTier,
  type AdjudicationUsageInput,
  type AdjudicationVerdictDecision,
  type BatchOutcome,
  type CreateAdjudicationDriverOptions,
  type SuperAgentAdjudicationContract,
} from "./contract.js";
import { buildAdjudicationPrompt } from "./prompt.js";
import { ADJUDICATION_TOOL_ALLOWLIST, ADJUDICATION_TOOL_DISALLOWLIST } from "./toolface.js";
import { validateVerdictBatch } from "./verdict.js";

interface KvWindow {
  key: string;
  expiresAt: number;
  cancelDestroy: () => void;
}

interface WakeTimer {
  deadline: number;
  cancel: () => void;
}

/** UTC 日键（微预算按日换桶，跨日自动清零）。 */
function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** 域键已知前缀（spec §1.2 P2 档）：thread_key 按此前缀从尾部解析域键。 */
const DOMAIN_KEY_PREFIXES = ["bot:", "schedule:", "webhook:"] as const;

/**
 * thread_key → 域键（`<workspaceIdentity>|<域键>`）。workspaceIdentity 可含 `|`（路径
 * 合法），按首个 `|` 切分会把 workspace 尾段误当域键；域键前缀固定，从右往左取第一个
 * 「后缀以已知前缀起始」的 `|` 分界（域键本体内偶发 `|` 也能回到正确的起点）。
 */
function domainKeyOf(threadKey: string): string {
  let scanFrom = threadKey.length;
  while (scanFrom > 0) {
    const at = threadKey.lastIndexOf("|", scanFrom - 1);
    if (at < 0) break;
    const suffix = threadKey.slice(at + 1);
    if (DOMAIN_KEY_PREFIXES.some((prefix) => suffix.startsWith(prefix))) {
      return suffix;
    }
    scanFrom = at;
  }
  // 未知域键：退回首个 `|` 切分（保持既有推导形状；P2 resolveFor 忽略入参）。
  const first = threadKey.indexOf("|");
  return first >= 0 ? threadKey.slice(first + 1) : threadKey;
}

/**
 * trigger_class 推导（spec §1.4 形态 `bot:<botId>` / `cron:<automationId>` /
 * `webhook:<routeId>`）：P2 resolveFor 忽略入参（恒隐式 record_only），推导为
 * Phase 3 就绪——届时错档会静默落隐式 record_only（fail-closed 方向但档位错）。
 */
function triggerClassOf(row: PendingCandidateRow): string {
  const domain = domainKeyOf(row.threadKey);
  if (domain.startsWith("bot:")) {
    const botId = domain.slice(4).split("+")[0] ?? "";
    return `bot:${botId}`;
  }
  // spec §1.4：schedule 域键 `schedule:<automationId>` → `cron:<automationId>`。
  if (domain.startsWith("schedule:")) {
    return `cron:${domain.slice("schedule:".length)}`;
  }
  // webhook 域键 `webhook:<routeId>` 已是 §1.4 形态（再叠 source 前缀会重复）。
  if (domain.startsWith("webhook:")) {
    return domain;
  }
  return `${row.source}:${domain}`;
}

export function createAdjudicationDriver(
  options: CreateAdjudicationDriverOptions,
): SuperAgentAdjudicationContract {
  const { db, session, delivery, mandate, onError } = options;
  const dailyTokenBudget = options.dailyTokenBudget ?? ADJUDICATION_DAILY_TOKEN_BUDGET;

  let running = false;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  const wakeTimers = new Map<string, WakeTimer>();
  const inFlight = new Map<string, Promise<BatchOutcome>>();
  const kvWindows = new Map<string, KvWindow>();
  /** 微预算：workspace → {UTC 日键 → 当日已耗 tokens}（分日桶，读侧只看今日键）。 */
  const usage = new Map<string, Map<string, number>>();
  /** 会话故障冷却（固定 = T）：冷却内 notify/评估点不重试，防故障热循环。 */
  const failureRetryAt = new Map<string, number>();
  const counters = { batchesRun: 0, schemaFailures: 0, budgetTrips: 0, sessionFaults: 0 };

  function spentToday(workspaceIdentity: string): number {
    return usage.get(workspaceIdentity)?.get(utcDay(Date.now())) ?? 0;
  }

  function recordUsage(input: AdjudicationUsageInput): void {
    const day = utcDay(input.at ?? Date.now());
    const today = utcDay(Date.now());
    // 迟到/历史时间戳不入桶：单桶按「最后一条的日期」覆盖会让旧日回写清零当日
    // 已耗、绕过预算帽（契约 at 公开，组合根可能喂迟到 usage 事件），日桶只朝前滚。
    if (day < today) return;
    let days = usage.get(input.workspaceIdentity);
    if (!days) {
      days = new Map();
      usage.set(input.workspaceIdentity, days);
    }
    // 剪掉过期日键：跨日自动清零（读侧只看今日键）且长跑内存有界。
    for (const key of days.keys()) {
      if (key < today) days.delete(key);
    }
    days.set(day, (days.get(day) ?? 0) + input.tokens);
  }

  /** 短窗 KV 复用：同 workspace 5min 窗内复用同一短命会话，窗末销毁。 */
  function ensureSessionKey(workspaceIdentity: string): string {
    const now = Date.now();
    const existing = kvWindows.get(workspaceIdentity);
    if (existing && now < existing.expiresAt) return existing.key;
    if (existing) {
      existing.cancelDestroy();
      session.destroySession(existing.key);
    }
    const key = `adj:${workspaceIdentity}:${randomUUID()}`;
    const expiresAt = now + ADJUDICATION_KV_WINDOW_MS;
    const timer = setTimeout(() => {
      // 只销毁仍指向本 key 的窗口：过期替换后旧定时器必须空转（不误杀新窗）。
      const current = kvWindows.get(workspaceIdentity);
      if (current?.key === key) {
        kvWindows.delete(workspaceIdentity);
        session.destroySession(key);
      }
    }, ADJUDICATION_KV_WINDOW_MS);
    kvWindows.set(workspaceIdentity, {
      key,
      expiresAt,
      cancelDestroy: () => clearTimeout(timer),
    });
    return key;
  }

  function destroyKvWindows(): void {
    for (const window of kvWindows.values()) {
      window.cancelDestroy();
      session.destroySession(window.key);
    }
    kvWindows.clear();
  }

  function cancelWakeTimer(workspaceIdentity: string): void {
    wakeTimers.get(workspaceIdentity)?.cancel();
    wakeTimers.delete(workspaceIdentity);
  }

  /** T 单发定时器：挂到 oldest + T；已有更早/等早的定时器则保留（不后移延迟上限）。 */
  function ensureWakeTimer(workspaceIdentity: string, delayMs: number): void {
    const existing = wakeTimers.get(workspaceIdentity);
    const now = Date.now();
    if (existing && existing.deadline <= now + delayMs) return;
    existing?.cancel();
    const clamped = Math.max(delayMs, 0);
    const deadline = now + clamped;
    const timer = setTimeout(() => {
      wakeTimers.delete(workspaceIdentity);
      // 定时器到点重新评估（行可能已被别处收敛）：条件仍真才真正攒批。
      maybeWake(workspaceIdentity);
    }, clamped);
    wakeTimers.set(workspaceIdentity, {
      deadline,
      cancel: () => clearTimeout(timer),
    });
  }

  /**
   * 唤醒三选一评估：backlog≥N / 最老年龄≥T 立即攒批，否则挂 T 定时器。
   * 受 running（leader）与会话故障冷却门控。
   */
  function maybeWake(workspaceIdentity: string): void {
    if (!running) return;
    const stats = readPendingStats(db, workspaceIdentity);
    if (stats.count === 0) {
      cancelWakeTimer(workspaceIdentity);
      return;
    }
    const now = Date.now();
    if (
      stats.count >= ADJUDICATION_BACKLOG_THRESHOLD ||
      now - stats.oldest >= ADJUDICATION_OLDEST_AGE_MS
    ) {
      cancelWakeTimer(workspaceIdentity);
      fireWake(workspaceIdentity);
    } else {
      ensureWakeTimer(workspaceIdentity, stats.oldest + ADJUDICATION_OLDEST_AGE_MS - now);
    }
  }

  /**
   * 触发一次攒批（fire-and-forget）：永不等待模型；delivery/DB 错误经 onError
   * 告警（A10）。applied 且仍有 pending（单批上限截断）→ 继续评估；会话故障/
   * 预算耗尽不自动重试，交给冷却后的评估点/下一次 notify。
   */
  function fireWake(workspaceIdentity: string): void {
    if (!running) return;
    const retryAt = failureRetryAt.get(workspaceIdentity);
    if (retryAt !== undefined && Date.now() < retryAt) return;
    void runBatch(workspaceIdentity)
      .then((outcome) => {
        if (outcome.status === "applied") maybeWake(workspaceIdentity);
      })
      .catch((error: unknown) => {
        onError(error, `adjudication wake ${workspaceIdentity}`);
      });
  }

  async function executeBatch(workspaceIdentity: string): Promise<BatchOutcome> {
    const batchId = randomUUID();
    const pending = readPendingStats(db, workspaceIdentity);
    if (pending.count === 0) {
      return {
        batchId,
        workspaceIdentity,
        candidateCount: 0,
        modelCalled: false,
        status: "empty",
        decisions: [],
      };
    }
    if (spentToday(workspaceIdentity) >= dailyTokenBudget) {
      // 预算耗尽：不调模型、不动 pending（下个 UTC 日换桶后由评估点重试）。
      counters.budgetTrips += 1;
      return {
        batchId,
        workspaceIdentity,
        candidateCount: pending.count,
        modelCalled: false,
        status: "budget_exhausted",
        decisions: [],
      };
    }
    const rows = listPendingBatch(db, workspaceIdentity, ADJUDICATION_MAX_BATCH_SIZE);
    if (rows.length === 0) {
      // stats 与取批之间被别处收敛的竞态：按空批收。
      return {
        batchId,
        workspaceIdentity,
        candidateCount: 0,
        modelCalled: false,
        status: "empty",
        decisions: [],
      };
    }

    const sessionKey = ensureSessionKey(workspaceIdentity);
    const prompt = buildAdjudicationPrompt(rows);
    let outputText: string;
    let usageResult: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const result = await session.run({
        workspaceIdentity,
        sessionKey,
        prompt,
        candidateCount: rows.length,
        toolAllowlist: ADJUDICATION_TOOL_ALLOWLIST,
        toolDisallowlist: ADJUDICATION_TOOL_DISALLOWLIST,
        modelTier: "adjudicator",
        scheduling: "background-low-priority",
      });
      outputText = result.outputText;
      usageResult = result.usage;
    } catch (error) {
      // 会话故障：留 pending，冷却 T 后由评估点/notify 重试；告警不静默（A10）。
      counters.sessionFaults += 1;
      failureRetryAt.set(workspaceIdentity, Date.now() + ADJUDICATION_OLDEST_AGE_MS);
      onError(error, `adjudication session ${workspaceIdentity}`);
      return {
        batchId,
        workspaceIdentity,
        candidateCount: rows.length,
        modelCalled: true,
        status: "session_error",
        decisions: [],
      };
    }
    if (usageResult) {
      // 会话自带 usage 自动计量；宿主勿对同一 usage 重复 recordUsage。
      recordUsage({
        workspaceIdentity,
        tokens: usageResult.inputTokens + usageResult.outputTokens,
      });
    }

    // verdict 校验 fail-closed（T2）：任一失败整批 record-only，无部分执行。
    const candidateIds = new Set(rows.map((row) => row.id));
    const validation = validateVerdictBatch(outputText, candidateIds);
    let decisions: AdjudicationVerdictDecision[];
    let verdictDegraded: BatchOutcome["verdictDegraded"];
    if (validation.ok) {
      decisions = validation.decisions;
    } else {
      counters.schemaFailures += 1;
      verdictDegraded = validation.failure;
      decisions = rows.map((row) => ({
        triggerId: row.id,
        disposition: "record-only" as const,
        reason: `verdict-validation-failed:${validation.failure}`,
      }));
    }

    // mandate 裁定（spec §1.4「被分派器调用」锚点；P2 恒隐式 record_only）。
    let mandateTier: AdjudicationMandateTier | undefined;
    for (const row of rows) {
      const verdict = mandate.resolveFor(triggerClassOf(row));
      mandateTier ??= verdict.tier;
    }

    // delivery 端口 = trigger.applyVerdicts 精确接缝（decision_log 唯一写者在
    // decision-log，由该 seam 持有仓储——本模块零直写）。
    await Promise.resolve(delivery.applyVerdicts(batchId, decisions));

    const stillPending = countStillPending(
      db,
      rows.map((row) => row.id),
    );
    if (stillPending === rows.length) {
      // 同步仓储已交付却零结算 = 接线错误，响亮暴露（不静默重试）。
      onError(
        new Error("adjudication: delivery 已返回但候选仍全部 pending（未结算）"),
        `adjudication delivery ${workspaceIdentity}`,
      );
    } else {
      failureRetryAt.delete(workspaceIdentity);
    }
    counters.batchesRun += 1;
    return {
      batchId,
      workspaceIdentity,
      candidateCount: rows.length,
      modelCalled: true,
      status: "applied",
      ...(verdictDegraded ? { verdictDegraded } : {}),
      decisions,
      ...(mandateTier ? { mandateTier } : {}),
    };
  }

  function runBatch(workspaceIdentity: string): Promise<BatchOutcome> {
    // 同 workspace 在途批合流：返回同一 Promise，不并发双跑。
    const existing = inFlight.get(workspaceIdentity);
    if (existing) return existing;
    const promise = executeBatch(workspaceIdentity).finally(() => {
      inFlight.delete(workspaceIdentity);
    });
    inFlight.set(workspaceIdentity, promise);
    return promise;
  }

  function notifyCandidate(triggerId: string): void {
    const row = readTriggerRow(db, triggerId);
    // 行缺失 = 装配错误（intake 应先落行再通知），响亮失败。
    if (!row) {
      throw new Error(`adjudication: trigger_events 行不存在: ${triggerId}`);
    }
    // 已收敛/非 candidate：幂等重通知忽略。
    if (!row.pendingCandidate) return;
    // 非 leader（未 start）：仅校验不唤醒；行仍在 pending，启动扫描会补评估。
    if (!running) return;
    maybeWake(row.workspaceIdentity);
  }

  function start(): void {
    if (running) return;
    running = true;
    // 定时评估点：无视 N/T，flush 全部 pending workspace（三选一兜底）。
    tickTimer = setInterval(() => {
      for (const workspaceIdentity of listPendingWorkspaces(db)) {
        cancelWakeTimer(workspaceIdentity);
        fireWake(workspaceIdentity);
      }
    }, ADJUDICATION_EVALUATION_TICK_MS);
    // 启动补扫：age≥T 的立即攒批，年轻的挂 T 定时器（spec §1.2 启动扫描重放）。
    for (const workspaceIdentity of listPendingWorkspaces(db)) {
      maybeWake(workspaceIdentity);
    }
  }

  function stop(): void {
    // 幂等：重复 stop 清理空状态无副作用；在途批不取消（自然收尾，
    // 收尾后的唤醒被 running 门控拦下）。
    running = false;
    if (tickTimer !== undefined) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
    for (const timer of wakeTimers.values()) timer.cancel();
    wakeTimers.clear();
    destroyKvWindows();
  }

  function stats() {
    return { ...counters };
  }

  return {
    notifyCandidate,
    runBatch,
    start,
    stop,
    recordUsage,
    stats,
  };
}
