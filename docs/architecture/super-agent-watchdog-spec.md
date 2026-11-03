# Super-agent 看门狗实施规格（M8 BackgroundRun registry + M10 进程外看门狗）

状态：实施级 spec（对应 [super-agent-harness-design.md](./super-agent-harness-design.md) M8 / M10，组件矩阵 §2.2 里程碑 A）。本文定五样：registry 投影契约、探针目录、typed repair 枚举、熔断参数、progress-vs-objective（LLM 无进展裁决缺省 OFF）。与设计冲突时以设计为准，差异登记在 §7。

## 0. 范围与不变量

里程碑 A 交付（Phase 4 批）：

1. `background_run_registry` 行级所有权投影（内存聚合视图；随 owner 库 + 聚合视图的持久化形态在 daemon 迁移批落地，见 §7-1）。
2. 看门狗程序循环：探针 → typed repair → 熔断升级，宿主无关（start/stop 端口，§5）。
3. progress-vs-objective 最低配偏离检测：K 轮零进展 →（按档）LLM 无进展裁决，缺省 OFF。
4. 四处 M8 注册钩子：dynamic-workflow-run-track、bootstrap background task registry（core `background-task-registry.ts`）、automationService、offPeakTaskService。

硬不变量：

- **行级所有权**：每行 `owner` 在 register 时定死；仅 owner 可 settle/touch/drop 本行，第二写者（异 owner）**响亮拒绝**（抛 `BackgroundRunOwnershipError`），不排队、不合并。
- registry 不是第二写者、不在准入路径上：只收各子系统的注册/回写，watchdog 探针与聚合读一律只读。
- watchdog **永不直写业务状态**：repair 只经既有 command surface（cancel-stalled / pause-automation / notify-user），升级经既有 goal command surface（pause-goal + notify）。模块内不存在任何 setState/updateTarget/markTerminal 类调用。
- **cancel-stalled 仅允许 cancel 带 stall 时钟的 run**（行内 `stallClockRef` 在场）；程序在执行前复核，不在场则拒绝执行。LLM 提案发起的 cancel 同样必须命中 stall 资格（与探针同判据），健康行不可被裁决取消。
- **熔断只统计状态变更类 repair**（cancel-stalled / pause-automation）：成功清零、失败累加；notify-user 是观察信道，其成败都不进计数（避免同轮 notify 成功掩盖 cancel 失败，也避免告警信道故障误升级）。
- 看门狗**无提示词/策略编辑权**：progress-vs-objective 只读比较，LLM 裁决只产出 repair 提案枚举，程序校验枚举后执行；永不修改 prompt / 策略 / mandate。
- LLM 无进展裁决**缺省 OFF**（模块配置 `llmNoProgressAdjudication: false`，不进 contracts config）；OFF 时裁决器一次都不会被调用。
- 探针数据源缺席 ⇒ 该探针显式 `skipped`（带原因），不猜、不兜底、不造数；progress-vs-objective 的 `goalHint` 半边同规则（缺席 ⇒ 跳过该轮比较，见 §5）。

## 1. BackgroundRun registry 投影契约（M8）

### 1.1 行形状

```ts
type BackgroundRunKind = "workflow" | "automation" | "offpeak" | "background_task" | "goal";
type BackgroundRunOwner =
  | "dynamic-workflow" | "runtime-background-task" | "automation" | "offpeak" | "goal";
type BackgroundRunTerminalState =
  | "completed" | "failed" | "cancelled" | "killed" | "lost" | "dropped";

interface BackgroundRunRow {
  id: string;                 // 稳定 id（runId / taskId / offPeakTaskId），跨系统 cancel 键
  kind: BackgroundRunKind;
  owner: BackgroundRunOwner;  // 注册时定死，终身不变
  ownerSession?: string;
  workspaceKey?: string;      // pause-automation 的定位键（automation/offpeak 行携带）
  state: "running" | BackgroundRunTerminalState;
  narrowResultRef?: string;   // 窄结果引用（终态回写时补）
  stallClockRef?: string;     // stall 时钟指针；在场 ⇒ 具备 cancel-stalled 资格
  stalledSince?: number;      // owner 投影的 run-stalled 时刻（引擎钟，见 §2.2）
  heartbeat?: boolean;        // owner 承诺运行期周期回写（≤ stalenessCapMs）；registry-stall 只判声明行
  registeredAt: number;
  updatedAt: number;          // 最近一次 owner 写；探针 staleness 判据
  terminalAt?: number;
}
```

