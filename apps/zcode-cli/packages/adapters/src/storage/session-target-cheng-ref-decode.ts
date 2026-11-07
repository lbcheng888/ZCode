import {
  GoalChengRefSchema,
  makeGoalChengRef,
  type GoalChengRef,
} from "@zcode/contracts";

/**
 * session_target 的 Cheng 引用三列解码。半填充/非法 jobId/task 是存储损坏，
 * 直接抛错，不静默降成“未绑定”。拆出本模块是为了让 session-target.ts 保持在
 * oxlint max-lines 上限内。
 */
export interface SessionTargetChengRefColumns {
  cheng_job_id: string | null;
  cheng_run_id: string | null;
  cheng_task: string | null;
}

export function decodeSessionTargetChengRef(
  row: SessionTargetChengRefColumns,
): GoalChengRef | undefined {
  const jobId = row.cheng_job_id;
  if (jobId === null) {
    if (row.cheng_run_id !== null || row.cheng_task !== null) {
      throw new Error("session_target Cheng reference is partially populated");
    }
    return undefined;
  }
  if (row.cheng_task === null) {
    throw new Error("session_target Cheng reference has no task");
  }
  // 与 session goal wire 快照共用同一校验；存储损坏不静默降级成“未绑定”。
  return GoalChengRefSchema.parse(
    makeGoalChengRef({
      jobId,
      task: row.cheng_task,
      ...(row.cheng_run_id === null ? {} : { runId: row.cheng_run_id }),
    }),
  );
}
