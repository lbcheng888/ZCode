# Goal layer: default-on, legacy removal, zero-injection

状态：实现规格（Phase 1 / M11 落地）。上游设计：`docs/architecture/super-agent-harness-design.md`（M11 + §7 Remove 清单）；灰度规划：`docs/architecture/long-horizon-goal-redesign-plan.md`。

本文只覆盖三件事，均以「flag 仍可显式关闭，但关闭世界被削减到剩余语义」为前提：

1. **默认开启**：goal layer（idle 回合驱动器、三维预算、target_anchor、inject 车道、goal auto-drain 闸门、5/5 todo 提醒）无需任何旗即启用。
2. **删旧路径**：删除旧 while 忙碌续跑循环、`continueActiveTargetAfterTurn` 触发源、inject→queue 降级残留。
3. **零注入**：goal 状态变更不再写模型上下文；UI/审计可见性由既有 `TargetChanged` 投影承担。

## 产品规则

### 1. 默认开启

- `features.goalLayer` 配置键默认 `true`（`contracts/src/config/index.ts` 的 `DefaultRuntimeConfig`）。
- CLI `--goal-layer on|off` 仍可覆盖：显式 `off` 写入 `goalLayerEnabled:false`，显式 `on` 写 `true`；未传时不写该字段，由 `features.goalLayer` 兜底（现在默认 `true`）。
- 环境变量 `ZCODE_GOAL_LAYER` 与配置文件 `features.goalLayer` 语义不变。
- 会话级 `runtimeConfig.goalLayerEnabled`（Host 下发）优先级最高，其次 `features.goalLayer`。

### 2. 删旧路径（Remove 清单）

| 删除项 | 位置 | 删除后语义 |
| --- | --- | --- |
| `target-continuation-loop.ts`（while 忙碌循环） | `core/src/runtime/methods/` | goal 续跑唯一由 `continueActiveTargetLoop`（arm + 预约）与 idle 驱动器产生；`continueActiveTargetLoop` 不再按旗分流，恒走 arm + 预约一条回合。 |
| `continueActiveTargetAfterTurn` 触发源 | `input-facade.ts` 写入 + `runtime-command-queue.ts` 读取 + `types.ts` 选项 | prompt 回合收口后不再在同一前台执行内续跑目标；由 drain 空闲沿的 idle 驱动器统一预约。 |
| `runPostCommandActiveTargetLoop` | `runtime-command-queue.ts` | prompt 与 task-notification 批次都不再触发旧循环。 |
| `target-continuation-loop` 运行时命令模式 | `command-queue.ts` | 队列不再承载该模式。 |
| inject→queue 降级 | `prompt-admission.ts` + `steering.ts` | inject 车道恒可用，不因旗关闭而降级为 queue、不再 `warn`。 |

**保留的旗语义**（关闭 `--goal-layer off` 时仍生效，故仍读 `isGoalLayerEnabled`）：

- idle 驱动器不预约（`scheduleIdleGoalRound` 早退）→ 关旗时 goal 不在空闲沿自动续跑，仅显式 `continueActiveTargetLoop` 跑单回合。
- 三维预算（`exhaustedDimension`、宽限终局回合）关旗不启用。
- turn 记账、`target_anchor`、5/5 todo 提醒、`formatGoalContinuationPrompt`/`formatGoalStateForModel` 的关旗旧文案，均维持。
- goal↔workflow 后台互锁改为**无条件**（`executeTargetContinuationCommand` 不再按旗放宽）：删除旧循环后，手动 resume 亦须让位在途后台任务，避免双重驱动（设计 M5「无条件 interlock」）。

### 3. 零注入（goal-state-reminder 移除）

