// ============================================================
// 回合级隐藏 system reminder 队列（queueTurnSystemReminder）
// ============================================================
// super-agent 等回合并发车道把一次性指导信息送进 worker 上下文的唯一入口：
// body 在指定 turn 的下一次模型请求以 `<system-reminder>` 附件注入（复用
// systemReminderAttachmentEntry 的投影机制），不进 canonical 历史、不出现在
// UI 消息流；drain 按 turnId 过滤，不匹配即丢弃（turn 结束未消费即丢弃）。

import {
  isKnownSystemReminderSource,
  systemReminderAttachmentEntry,
} from "../../../agent/message-history.js";
import { SYSTEM_REMINDER_PER_REQUEST_SOURCES, type SystemReminderSource } from "../../../system-reminder/source.js";
import type { TurnId } from "../../deps.js";
import { traceContextToLogContext } from "../../deps.js";
import type { AgentRuntimeInternal } from "../../internal.js";
import type { QueueTurnSystemReminderInput } from "./contract.js";
import type { RegularTurnLoopState } from "../turn-loop-state.js";
import { appendTurnRequestEntries } from "../turn-output-token-continuation.js";

interface QueuedTurnSystemReminder {
  turnId: TurnId;
  source: SystemReminderSource;
  body: string;
}

// 队列挂在 WeakMap 而不是 runtime 字段：一次性的进程内注入通道，不为它扩
// AgentRuntimeInternal 面（先例：turn-model.ts publishedSelections、events.ts pendingSessionPersistence）。
const pendingReminders = new WeakMap<AgentRuntimeInternal, QueuedTurnSystemReminder[]>();

const PER_REQUEST_SOURCES = new Set<string>(SYSTEM_REMINDER_PER_REQUEST_SOURCES);

/**
 * 入队一条隐藏提醒：在该 turn 的下一次模型请求生效，一次性消费。
 * source 限定 per-request 提醒源——本队列只做 turn-local 注入，不接受持久生命周期的源，
 * 否则条目与该 source 声明的持久化契约矛盾；未知源在投影层会直接炸请求，入队时拦住。
 */
export function queueTurnSystemReminder(
  this: AgentRuntimeInternal,
  input: QueueTurnSystemReminderInput,
): void {
  if (!isKnownSystemReminderSource(input.source) || !PER_REQUEST_SOURCES.has(input.source)) {
    throw new Error(
      `queueTurnSystemReminder: source "${input.source}" 不是已注册的 per-request system-reminder 源`,
    );
  }
  // wrapSystemReminder 对空正文抛错，空 body 入队会炸掉整个模型请求；在 API 边界拦住。
  if (input.body.trim().length === 0) {
    throw new Error("queueTurnSystemReminder: body 不能为空");
  }
  const queue = pendingReminders.get(this) ?? [];
  queue.push({ turnId: input.turnId, source: input.source, body: input.body });
  pendingReminders.set(this, queue);
}

/**
 * 回合循环每次迭代消费一次：compaction 之后、请求投影之前调用，保证刚入队的提醒
 * 不被本轮 compact 吞掉。匹配 turnId 的条目转成附件进 turn-local request history；
 * 不匹配的条目（上一回合遗留）按丢弃语义清除。队列整体取空，天然一次性。
 */
export function drainQueuedTurnSystemReminders(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): void {
  const queue = pendingReminders.get(runtime);
  if (!queue || queue.length === 0) return;
  pendingReminders.delete(runtime);
  const matching = queue.filter((item) => item.turnId === state.turnId);
  if (matching.length === 0) return;
  appendTurnRequestEntries(
    state.turnRequestState,
    matching.map((item) => systemReminderAttachmentEntry(item.source, item.body)),
  );
  runtime.logger?.debug("Queued turn system reminder injected", {
    ...traceContextToLogContext(state.turnTraceContext),
    event: "turn.system_reminder.drained",
    injected: matching.length,
    discarded: queue.length - matching.length,
    sources: matching.map((item) => item.source),
  });
}