### 1.2 写 API 与所有权

| 方法 | 语义 | 所有权检查 |
| --- | --- | --- |
| `register(row)` | 首登或同 owner 重臂（终态行上再 register = 新生命周期，复位结算面） | 已存在且 `row.owner` 不同 ⇒ 抛（第二写者） |
| `settle(id, owner, state, opts?)` | owner 原子回写终态；重复 settle 同态幂等；注册失败回滚 = `settle("dropped")` | 行存在且 owner 不匹配 ⇒ 抛；**行缺席 = no-op**（投影不阻断 deleteRun/cancelTask 等业务路径） |
| `touch(id, owner, patch)` | owner 局部更新（stalledSince / narrowResultRef / ownerSession） | 同 settle |
| `list(filter?)` | 只读聚合（探针 / 观察面用） | 无写 |

终态行按 `terminalRowRetention`（默认 500）FIFO 保留，供对账与审计；running 行不淘汰。

`heartbeat` 是 register 时声明的 owner 承诺（touch 不改）：只有声明了心跳的行才进入 registry-stall 判据。事件驱动 owner（automation 执行期、offpeak 服务端主导的 5min 级轮询）在心跳接线（§7-3）前不声明——数据源缺席不造数，其行不被误判 stall。

### 1.3 注册钩子（M8 落点，owner 分配）

| 钩子文件 | owner | 触发点 |
| --- | --- | --- |
| `core/src/tool/executor/background-task-registry.ts` | `local_dynamic_workflow`→`dynamic-workflow`；其余 taskType→`runtime-background-task` | register（含重臂）、running touch、终态 settle、注册失败 drop |
| `core/src/runtime/methods/dynamic-workflow-run-track.ts` | `dynamic-workflow` | resume 追踪后 register/upsert，补 `stallClockRef = "dwf-run:" + runId` |
| `packages/services/src/session/automationService.ts` | `automation` | `runNow` 建 run ⇒ register；`deleteRun` ⇒ settle `dropped` |
| `packages/services/src/session/offPeakTaskService.ts` | `offpeak` | 创建成功 ⇒ register；`markRunning` ⇒ touch；`cancelTask` ⇒ settle `cancelled` |

钩子与 watchdog 之间只隔一个组合根接缝（`watchdog/composition.ts` 导出的绑定函数 + core `setBackgroundRunProjection` / services 侧 setter 或 deps 字段）；接线文件不在本 lane，见 §7-2。接缝缺席时钩子为 no-op（投影未挂载），不报错、不阻塞业务路径——这是注册缺席不是状态兜底。

## 2. 探针目录（M10 程序探针）

探针只读：registry 聚合 + 显式数据源端口。每轮 tick 全量跑一遍，输出 `ok | hit | skipped(reason)`。

| 探针 id | 数据源 | hit 条件 | 修复动作 |
| --- | --- | --- | --- |
| `registry-stall` | registry | running ∧ `heartbeat` 在场 ∧ `now - updatedAt > stalenessCapMs`（默认 60s = 对账周期） | `notify-user` |
| `workflow-run-stalled` | registry | kind=workflow ∧ running ∧ `stallClockRef` 在场 ∧（`stalledSince` 在场 ∨ `now - updatedAt ≥ workflowStallMs`（默认 20min）） | `cancel-stalled`（资格 = stallClockRef 在场，执行前复核） |
| `goal-budget-limited-open-questions` | `goalState` 端口 | `status === "budget_limited"` ∧ openQuestionCount > 0 | `notify-user` |
| `trigger-backlog-age` | `triggerBacklog` 端口 | `oldestAgeMs > triggerBacklogAgeMs`（默认 10min） | `notify-user` |
| `dispatch-pending-overage` | 未建 | 数据源未落地 ⇒ 恒 `skipped`（接缝 §7-3） | — |
| `daemon-heartbeat` | 未建 | 同上 | — |
| `permission-pending-overage` | 未建 | 同上 | — |
| `restart-storm` | 未建 | 同上 | — |

