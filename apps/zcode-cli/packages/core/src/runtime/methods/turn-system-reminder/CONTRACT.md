# cli-turn-system-reminder

回合级隐藏 system reminder 队列：super-agent 等回合并发车道把一次性指导信息送进 worker 上下文的唯一入口。

## 不变量

- 一次性：队列整体取空（drain 后即删），每条提醒只在该 turn 的下一次模型请求生效。
- turn 局部：drain 按 turnId 精确匹配；上一回合遗留条目按丢弃语义清除，永不过期重放。
- 源约束：只接受 `SYSTEM_REMINDER_PER_REQUEST_SOURCES` 内的已注册源；持久生命周期源在入队时抛错，避免与源声明的持久化契约矛盾。
- 隐身：条目转 `<system-reminder>` 附件进 turn-local request history，不进 canonical 历史、不出现在 UI 消息流。
- 非空：空 body 在入队时抛错（wrapSystemReminder 对空正文会炸掉整个模型请求，在 API 边界拦住）。

## 与其它模块的交集

- 入口方向：bootstrap 侧车道经 `AgentRuntime.queueTurnSystemReminder`（methods/index.ts 挂载）入队。
- 消费方向：`methods/turn-loop.ts` 在 compaction 之后、请求投影之前调用 `drainQueuedTurnSystemReminders`。
- 投影机制复用 `agent/message-history.ts` 的 `systemReminderAttachmentEntry`，本模块不定义新的投影路径。
