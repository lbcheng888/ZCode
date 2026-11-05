/**
 * super-agent 组合根的宿主端口适配器（里程碑 A / B-SPEC §3.3–§3.4）。
 *
 * 从 `super-agent-control-plane.ts` 拆出的职责分离：本文件只做「宿主既有能力 →
 * trigger 端口」的形态转换（CommandInbox admission 信封、worker 唤醒投递），
 * 不持有控制面生命周期/租约/派发桥状态。组合根 re-export 保持既有 import 面不变。
 *
 * 这些适配器是生产代码：`handleCommand` 由宿主注入真实 CommandInbox（协议宿主
 * gateway / daemon 反向 RPC），测试注入脚本化替身仅存在于测试代码。
 */
import type { DatabaseSync } from "node:sqlite";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

import {
  createTriggerSubscriptions,
  triggerDeliveryCommandId,
  type DispatchPushCommand,
  type DispatchPushOutcome,
  type DispatchPushPort,
  type TriggerHostDeliveryPort,
  type TriggerWorkerPort,
} from "../super-agent/trigger/index.js";
import type { SuperAgentCommandHandle, SuperAgentSessionFace } from "./super-agent-control-plane.js";

const SUPER_AGENT_CLIENT_ID = "super-agent-trigger";
const DISPATCH_CLIENT_ID = "super-agent-dispatch";

function buildSendTextEnvelope(input: {
  commandId: string;
  sessionId: string;
  text: string;
  requestedDelivery?: "startNow" | "queue" | "guide";
  clientId: string;
  triggerId?: string;
  taint?: boolean;
  now: number;
}): CommandEnvelope {
  return {
    commandId: input.commandId,
    clientId: input.clientId,
    sessionId: input.sessionId,
    type: "sendText",
    payload: {
      text: input.text,
      ...(input.requestedDelivery ? { requestedDelivery: input.requestedDelivery } : {}),
    },
    issuedAt: input.now,
    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    ...(input.taint !== undefined ? { taint: input.taint } : {}),
  };
}

function receiptFromAck(ack: CommandAck): DispatchPushOutcome {
  if (ack.status === "accepted") return { status: "admitted" };
  if (ack.status === "duplicate") return { status: "duplicate" };
  return {
    status: "rejected",
    ...(ack.reasonCode !== undefined ? { reasonCode: ack.reasonCode } : {}),
  };
}

/**
 * EventRouter / human-explicit 分派器的投递面（spec §2.1 TriggerHostDeliveryPort）：
 * TriggerDeliveryInput → sendText 信封 → CommandInbox 唯一 admission，回执映射
 * admitted|duplicate|rejected。lane 映射按 M1 车道表（wire 面只有 startNow/queue/guide）：
 * followup→queue（idle 起轮 / busy 入队待 autoDrain）、guide→guide（步边界行内）、
 * inject→拒绝（wire schema 无 inject 面，P2 生产订阅只产 followup；见 spec 实施偏差）。
 */
export function createCommandInboxTriggerDelivery(options: {
  handleCommand: SuperAgentCommandHandle;
  now?: () => number;
}): TriggerHostDeliveryPort {
  const now = options.now ?? Date.now;
  return {
    async deliver(input) {
      if (input.lane === "inject") {
        // 响亮拒绝而非静默改车道：inject≠queue 是 M1 语义（不唤醒），错投会唤醒。
        return {
          status: "rejected",
          reasonCode: "proto.deliveryLaneUnsupported",
        };
      }
      const requestedDelivery: "queue" | "guide" = input.lane === "guide" ? "guide" : "queue";
      const ack = await options.handleCommand(
        buildSendTextEnvelope({
          commandId: input.commandId,
          sessionId: input.sessionId,
          text: input.text,
          requestedDelivery,
          clientId: SUPER_AGENT_CLIENT_ID,
          triggerId: input.triggerId,
          taint: input.taint,
          now: now(),
        }),
      );
      return receiptFromAck(ack);
    },
  };
}

/**
 * 派发桥 push 端（spec §1.6 / M7②，dispatchBridgePort 注释：milestone A 的 push =
 * host 进程内 CommandInbox 直推生产适配器）。admission 回执即 ACK：admitted/duplicate
 * 转发 onHostAck settle dispatched；rejected 不 ACK（行保持 pushed，按崩溃重投续推）。
 */
