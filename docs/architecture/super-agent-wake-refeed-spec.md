# Super-agent 终态唤醒再投喂（wake re-feed）实施规格

状态：实施级 spec（对应 [super-agent-harness-design.md](./super-agent-harness-design.md) M7① / Phase 1「持久底座」）。与设计文档冲突时以设计为准。

## 0. 缺口与不变量

现状：`enqueueBackgroundTaskNotification` 把后台唤醒写进 durable 账本（`session_input`，kind=`backgroundNotification`，admitted）；冷 resume 的 `discardPersistedPendingSteerInputs` 把残留 admitted 收口为 `discarded(session_resumed)`——**可追责、不可恢复**：进程死亡时已终态的 workflow run，其窄结果通知永不投递，worker 等死。

硬不变量：

1. 现有 discard 语义不动：user/steer 输入的收口、`TurnSteerDiscarded` 投影收口均不变。
2. 死主体不重投：`backgroundSource` 为 `bash` / `subagent` 的 wake 保持 `discarded(session_resumed)`，账本审计保留。
3. 重投 exactly-once：稳定幂等键 claim-once；同一 run 重复 resume、崩溃前后重入都不双投（宁可窄窗口不丢失，不可重复投递）。
4. 只重投**终态窄结果**：`originMeta.workflowNotification.kind === "terminal"`。escalation / hole / stall / blocked 提醒不重投——它们可从 journal/时钟重导出，且崩溃前的 qid/时钟在重启后已陈旧，重投是错的。

## 1. 状态所有者

| 事实 | 所有者 | 说明 |
| --- | --- | --- |
| wake 事实（谁被唤醒过、投没投出去） | `session_input` 账本（CLI persistence 适配层，唯一写者） | admitted → promoted / discarded；upsert 不复位 status，settle/promote 只认 admitted |
| 主体可恢复性（run 还在不在、终态有没有结果） | workflow journal（dynamic-workflow 引擎） | core 只经 `DynamicWorkflowRunPort.getTask` 只读查询，不直读 journal |
| 投递 | runtime command queue（纯内存） | 命令 id = 幂等键，promote 时账本结算 |
| 重投判定 | core runtime 新 helper | resume 链唯一调用点；单 runtime 单写者，不新增状态 |

## 2. 判定与幂等

> **读法标注（对设计原文的显式收敛，待设计方确认）**：设计文档 M7① 与关键流五写「冷恢复时从 registry/journal 把已终态未消费的窄结果重新 enqueue」。本实现收敛为**账本驱动 + journal 校验**：候选集只来自账本 `discarded(session_resumed)` 行（「曾被 wake 且未消费」的唯一事实来源），journal 只判主体可恢复性。纯 journal 枚举分不清 policy 抑制 / TaskOutput 已消费 / 从未 wake（`background-tasks.ts` 的 claim 抑制路径），会错投；反面代价是「journal 终态但 wake 行从未落库」的窗口不被覆盖。已确认（2026-11-02，设计方）：账本驱动 + journal 校验成立，设计文档 M7① 与关键流五措辞已同步为此收敛。

重投扫描（`refeedRecoverableBackgroundWakes`，在 resume 的 sweep 之后执行）：

1. `listSessionInputs({ sessionID })` 一次全量：候选 = kind `backgroundNotification` 且 status `discarded` 且 statusReason `session_resumed`；同一份结果同时充当 claim 集合（见下）。
2. `payload.taskId` 必须是非空字符串（派生键的原料）。
3. `payload.originMeta.backgroundSource === "workflow"`；bash/subagent/缺失 → 保持丢弃。
4. `payload.originMeta.workflowNotification.kind === "terminal"`；escalation/hole/stall/blocked/缺失 → 保持丢弃。
5. 内存命令队列去重：队列中已有同 `taskId` **且同 text** 的 pending `task-notification` 命令（同实例二次 resume 且原 wake 命令未消费；只按 taskId 会误匹配同 run 的 stall/progress 提醒而误 claim 丢投）→ 不再入队第二条，但**代写 claim 行**——投递责任已由在队命令承担，若不落 claim，后续 resume 会在原命令消费后再次重投（原行已被 sweep 收口、promote 空转）。不计重投数。
6. journal 判别 `dynamicWorkflowRunPort.getTask(taskId)`：
   - `undefined`（主体已死/未知）→ 保持丢弃；
   - `runStatus` 为终态（`completed` / `errored` / `stopped`）且非 `stopped(superseded)` → 可恢复，重投；`superseded` 的工作已归后继 run，重投是错的；
   - `running` / `pending` / `lost`（非终态）→ 不重投（该 wake 对应的生命周期已过，新生命周期自带通知）；
   - port 缺席或 `getTask` 抛错 → 保持丢弃（fail-closed，审计优先）。

