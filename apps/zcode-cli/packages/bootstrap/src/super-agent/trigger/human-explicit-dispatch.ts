import type { DatabaseSync } from "node:sqlite";

import type { DispatchHumanExplicitOutcome } from "./contract.js";
import type { TriggerHostDeliveryPort, TriggerWorkerPort } from "./ports.js";
import { triggerDeliveryCommandId } from "./event-router.js";
import {
  assembleHumanExplicitWakeText,
  extractPayloadText,
  TRIGGER_DISPATCH_TEXT_MAX_CHARS,
} from "./payload-text.js";
import { getTriggerEvent } from "./trigger-events-access.js";
import type { createTriggerSubscriptions } from "./subscriptions.js";

type TriggerSubscriptions = ReturnType<typeof createTriggerSubscriptions>;

export interface HumanExplicitDispatchDeps {
  db: DatabaseSync;
  subscriptions: TriggerSubscriptions;
  worker: TriggerWorkerPort;
  /** host RPC CommandInbox 投递面：worker 在跑（busy）时 lane=guide 行内投递用。 */
  delivery: TriggerHostDeliveryPort;
  now?: () => number;
}

/**
 * Dispatcher.dispatchHumanExplicit（§3.1 human_explicit 边）【免 Mandate、免攒批】。
 *
 * resume-vs-createTask 决策矩阵（spec §2.1 + §1.3 M1 车道语义）：
 * - 无 worker（threadKey 未绑定）            → createTask + 上下文装配
 * - worker 终态且非人为停止                  → resume（保留会话上下文）
 * - worker 终态但人为停止（用户 cancel/stop） → createTask（不复活被停会话）
 * - worker 未终态（仍在跑）                  → TriggerHostDeliveryPort lane=guide
 *   行内投递到在跑会话（M1「busy 时 guide/inject 行内投递」），不新建同 threadKey
 *   平行会话——否则同 thread 双订阅、双会话并行跑同一工作，与 legacy 忙碌时把消息
 *   排进在跑会话的行为背离（A2「与现状持平」），且 findWorkerByThreadKey 对同
 *   threadKey 返回哪个会话变得歧义。在跑会话上下文已在会话内，行内投递只送原文，
 *   不重复装配 M2 冷启动上下文（装配仅为 resume/createTask 服务）。
 *
 * 延迟验收（A2）：createTask/resume 直通注入的既有 worker port，分派器自身只做
 * 决策 + 一次订阅 upsert，不引入模型调用或额外往返——新线程首条直接消息延迟与
 * 现状 bots 私聊 createTask 持平。fast_path decision_log 行由 Intake 在 ingest 时
 * 落（§3.1 步 2），这里不重复落行。
 */
export async function dispatchHumanExplicit(
  deps: HumanExplicitDispatchDeps,
  triggerId: string,
): Promise<DispatchHumanExplicitOutcome> {
  const now = deps.now?.() ?? Date.now();
  const event = getTriggerEvent(deps.db, triggerId);
  if (!event) return { kind: "not_found", triggerId };

  const worker = await deps.worker.findWorkerByThreadKey({
    workspaceIdentity: event.workspaceIdentity,
    threadKey: event.threadKey,
  });
  const text = extractPayloadText(event.payload, TRIGGER_DISPATCH_TEXT_MAX_CHARS);

  // busy 格先行判定：在跑会话走行内投递，不落入 resume/createTask 分支。
  if (worker && !worker.terminal) {
    const receipt = await deps.delivery.deliver({
      sessionId: worker.sessionId,
      commandId: triggerDeliveryCommandId(triggerId, worker.sessionId),
      triggerId,
      taint: event.taint,
      lane: "guide",
      text,
      workspaceIdentity: event.workspaceIdentity,
    });
    // 订阅 = 会话与 thread 的绑定，与本条消息的投递结果无关；upsert 首写者胜，
    // 不会把该会话既有的 guide/inject 车道降级成 followup。
    deps.subscriptions.upsert({
      workspaceIdentity: event.workspaceIdentity,
      threadKey: event.threadKey,
      sessionId: worker.sessionId,
      lane: "followup",
      ownerKind: "session",
      now,
    });
    if (receipt.status === "rejected") {
      // 宿主不可达/会话未 hydrate：响亮暴露，不静默降级成 createTask（那会开平行会话）。
      return {
        kind: "delivery_failed",
        triggerId,
        sessionId: worker.sessionId,
        ...(receipt.reasonCode !== undefined ? { reasonCode: receipt.reasonCode } : {}),
      };
    }
    return { kind: "delivered", triggerId, sessionId: worker.sessionId };
  }

  const wakeText = assembleHumanExplicitWakeText({ text, context: worker?.context });

  let sessionId: string;
  let kind: "resumed" | "created_task";
  if (worker && worker.terminal && !worker.stoppedByHuman) {
    const resumed = await deps.worker.resume({
      sessionId: worker.sessionId,
      triggerId,
      text: wakeText,
      context: worker.context,
    });
    sessionId = resumed.sessionId;
    kind = "resumed";
  } else {
    const created = await deps.worker.createTask({
      workspaceIdentity: event.workspaceIdentity,
      threadKey: event.threadKey,
      triggerId,
      text: wakeText,
      context: worker?.context,
    });
    sessionId = created.sessionId;
    kind = "created_task";
  }

  deps.subscriptions.upsert({
    workspaceIdentity: event.workspaceIdentity,
    threadKey: event.threadKey,
    sessionId,
    lane: "followup",
    ownerKind: "session",
    now,
  });
  return { kind, triggerId, sessionId };
}