staleness 上限 = 对账周期（`stalenessCapMs`，默认 60s）写死在探针规格：owner 停止回写超过该值，registry-stall 先告警；workflow 行带 stall 钟满 20min 才允许 cancel。`stalledSince` 由 workflow 引擎 run-stalled 事件投影到行（接缝 §7-3）；接缝未接时 20min 时钟路径仍可独立命中。

registry-stall 以 owner 声明心跳为前提：存在 running 行但均未声明 `heartbeat` ⇒ 该探针 `skipped`（带原因，数据源缺席不造数，§0）；声明行超时才 hit。LLM 裁决发起的 cancel-stalled 目标复用 `workflow-run-stalled` 同一条 stall 资格判据（kind=workflow ∧ running ∧ stallClockRef 在场 ∧ stalledSince 在场或 20min 时钟命中），防止裁决用 `stallClockRef` 恒在场的健康 workflow 行骗过执行前复核。

## 3. typed repair 枚举与执行

```ts
const REPAIR_ACTIONS = ["cancel-stalled", "pause-automation", "notify-user"] as const;
type RepairAction = (typeof REPAIR_ACTIONS)[number];

function validateRepairAction(x: unknown): RepairAction | null;
// 未知动作 ⇒ null（调用方拒绝执行并记录 invalidProposal；不执行、不计入熔断失败）
```

执行只经 `WatchdogRepairCommandSurface`（既有命令面的组合根绑定）：

```ts
interface WatchdogRepairCommandSurface {
  cancelStalledRun(runId: string): Promise<CommandResult>;   // 仅 stall 钟 run
  pauseWorkspaceAutomation(workspaceKey: string): Promise<CommandResult>;
  notifyUser(message: string): Promise<CommandResult>;
  pauseGoal(goalId: string): Promise<CommandResult>;         // 升级用 goal 命令面
}
type CommandResult = { ok: boolean; error?: string };
```

测试内允许 mock command surface；生产组合根绑到既有 cancelBackgroundTask / automationService.setEnabled(false) / notify 通道 / goal pause 命令（§7-2）。

同一 (probe, target) 的重复修复受 `repairCooldownMs`（默认 5min）抑制：冷却期内命中只记录不重发，避免逐 tick 轰炸。

## 4. 熔断参数（N / 冷却 / 升级）

| 参数 | 配置键 | 默认 | 语义 |
| --- | --- | --- | --- |
| N | `escalationFailureThreshold` | 3 | 连续 N 次**状态变更类已执行** repair 失败（cancel-stalled / pause-automation，CommandResult.ok=false）⇒ 升级 |
| 冷却 | `escalationCooldownMs` | 10min | 升级后冷却窗内不再升级；状态变更类成功 repair 或冷却窗过期复位计数 |
| 升级信道 | `escalationChannel` | `notify-user` | 升级 = `pauseGoal(goalId)` + `notifyUser(升级文案)`；goalState 端口缺席时只 notify 并记录无法定位 goal |

校验拒绝（枚举或目标不合格，见 §5）不计入 N：没执行过的东西没有失败。notify-user 不进计数：它的成功不重置计数（同轮 notify 成功不得掩盖 cancel-stalled 的失败累积），它的失败也不累加（告警信道故障不构成暂停 goal 的理由）。升级失败（pauseGoal 返回 ok=false）计入连续失败并保留待下轮重试升级。

## 5. progress-vs-objective（M10 偏离检测最低配）

