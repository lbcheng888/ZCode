# Super-agent 里程碑 B 实施规格（daemon 受管控制面子进程 + 入站/scheduler 下沉）

状态：实施级 spec。对应 [super-agent-harness-design.md](./super-agent-harness-design.md) §2.2「控制面组件 × 进程 × 阶段矩阵」、§2.3「物理部署」、§7 Phase 2 以及 [super-agent-trigger-subsystem-spec.md](./super-agent-trigger-subsystem-spec.md) §7-7 裁决 ①「daemon 受管子进程承载 bootstrap 组合根」。里程碑 A（Desktop/CLI 进程内控制面全链）已由 trigger-subsystem-spec §8 记录；本文只覆盖里程碑 B：把控制面宿主迁到 daemon 侧、入站接收与 scheduler claim 下沉、跨进程波次接线，使「关 Desktop 主动继续」在 daemon 可达平台成立。

相关配套文档：[super-agent-gray-pilot-runbook.md](./super-agent-gray-pilot-runbook.md)（开关启动期只读与试点前置）、[super-agent-p6-capabilities-spec.md](./super-agent-p6-capabilities-spec.md)（P6 设备权限/票据，本文只登记接缝，不交付）。

与设计文档冲突时以设计为准；本文新增或改判的接缝统一登记 §8。**不写代码**；标「已具备」的条目指当前工作树已有的实现锚点，标「待实现」的条目是本里程碑的实施范围。

---

## 0. 范围、术语与硬不变量

### 0.1 里程碑 B 的完成定义

在 daemon 可达平台（判定见 §6.1），关闭 Desktop 窗口与 Desktop 主进程后，以下事实仍成立：

1. **入站存活**：IM 的 WebSocket/长轮询连接与 webhook HTTP 回调由 daemon 侧持有，关闭 Desktop 后仍收到新事件，`trigger_events` 产生新行。
2. **控制面继续**：已收事件仍被裁决（落 `decision_log` / would-accept）或被 owned / human-explicit 直通，CommandInbox admission 在仍存活的 worker host 内发生。
3. **调度继续**：automation / off-peak 的 claim 在 daemon 内进行；派发桥按 exactly-once 语义 push 到在线 host，崩溃重投不双跑。
4. **单写者不破**：`super-agent.sqlite` 仍只有控制面 leader 写；`tasks-index.sqlite` 的 claim 与派发状态机不被两个进程同时写同一状态列。
5. **失败可观测**：子进程崩溃、崩溃预算耗尽、平台门禁不通过、RPC 不可达都必须在 `control-plane-status` / `super-agent-status` 中响亮呈现，禁止静默 legacy 降级。

### 0.2 术语

| 术语 | 指代 |
| --- | --- |
| daemon | `@zcode/server-cli` 的 Supervisor + Server Core 两进程的整体；本文不把 Supervisor 与 Core 混为一个写者 |
| Supervisor | `packages/zcode-server-cli/src/supervisor/supervisor.ts`，持有 data-root 锁、监管 Core 与 control-plane 子进程 |
| Core | `packages/zcode-server-cli/src/server-core/core.ts`，承载 `@zcode/services`、HTTP/WS、botsService、workspace agent 与（B 起）scheduler |
| 控制面子进程 / child | Supervisor spawn 的 headless bootstrap 组合根，持有 per-workspace leader 租约、写 super-agent 域库 |
| workspace plane | child 内部按 `workspaceIdentity` 隔离的一套控制面实例（intake / router / adjudicator / dispatch bridge / 租约） |
| CLI host attachment | Core 通过 `ZCodeAgentProcessManager` 管理的 workspace agent（`zcode app-server --stdio`）；持有 session、CommandInbox、v4 gateway |
| Desktop host | Electron 主进程与 local host（`packages/desktop/src/host/index.ts`）；B 期保留为回退/UI 宿主，不再是与 daemon 并行的第二控制面 |
| legacy 直路 | botsService 的既有 `handleInboundMessage` → createTask/回复路径；仅作 kill-switch 与平台回退语义 |

### 0.3 硬不变量

- **唯一域库写者**：`super-agent.sqlite` 的写者 = child 内的 workspace plane。Core、Desktop、CLI host 一律不写；需要写时经 §3 RPC 请求 child。读面同理只经 RPC；Core scheduler 的租约门控只调 `lease.list` / `lease.get`（§3.2），不直接打开域库（§4.4）。
- **CommandInbox 唯一准入**：owned / human-explicit / dispatch push 全部经 Core → 目标 agent 的 v4 gateway `handleCommand`；child 不得在 bootstrap 内另建用户 session 的平行 admission。
- **状态机单写者**：`dispatch_requests` 的 `pending_dispatch` 由 Core scheduler 插入；`pushed` / `dispatched` / `skipped` 的 CAS 只由 child 的派发桥写（§4.4）。
- **幂等权威**：`trigger_events UNIQUE(provider, provider_message_id)` 是消息级去重权威；`dispatch_requests.command_id = hash(runId)` 是派发去重权威；投递幂等键 = `triggerId + subscriberSessionId`。
- **禁止假 spawn**：headless bootstrap 入口或运行时可执行文件不可解析时，flag-on 必须启动期响亮失败；不得向不存在的命令 spawn，也不得把子进程失败当作 legacy 直路。
- **只允许两种运行态**：控制面主导（child ready + leader）或 legacy 直路（部署门禁关闭/未注入控制面，或 child 处于 `starting` 且本代际尚未观测到任何 ready/exit/close/spawn error）。首个崩溃信号（含 spawn error）后 legacy 窗口立即关闭；此后 `crashed` / `crash-loop-stopped`（**无论是否曾 ready**，含启动即崩）一律按可重试错误处理（§3.6）。禁止第三种「半控制面 + 半 legacy」的按消息随机分流。
- **原文与凭据零落库/零入日志**：RPC 帧不携带凭据；trigger payload 只落摘要（既有 intake 合同）。

---

## 1. 拓扑与进程边界

### 1.1 进程图

```text
┌────────────────────────────── zcode-server-cli daemon（data-root 单实例锁）──────────────────────────────┐
│                                                                                                         │
│  Supervisor（Supervisor 进程）                                                                           │
│    ├─ fork → Server Core（server-core.js）                                                               │
│    │     ├─ @zcode/services（project / automation / botsService / agent process manager / HTTP/WS）       │
│    │     ├─ bots provider runtimes（Feishu WS / Telegram 长轮询 / Weixin 轮询；provider 连接消费锁持有者） │
│    │     ├─ scheduler（B 起；tasks-index claim + pending 行 + 审计 RPC）                                   │
│    │     └─ v4 host RPC → workspace agent                                                               │
│    │                                                                                                    │
│    └─ spawn → control-plane child（bootstrap 组合根；headless）                                          │
│          ├─ workspace plane(s)：intake / EventRouter / dispatcher / adjudication / dispatch bridge        │
│          ├─ control_plane_leases（per-workspace，唯一 leader）                                           │
│          └─ super-agent.sqlite + tasks-index dispatch_requests CAS                                      │
│                                                                                                         │
│  runDir/super-agent.sock（Unix socket / Windows named pipe）：Core ↔ child 数据面 RPC                   │
│  runDir/status.json：Supervisor 严格快照（control_plane 状态走独立 control-plane-status，不入该 schema） │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘

Desktop / CLI / web / phone attachment
   └─ HTTP/WS → Server Core → workspace agent（CLI host attachment）
                                  ├─ session / CommandInbox / v4 gateway
                                  └─ Desktop attachment 关闭后仍由 Core 持有（无生产 idle 回收配置）
```

### 1.2 与任务书四段边界的对应关系

| 边界 | 实际承载 | 说明 |
| --- | --- | --- |
| daemon ↔ control-plane child | Supervisor 的 child IPC（ready/health/stopped）+ `runDir/super-agent.sock` 数据面 | Supervisor 只做生命周期与崩溃预算；不转发业务帧（§2、§3.1） |
| control-plane child ↔ CLI host attachment | child → Core 的 `host.command` RPC；Core → agent v4 `commands/query` | child 不直接持有用户的 CommandInbox；worker 的创建/resume 也经 Core |
| CLI host attachment ↔ Desktop host botsService | Core 托管 agent；Desktop UI 经 WS 订阅；botsService 入站在 B 期由 Core 持有（Desktop 侧保留管理面与回退） | Desktop 不再是并行的入站宿主；provider 连接锁兜底 |
| Desktop host ↔ daemon | Desktop 只作为 attachment；关闭不触发控制面停止 | `onStopped` / window close 不杀 Core 与 child |

### 1.3 责任归属（唯一权威）

| 事项 | 唯一归属 | 现状 |
| --- | --- | --- |
| `control_plane_leases` | child 内 per-workspace plane | 已具备（in-process 版；跨进程 ownerId 仍随机，见 §8-2） |
| `trigger_events` / `trigger_subscriptions` / `decision_log` / `mandate` / `write_leases` | child 内 workspace plane | 已具备（模块）；跨进程写入口待实现 |
| `tasks-index` automation / off-peak / `dispatch_requests.pending` | Core scheduler | 待实现（现为 Desktop Main fork） |
| `dispatch_requests` 状态 CAS | child dispatch bridge | 模块已具备；生产 push/sweep 接线待实现 |
| bots provider 连接 | provider 连接消费锁的持有者；B 期目标 = Core | 结构已具备（Core 已构造 botsService），TriggerSink 注入待实现 |
| CommandInbox | 每个 workspace agent 会话 | 已具备 |
| 关闭 Desktop 后 agent 存活 | Core 的 agent process manager | 现状无生产 `idleTimeoutMs` 配置；B 验收锁定 |
| Super-agent 域库读写路径 | `getSuperAgentDatabasePath()`（bootstrap 侧） | 已具备 |

### 1.4 为什么不是一个 workspace 一个 child

