import { evaluateChengDeliveryGate } from "@zcode/contracts";
import type {
  TriggerChengGateVerdict,
  TriggerVerdictDecision,
} from "./contract.js";
import type { TriggerEventRow } from "./trigger-events-access.js";

/**
 * 所有 super-agent 出站面（would-accept 卡、owned 回复、spec run）共用的 Cheng 门：
 * trigger payload 带 `chengJobId` 时，先求真实 gate；红/blocked 一律静默丢弃出站。
 * 无 chengJobId = 非 Cheng 触发，照常出站。
 */
export interface TriggerOutboundGateDeps {
  resolveGate?: (jobId: string) => Promise<TriggerChengGateVerdict>;
}

export type TriggerOutboundGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** trigger payload 的 Cheng job 引用（对象 payload 的 `chengJobId`；非法 JSON = 无引用）。 */
export function chengJobIdOfTriggerEvent(event: TriggerEventRow): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const value = (parsed as Record<string, unknown>).chengJobId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 求值出站门。带 chengJobId 但未注入 resolver = 装配错误（抛出，不能静默放行）；
 * resolver 失败原样上浮；红/blocked 返回 allowed:false + 稳定 reason。
 */
export async function evaluateTriggerOutboundChengGate(
  event: TriggerEventRow,
  deps: TriggerOutboundGateDeps,
): Promise<TriggerOutboundGateResult> {
  const jobId = chengJobIdOfTriggerEvent(event);
  if (jobId === undefined) return { allowed: true };
  if (deps.resolveGate === undefined) {
    throw new Error(
      `trigger payload 带 chengJobId 但未注入 outbound gate resolver (triggerId=${event.id})`,
    );
  }
  const gate = await deps.resolveGate(jobId);
  return evaluateChengDeliveryGate(gate);
}

export function chengJobIdsOfDecisions(
  decisions: readonly TriggerVerdictDecision[],
  events: readonly TriggerEventRow[],
): ReadonlyMap<string, string> {
  const byTrigger = new Map<string, string>();
  decisions.forEach((decision, index) => {
    const jobId = chengJobIdOfTriggerEvent(events[index]!);
    if (jobId !== undefined) byTrigger.set(decision.triggerId, jobId);
  });
  return byTrigger;
}
