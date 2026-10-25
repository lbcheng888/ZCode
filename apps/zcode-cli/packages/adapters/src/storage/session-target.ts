// ============================================================
// SQLite session target helpers
// ============================================================

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_TARGET_TURN_BUDGET,
  TARGET_BUDGET_EXHAUSTED_BLOCKER_CODE,
  type SessionId,
  type SessionGoal,
  type GoalStatus,
  type SessionTargetEvent,
  type SessionTargetEventKind,
} from "@zcode/contracts";

interface TargetRow {
  session_id: string;
  target_id: string;
  objective: string;
  summary_title: string | null;
  status: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  turn_budget: number | null;
  turns_used: number;
  wall_clock_budget_seconds: number | null;
  active_input_id: string | null;
  active_run_started_at: number | null;
  active_run_last_seen_at: number | null;
  time_created: number;
  time_updated: number;
}

interface TargetEventRow {
  id: number;
  session_id: string;
  target_id: string;
  kind: string;
  blocker_code: string | null;
  reason: string | null;
  snapshot_json: string | null;
  time_created: number;
}

/**
 * 状态机事件种类推导(long-horizon-goal-redesign-plan §3.2/§4.1):
 * 持久状态 blocked 复用 budget_limited 列,事件层用稳定 blocker code 区分。
 */
function targetEventKindForStatus(
  status: GoalStatus,
): SessionTargetEventKind | null {
  switch (status) {
    case "active":
      return "resumed";
    case "paused":
      return "paused";
    case "budget_limited":
      return "blocked";
    case "complete":
      return "completed";
  }
}

function blockerCodeForStatus(
  status: GoalStatus,
  reason: string | undefined,
): string | null {
  if (status !== "budget_limited") return null;
  // 现阶段 budget_limited 只由预算耗尽触发;reason 透传调用方语义。
  return reason ?? TARGET_BUDGET_EXHAUSTED_BLOCKER_CODE;
}