受管子进程是 **daemon 级单例**（`controlPlane` 在 Supervisor 选项上只有一个），进程内按 workspace 复用多个 plane。理由：

- data-root 锁已经保证每 server root 至多一个 Supervisor；child 再按 workspace 分裂只会增加进程数与崩溃预算数量，收益为零。
- workspace 是数据分片，不是故障域：plane 的失败（单库损坏、单 workspace 裁决异常）在 child 内按 workspace 隔离并上报，不扩大为进程崩溃。
- 子进程崩溃的恢复粒度是整进程；重启后所有 plane 用稳定 ownerId 立即重抢租约（§2.5），比 N 个进程各自等待更快。

代价：一个 workspace 的病态 DB/循环会拖慢同进程其他 plane；用 §2.6 的 per-plane 错误隔离 + 单批超时兜住，禁止让单 workspace 异常停掉整个 child。

---

## 2. 子进程契约

### 2.1 启动接口（已具备）

`packages/zcode-server-cli/src/supervisor/controlPlaneLauncher.ts` 已提供唯一启动接口：

```ts
interface ControlPlaneLauncher {
  launch(params: ControlPlaneLaunchParams): ChildProcess;
}
```

当前默认实现按调用方给出的 `HeadlessControlPlaneCommand` spawn，并注入：

- `ZCODE_CONTROL_PLANE_GENERATION`
- `ZCODE_CONTROL_PLANE_PROTOCOL_VERSION`
- `ZCODE_DATA_BASE_DIR`
- `ZCODE_SERVER_ROOT`
- 可选 `ZCODE_SERVER_RELEASE_ID`

`stdio = ["ignore","ignore","ignore","ipc"]`；子进程经 `process.send` 发 ready/health/stopped，经 `process.on("message")` 收 `{command:"shutdown"}`。**不猜入口路径**：入口不可解析时调用方不得启用 launcher（否则违反 §0.3 禁止假 spawn）。

### 2.2 入口解析与可执行文件（待实现）

需要新增一个 headless CLI 子命令（名字建议 `super-agent-control-plane`，与 `app-server` 同级的内部命令）：

- 打包态：`<releaseDir>/runtime/<node> <releaseDir>/runtime/zcode.cjs super-agent-control-plane`
- 开发态：`tsx apps/zcode-cli/packages/cli/src/main.ts super-agent-control-plane`
- 解析来源与 Core 的 `createReleaseAgentWiring()` / `resolveBundledAgentWiring()` 同源，禁止从 `PATH` 猜 `zcode`。
- 入口内部只装配 bootstrap 侧模块（`createSuperAgentControlPlane` + 模型调用面 + RPC server + 生命周期 IPC），不 import `@zcode/services`、不 import `@zcode/server-cli`。

`cli.ts` 的 `runServe` 在部署门禁打开时构造 `ControlPlaneOptions`；门禁关闭或缺入口时：

- 门禁关闭 → 不传 `controlPlane`，Supervisor 不 spawn；
- 门禁打开但入口不可解析 → `runServe` 启动期抛错（不做静默回退）。

### 2.3 进程级与 workspace 级参数

当前 `ControlPlaneLaunchParams`（已具备）只承载进程级事实：`generation` / `protocolVersion` / `dataBaseDir` / `serverRoot` / `release`。workspace 级事实不得塞进 argv（argv 会出现在进程列表，且 workspace 集合是动态的），按以下分层注入：

| 层级 | 参数 | 来源 | 现状 |
| --- | --- | --- | --- |
| 进程级 | `dataBaseDir` / `serverRoot` / `release` / `generation` / `protocolVersion` | Supervisor env | 已具备 |
| workspace 级 | `workspaceIdentity`（`workspaceIdentity?.trim() || workspacePath`）、`workspacePath` | Core → child `workspace.ensure` RPC | 待实现 |
| 路径 | `super-agent.sqlite` = `getSuperAgentDatabasePath(dataBaseDir)`；`tasks-index.sqlite` = `<dataBaseDir>/.zcode/v2/tasks-index.sqlite` | child 用 bootstrap 路径 getter 与 dataBaseDir 推导；Core 用 `getTasksIndexDatabasePath()` 推导，两侧同根 | 路径 getter 已具备；跨进程一致性校验待实现 |
| flag：launcher 门禁 | `features.eventRouter` | `runServe` 启动期读 CLI RuntimeConfig；spawn 前判定 | 待实现 |
| flag：child | `features.mandateGate` | 启动方投影（见下） | child 侧读取待实现 |
| flag：Core scheduler | `features.durableSchedulerDispatch` | 启动方投影给 Core | 待实现 |
| flag：Core admission | `features.specWriteLease` | 启动方投影给 Core（写工具准入随 host.command 的 permission context/SendInputOptions 传递） | 待实现 |
| 灰度 | `BotConfig.eventRouterEnabled` | Core 的 botsService 在出口前读取；child 不感知 bot 维度 | 已具备（`botsService.processProviderCallback`） |

**唯一投影源**：`runServe` 在启动期读一次 CLI RuntimeConfig（`apps/zcode-cli/packages/contracts`），生成不可变快照 `{eventRouter, mandateGate, durableSchedulerDispatch, specWriteLease}`，经 spawn env（child）与 Core 启动参数/环境（Core）同时投影给两侧。禁止 Core 或 child 各自再读 RuntimeConfig；一旦出现两份来源，按 §6.2 视为配置漂移并启动期失败。各 flag 的消费者互不重叠：launcher 只读 `eventRouter`；child 只读 `mandateGate`；Core scheduler 只读 `durableSchedulerDispatch`；Core admission（Core 转发写工具准入）只读 `specWriteLease`。

一致性校验（fail-closed）：

- `super-agent.sqlite` 与 `tasks-index.sqlite` 必须落在同一个 dataBaseDir；不一致时 child 拒绝服务并上报 fatal。
- 部署门禁打开（`ControlPlaneOptions` 存在）而投影 `features.eventRouter !== true`：`runServe` 在 spawn **之前**拒绝并抛错，真正不 spawn child（不进入崩溃预算，也不接受「门禁开但 kill-switch 关」的伪装态）。二者同源投影，行为只有这一种。门禁关闭而 eventRouter=true 不是 daemon 错误：Desktop/CLI 照旧走里程碑 A 的进程内控制面。**B 期 flags 是启动期只读，不支持热切换**，改开关必须 stop/start daemon（§6.2）。
- tasks-index 未迁移（无 `dispatch_requests` 表）而注入桥：child 构造期响亮失败（沿用 trigger-subsystem-spec §8-6）。
- **启动顺序**：Supervisor 同时拉起 Core 与 child，child 可能先于 Core 完成 tasks-index 迁移。child 启动只建 super-agent 域库；dispatch bridge 的构造推迟到 Core 首次 `workspace.ensure` 之后（Core 在 services 初始化与 tasks-index 迁移完成后才发）。在此之前不写 pending、不 push、不 sweep。禁止用「tasks-index 文件存在」推断迁移完成。

### 2.4 ready / health / 生命周期消息（已具备）

**选型**：复用 `CoreLauncher` 的进程/IPC 形态与消息模式（`fork + ipc`、ready/heartbeat-equivalent/stopped、generation 门禁、父进程断连即退出），但**不复用 `coreMessageSchema`**：后者绑定 Core 的 HTTP host/port 与 server-core 语义，且 `zcode-server-cli` 是 bootstrap 的调用方而非被依赖方，强行共用会把 server 生命周期与业务控制面契约耦合。control-plane 使用独立严格 schema，与 Server CLI 协议版本同源演进。

`packages/zcode-server-cli/src/contracts.ts` 已定义严格 schema：

```ts
controlPlaneMessageSchema =
  | { type:"ready", protocolVersion, generation, version?, releaseId? }
  | { type:"health", at, pendingEventCount? }
  | { type:"stopped", reason }
  | { type:"fatal", message }
```

`fatal` 是 child 启动级不可恢复错误（路径不一致、socket bind 冲突、tasks-index 未迁移等）的一等上报：Supervisor 记录原因、确保子进程收口，并按崩溃预算处理；不得把它降级成通用退出串。门禁开而 `eventRouter` 非 true 属于配置矛盾，由 `runServe` spawn 前拒绝（§2.3），不进入该通道。`ControlPlaneStatus` 同时暴露 `firstReadyAt`（本 daemon 代际内首次 ready 时间，跨 child 重启不清零）：child 曾 ready 后崩溃重启时 `startedAt`/`generation` 都会变化，`firstReadyAt` 保留「本代际曾 ready」证据，供 §3.6 的状态判断与排障使用；启动窗口是否仍开放还需结合 crash 信号（§3.6 rule 2）。

Supervisor 侧门禁（已具备）：

- ready 必须匹配当前 child + 当前 generation + 同源 `protocolVersion`；不匹配强杀，走统一崩溃路径。
- ready 超时（默认 15s）强杀；不等于健康的 child 不得留在 `ready`。
- `health` 只更新只读健康快照；`stopped` 记录退出原因。
- `control-plane-status` control 命令返回独立 `ControlPlaneStatus`，**不向 `ServerStatus` 增加字段**（持久化严格 schema 的旧版回滚兼容）。

B 期需补的 health 字段（待实现）。注意 `controlPlaneStatusSchema` / `health` 当前都是 `.strict()`：新增字段属于协议变更，必须同批 bump `CONTROL_PLANE_PROTOCOL_VERSION`（或把 health 改为显式 passthrough），禁止只在一侧加字段导致旧读方 strict 解析失败；`ServerStatus` 持久化快照仍不加任何字段。

| 字段 | 语义 |
| --- | --- |
| `leaderWorkspaceCount` | 当前 leader plane 数 |
| `pendingDispatchCount` | `dispatch_requests` 非终态行数 |
| `degraded?` | `{ reason, since }`；只在「曾 ready 后降级」出现 |
| `workspaceErrors?` | 最近 per-plane 错误摘要（最多 N 条，去重） |

