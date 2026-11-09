# Goal Swarm：目标回合的并行蜂群

状态：已实现。代码在 `apps/zcode-cli/packages/core/src/runtime/swarm/`，登记为 `swarm-runtime` 模块
（`swarm/module.ts:1-10`），唯一调用方是 target 生命周期（`swarm/contract.ts:1-18`）。本文只描述当前
代码，不把未落地能力写成承诺。

## 状态机

```text
round_started → decomposed → task_result* → round_completed
round_started → round_completed(error)        # 分解失败/取消：没有 decomposed
```

- `round_started`：git 前置、orphan 清理、checkpoint 读取之后，分解调用之前写入（`swarm-orchestrator.ts:184-190`）。
- `decomposed`：响应非空、非 `finishReason=length`、严格通过 2-5（续跑 1-5）校验后写入；结构不符直接抛错，
  不修补（`:237-250`）。
- `task_result`：每个已准备 worker 终态收口后按输入顺序逐条写；`done`/`failed`/`cancelled`，completed 正文
  截断 2k，失败保留原始 error（`:542-571`）。
- `round_completed`：`round_started` 已落盘且本轮收口后写入；只尝试一次，成功落盘时恰好一条，成功后带
  completed/failed/output，失败/拒绝带 error（`swarm-journal.ts:215-248`）。`round_started` 之后的分解失败、
  Stop 取消或异常都走 catch 路径：`completedTaskIds=[]`，`failedTaskIds` 只收已返回的非 completed 结果，
  error 为原始错误文本（`swarm-orchestrator.ts:383-404`）。此时没有 `decomposed`，投影得到
  `totalUnits=0` 且 `interrupted=true`，UI 仍显示「已中断」。

前置失败（非 git 仓库、无 HEAD、基准树脏、目录在仓库外）发生在 `round_started` 之前，不写 journal，以
`ConfigurationError(recoverable:false)` 停住（`swarm-worktree.ts:82-108`）。

结局：成功或部分成功时聚合器返回 completed 与失败清单，失败 worker 不算执行证据，预算未翻越时目标保持
active（`swarm-aggregator.ts:35-89`）；全部失败时聚合器抛错并保留 worker 原始 cause，目标身份/版本/状态
未变时 pause，reason 为 `swarm_execution_failed: ...`，随后错误上抛（`swarm-aggregator.ts:66-83`、
`target-continuation.ts:47-76`）；全部取消抛 `SwarmRoundCancelledError`，Stop 或目标已变化时 skip；进程
中断则没有 `round_completed`，checkpoint `completed=false`，下一轮只把中断轮当分解提示，不重放产出。

## 不变量

1. **每次 merge 前 revision CAS**：每份 `merge()` 前重读权威目标，要求 targetID、revision、status
   (`active`) 与取消位全部一致，否则拒绝本份及后续回写（`target-continuation.ts:223-237`）；轮末再复核
   targetID/revision，防止旧轮产出进入新 objective 的提示。
2. **拒绝即丢弃未合并 worktree**：从当前 index 起的 completed 改 cancelled，逐份 `dispose()` 清工作树，再写
   `task_result` 与唯一 `round_completed`；index 之前已合并的结果保留（`swarm-orchestrator.ts:603-657`）。
3. **merge 失败先 abort**：`git merge` 失败后检查 `MERGE_HEAD`，存在则 `git merge --abort`，abort 自身失败
   时两个错误都写进抛出消息（`swarm-worktree.ts:374-392`）；冲突由 `merge-tree --write-tree` 预检发现，
   此时尚未改基准树。
4. **一个 worker 一个 worktree**：每任务在 `git worktree add --detach <HEAD>` 的独立目录执行，cwd 与
   workspaceRoot 都映射到该目录；建树失败只让该任务 failed，绝不回落共享目录
   （`swarm-orchestrator.ts:407-434`、`swarm-worktree.ts:31-69`）。
5. **预算含失败 worker**：分解 token 在解析前记账；轮末累加全部终态 worker（completed/failed/cancelled）的
   真实 token，闸门拒绝路径也累加；elapsed 在 `finally` 统一累加。失败 worker 的 usage 只从错误对象读取，
   不估算（`swarm-orchestrator.ts:232-235`、`:321-330`、`:625-633`）。
