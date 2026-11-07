import type { DatabaseSync } from "node:sqlite";
import type { GoalChengRef, SessionGoal, SessionId } from "@zcode/contracts";

import {
  appendSessionTargetEvent,
  mustReadTarget,
  touchSessionForTarget,
} from "./session-target.js";

/**
 * 显式 Cheng plan/run 绑定的 CAS 写：只有 target_id + revision 命中才写入。
 * 绑定/清除都递增 revision 并追加 edited 事件；completed 目标不可改写。
 * 拆出本模块是为了让 session-target.ts 保持在 oxlint max-lines 上限内。
 */
export function updateSessionTargetChengRef(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    revision: number;
    chengRef: GoalChengRef | null;
  },
): SessionGoal | null {
  const now = Date.now();
  const result = db
    .prepare(
      `
      update session_target
      set
        cheng_job_id = ?,
        cheng_run_id = ?,
        cheng_task = ?,
        revision = revision + 1,
        time_updated = ?
      where session_id = ? and target_id = ? and revision = ? and status <> 'complete'
      `,
    )
    .run(
      input.chengRef?.jobId ?? null,
      input.chengRef?.runId ?? null,
      input.chengRef?.task ?? null,
      now,
      input.sessionID,
      input.targetID,
      input.revision,
    );
  if (result.changes === 0) return null;
  touchSessionForTarget(db, input.sessionID, now);
  const target = mustReadTarget(db, input.sessionID);
  appendSessionTargetEvent(db, {
    kind: "edited",
    reason: input.chengRef === null ? "cheng-ref-cleared" : "cheng-ref-updated",
    sessionID: input.sessionID,
    snapshot: target,
    targetID: target.targetID,
  });
  return target;
}