### 2.5 崩溃预算、代际与重启语义（Supervisor 层已具备，plane 层待实现）

- **进程崩溃预算**：复用 `CrashBudget`（5 分钟窗口；退避 1/2/4/8/16s；超出进入 `crash-loop-stopped`）。Supervisor 已为 control-plane 建独立预算，child 崩溃不拖垮 Core，Core 不因 child 熔断而停止。
- **代际**：每次重新 launch `generation += 1`；旧 child 的迟到消息以 `(child, generation)` 双重过滤丢弃。
- **重启前置**：只有观察到 exit/close（或 spawn error）后才允许重启，避免旧进程仍存活时新进程并起。
- **Core ready 前不抢租约（待实现）**：child 先建 plane 与 RPC server，等 Core 首个 `workspace.ensure`（Core 已 ready）后才 `tryClaim`。否则 Core 未就绪时 child 持有租约会让 Main fork 误判控制面活跃而跳过 claim，造成 scheduler 空转；Core down 时租约也不应阻塞回退。
- **租约 ownerId（改判，待实现）**：当前 `createSuperAgentControlPlane` 缺省用随机 UUID。B 期改为稳定键：
  `ownerId = "control-plane:" + sha256(serverRoot) + ":" + sha256(workspaceIdentity)`
  - 稳定 ownerId 让重启后的 child 依据 `control_plane_leases` upsert 的 `owner_id = excluded.owner_id` 分支立即重抢，不必等 45s TTL。
  - 安全前提是「旧进程已观察到终态」；Supervisor 已满足。data-root 锁保证同 root 不会有第二个 Supervisor 并起。
- **优雅停止（待实现）**：新增 `releaseLeadership(workspaceIdentity, ownerId)`（`delete ... where owner_id = ?`），child 在收到 shutdown 后：停裁决/总线 → 释放租约 → 关库 → 发 `stopped`。若释放失败，仍按稳定 ownerId 的快速重抢路径恢复。
- **崩溃后租约**：child 崩溃不主动删行；租约在 3 × 15s = 45s 后过期。稳定 ownerId 的重启路径通常先于过期完成；若遇到另一个不同 ownerId 的合法实例（里程碑 A 的 in-process 控制面），重启者变 follower，不跑循环并上报。
- **follower 语义**：follower plane 的 `ingest` 恒 `handled:false`（纯转发/legacy，与 trigger-subsystem-spec §3.3 一致），但必须计数并在 health 暴露。
- **父进程断连（待实现）**：child 监听 IPC `disconnect`（Supervisor 崩溃/被杀），自行停裁决与总线、尽力释放租约、关库并退出；不得成为绕过 data-root 锁的孤儿。语义与 Core 的 `installParentDisconnectHandler` 一致。

### 2.6 per-plane 故障隔离（待实现）

child 内单个 workspace 错误不得 crash 进程：

- `workspace.ensure` / `ingest` / `audit` 的单次异常 → 返回 RPC error + 写 health `workspaceErrors`，不 throw 到 IPC。
- 单批裁决超时按 adjudication 合同留 pending；驱动器故障按 A10 降级（candidate 直落 record-only）。
- 域库打开失败只影响该 workspace plane；该 workspace 的 sink 返回 error（provider 重试）或 follower false（从未 leader 时）。
- 只有进程级不可恢复错误（IPC 协议损坏、bootstrap 装配失败、无法打开 dataBaseDir）才允许进程退出，让 Supervisor 重启。

### 2.7 kill-switch（flag 关）

- 部署门禁关闭：`ServerCliRuntimeOptions.controlPlane` 不注入 → Supervisor 不 spawn；Core 的 botsService 不注入 TriggerSink（或注入 `noopTriggerSink`）→ 逐字节 legacy。
- 门禁打开但 child 进入 `crash-loop-stopped`（**包括从未 ready 的启动即崩**）：**不得**静默切换 legacy（§3.6）；该 workspace 的 ingest 返回可重试错误，status 暴露 `crash-loop-stopped`，由运维/用户 stop/restart 或回退门禁。
- 门禁打开且 child 从未 ready、但已出现首次崩溃（`crashed` 或重启退避中）：同样返回可重试错误，不回 legacy。本代际唯一的 legacy 启动窗口 = `controlPlaneState === "starting"` 且尚未观测到任何 ready/exit/close/spawn error；一旦观测到即永久关闭（直到重启 daemon 产生新代际）。
- 门禁切换是 daemon 重启级操作，不提供运行期热开关。

---

## 3. 跨进程 RPC（Core ↔ control-plane child）

### 3.1 选型：专用本地 socket 的 JSONL RPC，不复用 stdio v4 协议

候选：

| 方案 | 优点 | 否决理由 |
| --- | --- | --- |
| 复用 Supervisor 的 child IPC（`process.send`） | 零新端点 | Supervisor 只应做生命周期；把 envelope 与 CommandInbox 投递放进 Supervisor = 业务状态进入进程管理状态机，违反 R2 §3.2「Supervisor 不持有 CommandInbox/queued prompt」 |
| 复用 agent 的 v4 stdio 协议 | 协议成熟 | child 不是 agent host；stdio 已被 Core↔agent 占用；且 child 需要反向调用 Core，stdio 单通道方向受限 |
| 复用 Supervisor control socket（`runDir/control.sock`） | 已有鉴权与 framing | 该 socket 是 CLI 运维面；引入业务帧会把运维面变成数据面，且任何本地 CLI 都能伪造 trigger |
| **专用 `runDir/super-agent.sock` + JSONL RPC** | 父子生命周期外独立；连接建立时校验 peer 为 Supervisor/Core（§3.8）；双向请求；schema 严格 | 新增一个本地端点与两套薄客户端（成本可控） |

端点：

- POSIX：`<serverRoot>/run/super-agent.sock`，目录 `0700`，socket `0600`。
- Windows：`\\.\pipe\zcode-super-agent-<stablePathId(serverRoot)>`。
- 生命周期：child 启动时先 unlink 陈旧 socket 再 bind；bind 失败且存在存活 peer → 退出 fatal（data-root 锁应已排除第二实例）。child 退出时 unlink。

Framing：每行一个 JSON；单帧上限 256 KiB；超限断开并计错。RPC 包：

```ts
// request
{ v:1, id:string, method:string, params:unknown }
// response
{ v:1, id:string, ok:true, result:unknown }
| { v:1, id:string, ok:false, error:{ code:string, message:string, retriable:boolean } }
```

请求/响应按 `id` 相关；双方都既是 server 也是 client（方法注册表按方向区分）。所有 params/result 走 `@zcode/shared` 的 zod schema，运行时校验；反序列化失败即协议错误，断开连接并上报，不猜字段。

嵌套调用受父请求 deadline 约束：`trigger.ingest` 内的 `host.command` / `host.worker.*` 必须在 ingest 截止前返回；超时即整个 ingest 失败（provider 重试），不得「先 ACK、后台补投」——那会让 ACK 语义失真并丢失重投路径。

### 3.2 方法表（daemon/Core → child）

| 方法 | params | result | 超时 | 幂等/说明 |
| --- | --- | --- | --- | --- |
| `workspace.ensure` | `{ workspaceIdentity, workspacePath?, tasksIndexReady?: boolean }` | `{ state:"leader"\|"follower", leaseExpiresAt }` | 10s | 按 workspaceIdentity 幂等；创建 plane、抢租约、清过期、回填种子；`tasksIndexReady=true` 才允许构造派发桥 |
| `trigger.ingest` | `TriggerSinkEnvelope`（shared wire schema，与 services `triggerSink.ts` 结构同源） | `TriggerSinkOutcome` + additive `delivery?: "routed"\|"delivery_failed"` | 30s | 幂等权威 = `trigger_events UNIQUE(provider, provider_message_id)` |
| `schedule.audit` | `{ workspaceIdentity, domainKey, providerMessageId, payloadSummary, now }` | `{ inserted:boolean }` | 5s | `provider_message_id` 幂等；只落审计行，不进路由/攒批 |
| `lease.list` | `{}` | `{ workspaces:[{ workspaceIdentity, ownerId, expiresAt }] }` | 2s | Core scheduler 门控读面（一次范围查，替代直接读库） |
| `lease.get` | `{ workspaceIdentity }` | `{ ownerId, expiresAt } \| null` | 2s | 单 workspace 诊断/claim 前复核 |
| `mandate.resolve` | `{ triggerId, purpose: "delivery_precheck"\|"admission", sessionId?, turnId? }` | `SuperAgentAdmissionMandateResolution \| undefined` | 5s | 只读解析：读 `trigger_events.fast_path` + `mandate.resolveFor`；`purpose=admission` 在**每个**新 admission 边界重新执行（含排队提升/steer），不复用投递时刻结论；缺失/跨 workspace 响亮 error |
| `wouldAccept.list` | `{ workspaceIdentity }` | `PendingWouldAcceptCard[]` | 5s | UI 读面（TUI/desktop 经 Core） |
| `wouldAccept.promote` | `{ cardId }` | `{}` | 10s | 幂等（convert 行按 trigger_id 去重） |
| `control.status` | `{}` | `{ planes:[{workspaceIdentity,leader,pendingEventCount,lastError?}] }` | 5s | 运维诊断；也可直接读 health 快照 |

### 3.3 方法表（child → Core，回调）

本节只列 child→Core 方向；agent→Core 的内部 admission 请求（`admission.resolveMandate`）不属于该方向，见 §3.7。

