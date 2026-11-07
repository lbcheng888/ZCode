import {
  goalChengPlanId,
  modelMessageContentToText,
  type CompactRecoveryPointer,
  type ModelToolCall,
  type SessionGoal,
  type SessionId,
} from "@zcode/contracts";

import type { RuntimeMessageEntry } from "../agent/message-history.js";

/** 能产生真实 Cheng 引用的工具调用名（只读 + 显式绑定）。 */
const CHENG_REF_TOOL_NAMES = new Set([
  "ChengInspect",
  "ChengPlan",
  "ChengVerify",
  "ChengExplain",
  "GoalChengBind",
]);

export interface CompactChengRefFacts {
  planIds: ReadonlySet<string>;
  runIds: ReadonlySet<string>;
}

/**
 * 从本会话真实工具调用/结果与 goal 显式引用收集 Cheng refs。
 * 只认成功工具结果：assistant toolCall + 对应 role=tool 结果按 toolCallId 配对；
 * ChengInspect 结果携带 jobId/runId，其余 Cheng 工具从成功调用的 jobId 派生 planId；
 * GoalChengBind 结果直接带 goal.chengRef。旧消息缺 toolCallId 时不猜。
 */
export function collectCompactChengRefFacts(
  entries: readonly RuntimeMessageEntry[],
  target?: SessionGoal | null,
): CompactChengRefFacts {
  const planIds = new Set<string>();
  const runIds = new Set<string>();
  if (target?.chengRef !== undefined) {
    planIds.add(target.chengRef.planId);
    if (target.chengRef.runId !== undefined) runIds.add(target.chengRef.runId);
  }

  const calls = new Map<string, ModelToolCall>();
  for (const entry of entries) {
    if (entry.kind === "attachment") continue;
    for (const call of entry.message.toolCalls ?? []) {
      if (CHENG_REF_TOOL_NAMES.has(call.name)) calls.set(call.id, call);
    }
  }
  for (const entry of entries) {
    if (entry.kind === "attachment") continue;
    const message = entry.message;
    if (message.role !== "tool" || message.isError === true) continue;
    const call = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
    if (call === undefined) continue;
    const text = modelMessageContentToText(message.content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (call.name === "ChengInspect") {
      if (record.status !== "ok") continue;
      const jobId = typeof record.jobId === "string" ? record.jobId : undefined;
      const runId = typeof record.runId === "string" ? record.runId : undefined;
      if (jobId !== undefined && jobId.length > 0) planIds.add(goalChengPlanId(jobId));
      if (runId !== undefined && runId.length > 0) runIds.add(runId);
      continue;
    }
    if (call.name === "GoalChengBind") {
      const goal = record.goal;
      if (typeof goal !== "object" || goal === null) continue;
      const chengRef = (goal as Record<string, unknown>).chengRef;
      if (typeof chengRef !== "object" || chengRef === null) continue;
      const ref = chengRef as Record<string, unknown>;
      if (typeof ref.planId === "string" && ref.planId.length > 0) planIds.add(ref.planId);
      if (typeof ref.runId === "string" && ref.runId.length > 0) runIds.add(ref.runId);
      continue;
    }
    const input = call.input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) continue;
    const jobId = (input as Record<string, unknown>).jobId;
    if (typeof jobId === "string" && jobId.length > 0) planIds.add(goalChengPlanId(jobId));
  }
  return { planIds, runIds };
}

/**
 * 逐字段校验 compact pointer 的 Cheng 引用：未命中本会话真实 refs 的字段直接丢弃；
 * 其它 pointer 字段原样保留（宽进，不能让伪造引用废掉整个恢复锚点）。
 */
export function sanitizeCompactRecoveryPointer(
  pointer: CompactRecoveryPointer,
  facts: CompactChengRefFacts,
): CompactRecoveryPointer {
  const { chengRunId, chengPlanId, ...rest } = pointer;
  return {
    ...rest,
    ...(chengRunId !== undefined && facts.runIds.has(chengRunId) ? { chengRunId } : {}),
    ...(chengPlanId !== undefined && facts.planIds.has(chengPlanId) ? { chengPlanId } : {}),
  };
}

/** compact 组合口：现读目标行 + 工具回执后逐字段校验；无 store 时只用会话内工具事实。 */
export async function validateCompactRecoveryPointerForSession(
  pointer: CompactRecoveryPointer,
  entries: readonly RuntimeMessageEntry[],
  sessionStore: { readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null> } | undefined,
  sessionId: SessionId,
): Promise<CompactRecoveryPointer> {
  const target = sessionStore === undefined ? null : await sessionStore.readTarget({ sessionID: sessionId });
  return sanitizeCompactRecoveryPointer(pointer, collectCompactChengRefFacts(entries, target));
}
