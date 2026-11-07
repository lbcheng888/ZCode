import type { DatabaseSync } from "node:sqlite";

import type {
  RouteOwnedOutcome,
  TriggerChengGateVerdict,
  TriggerDeliveryReceipt,
} from "./contract.js";
import type { TriggerHostDeliveryPort } from "./ports.js";
import { evaluateTriggerOutboundChengGate } from "./outbound-gate.js";
import { extractPayloadText, TRIGGER_DISPATCH_TEXT_MAX_CHARS } from "./payload-text.js";
import { getTriggerEvent, setTriggerEventFinalDisposition } from "./trigger-events-access.js";
import type { createTriggerSubscriptions } from "./subscriptions.js";

type TriggerSubscriptions = ReturnType<typeof createTriggerSubscriptions>;

/**
 * 投递幂等键（§1.3 fan-out）：triggerId + subscriberSessionId。triggerId 为 uuid
 * （无冒号），拼接无歧义；同键重投由 CommandInbox 幂等吸收（admission duplicate）。
 */
export function triggerDeliveryCommandId(triggerId: string, sessionId: string): string {
  return `${triggerId}:${sessionId}`;
}

export interface EventRouterDeps {
  db: DatabaseSync;
  subscriptions: TriggerSubscriptions;
  delivery: TriggerHostDeliveryPort;
  /** trigger payload 带 chengJobId 时的真实 gate；缺席 = 带 job 的 reply 装配错误。 */
  resolveGate?: (jobId: string) => Promise<TriggerChengGateVerdict>;
  now?: () => number;
}

/**
 * EventRouter.routeOwned（§3.1 owned 边，零 LLM）：
 * 1. 读 trigger_events 行（缺行 → not_found，响亮暴露 intake 侧问题）；
 * 2. 查 active 订阅（含未过期）；无订阅者 → final_disposition=orphaned（计数告警由
 *    调用方按 outcome 记，不应发生）；
 * 3. 逐订阅者经 host RPC 投 CommandInbox，lane 透传（§3.1 车道表权威，本层不改车道）；
 * 4. 回执全为 admitted|duplicate 才落 final_disposition=routed；出现 rejected 则
 *    终态不落（保持 NULL 未决）并以 outcome=delivery_failed 暴露失败——启动重放扫描
 *    （§4 流五 3）只覆盖未决行，误落 routed 会让事件永无重试路径且审计失真。
 * 不查 mandate、不进攒批、不构造任何模型调用（A1）。
 */
export async function routeOwned(
  deps: EventRouterDeps,
  triggerId: string,
): Promise<RouteOwnedOutcome> {
  const now = deps.now?.() ?? Date.now();
  const event = getTriggerEvent(deps.db, triggerId);
  if (!event) return { kind: "not_found", triggerId };

  // 回复出站门：带 chengJobId 的 owned 事件先求真实 gate；红 gate 静默丢弃，
  // final_disposition=record_only（owner 无订阅投递）。
  const gate = await evaluateTriggerOutboundChengGate(event, {
    resolveGate: deps.resolveGate,
  });
  if (!gate.allowed) {
    setTriggerEventFinalDisposition(deps.db, triggerId, "record_only", now);
    return { kind: "gate_blocked", triggerId, reason: gate.reason };
  }

  const subscribers = deps.subscriptions.listActive(
    event.workspaceIdentity,
    event.threadKey,
    now,
  );
  if (subscribers.length === 0) {
    setTriggerEventFinalDisposition(deps.db, triggerId, "orphaned", now);
    return { kind: "orphaned", triggerId };
  }

  const text = extractPayloadText(event.payload, TRIGGER_DISPATCH_TEXT_MAX_CHARS);
  const deliveries: TriggerDeliveryReceipt[] = [];
  for (const subscriber of subscribers) {
    const receipt = await deps.delivery.deliver({
      sessionId: subscriber.sessionId,
      commandId: triggerDeliveryCommandId(triggerId, subscriber.sessionId),
      triggerId,
      taint: event.taint,
      lane: subscriber.lane,
      text,
      workspaceIdentity: event.workspaceIdentity,
    });
    deliveries.push(receipt);
  }
  // 任一订阅者被拒（宿主冷启动/会话未 hydrate 等）→ 行保持未决：不落终态，留给
  // 启动重放/告警覆盖；已 admitted 的订阅者重放时由 commandId 幂等吸收，不双跑。
  const hasRejected = deliveries.some(
    (receipt) => receipt.status !== "admitted" && receipt.status !== "duplicate",
  );
  if (hasRejected) {
    return { kind: "delivery_failed", triggerId, deliveries };
  }
  setTriggerEventFinalDisposition(deps.db, triggerId, "routed", now);
  return { kind: "routed", triggerId, deliveries };
}