| 方法 | params | result | 超时 | 说明 |
| --- | --- | --- | --- | --- |
| `host.command` | `{ workspaceIdentity, commandId, triggerId?, taint?, lane: "guide"\|"followup", sessionId?, envelope }` | `CommandAck` | 30s | Core 经 agent v4 gateway `commands/query`（`handleCommand`）投递；admission 回执即 ACK。`lane=inject` 不在 wire 枚举内，收到即返回 typed error `proto.deliveryLaneUnsupported`（不投递、不改 queue、§3.4） |
| `host.watchdogCommand` | `{ action:"cancel-workflow", workspaceIdentity, runId, sessionId }` \| `{ action:"pause-automation", workspaceIdentity, automationId }` \| `{ action:"notify-user", workspaceIdentity, sessionId, message, commandId }` | `{ ok:boolean, error?:string }` | 30s | daemon watchdog 的窄修复面：cancel-workflow 合成 V4 `cancelBackgroundWork{workId=runId}` 投 owner session；pause-automation 调 `automationService.pause`；notify-user 合成 V4 `notifyUser{text}`（`commandId` 为 daemon 侧幂等键，透传为 envelope commandId）投 owner session，CLI 直驱 runtime task-notification 队列，runtime 拒绝时 ACK 带 `fault.command.notificationRejected`。业务拒绝/未生效原样返回 `ok=false`，不伪造成功 |
| `host.worker.find` | `{ workspaceIdentity, threadKey }` | `ResumableWorker \| null` | 10s | 订阅/worker 投影查询 |
| `host.worker.resume` | `{ workspaceIdentity, sessionId, triggerId }` | `{ sessionId }` | 60s | 经 Core `resumeSession`/admission；幂等键 `triggerId` |
| `host.worker.createTask` | `{ workspaceIdentity, threadKey, triggerId, payload, context? }` | `{ sessionId }` | 60s | 经 Core `createSession`/admission；同一 trigger 只建一次 |
| `host.autoReplyGuard` | `{ workspaceIdentity, botId, threadKey, actorId }` + additive-optional `chatType/senderType/mentionedBot/groupCardAction/elicitation/providerMessageId/commandText` | `{ admitted:boolean }` | 5s | Core 的 botsService `admitAutoReplyTurn` 包装（含占额写 state）；发送者身份只认出口规范化事实，不由 actorId 推断 |
| `backfill.seeds` | `{ workspaceIdentity }` | `SubscriptionBackfillSeed[]` | 10s | leader 接管时取最新种子；替代启动期静态快照 |

实现缺口（待实现）：

- `IZCodeAgentService` 目前没有 v4 `commands/query`/`handleCommand` 直通方法；需新增窄方法（或在 services 定义 `SuperAgentHostCommandPort`），由 Core 转发到 agent 的 v4 gateway。禁止 child 自建平行 admission。
- `findWorkerByThreadKey` / `createTask` 需要 Core 用 project/task 投影实现；不得由 child 直接读 session 库。
- `createTask` / `resume` 的 ACK 丢失重投必须在 Core 侧按 `triggerId` 幂等：agent 的 `session/create` 不天然带命令幂等键，若只靠 child 重试会建出第二个 worker。幂等状态可复用 subscription 唯一约束或 Core 内的投递去重表；禁止「建了再说」。
- `autoReplyGuard` 需从 botsService 暴露窄方法；不得让 child import `@zcode/services`。

### 3.4 触发信封投递链与 ACK 语义

```text
provider 入站（Core 的 botsService）
  │ markInboundDelivery 快速去重（进程内 Map）
  │ BotConfig.eventRouterEnabled === true 且 TriggerSink 已注入
  ▼
TriggerSink.ingest(envelope)                      [Core 接线适配器，待实现]
  │ RPC trigger.ingest → child
  ▼
workspace plane：intake.ingest
  │ trigger_events INSERT（UNIQUE 幂等；冲突 → 同一 triggerId）
  │ Fast Path 三态
  ▼
route action
  ├─ owned → host.command(lane=guide|followup；commandId=triggerId+sessionId)
  ├─ human_explicit → host.worker.resume/createTask（幂等键 triggerId）
  └─ unowned_candidate → adjudication.notifyCandidate（无外部副作用）
  ▼
返回 { handled:true, triggerId, route, delivery? }  ← ACK
```

ACK 成立条件：

- `handled:true` 只在 `trigger_events` 已提交 **且** route action 已返回后发出。
- owned 投递被 host 拒绝（rejected）：`trigger_events.final_disposition` 保持 NULL（未决），outcome 标 `delivery_failed`，仍返回 `handled:true` 防止 legacy 双跑；启动重放扫描按 `final_disposition IS NULL` 且排除 `fast_path='human_explicit'` 的行重试。
- candidate：`notifyCandidate` 只是内存唤醒，返回即 ACK；裁决在后台攒批。
- rejected（Fast Path 拒）：返回 `handled:true`，不继续 legacy。
- **lane=inject**：v4 wire 命令枚举无 inject（trigger-subsystem-spec §8-4），`host.command` 收到 inject 一律返回 typed error `proto.deliveryLaneUnsupported`，不投递、不静默改 queue、不重试；child 只能使用 `followup`（P2 生产订阅）或 `guide`（mandateGate 关闭时的行内投递）。要支持 inject 必须先扩 v4 wire 枚举（先行条件已登记 trigger-subsystem-spec §8-4），本里程碑不做。

重投与丢失窗口：

| 时点 | daemon 行为 | 期望 |
| --- | --- | --- |
| RPC 连接失败/超时，且此前未拿到结果 | 向上抛错，botsService `releaseInboundDelivery` 后由 provider 重试 | 不得返回 `handled:false`（否则可能 legacy + 后续重投双跑） |
| child 已提交 ingest，ACK 帧丢失 | provider 重试 → UNIQUE 短路返回同一 triggerId，route action 重跑 | host.command 用同一 commandId，CommandInbox 幂等吸收；不双跑 |
| child ACK 后被 kill | 无 provider 重试 | 已消费；无需补 |
| child 仍处于启动窗口（未 leader 且本代际无崩溃信号） | 返回 `handled:false`（纯转发/legacy） | 事件未进新链路；legacy 单跑 |
| child 已出现崩溃信号（`crashed`/`crash-loop-stopped`，无论是否曾 ready/leader）或曾 leader 后不可用 | 抛错（可重试 503），禁止切 legacy | 见 §3.6 |

### 3.5 派发桥跨进程 ACK

- Core scheduler 插入 `pending_dispatch`（`commandId = hash(runId)`）。
- child bridge `pushDispatch` → `host.command`（envelope 带 `triggerId?`、`taint`、`requestedDelivery`）。
- Core 返回 admission `admitted|duplicate` 后，child 才 CAS `pushed → dispatched`。
- 回执丢失：bridge 按停滞扫描重推同 commandId；admission 幂等吸收；最终收敛 `dispatched` 或宽限定时器 `skipped`。
- kill-point 语义沿用 trigger-subsystem-spec §4.2 T3；B 期新增一条：Core 在 push 后、child CAS 前崩溃 → 重启后桥按 `pushed` 停滞行续推，不按 `pending` 误结算 skipped。

### 3.6 失败升级规则（决定「legacy 还是失败」）

这是本 spec 唯一允许的降级判据，必须按代际状态判断，禁止按单条消息的偶然结果：

1. **部署门禁关闭** → 不 spawn；`handled:false` = legacy（正常 kill-switch）。
2. **本 daemon 代际内 child 仍处于启动窗口**（`controlPlaneState === "starting"` 且本代际尚未观测到任何 ready/exit/close/spawn error） → `handled:false` = legacy；该窗口内事件不进新链路；status 保持 `controlPlane.state === "starting"`（`degraded` 字段只用于「曾 ready 后降级」，见 §2.4）。这是启动期唯一窗口，首个崩溃信号后立即并永久关闭（代际内不再重开）。
3. **本 daemon 代际内 child 已出现崩溃信号（`crashed` / `crash-loop-stopped`，均包含从未 ready 的启动即崩）、socket 不可达或正在重启** → `trigger.ingest` 返回 `retriable` error，不返回 `handled:false`。依赖 provider 重试/503，禁止 legacy 双跑。运维恢复手段 = 重启 daemon 或关闭部署门禁（重启级）。
4. **follower plane**（另一 leader 存在） → `handled:false` = pure-forward/legacy，并计数；这是 trigger-subsystem-spec §3.3 既定语义。

provider 重试语义（B 期义务）：

- Telegram 长轮询只有 `processProviderCallback` 成功后逐条推进 offset；ingest 失败不推进，下一轮 `getUpdates` 重投同 update。
- Weixin 轮询只有本批全部消息成功后才持久化 `get_updates_buf`；失败不落游标，重投同批。
- Feishu/Lark WS 的 payload 回调抛错由 SDK 重投/重连承担；runtime 在连接终止后 5s 退避重建，不视为业务消息已消费。
- HTTP webhook（含 Feishu webhook）由 Core 路由把 ingest 抛错/不可达映射为 503（§4.2），由 provider 重投。
- 重试预算：Telegram/Weixin 轮询失败固定 5s 后重试、无次数上限（直到 daemon 停止或 provider 锁被接管）；Feishu/Lark WS 连接终止后 5s 重建、无次数上限；HTTP webhook 的重投次数由 provider 策略决定，Core 只保证每次未消费必返回非 2xx。重投由 `trigger_events UNIQUE` 与 commandId 幂等吸收，不双跑；provider 重试不计入 child 崩溃预算。

scheduler 同理：本代际 child 曾 leader 后失效 → 该 workspace 的 claim 走 release/skip，不 legacy 直派；租约过期后由 Main fork 按回退语义接管（若 Desktop Main fork 在跑）。

### 3.7 准入 mandateFacts 的跨进程交接（待实现）

现状锚点（里程碑 A 进程内）：`bindTurnPermissionFacts` 在 `apps/zcode-cli/packages/core/src/permission/service.ts:155`；登记表在 `apps/zcode-cli/packages/bootstrap/src/app/super-agent-admission-facts.ts`。两者都在 agent app 进程。B 期的 Core 是 `server-core` 另一进程，既无法写 agent 进程内的登记表，agent 的 admission 边界也拿不到 child 的 socket。因此必须新增一条 **agent↔Core 的内部受信通道**，并把解析时点前移到 admission 边界。

通道定义：

