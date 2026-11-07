import type { GoalAcceptanceLevel, GoalStatus, SessionGoal, SessionId } from "@zcode/contracts";

import { decodeSessionTargetChengRef } from "./session-target-cheng-ref-decode.js";

export interface TargetRow {
  session_id: string;
  target_id: string;
  objective: string;
  summary_title: string | null;
  status: string;
  acceptance_level: string;
  cheng_job_id: string | null;
  cheng_run_id: string | null;
  cheng_task: string | null;
  revision: number;
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

function decodeAcceptanceLevel(value: string): GoalAcceptanceLevel {
  if (value === "diagnostic" || value === "production") return value;
  // 未知等级 = 存储损坏；fail-closed，不静默降成 production 或 diagnostic。
  throw new Error(`session_target.acceptance_level invalid: ${value}`);
}

export function decodeSessionTargetRow(row: TargetRow): SessionGoal {
  const chengRef = decodeSessionTargetChengRef(row);
  return {
    sessionID: row.session_id as SessionId,
    targetID: row.target_id,
    objective: row.objective,
    summaryTitle: row.summary_title,
    status: row.status as GoalStatus,
    acceptanceLevel: decodeAcceptanceLevel(row.acceptance_level),
    ...(chengRef === undefined ? {} : { chengRef }),
    revision: row.revision,
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