幂等键：`refeed_<taskId>`。taskId 即 workflow runId（uuid 全局唯一），`session_input.id` 是全局主键，无跨会话碰撞。

claim-once：账本存在 id = 幂等键的行（**任意状态**）→ 跳过。依据账本语义：

- `saveSessionInput` upsert 冲突只更新 kind/delivery/payload，**不复位 status**；
- `settleSessionInput` / `markSessionInputPromoted` 只认 admitted。

因此键行一旦落库即为认领凭证，不可复活——`promoted` = 已消费；`discarded` = 上次重投入队后、消费前再次崩溃（窄窗口）→ 不重复优先于不丢失，保持丢弃。键行经既有 `enqueueBackgroundTaskNotification` 的 claim 路径写入（`persistBackgroundTaskNotificationClaim`），不新增写路径；常规（非重投）wake 的账本行仍是 fire-and-forget 审计痕迹，语义不同。

**claim-first 顺序（硬要求）**：重投路径必须**先 await claim 键行落库、确认成功，再 enqueueRuntimeCommand**；写失败则不入队、不认领（键行缺位 ⇒ 下次 resume 重试）。若先入队后写账本，写失败时通知已投递而键行缺位，下一次 resume 会把同一条 wake 再投一次——at-most-once 退化为 at-least-once。顺序由代码保证，不依赖同步存储的时序。claim 落库成功后入队携带 `claimPersisted: true`，`enqueueBackgroundTaskNotification` 跳过重复的账本写。

## 3. 接口

- `enqueueBackgroundTaskNotification` 的 notification 参数增加可选 `commandId`：在场时作为 runtime 命令 id 与账本行 id（幂等键），缺席时维持 `createRuntimeCommandId()` 进程内序列——既有调用方零改动（签名保持同步 `void`，常规路径行为不变）。
- 新增 `persistBackgroundTaskNotificationClaim(input): Promise<boolean>`（`background-notifications.ts` 导出）：claim 键行落库，成功 `true`；账本缺席/写失败 `false`（fail-closed，调用方不入队）。重投路径先 await 它，成功后以 `claimPersisted: true` 调 `enqueueBackgroundTaskNotification`（跳过重复账本写）。
- 新文件 `packages/core/src/runtime/methods/background-wake-refeed.ts` 导出 `refeedRecoverableBackgroundWakes(traceContext): Promise<number>`（返回重投条数）；由 `resume.ts` 直接 import 调用（`.call(this, ...)`，同 `restoreDynamicWorkflowActivationOnResume` 先例），不改 `internal-methods.ts` / `methods/index.ts`。
- 调用点：`resumeFromStore` 在 `SessionResumed` 事件落库与 session-start hooks 完成之后、返回之前调用——重投入队即触发 `drainRuntimeCommandQueue`，通知回合不得先于 SessionResumed 进入事件流。
- helper 自身吞掉扫描/查询错误（warn 日志、返回 0），resume 主链不因重投失败而失败；与 sweep 的既有容错一致。

## 4. 验收场景

1. **崩溃 + 终态 workflow wake 残留**：admitted 的 terminal workflow wake 随进程死亡残留 → resume sweep 收口 `discarded(session_resumed)` 后，同一 resume 内重投恰好一次（幂等键行落库 + 队列一条 task-notification 命令）；紧接着再 resume 一次，仍是一次。
2. **死 bash wake**：`backgroundSource: "bash"` 的 admitted wake → resume 后保持 `discarded(session_resumed)`（审计可查），零重投、journal 不被查询。
3. **已消费 wake**：wake 已 `promoted`（通知先前已投递）→ 不在候选集，零重投。
4. **claim 写失败不入队**：claim 键行落库 reject → 零入队（队列无 task-notification）、无 claim 行，候选保持 discarded 待下次 resume 重试；恢复写入后下一次 resume 恰好一次。
5. **同实例队列已有同 taskId 同 text 通知**：内存队列 pending 一条同 taskId 且同 text 的 task-notification（原 wake 未消费）→ 不入队第二条，但代写 claim 行；后续 resume 不再重投。

Phase 1 总验收（设计 §7）：kill -9 时在途已完成 workflow 的 task-notification 重启后可达且不重复；死任务 wake 丢弃留审计。

## 5. 边界（本 spec 不做）

- 不修改 adapters 账本语义（不复活 discarded 键行、不加 TTL）。
- 不重投 escalation/hole/stall/blocked 提醒；不为死 Bash/subagent 建恢复机制。
- 不改 `discardPersistedPendingSteerInputs` 本体；重投是 sweep 之后的独立一步。