| 方向 | 方法 | params | result | 超时 |
| --- | --- | --- | --- | --- |
| agent → Core（内部 host 请求） | `admission.resolveMandate` | `{ workspaceIdentity, triggerId, sessionId, turnId }` | `SuperAgentAdmissionMandateResolution` | 10s |

- **信任边界**：agent 的 stdio 由 Core 独占 spawn，公开 attachment 无法直接向该通道发请求；该方法名不在公开 v4 command 面注册，Core 拒绝任何来自 attachment 的同名命令（`proto.commandNotAllowed`）。内部请求走 Core 与 agent 之间新增的内部 RPC 帧：复用 agent stdio 的双向 framing（agent 写请求帧、Core 按 id 回响应帧），与公开 v4 command/delta 命名空间隔离；不新增本地 socket，也不暴露给 attachment。TUI/CLI 本地 in-process 路径沿用既有进程级登记表，不经过该通道。
- **解析时点**：agent 在每个真正起轮的 admission 边界（首轮、排队提升、steer 起新轮）调用 `admission.resolveMandate` → Core 转发 child `mandate.resolve { purpose:"admission" }` → 返回 resolution → agent 按新 `turnId` 调 `bindTurnPermissionFacts({sessionId, turnId, facts})`。`human_explicit_exempt` 按既有 user-origin 执行，不声明 trigger 来源。
- **投递前置校验**：Core 在把 `host.command` 转给 agent 前先调 child `mandate.resolve { purpose:"delivery_precheck" }`；child 不可达或返回缺失 ⇒ **响亮拒绝**本次投递（`host.command` 返回 retriable error），不退回 user-origin，不静默放行；事件行保持未决，按 §3.4 启动重放。
- **失败与重试语义**：`admission.resolveMandate` 超时/不可达 ⇒ 本次 admission 响亮失败（deny）；排队项保留在队首、不执行、不降级为 user-origin。宿主按 1/2/4/8s 退避，在下一个 admission 边界重试；连续 5 次失败后向用户与 status 暴露，该项维持 pending 等人工重试或 daemon 重启。steer 同一语义。
- **撤销生效**：每个 admission 边界都重新解析，mandate revoke 后下一边界即 deny；不缓存跨边界结论。`turnId` 由运行时每轮新建、`releaseTurnStart` 删除，客户端不可复用（§8-19③）。
- **facts 不进公共 wire command**：resolution 只存在于内部通道帧与进程内登记表；公开 v4 `sendText` / command 不接受也不读取 facts 字段。

### 3.8 RPC 安全与 P6 接缝

- socket 仅本机、data-root 权限；不做 TCP 监听，不引网络鉴权。socket `0600` / 目录 `0700` 只是纵深防御，**不是**「同 data-root 进程即可信」的证明。
- **peer 身份是认证，taint 不是**：连接建立后、首帧之前校验 peer——Linux `SO_PEERCRED`、macOS `LOCAL_PEERPID`、Windows `GetNamedPipeClientProcessId` + 客户端 SID；可信集合 = 本 data-root 的 Supervisor 与 Core（Core PID 由 Supervisor 经 child IPC / spawn env 传递）。无法取得 peer 身份或 peer 不在可信集合 → 立即断开、计数并上报 health，fail-closed。同 UID 但不是 Core 的进程因 PID 不匹配被拒；设计 §5 登记的同 UID 本机攻击面在本 RPC 上收窄为「能取得 Core PID 身份的进程」，仍不承诺。
- **B 期落地路径**：Node 公共 API 不暴露内核 peer credential，生产认证仍是**显式凭据握手**：Supervisor 在 daemon 启动期用 `randomBytes` 铸造凭据并原子写入 `<serverRoot>/run/super-agent.auth`（0600，目录 0700）；Core 连接首帧提交凭据，child 在认证前不处理任何业务帧，缺失/不匹配立即断开并计错。凭据每次 daemon 启动重新铸造（Core 重启读同一文件，租约不中断）；文件缺失/为空时 child 启动级 fatal、客户端连接 fail-closed。它收窄的攻击面是「能读同 UID 0600 文件的进程」，仍属设计 §5 不承诺范围。
- **原生 peer credential 状态（§3.8 加固项）**：`packages/native-peer-credentials` 提供 Node-API C addon（macOS `LOCAL_PEERPID` + `getpeereid`、Linux `SO_PEERCRED`；`_GNU_SOURCE` 在任何 libc 头文件之前定义，否则 glibc 不暴露 `struct ucred`），产物 `prebuilds/<platform>-<arch>/peercred.node`，由 `scripts/build-native-peer-credentials.mjs` 构建（二进制不入库）。**Windows 不支持**：Node 不把 named-pipe 连接句柄暴露为 fd，JS 侧拿不到内核 HANDLE，客户端 SID 查询未实现；Windows resolver 恒为 unavailable（fail-closed），不得声称已支持。`peerIdentity` 在原生 addon 可用时优先使用内核身份；仅非原生模式的 Linux 才退回 `/proc` inode 启发式，macOS/Windows 无原生即 unavailable。**macOS 已用真实 Unix socket + 真实子进程验证解析到的 peer PID 等于子进程 PID；Linux 构建/测试未在本机执行（本机为 darwin），不得声称 Linux 已真机验证。**
- **显式 peer 门模式（非默认）**：`ZCODE_CONTROL_PLANE_PEER_MODE=1`（Core 与 child 共用同一 env）时 child 不读凭据文件，改用原生 resolver；可信集合 = `process.ppid`（Supervisor）+ `ZCODE_CONTROL_PLANE_TRUSTED_PIDS`。Supervisor 在每次 `launchControlPlane` 读取当前 Core PID 并经 launch params 投影为该 env。peer 模式下 `ZCODE_PEER_CREDENTIALS_NATIVE_PATH` 必须指向可加载的原生 addon：缺失/未提供即启动级 fatal，绝不回退 `/proc` 或未认证端点；Core 侧同时不再发送 auth 首帧。默认（未设置该 env）仍是 Supervisor 铸造的 0600 凭据握手，生产入口始终走 authToken，不得把原生 resolver 描述为已替代凭据。打包态由 staging 把同平台 addon 复制到 release `runtime/peercred.node` 并纳入 server-runtime 组件哈希；同平台未构建 addon 时 staging 响亮失败，跨平台 staging 不注入（构建脚本拒绝交叉编译）。
- 帧内禁止凭据、token、完整 prompt 之外的敏感字段；payload 摘要沿用 intake 上限。
- `taint` 只由可信出口铸造，反序列化后校验 `taint === true`，否则拒收；这是来源完整性检查，**不构成认证**，不能替代 peer 校验。
- P6（deviceScope/能力票据）在此边界挂接：远程/多设备接入若未来复用该 RPC，必须先加 capability ticket 与吊销传播；B 不实现 P6，也不预留无鉴权的远程扩展。

---

## 4. 入站与 scheduler 下沉

### 4.1 现状核查（已具备）

- Server Core 的 `createServerHostServices()` 已构造 `IBotsService`，且 standalone-server 下 `runStartupBackgroundTasks: true`，会启动 Feishu WS / Telegram 长轮询 / Weixin 轮询（`packages/services/src/node.ts:3219` 起、`botsService` 装配约 2681 行）。
- provider 连接消费锁已跨进程：`packages/services/src/bots/channelRuntime.ts` 的目录锁 + `owner.json` 原子 rename + nonce lease 心跳；失败一方把 runtime 标为 `idle`（"handled by another ZCode window"）。这是入站单宿主的承接机制，不是消息级去重。
- 消息级去重权威仍是 `trigger_events UNIQUE(provider, provider_message_id)`；`markInboundDelivery` 只是进程内快速守卫。
- Desktop local host 也构造 botsService（`serviceAuthorityMode: "desktop-local"`），与 Core 竞争同一连接锁。
- botsService 出口已具备 `TriggerSink` 窄 port 与 `BotConfig.eventRouterEnabled` 读点（`packages/services/src/bots/botsService.ts:3993`），`noopTriggerSink` = kill-switch 直路。
- 缺口：Core 从未注入 TriggerSink；server-core 的 HTTP 未挂 `/api/bots/:provider`（该路由只在 legacy `packages/server/src/http.ts:447`）。

### 4.2 目标装配点（待实现）

1. **TriggerSink 注入**：在 `createServerHostServices` 或 server-core 装配层，把 Core 的 `TriggerSink` 适配器传给 `createBotsService({ triggerSink })`。适配器只做一件事：`trigger.ingest` RPC（§3.4）；不得 import bootstrap，不得复制 intake 逻辑。
2. **webhook 路由**：把 `packages/server/src/http.ts` 的 `/api/bots/:provider` 与 `/api/bots/:provider/:botId` 处理迁到 `packages/zcode-server-cli/src/server-core/http.ts`，语义保持：
   - 不支持 provider → 400；
   - 缺 botsService → 503；
   - secret 校验失败 → 401；
   - bot 业务失败 → 503（可重试，禁止 200 误消费）；
   - **ingest RPC 抛错 / child 不可达**：`botsService.processProviderCallback` 原样 rethrow（`botsService.ts` 现有行为），Core webhook 处理必须 catch 该错误并映射 503；禁止落到 Hono 默认 500，也禁止返回 200 假装消费。503 是 provider 重投的唯一信号（Telegram/Weixin/Feishu 语义见 §3.6）。
3. **Desktop 让位**：B 期目标是 Core 持有连接。两个收敛手段同时使用（仅部署门禁通过时启用）：
   - 启动顺序：daemon 作为 OS service / detached Supervisor 先于 Desktop 启动，通常先拿锁；
   - bot 维度门：flag-on 且 `BotConfig.eventRouterEnabled===true` 的 bot，Desktop local host 不再启动该 bot 的 provider runtime（管理面、配置 CRUD、手动测试仍可用）；具体读点落在 Desktop host 的 bots runtime 装配层（待实现）。门禁不通过（回退平台）时 Desktop 仍按现状启动 provider runtime。
   - 锁仍是最后防线：即使双方都启动，只有一个持有连接；失败方如实显示 idle，不静默重连抢占。