6. **journal 单轮一条 `round_completed`**：轮级标志先置位再落盘，catch 与闸门拒绝路径共用；落盘失败只记
   warning，不撤销已确定产出（`swarm-journal.ts:215-248`、`swarm-orchestrator.ts:383-404`）。前提是
   `round_started` 已落盘；进程崩溃或 `round_completed` 落盘失败时，journal 里可能没有该事件（后者记
   warning）。

## 隔离威胁模型

`SwarmWorkspace.boundary` 是整棵隔离工作树的根（`swarm-worktree.ts:211-232`）；编排层把它写入
`SwarmTask.workspaceBoundary`（`swarm-orchestrator.ts:453-459`），`SwarmWorker` 再写入
`SubagentRunRequest.workspaceBoundary`（`swarm-worker.ts:232-250`），沿
`SubagentPort → child runtime`（`runtime/methods/subagent.ts:323-326`、`subagent/runner.ts:1319-1322`）进入
ToolExecutor，最终由 `path-policy.ts` 判定（`tool/executor/call-runner.ts:567`）。非隔离调用方
（测试/直接 runSwarm）没有 boundary 时，worker 回退 `task.workspaceRoot`，保持旧语义。

强制范围是**文件工具 + 显式 cwd**：Read/Write/Edit/ApplyPatch/Glob/Grep 的路径都过
`resolveWorkspacePath`（`tool/handlers/read.ts:177-183`、`write.ts:87-93`、`edit.ts:120-126`、
`apply-patch.ts:296-307`、`glob.ts:43-56`、`grep.ts:51-63`），Bash 初始 cwd 与默认工作目录都过
`resolveToolWorkingDirectory`，边界外 cwd 在 spawn 前被拒绝（`path-policy.ts:72-96`）。判定逐段
`lstat` 并展开 symlink，dangling target 也按 readlink 解析，循环或超过解析上限 fail-closed
（`path-policy.ts:146-234`）。空串、相对路径、不存在或非目录都 fail-closed 抛 `ConfigurationError`
（`:98-144`）；边界缺席表示普通会话，只有 swarm worker 请求会设置它（`runtime/types.ts:283-287`、
`contracts/interfaces/subagent.port.ts:24-27`）。

**残余逃逸**：`workspaceBoundary` 不解析 Bash 命令字符串，`cd /绝对路径`、绝对路径参数、子 shell、`git -C`
等仍可在工作树外读写（`path-policy.ts:9-21`）。它是“文件工具不误越界 + 合并只走 worktree”的完整性边界，
不是命令级沙箱，也不提供机密性隔离；命令在工作树外的副作用不会被 `git add -A` 捕获，也不会进入 merge。

**`git add -A` 语义**：merge 在隔离工作树根执行 `git add -A -- .`（`swarm-worktree.ts:235-311`），捕获的是
该 worker 私有工作树内的全部改动，包括映射 `workspaceRoot` 之外的路径。Bash 命令字符串不解析，`cd` 到
工作树内任意目录的写入同样落在这棵树里并被提交。这些改动只存在于该工作树，随后以单个 commit 经 merge
进入基准树；边界设为工作树根后，worker 的文件工具无法写到基准树或其它 worker 的工作树，因此
`git add -A` 不会把边界外的改动带进本轮回写。工作树根的 `.git` 指针文件本身也在边界内：merge 在
`git add` 前校验它仍指向建树时登记的 worktree gitdir，并用该 gitdir 显式执行 add/commit
（`swarm-worktree.ts:235-263`、`:339-372`）；文件工具改写指针会被 fail-closed 拒绝，提交不会落到基准分支。

**clean base 前置条件**：轮前必须是 git 仓库、有 HEAD commit、`git status --porcelain` 为空、
`workingDirectory`/`workspaceRoot` 都在仓库内（`swarm-worktree.ts:82-108`）；每份 merge 前闸门通过后还要
重跑 `assertSwarmBaseClean`，脏树按 superseded 拒绝（`swarm-orchestrator.ts:576-597`）。检查与
`git merge` 之间仍有 TOCTOU 窗口，没有跨进程锁。

## 合并策略