- 触发：goal 在途（`goalState` 端口在场且 status=active）时每轮 tick 做一次只读比较。
- 输入：goal 续跑提示（`goalHint` 端口，只读文本）+ registry 近况（近 `progressRecentRows` 条 running/终态行的描述拼接）。
- **objective 半边缺席 ⇒ 跳过该轮**（§0 不变量的 progress 版）：`goalHint` 端口缺席、`read()` 返回 undefined、或提示分词后无关键词（长度 ≥2）时，该轮不比较——streak 保持不变、不自增、不进入裁决，`TickReport.progressSkippedReason` 带原因。不拿空提示当「零命中」造零进展信号。
- 零进展判定（程序，确定性）：提示关键词（小写分词，长度 ≥2）在近况文本零命中 ⇒ `zeroProgressStreak++`；有命中 ⇒ 清零。
- 连续 K 轮（`zeroProgressRounds`，默认 3）零进展 ⇒ 尝试开启一次 LLM 无进展裁决：
  - `llmNoProgressAdjudication === false`（缺省）：**裁决器不被调用**，仅记录 streak（dormant，可经 `status()` 观测）。
  - true：调用短命只读裁决器端口（输入 = 提示 + 近况 + streak；输出 = `{ proposal, targetId? }`），两级程序校验后才执行：
    1. 枚举：`validateRepairAction(proposal)` 过关；
    2. 目标：需要目标的动作必须指向真实可执行的 registry 行——`cancel-stalled` ⇒ `targetId` 行在场 ∧ 命中探针同款 stall 资格；`pause-automation` ⇒ `targetId` 行在场 ∧ `workspaceKey` 在场；`notify-user` ⇒ 无需目标。
    任一不过 ⇒ 记 `invalidProposal`，不执行、不计熔断。执行时 dispatch 按 `targetId` 取真实行（`progress:<streak>` 只是无目标动作的记录键，不得充当 cancel/pause 目标）。
  - 每个 streak 峰只裁决一次（streak 清零后可再裁）。
- 模块无任何 prompt/策略写路径；裁决器端口由组合根绑到短命只读会话（接缝 §7-2）。

## 6. 宿主与生命周期（§2.2 里程碑 A）

- 看门狗 = 宿主进程内程序循环：`start()` 起 `tickIntervalMs`（默认 30s）定时器，`stop()` 清定时器并等待在途 tick 收尾。
- 模块**不假设宿主形态**（Desktop 进程 / SourceServer daemon 皆可）：不 import 宿主 API、不自持持久化，只依赖注入的 registry / 端口 / command surface；迁 daemon 时只动组合根。
- `tick(now?)` 单轮可独立调用（测试与手动触发用），返回 `TickReport`（逐探针结果、执行的 repair、升级记录）。

## 7. 接缝登记（本 lane 之外）

1. **持久化**：registry 里程碑 A 为进程内投影；daemon 批再落「随各 owner 库 + 聚合视图」（设计 §2.3）。行形状即届时的表形状。
2. **组合根接线**：`watchdog/composition.ts` 提供绑定函数；实际调用点（create-app / zcodeAgentService / node.ts 构造处）不在本 lane。含：core `setBackgroundRunProjection`、services 侧投影 setter/deps 字段、command surface 绑既有命令、goalState/triggerBacklog/goalHint 端口、LLM 裁决器（flag ON 时）。
3. **数据源未落地的探针**：dispatch pending / daemon 心跳 / permission pending / 连续重启计数（恒 skipped）；workflow 引擎 run-stalled 事件 → `touch(stalledSince)` 投影；automation 定时 run 的 claim/settle（在 automationRepo/scheduler，不在 automationService）→ 投影；offpeak host/scheduler 侧终态回写 → 投影；goal 行注册（target 层）→ 投影；**owner 心跳接线**——background-task/dwf 轮询路径（`background-tasks.ts`，running 快照与 UI 事件去重解耦的周期 touch）、automation 执行期回写、offpeak sync 周期 touch，接线时在 register 声明 `heartbeat`；未接线前 registry-stall 对未声明行 skipped（里程碑 A 现状）。
4. **contracts config**：本模块配置不进 `contracts/src/config`；唯一对外配置面 = 模块 config + 组合根接线。

## 8. 测试锚