4. **provider 状态可见**：Core 的 bots status 需经现有 attachment RPC 投到 Desktop UI；状态文案保留「handled by another ZCode window」语义，避免用户误判掉线。
5. **单宿主不变量**：同一 provider 凭证同一时刻只有一个连接消费者；不得用「两个都连、消息去重」替代连接单宿主（会重复计费/触发 provider 限流）。

### 4.3 三个阶段与灰度

| 阶段 | 入站宿主 | TriggerSink | 灰度 |
| --- | --- | --- | --- |
| B0（现状） | Desktop/Core 抢锁 | 仅 in-process（Desktop 未注入） | 全 legacy |
| B1 | Core 抢锁为主，Desktop 兜底 | Core 注入 RPC sink；flag 关闭时 `noopTriggerSink` | 全局 + bot 维度 |
| B2 | Core 独占 flag-on bot 的 provider runtime | 同上 | bot 维度，非 flag bot 继续 Desktop |

B2 只对部署门禁通过且 `features.eventRouter` 为真的 daemon 生效；WSL/Docker/未注册 win32 保持 B0。

### 4.4 scheduler 下沉

现状（已具备）：`packages/desktop/src/scheduler/index.ts` 是 Main fork 的常驻 scheduler，负责：

- AutomationRepo `BEGIN IMMEDIATE` 单飞 claim；
- misfire skip、single-flight、结算/退避；
- per-workspace `control_plane_leases` 门控；
- 认领成功落 `trigger_events` 审计行（直接写 super-agent 库）；
- `insertPendingDispatchRequest`（桥循环未接线时生产不调用，ws7 偏差）。

B 期目标（待实现）：

1. scheduler 代码迁入 `packages/zcode-server-cli/src/server-core/scheduler/`（可直接复用 `@zcode/services/node` 与 shared，去掉 `electronUtilityProcess.parentPort` 依赖）。
2. `trigger_events` 审计改走 `schedule.audit` RPC，由 child 写入；Core 不再直接写 super-agent 库。若 RPC 失败：释放本轮 claim、下一 tick 重试；不得无审计直派。
3. `dispatch_requests.pending` 由 Core 写；`pushed/dispatched/skipped` 由 child CAS（§3.5）。桥的构造以 Core 的 `workspace.ensure`（已含 tasks-index 迁移完成事实）为门，未确认前不写行/不 push。从「legacy 直派」切到「桥 + push」必须一次原子切换：
   - 先确认 child bridge 的 `pushDispatch` / `sweepSkipped` / `resumePendingAfterBoot` 已生产接线；
   - 停用 scheduler 直派；
   - 同批开启 pending 写入 + push + sweep。
   - 禁止长期双写（同 run 双执行）。
4. **scheduler 所有权门控**：
   - B 期 daemon 内 scheduler 启用 = 平台/部署级；Desktop 在门禁通过时**不再启动** `desktopCronScheduler` fork（Desktop 读取 daemon 门禁/就绪状态的接线待实现）。
   - 过渡重叠窗口（Desktop fork 已在跑、daemon 后启动）沿用 per-workspace 租约门：Main fork 对每个候选 workspace 检查 `control_plane_leases`，有未过期租约则 release/skip；无则照常 claim。
   - daemon scheduler 只对「child 已 leader」的 workspace claim，租约可见性只经 `lease.list` / `lease.get` RPC 读取（Core 不直接打开 `super-agent.sqlite`）。workspace 集合有两个来源：child 启动时自枚举域库已有 `workspace_identity`（`trigger_events` / `trigger_subscriptions` / `control_plane_leases`）并*准备* plane（Core ready 前不抢租约）；Core 枚举 tasks-index 的 automation / off-peak 与 bot 绑定涉及但域库尚无行的 workspace，Core ready 后逐个 `workspace.ensure`。租约在，才 claim。租约不在（child 未就绪/熔断）→ 不 claim，等 child 恢复或租约过期后由 Main fork 接管。
   - 这条同时解决双调度者分摊与「未领导 workspace 无人认领」两个问题。
5. off-peak 保持 ticket 顺延语义，不进 dispatch bridge（trigger-subsystem-spec §7-5 已裁决）；只落审计。

### 4.5 tasks-index 并发写边界

同一 tasks-index（WAL）被两个进程写：

| 表/列 | Core scheduler | child dispatch bridge |
| --- | --- | --- |
| automation / automation_runs / off_peak | 唯一写者 | 不碰 |
| `dispatch_requests.pending_dispatch` INSERT | 写 | 不写 |
| `dispatch_requests.pushed/dispatched/skipped` + 时间戳 | 不写 | 唯一 CAS 写者 |
| `dispatch_requests` 读取 | 读 | 读 |

约束：所有状态转移用单条 `UPDATE … WHERE id=? AND status=?` CAS；跨进程不共享内存锁，禁止 read-modify-write。

---

## 5. 验收用例矩阵与测试策略

### 5.1 用例矩阵

| ID | 场景 | 步骤 | 成功判据 | 失败暴露 |
| --- | --- | --- | --- | --- |
| B-A1 | 关窗/关 Desktop 后入站存活 | Desktop 退出；provider 推一条 IM/长轮询消息 + 一条 webhook | `trigger_events` 新行；provider 连接锁 owner = Core；Desktop 侧无第二连接（runtime idle 或未启动，状态可见） | 无新行 / 锁 owner 仍是 Desktop → 失败 |
| B-A2 | 关 Desktop 后 owned 直通 | 已订阅 thread 发消息；Desktop 关闭 | agent 的 CommandInbox admission 发生；worker 收到 followup；admission 回执 admitted | admission 不发生 / legacy createTask 被调用 → 失败 |
| B-A3 | 关 Desktop 后 human-explicit | 未订阅 thread 的人类 @ 消息 | `dispatchHumanExplicit` resume/createTask；P95 与 legacy 私聊 createTask 基线对比在预算内 | 超时、无 session、或错误进候选 → 失败 |
| B-A4 | 关 Desktop 后裁决继续 | unowned candidate | `decision_log` / `pendingWouldAccept` 落行；无 goal workspace 同样评估 | 无行 / 驱动器停 → 失败 |
| B-A5 | child kill -9（裁决中） | SIGKILL child | Supervisor 退避重启；新 child 稳定 ownerId 立即重抢；pending 行重攒；decision_log 不重复 | 租约 45s 空窗、候选丢失、重复批 → 失败 |
| B-A6 | child kill -9（ingest 后 ACK 前） | 在 trigger.ingest 提交后杀 child | provider 重试 → 同一 triggerId；Telegram offset / Weixin buf 未推进、webhook 返回 503；route 重跑但 CommandInbox duplicate；不双跑 | 游标推进丢消息 / 200 误消费 / 双跑 / 双 trigger_events → 失败 |
| B-A7 | child 崩溃预算耗尽（含新 daemon 启动即崩、从未 ready） | 连续崩溃超过退避序列 | `crash-loop-stopped`；Core 仍 ready；ingest 返回可重试错误且不 legacy（从未 ready 的 crash-loop 同样禁止 legacy） | 静默 legacy / Core 被拖垮 → 失败 |
| B-A8 | Core 崩溃重启 | SIGKILL Core | Supervisor 重启 Core；child 继续存活并重连 socket；租约不中断；入站锁不丢 | child 被误杀或 socket 不可重连 → 失败 |
| B-A9 | 双实例仲裁 | 两个不同 ownerId 的 plane 同 workspace | 恰一个 leader；批 `batch_id` 唯一；follower 不跑循环、ingest=false | 双 leader / 双批 → 失败 |
| B-A10 | 调度不双 claim | daemon scheduler 与 Main fork 同时在跑 | 同一 run 只 claim 一次；有租约 workspace 由 daemon；无租约由 Main fork | 双 claim / 双派 → 失败 |
| B-A11 | 派发桥 kill-point | claim 后/push 后/ACK 后各杀 Core 或 child | 结果收敛 dispatched 或 skipped；commandId 重推不双跑 | 双跑 / 永久 pending → 失败 |
| B-A12 | win32/WSL/Docker 回退 | 门禁不过平台启动 | 不 spawn child；Desktop 内 in-process 控制面 + Main fork scheduler；status 标 fallback 原因 | 强行 spawn / 主动继续假成立 → 失败 |
| B-A13 | kill-switch | `features.eventRouter=false` 启动 | 不建 child；sink no-op；legacy 逐字节行为 | 仍 spawn / 新链路被调用 → 失败 |
| B-A14 | 门禁开但入口缺失 | 配 controlPlane 但解析不到 headless 入口 | daemon 启动期响亮失败，不 spawn 假进程 | 静默跳过 → 失败 |
| B-A15 | 跨进程 mandateFacts | 事件回合执行写工具；再制造一条排队输入/steer | Core 投递前 `mandate.resolve(delivery_precheck)`；agent 在每个 admission 边界经 `admission.resolveMandate` 重解析并绑定新 turnId；record_only/缺 mandate 被 deny；resolve 不可达时 admission 响亮失败且排队项保留；revoke 后在下一 admission 边界生效 | user-origin 放行 / 命中旧 facts / resolve 失败后静默执行 → 失败 |
| B-A16 | provider 锁单宿主 | 同时启动 Core 与 Desktop 的 provider runtime | 恰一个持有锁并收消息；另一方 idle 状态可见 | 双连接 / 双收 → 失败 |
| B-A17 | 协议/库路径不一致 | child 启动参数与配置冲突 | 拒绝服务并 fatal；Supervisor 计数 | 静默用错库 → 失败 |
| B-A18 | 关 Desktop 后 would-accept 可见 | 关窗后产生卡片，再从 Desktop 重开 | 收件箱有卡；promote 生效且幂等 | 卡片丢失 / 重复 → 失败 |