export function createCommandInboxDispatchPush(options: {
  handleCommand: SuperAgentCommandHandle;
  /** 结构 = SuperAgentDispatchBridgeContract.onHostAck；组合根接同一桥实例。 */
  onHostAck?: (commandId: string, outcome: "admitted" | "duplicate") => void;
  /** 宿主可达判定（daemon child 传 Core 通道状态）；缺席视为注入即可达。 */
  isHostReachable?: () => boolean;
  now?: () => number;
}): DispatchPushPort {
  const now = options.now ?? Date.now;
  return {
    ...(options.isHostReachable ? { isHostReachable: options.isHostReachable } : {}),
    async push(command: DispatchPushCommand): Promise<DispatchPushOutcome> {
      if (command.sessionId === null) {
        // 无目标会话无法构成 sendText admission；响亮拒绝，不向空会话刷推送。
        return { status: "rejected", reasonCode: "dispatch.sessionRequired" };
      }
      if (command.payload === null || command.payload.length === 0) {
        return { status: "rejected", reasonCode: "dispatch.payloadMissing" };
      }
      const ack = await options.handleCommand(
        buildSendTextEnvelope({
          commandId: command.commandId,
          sessionId: command.sessionId,
          text: command.payload,
          clientId: DISPATCH_CLIENT_ID,
          now: now(),
        }),
      );
      const receipt = receiptFromAck(ack);
      if (receipt.status === "admitted" || receipt.status === "duplicate") {
        options.onHostAck?.(command.commandId, receipt.status);
      }
      return receipt;
    },
  };
}

/**
 * 单会话宿主的默认 worker 装配面（spec §2.1 TriggerWorkerPort；M2 分派器只做决策，
 * 会话面经此注入）。查订阅定 worker，resume/createTask 一律经 CommandInbox 投递——
 * 触发输入不旁路唯一 admission（M1）。
 *
 * - 订阅命中本会话 → terminal = face.isIdle()；stoppedByHuman 恒 false：本组合根没有
 *   「人为停止」事实面（cancel 史在 runtime 控制面未暴露），且单会话下 resume 与
 *   createTask 同为「向本会话提交唤醒输入」，语义差仅在多会话宿主（其注入完整 worker）。
 * - 订阅只命中外部会话 → terminal 恒 false（跨组合根不可观测终态）：走 M1 busy 行内
 *   投递，由目标会话 admission 裁决，不冒充 resume、不建平行会话。
 * - 不供 `context`（M2 上下文装配缺口，spec §8-5 登记）：同会话唤醒时目标摘要与历史
 *   已在会话内，再拼一份属冗余投喂；装配随宿主注入完整 worker 批启用，本缺省面不拼装。
 */
export function createInProcessTriggerWorkerPort(options: {
  database: DatabaseSync;
  face: SuperAgentSessionFace;
  handleCommand: SuperAgentCommandHandle;
  now?: () => number;
}): TriggerWorkerPort {
  const now = options.now ?? Date.now;
  const subscriptions = createTriggerSubscriptions(options.database);

  const submitWake = async (sessionId: string, triggerId: string, text: string): Promise<void> => {
    const ack = await options.handleCommand(
      buildSendTextEnvelope({
        // 幂等键 = triggerId+sessionId（§1.3 fan-out）：同一触发对一会话至多一条输入。
        commandId: triggerDeliveryCommandId(triggerId, sessionId),
        sessionId,
        text,
        requestedDelivery: "queue",
        clientId: SUPER_AGENT_CLIENT_ID,
        triggerId,
        // 触发事件恒 taint=1（§1.2；intake 对非 true 直接抛错），唤醒文本源自 trigger payload。
        taint: true,
        now: now(),
      }),
    );
    if (ack.status !== "accepted" && ack.status !== "duplicate") {
      throw new Error(
        `super-agent worker 唤醒投递被拒: ${ack.reasonCode ?? ack.status}（triggerId=${triggerId}）`,
      );
    }
  };

  return {
    findWorkerByThreadKey(input): ReturnType<TriggerWorkerPort["findWorkerByThreadKey"]> {
      const active = subscriptions.listActive(input.workspaceIdentity, input.threadKey, now());
      const own = active.find((row) => row.sessionId === options.face.sessionId);
      const bound = own ?? active[0];
      if (!bound) return undefined;
      if (bound.sessionId !== options.face.sessionId) {
        return { sessionId: bound.sessionId, terminal: false, stoppedByHuman: false };
      }
      return {
        sessionId: bound.sessionId,
        terminal: options.face.isIdle(),
        stoppedByHuman: false,
      };
    },
    async resume(input) {
      if (input.sessionId !== options.face.sessionId) {
        // 只可能发生在宿主注入的 worker 与默认实现混用时：响亮失败，不静默改投。
        throw new Error(
          `super-agent worker.resume 越出本组合根会话: ${input.sessionId}（需宿主注入完整 worker port）`,
        );
      }
      await submitWake(input.sessionId, input.triggerId, input.text);
      return { sessionId: input.sessionId };
    },
    async createTask(input) {
      await submitWake(options.face.sessionId, input.triggerId, input.text);
      return { sessionId: options.face.sessionId };
    },
  };
}