按输入顺序串行合并（`swarm-orchestrator.ts:490-573`）：工作树内 `git add -A -- .`，有 staged 变化才提交
（固定身份 + `--no-verify`）；`git merge-tree --write-tree` 预检，退出码 1 视为冲突；干净才在基准树执行
`git merge --no-ff --no-verify`，失败按上节 abort；每个 worker merge 后 `dispose()`，清理失败只附
`workspaceCleanupError`，不反标已成功回写的任务（`swarm-worktree.ts:235-311`）。

冲突只败该任务：冲突 worker 记 failed，其余继续执行/合并，聚合器返回部分成功与失败清单；已合并的前序
提交不会因后续冲突回滚。**没有整轮回滚**：不存在跨 merge 事务、saga 或 revert。闸门中途拒绝时，前序已
合并提交保留，剩余未合并结果改 cancelled 并清工作树，但本轮以 `SwarmRoundSupersededError` 抛出，不返回
evidence（`swarm-orchestrator.ts:521-558`、`:603-657`）。因此“部分成功”只适用于正常聚合路径；闸门拒绝
路径是“已合并保留 + 本轮失败收口”。

## 恢复语义

journal 只追加：从最近 `round_started` 起回放，`task_result` 按 taskId 取最后一次，见到 `round_completed`
才标 completed（`swarm-journal.ts:49-129`）。恢复使用两条独立事实：

- **checkpoint 用于分解提示**：最近一轮未完成且 objective 完全一致时，把它传给下一轮分解；
  `formatSwarmResumeContext` 合并 `completedTaskIds` 与 per-task `done` 结果，列出已完成项并要求模型不要
  重复，同时把 schema/解析下限降为 1（`swarm-orchestrator.ts:684-691`、`swarm-journal.ts:145-171`）。
- **orphan 清理不依赖 checkpoint**：每轮启动扫描 `/tmp/zcode-swarm-*`，跳过 owner pid 仍存活、本身是 git
  仓库或缺 owner/worktree 标记的目录；确认孤儿后 `worktree remove --force`、删除临时根、`worktree prune`。
  清理失败只记 warn，不阻塞本轮（`swarm-worktree.ts:136-197`、`swarm-orchestrator.ts:694-726`）。

**未合并结果不重放**：`runSwarm` 不接收 checkpoint，也不会按 checkpoint 复用或跳过 task；每轮都执行新
分解出的任务。checkpoint 只是提示模型“这些已完成，不要再排”，是提示级去重，不是运行时 exactly-once。
进程若在 `git merge` 成功之后、`task_result` 落盘之前崩溃，基准树会留下已合并但未记账的提交，下一轮可能
重做这部分工作；这是 at-least-once 行为。`task_result`/`round_completed` 落盘失败只进入
`journalWarnings` 并带入 goal 提示，不反转已确定结果；`round_started`/`decomposed` 落盘失败会中止本轮
（`swarm-journal.ts:202-287`、`swarm-evidence.ts:45-75`）。

## UI 数据链与 Stop

```text
SwarmRoundJournal → ProductProjection.onSwarmRoundJournal
  → snapshot.swarmActivity（含 units）→ SessionPane → ComposerStatusChips
```

`SessionEventType.SwarmRoundJournal` 是蜂群轮事实的唯一事件源（`contracts/events/session.events.ts:186-188`）；
Projection 在 `applyEventInternal` 中路由（`bootstrap/src/zcode-protocol-v4/product-projection.ts:1739-1740`）。
`round_started` 重置计数、发布空 units、置 `canStop=true`；`decomposed` 生成逐 worker 的 `running` 行；
`task_result` 按 `${roundId}:${taskId}` 只推进一次；`round_completed` 收口计数、把仍未终态的行按
cancelled 收口并清 `canStop`，带 `error` 时置 `interrupted`（`product-projection.ts` 的
`onSwarmRoundJournal`）。`Subagent*` 事件只给 `decomposed.taskToolCallIds` 命中的在途行补
`agentId`/`childSessionId` 与最近消息；spawn 不再写 `currentActivity`。终态收口点（`task_result`、
`round_completed`、`SessionResumed`）一并剥掉 `currentActivity`/`lastMessage`；迟到 spawn 只命中
running/pending 行，不会把终态行改回 running。
快照键 additive-optional，旧宿主没有该键时 UI 不渲染
（`packages/shared/src/zcode-protocol-v4/snapshot.ts:428-459`）。`round_completed` 后保留终态 units
供回看：宿主保留该键到下一轮 `round_started` 或会话结束，不提前撤键/置零。