function appendSessionTargetEvent(
  db: DatabaseSync,
  input: {
    blockerCode?: string | null;
    kind: SessionTargetEventKind;
    reason?: string | null;
    sessionID: SessionId;
    /** cleared tombstone 时为 null。 */
    snapshot: SessionGoal | null;
    targetID: string;
  },
): void {
  db.prepare(
    `
    insert into session_target_event (
      session_id, target_id, kind, blocker_code, reason, snapshot_json, time_created
    ) values (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.sessionID,
    input.targetID,
    input.kind,
    input.blockerCode ?? null,
    input.reason ?? null,
    input.snapshot ? JSON.stringify(input.snapshot) : null,
    Date.now(),
  );
}

export function readSessionTarget(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionGoal | null {
  const row = db
    .prepare("select * from session_target where session_id = ?")
    .get(input.sessionID) as TargetRow | undefined;
  return row ? decodeTargetRow(row) : null;
}

export function readSessionTargetEvents(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionTargetEvent[] {
  const rows = db
    .prepare(
      "select * from session_target_event where session_id = ? order by id asc",
    )
    .all(input.sessionID) as unknown as TargetEventRow[];
  return rows.map(decodeTargetEventRow);
}

function decodeTargetEventRow(row: TargetEventRow): SessionTargetEvent {
  let snapshot: SessionGoal | null = null;
  if (row.snapshot_json) {
    try {
      const parsed = JSON.parse(row.snapshot_json) as SessionGoal;
      snapshot = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      // 事件行由本模块写入;解析失败按缺失快照处理,不拖垮事件枚举。
      snapshot = null;
    }
  }
  return {
    id: row.id,
    sessionID: row.session_id as SessionId,
    targetID: row.target_id,
    kind: row.kind as SessionTargetEventKind,
    blockerCode: row.blocker_code,
    reason: row.reason,
    snapshot,
    time: row.time_created,
  };
}

export function setSessionTarget(
  db: DatabaseSync,
  input: {
    objective: string;
    sessionID: SessionId;
    status: GoalStatus;
    tokenBudget?: number | null;
    turnBudget?: number | null;
    wallClockBudgetSeconds?: number | null;
  },
): SessionGoal {
  const now = Date.now();
  const targetID = createStorageTargetId();
  // 回合预算缺省 256;显式 null 才表示不限(设计 §4.1 裁定 4)。
  const turnBudget =
    input.turnBudget === undefined ? DEFAULT_TARGET_TURN_BUDGET : input.turnBudget;
  const previous = readSessionTarget(db, { sessionID: input.sessionID });
  db.prepare(
    `
    insert into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, turn_budget, turns_used, wall_clock_budget_seconds, time_created, time_updated
    ) values (?, ?, ?, null, ?, ?, 0, 0, ?, 0, ?, ?, ?)
    on conflict(session_id) do update set
      target_id = excluded.target_id,
      objective = excluded.objective,
      summary_title = excluded.summary_title,
      status = excluded.status,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      turn_budget = excluded.turn_budget,
      turns_used = excluded.turns_used,
      wall_clock_budget_seconds = excluded.wall_clock_budget_seconds,
      active_input_id = null,
      active_run_started_at = null,
      active_run_last_seen_at = null,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated
    `,
  ).run(
    input.sessionID,
    targetID,
    input.objective,
    input.status,
    input.tokenBudget ?? null,
    turnBudget,
    input.wallClockBudgetSeconds ?? null,
    now,
    now,
  );
  touchSessionForTarget(db, input.sessionID, now);
  const target = mustReadTarget(db, input.sessionID);
  appendSessionTargetEvent(db, {
    kind: previous ? "edited" : "created",
    reason: previous ? "replaced" : null,
    sessionID: input.sessionID,
    snapshot: target,
    targetID: target.targetID,
  });
  return target;
}

export function cloneSessionTargetForFork(
  db: DatabaseSync,
  input: {
    source: SessionGoal;
    sessionID: SessionId;
    status: GoalStatus;
  },
): SessionGoal {
  const now = Date.now();
  const source = input.source;
  // fork 是 session state branch，不是新建 goal。必须保留 target_id 和
  // 原始 created time，让已复制的 goal-continuation / verifier metadata 能继续对齐。
  // active run 字段属于父 session 当前运行态，child 不能继承，否则会显示幽灵运行中。
  const hadExistingRow = readSessionTarget(db, { sessionID: input.sessionID }) !== null;
  db.prepare(
    `
    insert into session_target (
      session_id,
      target_id,
      objective,
      summary_title,
      status,
      token_budget,
      tokens_used,
      time_used_seconds,
      turn_budget,
      turns_used,
      wall_clock_budget_seconds,
      active_input_id,
      active_run_started_at,
      active_run_last_seen_at,
      time_created,
      time_updated
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?)
    on conflict(session_id) do update set
      target_id = excluded.target_id,
      objective = excluded.objective,
      summary_title = excluded.summary_title,
      status = excluded.status,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      turn_budget = excluded.turn_budget,
      turns_used = excluded.turns_used,
      wall_clock_budget_seconds = excluded.wall_clock_budget_seconds,
      active_input_id = null,
      active_run_started_at = null,
      active_run_last_seen_at = null,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated
    `,
  ).run(
    input.sessionID,
    source.targetID,
    source.objective,
    source.summaryTitle,
    input.status,
    source.tokenBudget,
    source.tokensUsed,
    source.timeUsedSeconds,
    source.turnBudget ?? DEFAULT_TARGET_TURN_BUDGET,
    source.turnsUsed ?? 0,
    source.wallClockBudgetSeconds ?? null,
    source.time.created,
    source.time.updated,
  );
  touchSessionForTarget(db, input.sessionID, now);
  const target = mustReadTarget(db, input.sessionID);
  if (!hadExistingRow) {
    // 子会话事件流从 created 起步;session-start 边缘的强制 paused 由子会话
    // resume 链路(activatePausedTargetAfterResume)统一落 paused 事件。
    appendSessionTargetEvent(db, {
      kind: "created",
      reason: "fork",
      sessionID: input.sessionID,
      snapshot: target,
      targetID: target.targetID,
    });
  }
  return target;
}

export function createSessionTarget(
  db: DatabaseSync,
  input: { objective: string; sessionID: SessionId; tokenBudget?: number | null },
): SessionGoal | null {
  const now = Date.now();
  const targetID = createStorageTargetId();
  db.prepare(
    `
    insert or ignore into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, turn_budget, turns_used, wall_clock_budget_seconds, time_created, time_updated
    ) values (?, ?, ?, null, 'active', ?, 0, 0, ?, 0, ?, ?, ?)
    `,
  ).run(
    input.sessionID,
    targetID,
    input.objective,
    input.tokenBudget ?? null,
    DEFAULT_TARGET_TURN_BUDGET,
    null,
    now,
    now,
  );

  const target = readSessionTarget(db, { sessionID: input.sessionID });
  if (target?.targetID !== targetID) return null;
  touchSessionForTarget(db, input.sessionID, now);
  appendSessionTargetEvent(db, {
    kind: "created",
    sessionID: input.sessionID,
    snapshot: target,
    targetID: target.targetID,
  });
  return target;
}

export function updateSessionTargetStatus(
  db: DatabaseSync,
  input: { sessionID: SessionId; status: GoalStatus; reason?: string },
): SessionGoal | null {
  const now = Date.now();
  const previous = readSessionTarget(db, { sessionID: input.sessionID });
  if (!previous) return null;
  const result = db
    .prepare(
      `
      update session_target
      set status = ?, time_updated = ?
      where session_id = ?
      `,
    )
    .run(input.status, now, input.sessionID);
  if (result.changes === 0) return null;
  touchSessionForTarget(db, input.sessionID, now);
  const target = mustReadTarget(db, input.sessionID);
  // 状态机事件只在真实迁移时追加;幂等重写(同状态)不产生事件。
  if (target.status !== previous.status) {
    const kind = targetEventKindForStatus(target.status);
    if (kind) {
      appendSessionTargetEvent(db, {
        blockerCode: blockerCodeForStatus(target.status, input.reason),
        kind,
        reason: input.reason ?? null,
        sessionID: input.sessionID,
        snapshot: target,
        targetID: target.targetID,
      });
    }
  }
  return target;
}

export function startSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  },
): SessionGoal | null {
  const startedAt = Math.max(0, input.startedAtMs);
  // goal live 计时必须跟随 agent 运行边界落库，不能再由 UI 从 assistant
  // message timestamp 反推；恢复 snapshot 时该 timestamp 可能是旧轮次，导致切回后异常增长。
  const result = db
    .prepare(
      `
      update session_target
      set
        active_input_id = ?,
        active_run_started_at = ?,
        active_run_last_seen_at = ?,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and status = 'active'
      `,
    )
    .run(input.inputID, startedAt, startedAt, startedAt, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, startedAt);
  return mustReadTarget(db, input.sessionID);
}

export function heartbeatSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  },
): SessionGoal | null {
  const seenAt = Math.max(0, input.seenAtMs);
  const result = db
    .prepare(
      `
      update session_target
      set
        active_run_last_seen_at = max(coalesce(active_run_last_seen_at, 0), ?),
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at is not null
      `,
    )
    .run(seenAt, seenAt, input.sessionID, input.targetID, input.inputID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, seenAt);
  return mustReadTarget(db, input.sessionID);
}

export function finishSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    reason?: string;
    tokensUsedDelta?: number;
    turnsUsedDelta?: number;
  },
): SessionGoal | null {
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (
    !current ||
    current.targetID !== input.targetID ||
    current.activeInputId !== input.inputID ||
    current.activeRunStartedAtMs == null
  ) {
    return current;
  }

  const endedAt = Math.max(0, input.endedAtMs);
  const tokenDelta = Math.max(0, input.tokensUsedDelta ?? 0);
  const turnDelta = Math.max(0, input.turnsUsedDelta ?? 0);
  const timeDelta = elapsedSecondsBetween(current.activeRunStartedAtMs, endedAt);
  const result = db
    .prepare(
      `
      update session_target
      set
        tokens_used = tokens_used + ?,
        turns_used = turns_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when ? is not null then ?
          when status = 'active' and (
            (token_budget is not null and tokens_used + ? >= token_budget)
            or (turn_budget is not null and turns_used + ? >= turn_budget)
            or (wall_clock_budget_seconds is not null and time_used_seconds + ? >= wall_clock_budget_seconds)
          ) then 'budget_limited'
          else status
        end,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      `,
    )
    .run(
      tokenDelta,
      turnDelta,
      timeDelta,
      input.status ?? null,
      input.status ?? null,
      tokenDelta,
      turnDelta,
      timeDelta,
      endedAt,
      input.sessionID,
      input.targetID,
      input.inputID,
      current.activeRunStartedAtMs,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, endedAt);
  const target = mustReadTarget(db, input.sessionID);
  // run 计量本身不产状态事件,但两类迁移必须落:①显式 status(取消收口把
  // active 翻 paused,reason turn-cancelled;此时 pauseActiveTargetForCancellation
  // 会因 status 已非 active 早退,事件只能在此落);②三维预算翻 budget_limited。
  if (input.status != null && target.status !== current.status) {
    const kind = targetEventKindForStatus(target.status);
    if (kind) {
      appendSessionTargetEvent(db, {
        blockerCode: blockerCodeForStatus(target.status, input.reason),
        kind,
        reason: input.reason ?? null,
        sessionID: input.sessionID,
        snapshot: target,
        targetID: target.targetID,
      });
    }
  } else {
    appendBlockedEventOnBudgetFlip(db, { current, sessionID: input.sessionID, target });
  }
  return target;
}

export function recoverInterruptedSessionTargetRun(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionGoal | null {
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (!current || !current.activeInputId || current.activeRunStartedAtMs == null) {
    return current;
  }

  // 进程崩溃/退出后，active_run_started_at 只能说明上次没有正常收口。
  // 恢复时不能用 Date.now() 结算，否则 app 离线时间会被计入 goal 运行时长。
  const endedAt = current.activeRunLastSeenAtMs ?? current.activeRunStartedAtMs;
  const timeDelta = elapsedSecondsBetween(current.activeRunStartedAtMs, endedAt);
  const nextStatus: GoalStatus = current.status === "active" ? "paused" : current.status;
  const result = db
    .prepare(
      `
      update session_target
      set
        time_used_seconds = time_used_seconds + ?,
        status = ?,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      `,
    )
    .run(
      timeDelta,
      nextStatus,
      endedAt,
      input.sessionID,
      current.targetID,
      current.activeInputId,
      current.activeRunStartedAtMs,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, endedAt);
  const target = mustReadTarget(db, input.sessionID);
  if (target.status === "paused" && current.status === "active") {
    appendSessionTargetEvent(db, {
      kind: "paused",
      reason: "interrupted-run-recovery",
      sessionID: input.sessionID,
      snapshot: target,
      targetID: target.targetID,
    });
  }
  return target;
}

export function accountSessionTargetUsage(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
    turnsUsedDelta?: number;
  },
): SessionGoal | null {
  const now = Date.now();
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (!current || current.targetID !== input.targetID) {
    return readSessionTarget(db, { sessionID: input.sessionID });
  }
  const tokenDelta = Math.max(0, input.tokensUsedDelta ?? 0);
  const timeDelta = Math.max(0, input.timeUsedSecondsDelta ?? 0);
  const turnDelta = Math.max(0, input.turnsUsedDelta ?? 0);
  if (tokenDelta === 0 && timeDelta === 0 && turnDelta === 0) {
    return current;
  }

  const result = db
    .prepare(
      `
      update session_target
      set
        tokens_used = tokens_used + ?,
        turns_used = turns_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when status = 'active' and (
            (token_budget is not null and tokens_used + ? >= token_budget)
            or (turn_budget is not null and turns_used + ? >= turn_budget)
            or (wall_clock_budget_seconds is not null and time_used_seconds + ? >= wall_clock_budget_seconds)
          ) then 'budget_limited'
          else status
        end,
        time_updated = ?
      where session_id = ? and target_id = ?
      `,
    )
    .run(
      tokenDelta,
      turnDelta,
      timeDelta,
      tokenDelta,
      turnDelta,
      timeDelta,
      now,
      input.sessionID,
      input.targetID,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  const target = mustReadTarget(db, input.sessionID);
  appendBlockedEventOnBudgetFlip(db, { current, sessionID: input.sessionID, target });
  return target;
}

/** 预算三维任一到达 100% 时的 active→budget_limited 迁移,追加 blocked 事件(稳定 code)。 */
function appendBlockedEventOnBudgetFlip(
  db: DatabaseSync,
  input: { current: SessionGoal; sessionID: SessionId; target: SessionGoal },
): void {
  if (
    input.current.status === "active" &&
    input.target.status === "budget_limited" &&
    input.target.targetID === input.current.targetID
  ) {
    appendSessionTargetEvent(db, {
      blockerCode: TARGET_BUDGET_EXHAUSTED_BLOCKER_CODE,
      kind: "blocked",
      reason: TARGET_BUDGET_EXHAUSTED_BLOCKER_CODE,
      sessionID: input.sessionID,
      snapshot: input.target,
      targetID: input.target.targetID,
    });
  }
}

export function updateSessionTargetSummaryTitle(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  },
): SessionGoal | null {
  const now = Date.now();
  // goal 概要由异步 title sidecar 生成；用户可能在模型返回前 replace/clear goal。
  // 必须带 target_id 条件写回，避免旧 objective 的概要覆盖新目标。
  const result = db
    .prepare(
      `
      update session_target
      set summary_title = ?, time_updated = ?
      where session_id = ? and target_id = ?
      `,
    )
    .run(input.summaryTitle, now, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function clearSessionTarget(db: DatabaseSync, input: { sessionID: SessionId }): boolean {
  const now = Date.now();
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  const result = db.prepare("delete from session_target where session_id = ?").run(input.sessionID);
  if (result.changes === 0) return false;
  if (current) {
    // cleared tombstone:目标行已删,快照为 null,target_id 记录被清的是哪个目标。
    appendSessionTargetEvent(db, {
      kind: "cleared",
      sessionID: input.sessionID,
      snapshot: null,
      targetID: current.targetID,
    });
  }
  touchSessionForTarget(db, input.sessionID, now);
  return true;
}

function mustReadTarget(db: DatabaseSync, sessionID: SessionId): SessionGoal {
  const target = readSessionTarget(db, { sessionID });
  if (!target) {
    throw new Error(`Session target not found after write: ${sessionID}`);
  }
  return target;
}

function touchSessionForTarget(db: DatabaseSync, sessionID: SessionId, timeUpdated: number): void {
  db.prepare("update session set time_updated = max(time_updated, ?) where id = ?").run(
    timeUpdated,
    sessionID,
  );
}

function decodeTargetRow(row: TargetRow): SessionGoal {
  return {
    sessionID: row.session_id as SessionId,
    targetID: row.target_id,
    objective: row.objective,
    summaryTitle: row.summary_title,
    status: row.status as GoalStatus,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    turnBudget: row.turn_budget,
    turnsUsed: row.turns_used,
    wallClockBudgetSeconds: row.wall_clock_budget_seconds,
    activeInputId: row.active_input_id,
    activeRunStartedAtMs: row.active_run_started_at,
    activeRunLastSeenAtMs: row.active_run_last_seen_at,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  };
}

function createStorageTargetId(): string {
  return `target_${Date.now().toString(36)}_${randomUUID()}`;
}

function elapsedSecondsBetween(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, Math.ceil((endedAtMs - startedAtMs) / 1000));
}