- `goal-state-reminder.ts` 整体删除：`recordGoalStateChangeReminder`、`openGoalStateChangeReminderDeferral`、`closeGoalStateChangeReminderDeferral` 及 `materializeGoalStateChangeReminder` 的 `messageHistory.addAttachment` + `persistSyntheticUserNoticeForSession(model-only)` 写入路径全部移除。
- goal 状态变更（`/goal` 的 set/pause/resume/clear）的 UI/审计可见性**只**由 `TargetChanged`（`recordTargetChanged`）投影承担，已有 session-facade 调用点保持。
- `ActiveTurnSteeringState` 上的 deferral/pending 字段（`goalStateChangeReminderDeferralOpen`、`pendingGoalStateChangeReminder`）随写者一起删除：reminder 删除后它们零读者，属于死可变状态，不保留。

## 实现备注（默认值解析链）

`features.goalLayer` 的有效默认由一处翻转决定：`contracts/src/config/index.ts` 的
`DefaultRuntimeConfig.features.goalLayer = true`。解析链：`createConfig`（adapters）
以 `DefaultRuntimeConfig` 为 System 基线播种 → `mergeConfigs` →
`ConfigPortImpl.getAll()` 读 `store.get(FeatureGoalLayer)`，缺席兜底统一为
`DefaultConfig.features.goalLayer`（与 `getDefaultValue(FeatureGoalLayer)` 同源，
避免同类内两个相反兜底）→ bootstrap
`resolveAppRuntimeConfig` 的 `?? configResult.config.features.goalLayer`。

`cli/src/goal-layer.ts` 的 `DEFAULT_CLI_GOAL_LAYER` 只是 CLI 缺省语义的文档常量
（未传旗时不写 `goalLayerEnabled`，回落 `features.goalLayer`）。

`queue-auto-drain.ts` / `goal-compact.ts` 本次无需改动：前者 `targetStatus ∈
{null, complete}` 契约不变（v4-bridge 关旗时仍读真实目标状态），后者经
`continueActiveTarget` 走已无 while 循环的续跑路径。

## 状态所有者

- `goalRoundDriverArmed` / `goalRoundDriverStandingDown` / `goalRoundDriverReservationPending`：AgentRuntime 进程内字段，唯一写者 = arm 入口与 idle 驱动器完成路径。
- goal 行权威：`session_target`（SQLite），写者 = session store；事件侧车 `session_target_event` + `TargetChanged` 投影。
- 模型上下文：不再有 goal 状态 reminder 写者（零注入后唯一 goal 注入源是 goal-continuation / target_anchor / budget-outcome 的 model-only 回合输入）。

## 接口

- `continueActiveTargetLoop(this, options)`：签名不变；内部恒 arm + `continueActiveTargetIfIdle` 预约一回合。
- `scheduleIdleGoalRound(this)`：签名不变；旗关闭早退。
- `recordGoalStateChangeReminder` / open / close：删除；`AgentRuntime` / `AgentRuntimeInternal` 接口同步移除该方法。
- inject 车道：`admitPrompt`、`steerTurn`、`enqueueDeferredInput`、`hydrateDeferredInjectInputsForTurnStart` 签名不变，行为上 inject 恒被识别。

## 验收场景

1. **默认开启**：未传任何旗时 `runtimeConfig.goalLayerEnabled === true`；`--goal-layer off` 仍得 `false`。
2. **idle 驱动器**：`/goal set` 后，队列排空的空闲沿自动预约下一 goal 回合（开旗）；关旗不预约。
3. **旧循环删除**：代码库中不存在 `target-continuation-loop`、`runActiveTargetContinuationLoop`、`enqueueActiveTargetContinuationLoop`、`continueActiveTargetAfterTurn`、`runPostCommandActiveTargetLoop` 的引用。
4. **inject 恒可用**：关旗时 `queueDelivery:"inject"` 仍落 inject 收件箱 / steer inject，不降级 queue、不 warn。
5. **零注入**：`/goal pause|resume|clear` 后，模型请求历史中**不含** `goal_state_change` 合成 notice；`TargetChanged` 事件照常广播。
6. **后台互锁**：workflow run 在途时 `continueActiveTargetLoop` 续跑让位（无论开旗关旗）。