`SessionPane` 把 `snapshot.swarmActivity` 传给 `ComposerStatusChips`（`SessionPane.tsx:6005`）。chip 在
`totalUnits>0` 且有 active/中断/units 时显示；`interrupted=true` 且 `totalUnits=0` 的零单元中断轮仍显示
「已中断」指示器，只是不展示计数。有 units 时可展开 `SwarmActivityPanel`，failed/cancelled 行显示原始
error；running 行有最近消息时只展示 lastMessage 副行（不再重复「运行中」状态文案），终态行不渲染
活动/消息；全部收尾但 units 仍在时保留芯片供回看（`ComposerStatusChips.tsx` 的 `buildSwarmChip`/
`SwarmActivityPanel`）。
`round_completed` 的坏计数帧（`completedTaskIds`/`failedTaskIds` 形状非法）不整条丢弃：投影按空数组收口、
照常清 `canStop`、把仍未终态的行标 cancelled，`interrupted` 只由 error 决定
（`product-projection.ts` 的 `onSwarmRoundJournal`）。正常 `round_completed` 不删除该键也不删终态
units；下一轮 `round_started` 用空 units 覆盖。Runtime epoch 恢复时，投影把残留 running 行收口为
cancelled、剥掉实时活动、置 `interrupted` 并清 `canStop`（`product-projection.ts` 的
`onSessionResumed`）。

**Stop 走 foreground execution 取消域**：`round_started` 只发布 `canStop`，没有蜂群专用 stop 命令。UI 的
Stop 带 `expectedForegroundExecutionId` 调 `stop`（`SessionPane.tsx:4740-4765`）；v4 handler 调
`runtime.stopActiveForegroundExecution`，id 不匹配/已 idle 时 noop，成功时 abort 前台 controller 并 pause
active goal（`bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts:315-368`）。该函数只 abort
`activeForegroundExecution.controller`
（`runtime-command-queue.ts:443-480`）；该 signal 就是 target-continuation 的 `abortSignal`，再与
`TargetChanged` 订阅合并成 `swarmAbort`，作为分解与全部 worker 的 `scope.signal`
（`target-continuation.ts:183-209`）。Stop 后预取消 worker 不 spawn，在途请求收到 abort，异步后台 worker
在 `waitForTask` 拒绝后 `stopTask`，回合在聚合/续跑前按取消 skip（`swarm-worker.ts:41-84`、`:93-211`）。

## 与 dynamic-workflow 的边界

当前实现是 **goal 回合专用 core 能力**：`config.swarm` 开启且 goal layer 在场时，`SwarmOrchestrator` 分解
objective、创建 worktree、并行跑子代理并合并；它不读取用户 workflow 脚本，也不调用 workflow run service。
dynamic workflow（dwf）负责用户显式请求的脚本 fan-out：`CreateWorkflow` 提交脚本，run service 管理并发、
run journal、取消与恢复（`docs/dynamic-workflow/launch.md:8-37`）。

两者在目标回合里可同时存在，但不是同一个执行器：goal arm 会激活 on-demand workflow 工具面
（`runtime/methods/target.ts:120-127`、`dynamic-workflow-activation.ts:1-16`），continuation prompt 也在
工具面可用时建议把可枚举、可并行、可机器校验的工作交给 `CreateWorkflow`（`target.ts:383-386`）。这是模型
在回合内的工具选择，不是 `SwarmOrchestrator` 的内部调用；蜂群 worker 不感知 dwf，dwf run 也不共享蜂群的
roundId/journal。长期是否把“目标回合 fan-out”统一到 dwf 执行引擎属于待决策项；本文不承诺迁移。

## 明确未实现

- 没有整轮回滚、跨 merge 事务或 revert；后续失败不会撤销已合并提交。
- 没有 Bash 命令字符串级隔离；`workspaceBoundary` 不是完整沙箱。
- 没有基于 checkpoint 的 worker 结果重放或 exactly-once 恢复；已合并但未记账的提交可能被下一轮重做。
- 没有蜂群专用 Stop API；Stop 复用 foreground execution 取消域。
- 没有把 goal swarm 统一到 dynamic workflow；该统一仍是待决策项。