- 探针命中矩阵：注入 stalled run（stallClockRef+stalledSince）⇒ mock command surface 收到 cancel-stalled；声明心跳且超时的 running 行 / goal-budget / trigger-backlog ⇒ notify-user；数据源缺席 ⇒ skipped（含：running 行均未声明心跳时 registry-stall 显式 skipped）。
- 熔断：连续 N 次状态变更类 repair ok=false ⇒ pauseGoal + 升级 notify；冷却窗内不重复升级；校验/目标拒绝不计入 N；同轮 notify 成功不清零 cancel 失败计数，notify 失败也不累加。
- 裁决目标通道：cancel-stalled 带真实 stalled 行 targetId ⇒ 按行执行；假 id、健康 workflow 行、缺 targetId 的 cancel/pause ⇒ invalidProposal（不执行、不计熔断）；pause-automation 经行 `workspaceKey` 定位。
- goalHint 缺席（端口未挂 / read 为 undefined / 空关键词）⇒ 该轮跳过比较：streak 保持、裁决器零调用、`progressSkippedReason` 在报告中。
- 行所有权：异 owner settle/touch/drop ⇒ 抛 `BackgroundRunOwnershipError`；同 owner 重臂合法。
- 枚举校验：未知动作 ⇒ null，不执行。
- LLM 休眠：flag OFF + K 轮零进展 ⇒ 裁决器零调用；flag ON ⇒ 调用一次、未知提案被拒。
- 注册钩子：core 两钩子与 services 两钩子各自 register/touch/settle 走投影端口（接缝未挂载时 no-op）。

## 9. 实施偏差 / 接线记录

1. **owner 心跳接线落地（2026-11-02，lane Y）**：`core/src/tool/executor/background-tasks.ts` 仅对 **runtime-background-task 行**（owner 经 `backgroundRunProjectionShape` 从 taskType 推导，且该工具确有 `getSnapshot` 快照提供者会起 1s 轮询）在 register 声明 `heartbeat: true`（判定提到 register 之前，声明与 touch 同源），并在 poll running 分支按 `HEARTBEAT_TOUCH_PERIOD_MS = 30_000` 周期调 `touchRuntimeBackgroundTaskHeartbeat`（owner 同源推导，禁止硬编码）。周期严格小于 `stalenessCapMs`（默认 60_000，探针判据为**严格大于**）并留出 1s 轮询粒度 + 30s tick 余量：最坏采样龄 30_000 + 1_000 = 31_000 < 60_000；取等号（60_000）即竞态——触达落在 [周期, 周期+粒度] 窗口，会以非零概率把健康行误判 registry-stall。
2. **偏差：dwf（workflow 行）不接心跳**——§7-3 原文「background-task/dwf 轮询路径……接线时在 register 声明 `heartbeat`」的 **dwf 半边不实施**。原因：workflow 行的 `updatedAt` 同时是 20min cancel-stalled 独立时钟（`isWorkflowStallCandidate` 在 `stalledSince` 缺席时按 `now - updatedAt ≥ workflowStallMs` 独立命中），而 dwf 快照签名（`backgroundSnapshotSignature` 只读 pid/stderr/stdout，对 `DynamicWorkflowRunSnapshot` 恒为常量）使签名变化 touch 基本缺席、running 期 updatedAt 只在 register 时写一次——这正是 20min 钟能独立命中的前提；心跳若刷新 updatedAt，liveness 双计成 progress，cancel-stalled 在 stalledSince 接缝（§7-3）落地前永久失效。workflow 行判活分工 = 引擎 `stalledSince` 投影 + 签名变化 touch（进度），**禁止**用心跳刷新 workflow 行的 updatedAt。无快照提供者（仅 `waitForTerminal`）的行同样不声明——不起轮询定时器，声明了等不到 touch。
3. **测试锚（§8 补充）**：心跳声明与 touch 同源（无快照提供者不声明、dwf 即使传 `heartbeat:true` 也被 owner 拦下、dwf 行周期推进零心跳 touch）；注入时钟钉「周期到期前探针不命中、到期后最坏采样龄（周期+轮询粒度）仍不命中、无回写超 `stalenessCapMs` 才命中」；跨包常量关系 `HEARTBEAT_TOUCH_PERIOD_MS + BACKGROUND_TASK_POLL_INTERVAL_MS < DEFAULT_WATCHDOG_CONFIG.stalenessCapMs`。