### 5.2 测试分层

| 层 | 位置/方式 | 覆盖 |
| --- | --- | --- |
| 单测 | `packages/zcode-server-cli/test/` | launcher 参数、ready/generation/protocol 门禁、崩溃预算、RPC schema、ACK 决策表、scheduler 门控 |
| child 集成 | `apps/zcode-cli/packages/bootstrap/tests/super-agent/` + 真实 spawn | 真 dataBaseDir/真 sqlite/真 socket；workspace.ensure、ingest、幂等、租约重抢、releaseLeadership |
| Core↔child 集成 | `packages/zcode-server-cli/test/super-agent/` | 真 Core 子进程 + 真 child（dev tsx 或 dist）；botsService sink、webhook、scheduler 审计 RPC、dispatch push |
| 故障注入 | kill -9 / socket 断开 / 磁盘只读 / IPC 协议损坏 | 矩阵见 §5.1；每点重启后断言不双跑、不丢未决 |
| E2E（Desktop bots） | `packages/desktop/test/e2e/bots/` | 关窗/关 Desktop 主动继续；四来源回归（T7）；provider 锁单宿主 |
| 故障注入套件 | `apps/zcode-cli/packages/bootstrap/tests/fault-matrix*.test.ts`、`workflow-fault-matrix.*.test.ts` | 故障注入基线；B 期在其上补 kill -9 / socket 断开 / 磁盘只读 / IPC 协议损坏 |
| 性能 | 基准对比 | human-explicit P95 与 legacy createTask 持平；裁决批处理期间前台首 token 不劣化（A6） |

测试用替身只允许存在于测试代码；生产路径禁止 mock/fake sink。spawn 测试必须用真实子进程（脚本或 dev 入口），不得用纯内存 EventEmitter 冒充 child 来证明生命周期。

---

## 6. 迁移与回退

### 6.1 平台可达性矩阵（部署门禁）

门禁在 daemon 启动时求值一次，结果写入 `control-plane-status` 与日志；不通过 = 不 spawn child，Desktop 保持里程碑 A 进程内控制面 + Main fork scheduler（语义 = 现状）。**本表是实现建议**：设计 §9 开放问题⑥ 明确平台可达性矩阵与 headless 派发策略需产品裁决，本 spec 不静默定案（§8-11）。

| 平台 | 通过条件 | 不通过时的行为 |
| --- | --- | --- |
| macOS | service 注册成功（launchd）或手动 detached Supervisor 且 Core ready；control socket 可达 | 回退 Desktop 进程内 |
| Linux（本机/SSH 远端） | systemd --user 注册成功或手动 daemon 且 Core ready；data-root 可写 | 回退 Desktop 进程内 |
| win32 | **必须** Task Scheduler 服务注册成功（`serviceRegistered=true`）且 named pipe 可达；未注册一律不通过 | 回退 Desktop 进程内（设计 §2.2 / 开放问题⑥） |
| WSL | 远端 Core ready 且 daemon 生命周期不依赖 Desktop 连接（R3 常驻 daemon）；否则不通过 | 回退 Desktop/远端 host 进程内 |
| Docker | 容器内 Core ready 且容器不随 Desktop 退出；否则不通过 | 回退 Desktop/远端 host 进程内 |

补充判据（按顺序短路求值，任一条失败即不通过并记录原因）：

1. 平台注册/常驻判据：win32 必须 `serviceRegistered === true`；macOS launchd 注册成功或手动 detached Supervisor；Linux systemd --user 注册成功或手动 daemon；WSL/Docker 远端 Core ready 且 daemon 生命周期不依赖 Desktop 连接。
2. `Supervisor.status().state === "ready"` 且 control endpoint 可连。
3. `release` runtime 可解析 headless 入口（判定方式与 §2.2 同源：release 目录下 `runtime/zcode.cjs` 存在且对应 node 可执行）。
4. `super-agent.sqlite` 与 `tasks-index.sqlite` 同根且 tasks-index 已迁移（仅桥接线阶段检查；未接线批次不检查迁移）。

门禁不通过不是错误：它是有明确定义的部署回退。必须打印原因与处理入口（启用服务 / 安装 runtime / 修复存储）。

### 6.2 开关表

| 开关 | 层级 | 语义 | 缺省 | 热切换 |
| --- | --- | --- | --- | --- |
| 部署门禁（`ControlPlaneOptions` 是否存在） | daemon 启动参数/服务描述 | 是否 spawn child；与 `features.eventRouter` 同源投影 | 关 | 否，stop/start |
| `features.eventRouter` | CLI RuntimeConfig（`runServe` 启动期唯一读取，投影 launcher/Core） | 全局 kill-switch；false = launcher 在 spawn 前拒绝（不建 child，部署门禁也必须关）/ sink no-op | false | 否，重启 |
| `BotConfig.eventRouterEnabled` | shared BotConfig（Core botsService 读取） | bot 维度灰度；只有 true 才进 RPC sink | undefined=legacy | 配置刷新可生效（既有） |
| `features.mandateGate` | 启动方投影给 child（同 §2.3） | child 三档解析/M6 门 | false | 否，重启 |
| `features.durableSchedulerDispatch` | 启动方投影给 Core scheduler | dispatch_policy durable_wait | false | 否，重启 |
| `features.specWriteLease` | 启动方投影给 Core admission | 写租约检查（P5） | false | 否，重启 |
| daemon scheduler 门禁 | 部署门禁派生 | Core scheduler 启停；Desktop Main fork 同步让位 | 随门禁 | 否，stop/start |
| 入站宿主门禁 | 部署门禁派生 | Core 独占 flag-on bot runtime；Desktop 让位 | 随门禁 | bot 配置刷新可生效 |

禁改：不得为了「先跑起来」在门禁打开时静默把 control-plane 换成 in-process，也不得在 child 熔断后把 ingest 切 legacy（§3.6）。

### 6.3 分阶段落地

| 批次 | 内容 | 回退方式 |
| --- | --- | --- |
| B0 | Supervisor child 生命周期（已具备）；headless 入口空壳 + ready/health | 不启用门禁 |
| B1 | child RPC server + workspace.ensure + trigger.ingest；Core sink 注入；workspaces eager ensure | 门禁关闭 + 重启；Desktop 保持 A |
| B2 | 入站宿主：Core webhook 路由 + provider runtime 独占 + Desktop 让位 | 门禁关闭；provider 锁自然回到 Desktop |
| B3 | scheduler 下沉 + 审计 RPC + pending 行 + bridge push/sweep 原子切换 | 门禁关闭 + 重启；Main fork 恢复 |
| B4 | 跨进程 mandateFacts、wouldAccept、运维状态面 | 门禁关闭；A 的 in-process 面恢复 |

每批独立可回归；B3 的原子切换是硬要求，禁止 pending 行与 legacy 直派长期并存。

### 6.4 数据兼容与回滚

- B 期不新增 super-agent 表/列（除 health 字段走协议而非持久化）；`dispatch_requests` 已有迁移。
- child 只使用既有迁移；旧数据可被 A 进程内控制面继续读。
- 回滚步骤：关闭部署门禁 → `zcode stop` → `zcode start`（或 `serve --daemon` 重启）→ 验证：
  - `control-plane-status` 返回 null 或 stopped；
  - provider 锁由 Desktop 获取；
  - Main fork scheduler 恢复 claim；
  - 无遗留 `pending_dispatch` 行（若有，按 §3.5 收敛或人工标记；不得直接改状态绕过 CAS）。
- 紧急回滚不删 super-agent 库：库是审计事实，保留。

---

## 7. 实施清单（目标文件 → 状态）

### 7.1 已具备（工作树，2026-11-05）

- [x] Supervisor 受管 child 生命周期：`packages/zcode-server-cli/src/supervisor/supervisor.ts`（spawn/ready 门/health/independent CrashBudget/restart/protocol mismatch/stop 对称收口）。
- [x] 启动接口与默认 launcher：`packages/zcode-server-cli/src/supervisor/controlPlaneLauncher.ts`。
- [x] child 消息/状态 schema + `control-plane-status` control 命令：`packages/zcode-server-cli/src/contracts.ts`。
- [x] 可注入退避/窗口的 `CrashBudget`：`packages/zcode-server-cli/src/supervisor/crashBudget.ts`。
- [x] Supervisor child 生命周期测试：`packages/zcode-server-cli/test/controlPlaneSupervisor.test.ts`。
- [x] bootstrap 进程内控制面全链：`apps/zcode-cli/packages/bootstrap/src/app/super-agent-control-plane.ts` + `create-app.ts` 装配。
- [x] leader 租约仓储（per-workspace upsert + heartbeat + changes 断言）：`apps/zcode-cli/packages/bootstrap/src/super-agent/trigger/control-plane-lease.ts`。
- [x] botsService TriggerSink 窄 port + `BotConfig.eventRouterEnabled` 读点：`packages/services/src/bots/triggerSink.ts`、`botsService.ts`。
- [x] Core 已构造 botsService 并启动 provider runtimes（standalone-server）：`packages/services/src/node.ts`。
- [x] provider 连接消费锁（目录锁 + owner.json + nonce lease）：`packages/services/src/bots/channelRuntime.ts`。
- [x] 派发桥模块与状态机：`apps/zcode-cli/packages/bootstrap/src/super-agent/trigger/dispatchBridge.ts`（生产循环未接线）。
- [x] Desktop scheduler 门控/审计/pending 插入函数：`packages/desktop/src/scheduler/index.ts`（尚未迁 daemon，桥行未接）。

### 7.2 待实现

- [ ] headless CLI 入口：`apps/zcode-cli/packages/cli/src/*` 增内部子命令；`apps/zcode-cli/packages/bootstrap/src/app/super-agent-daemon-entry.ts`（IPC 生命周期 + socket RPC server + per-workspace plane 管理）。
- [ ] 进程入口解析与生产 launcher 构造：`packages/zcode-server-cli/src/cli.ts` 按 release/runtime 解析 `runtime/zcode.cjs`，门禁打开时注入 `controlPlane`；缺入口响亮失败。
- [ ] RPC 合同与 framing：`packages/shared/src/super-agent/daemon-rpc.ts`（请求/响应 schema、方法名、错误码、帧上限）；`packages/zcode-server-cli` 与 bootstrap 各一套薄 socket 客户端。
- [ ] socket 端点与生命周期：`<serverRoot>/run/super-agent.sock`（win32 pipe）；unlink/bind/权限/断连处理。
- [ ] `workspace.ensure` + eager workspace 枚举：child 启动时自枚举域库已有 workspace；Core 枚举 automation/off-peak/bot 绑定涉及但域库无行的 workspace，逐个 ensure。
- [ ] `trigger.ingest` RPC 与 Core TriggerSink 适配器：`packages/zcode-server-cli/src/server-core/`；禁止 import bootstrap。
- [ ] `host.command` / worker / autoReplyGuard / backfill 回调：Core 侧实现；`IZCodeAgentService` 增 v4 command 直通窄方法（或新 port）。
- [ ] 跨进程 `mandate.resolve` + `admission.resolveMandate` 内部通道：Core 投递前 precheck；agent 在每个 admission 边界（含排队提升/steer）经 Core 转发 child 重新解析并绑定新 turnId；失败 deny 与退避重试（§3.7）。
- [ ] webhook 路由迁入 server-core HTTP：`/api/bots/:provider`、`/api/bots/:provider/:botId`。
- [ ] Desktop 让位：flag-on bot 的 provider runtime 在 Desktop local host 不启动；状态如实透传。
- [ ] scheduler 迁入 `packages/zcode-server-cli/src/server-core/scheduler/`；审计改 RPC；pending 写入；直派/桥原子切换。
- [ ] dispatch bridge 生产 push/sweep/resume 接线（child 侧）；`onHostAck` CAS。
- [ ] 稳定 ownerId + `releaseLeadership`。
- [ ] health 扩展字段 + per-workspace status 投影；`super-agent-status` 运维面（可扩 `control-plane-status`）。
- [ ] wouldAccept list/promote RPC（UI 经 Core；替代本地控制面）。
- [ ] 平台门禁实现与状态输出。
- [ ] 测试：§5.2 分层用例；真子进程集成；kill-point 矩阵；关 Desktop E2E。

---

## 8. 待裁决与已知风险

| # | 事项 | 现状/风险 | 建议 |
| --- | --- | --- | --- |
| 1 | 单 child 多 workspace vs 一 workspace 一 child | 当前 Supervisor 只支持一个 `controlPlane` child；per-plane 隔离需 child 内实现 | 采用单 child 多 plane（§1.4）；若后续出现单 workspace 毒化，再评估一 plane 一进程，需改 Supervisor 合同 |
| 2 | 稳定 ownerId 的越权重抢 | 同 ownerId 的 upsert 允许未过期接管；若出现旧进程未死的新进程，会双 leader | 强制「观察到 exit/close 后才重启」；Supervisor 已满足；测试钉住 |
| 3 | legacy 与失败的边界 | 本代际出现崩溃信号（无论是否曾 ready/leader）后若返回 `handled:false`，可能与已处理消息双跑 | 按 §3.6 代际规则 fail-closed；legacy 只保留无崩溃信号的 `starting` 窗口；禁止按单条消息降级 |
| 4 | 入站渡期双宿主 | Desktop 可能先持有 provider 锁；Core 的 receive 要等其释放 | 启动顺序 + flag-on bot 让位 + 锁兜底；过渡窗口状态可见 |
| 5 | scheduler 所有权 | Main fork 与 daemon scheduler 重叠；per-workspace 租约门是过渡 | 部署级让位 + eager workspace ensure + 租约门；B3 原子切换 |
| 6 | 审计写者 | 现有 scheduler 直接写 super-agent 库；B 后必须改 RPC | 已在 §4.4 规定；失败 release claim，不无审计直派 |
| 7 | child 内裁决模型运行时装配 | child 不 import services；需要裁决生成面，并在 Cheng host 可用时让 plan 引用命中真实回执 | 复用 bootstrap 短命会话面；`ZCODE_CHENG_ROOT`/host entry 在场时接只读 Cheng host + tool-loop，缺席保持 `tools=[]` model-only（能力缺席，plan 引用 fail-closed） |
| 8 | flag 来源与热切换 | 此前 Server CLI 不读 CLI RuntimeConfig，门禁与 `features.eventRouter` 可能漂移；同一 flag 被多个消费者各读一份 | 已收敛为 §2.3 单一投影源：`runServe` 启动期读一次 RuntimeConfig，按消费者投影给 launcher/Core/child；门禁开而 eventRouter 非 true 在 spawn 前拒绝；B 期只读、需重启 |
| 9 | `tasks-index` 迁移证明 | 不能以「文件存在」推断迁移 | 桥构造前 `prepare` 检查表存在；失败响亮；沿用 trigger-subsystem-spec §8-16① |
| 10 | P6 边界 | deviceScope 未实现；能力票据已由 P6 单独交付（B 不接入）；RPC 目前仅本机 | B 不实现 P6；未来远程复用 RPC 必须先加 capability ticket/吊销，禁止裸复用 |
| 11 | 平台可达性矩阵的裁决状态 | 设计 §9 开放问题⑥ 要求平台矩阵与 headless 派发策略由产品裁决；§6.1 的通过条件目前是实施建议，不是已定案 | 先按 §6.1 建议的判据顺序执行；产品另行裁决时只改门禁表与启动判据、不改拓扑；被否决平台保留 Desktop 回退 |
| 12 | `host.worker.createTask` 崩溃窗口 | `createTask` 已建会话、context 尚未写 `activeTaskId` 时进程崩溃，重投会再建第二个会话；`triggerId` 绑定要等创建成功后才落。当前实现不是原子幂等 | 需 runtime 提供幂等 `createSession` 命令键，或先落可反查 intent 行并在重投时收敛；缺口关闭前不得把 createTask 标成已闭环幂等 |

---

## 9. 与既有 spec 的差异登记

1. **控制面子进程数量**：trigger-subsystem-spec §7-7 写「daemon spawn 一个 headless 控制面进程」，本 spec 明确为「daemon 级单 child + per-workspace plane」，并把 workspaceIdentity 从进程 argv 移到 `workspace.ensure` RPC。
2. **ownerId**：既有实现随机 UUID；B 改稳定键以支持快速重抢，前提是旧进程终态已被观察。
3. **scheduler 仲裁**：ws7 偏差的 per-workspace 门控保留为过渡；B 期增加部署级让位与 eager ensure，避免「未领导 workspace 无人认领」。
4. **审计写者**：ws7 允许 Main fork scheduler 直写 `trigger_events`；B 期迁 daemon 后改为 `schedule.audit` RPC，child 是唯一写者。
5. **ingest 失败语义**：新增「本代际出现任何崩溃信号（无论是否曾 ready）后必须抛错、不得 legacy」的代际规则，补足 trigger-subsystem-spec §3.3 只覆盖 follower 的空缺；legacy 仅保留 `starting` 且无崩溃信号的启动窗口。
6. **process IPC vs 数据面**：Supervisor child IPC 只走生命周期；业务帧走独立 socket，避免 Supervisor 持有 CommandInbox 业务状态（R2 §3.2）。
7. **P6**：不在本里程碑交付；§3.8 仅登记未来接入约束。
8. **租约心跳归属收窄**：trigger-subsystem-spec §7-7 写「daemon 本体只做入站 webhook、scheduler claim、租约心跳、子进程监管」。本 spec 把 `control_plane_leases` 的 claim/heartbeat/release 唯一归属 child 内 workspace plane（域库单写者），Core 只经 `lease.list`/`lease.get` 只读门控（§4.4）。这是对 §7-7「daemon 本体」的收窄解释（daemon = Supervisor+Core+child 整体，心跳由 child 执行），避免 Core 与 child 形成两个心跳写者。
9. **mandateFacts 跨进程通道**：trigger-subsystem-spec 的 host 通道只覆盖 v4 wire 命令；本 spec 新增 agent↔Core 内部 `admission.resolveMandate`（解析时点前移到每个 admission 边界，含排队提升/steer），并明确 facts 不进公开 wire command（§3.7）。
10. **RPC peer 认证**：设计 §5 登记「同 UID 本机攻击面不承诺」；本 spec 在该 RPC 上额外要求 peer 身份校验（SO_PEERCRED/LOCAL_PEERPID/Windows client PID+SID，可信集合=Supervisor/Core），不可验证即拒绝（§3.8）。生产握手仍是 Supervisor 铸造的 0600 显式凭据；原生 peer credential addon 覆盖 macOS/Linux（macOS 已真实 socket + 子进程验证，Linux 本机未运行），作为显式 peer 门模式的加固路径；Windows 不支持（Node 不暴露 pipe HANDLE，resolver fail-closed），见 §3.8「原生 peer credential 状态」。

---

## 10. 验收命令与证据口径

B 期收口至少产出：

- `pnpm --dir packages/zcode-server-cli test`：child 生命周期、RPC、崩溃预算、门控。
- `pnpm --dir apps/zcode-cli test`（或对应 bootstrap 目标）：控制面、ingest、租约、跨进程 RPC 适配。
- 真机/真服务：
  - `zcode serve --daemon` 启动后 `zcode status --json` 与 `control-plane-status`；
  - 关闭 Desktop，provider 发消息，查 `trigger_events` 新行与 `bots-runtime-locks` owner；
  - kill child / kill Core 后查 `control-plane-status`、`dispatch_requests` 终态；
  - win32/WSL/Docker 各跑一次门禁不通过路径，确认 Desktop 回退可继续工作。
- 日志：崩溃/重启/降级/协议不匹配必须带 `generation`、`workspaceIdentity`、原因；禁止只打「failed」。
