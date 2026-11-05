# Super-agent 灰度试点操作手册

状态：操作级 runbook，2026-11-05。对应当前 `long-horizon-goal-redesign` 分支的 flag-on 试点。**本文不是能力承诺**：所有前置未满足的步骤必须先停下，不得用“先开再说”的方式绕过。

适用三级试点：① `eventRouter` 触发路由；② `mandateGate` mandate + 方案卡；③ speculative/spec lane 静默执行。三级严格串行，前一级未达放量判据不得进入下一级。

先读三份事实基线：

- [super-agent-trigger-subsystem-spec.md](./super-agent-trigger-subsystem-spec.md) §7-7（daemon 受管子进程承载组合根，里程碑 A/B）、§8（实施偏差与接缝现状）。
- [super-agent-grayscale-report.md](./super-agent-grayscale-report.md) §6（已知接缝）、§7（P6 排期）、§8（灰度建议）。
- [super-agent-spec-lane-spec.md](./super-agent-spec-lane-spec.md) §0/§5/§8-6（egress 诚实边界）。

## 0. 操作铁律

1. **四个 feature 开关是启动期读点，不是热开关**。`createConfig` 在 app 构造时读 `~/.zcode/cli/config.json` / 项目 `.zcode/config.json`（`apps/zcode-cli/packages/adapters/src/config/config-factory.ts:124-129`），`create-app` 在构造期判断 `features.eventRouter`（`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:1067`）。改配置文件后必须重启承载进程才生效；“置回 false 立即回 legacy”指的是**重启后**的语义。
2. **回滚顺序固定：先把 `mandateGate` 置 false，再把 `eventRouter` 置 false**。`mandateGate=true` 且 `eventRouter=false` 是启动期响亮失败（`create-app.ts:197-205`），顺序反了会导致宿主起不来。
3. **不要删除 `~/.zcode/v2/super-agent.sqlite`**。legacy 路径不读它；保留供审计与回滚取证。确需清理时先停宿主、先备份、再经明确批准。
4. **不夸大 auto 档**。当前实现里 `speculative` 与 `auto` 都走 `specRun.start`（`apps/zcode-cli/packages/bootstrap/src/super-agent/trigger/verdict-interpret.ts:215-232`），设计 M4 的 auto = createTask/resume 面**未实现**；TUI 文案“auto execution tier activates in a later phase”（`apps/zcode-cli/packages/tui/src/app-would-accept.ts:135-139`）与代码行为不一致。三级试点验证的是 spec lane 执行面，不是 auto 自治建任务。
5. **不要把 env 代理当安全边界**。spec lane 的已知残留（`curl --noproxy '*'`、undici `fetch` 直连）仍然成立，见 spec-lane §0/§5/§8-6。P6 围栏默认关闭，且当前只有 darwin sandbox-exec 可用；Linux/Windows 启用 `features.specEgressFence` 会 fail-closed 拒绝启动。试点期间按“零 egress + 零凭据 + 结构隔离”运行，但不得对外宣称硬隔离。

## 1. 开关矩阵与灰度边界

| 开关 | 缺省 | 位置 | 试点作用 | 备注 |
| --- | --- | --- | --- | --- |
| `features.eventRouter` | false | `~/.zcode/cli/config.json` 或项目 `.zcode/config.json` | 全局 kill-switch；true 才构造控制面 | false 时 create-app 完全不构造控制面，零行为变化 |
| `BotConfig.eventRouterEnabled` | undefined | `{dataBaseDir}/.zcode/v2/bot-config.v3.json` 的 `bots[]` | bot 维度灰度；必须全局 true 且该 bot true 才进 intake | 读点已接：`packages/services/src/bots/botsService.ts:3990-3993`（spec §8-19①） |
| `features.mandateGate` | false | 同 config | mandate 三档解析 + `checkPermission` 前端门 + 五字段方案门 | true 时**必须** eventRouter=true，否则启动失败 |
| `features.specWriteLease` | false | 同 config | 写租约 admission 检查 | **试点三级保持 false**；检查点未接（trigger spec §1.5/§5.4） |
| `features.durableSchedulerDispatch` | false | 同 config | durable-wait 派发策略 | **保持 false**；派发桥循环未接线（spec §8-6） |

没有单独的“spec lane 开关”。spec run 的触发条件 = `mandateGate=true` + 某 `trigger_class` 存在非 `record_only` 的显式 mandate 行 + verdict `accept`。在当前生产面，唯一可用的写行入口是 would-accept 收件箱的 `promoteWouldAccept`（写 `tier=auto`）；没有 speculative 的 UI 入口，也没有受控运维入口。本文不提供手改 DB 冒充生产路径的做法；要严格验证 speculative 语义，必须先补代码/运维入口。

配置优先级（低 → 高）：系统缺省 → 用户 `~/.zcode/cli/config.json` → 项目 `.zcode/config.json`（根到 cwd）→ `ZCODE_*` 环境变量 → CLI override（`config-factory.ts:124-129`）。**这四个 super-agent 开关没有环境变量读点**（`env-config.adapter.ts` 只覆盖存储/网络/日志/工具并发与 `ZCODE_GOAL_LAYER`，没有这四开关的 env 分支），所以只能改配置文件；项目配置会覆盖用户配置。

bot 配置实际路径取决于宿主的数据根：默认 `~/.zcode/v2/bot-config.v3.json`；若设置了 `ZCODE_DATA_BASE_DIR` 或 Desktop 调用了 `setDataBaseDir()`，则是 `{dataBaseDir}/.zcode/v2/bot-config.v3.json`（`packages/services/src/paths.ts:37-57`）。必须与 `super-agent.sqlite` 同根，否则控制面读不到 bot 事件。

## 2. 三级试点开始前的统一前置检查

每一项都要留下证据（命令输出或截图），不通过就不开 flag。

### G1. 代码与测试基线

- 记录当前 commit、构建产物版本。
- 跑定向回归：`apps/zcode-cli/packages/bootstrap/tests/super-agent/{feature-flags,control-plane-assembly,control-plane-create-app,create-app-admission-chain,admission-handoff,admission-mandate-facts,e2e-gray-chain,spec-run-dispatcher,spec-run-launch}.test.ts`；`packages/services/test/botsService.triggerSink.test.ts`；`apps/zcode-cli/packages/adapters/tests/spec-run-env.test.ts`；`apps/zcode-cli/packages/bootstrap/tests/super-agent-spec-lane.test.ts`；`apps/zcode-cli/packages/core/tests/{permission-mandate-admission,permission-mandate-gate}.test.ts`；`packages/zcode-server-cli/test/controlPlaneSupervisor.test.ts`。
- 失败即停，不靠“其他测试都过了”掩盖。

### G2. 宿主准入三件（spec §8-10 / §8-14 / §8-16 / §8-19）

| 项 | 现状 | 检查方式 | 不通过时 |
| --- | --- | --- | --- |
| 协议宿主注入 `handleCommand` / `autoReplyGuard` | **注入已接、群内 IM 守卫未实现**：`handleCommand` 真实接线；`autoReplyGuard` 是桩，群内 IM 被咨询即响亮抛错（`server-operations.ts:3453-3460`），botsService 状态未随入站下沉（spec §8-14①/§8-10②） | flag-on 启动成功即注入面成立；群内 IM 咨询必须响亮失败（不是通过） | 停；修宿主接线；**群聊试点在 §8-10② 接通前不开放** |
| services 侧 `TriggerSink` 跨进程注入 | **未接**（trigger spec §8-1、§8-10②；归入站宿主下沉/里程碑 B） | 真实 bot 消息后查 `trigger_events` 是否新增行；无行 = 未接通 | **一级试点阻塞**，不得用测试注入当生产证据 |
| `BotConfig.eventRouterEnabled` 读点 | 已接（spec §8-19①） | bot 未开时 sink 零调用（回归测试 `botsService.triggerSink.test.ts`） | 停；检查 bot id 与配置路径 |

### G3. 里程碑 B / daemon 承载（决定“关 Desktop 是否继续”）

- 当前 `packages/server` / `packages/zcode-server-cli` 不依赖 `@zcode/bootstrap`。受管子进程的**生命周期脚手架已落**（`packages/zcode-server-cli/src/supervisor/` + `controlPlaneLauncher.ts`：真实 spawn、ready/协议校验、崩溃预算；测试 `packages/zcode-server-cli/test/controlPlaneSupervisor.test.ts`），但**生产 flag、headless 入口与 RPC 未接**，里程碑 B 仍未完成（spec §7-7），A8 仍不成立。
- 若未落地：试点只能在 Desktop/TUI 宿主存活期内运行；**A8“关窗/关 Desktop 主动继续”不成立**，不得对外声称已达成。关宿主即控制面停，事件不会继续被裁决。
- 检查方式：确认 daemon 侧存在 spawn 控制面子进程的入口、入站 webhook / scheduler 已随之下沉、`control_plane_leases` 在关 Desktop 后仍有心跳；三者缺一即按里程碑 A 语义运行。

### G4. 域库与迁移

- 路径：`~/.zcode/v2/super-agent.sqlite`（`apps/zcode-cli/packages/bootstrap/src/app/paths.ts:39-46`；`ZCODE_DATA_BASE_DIR` 下为 `{root}/.zcode/v2/...`）。
- flag-off 时文件不存在是正常；flag-on 首次启动创建并跑迁移 0001/0002。
- 检查表：`trigger_events / trigger_subscriptions / mandate / write_leases / decision_log / control_plane_leases`；`decision_log` 有 `card_payload` 列。
- 若文件已存在：`sqlite3 "$DB" ".tables"`、`select count(*) from decision_log;`，确认不是旧结构。

### G5. tasks-index 派发桥注入

- 协议宿主路径会注入 `tasksIndexDatabasePath`（spec §8-14①）；若该 tasks-index 文件存在但没有 `dispatch_requests` 表，构造期 prepare 会响亮失败（spec §8-16①）。
- 检查：`sqlite3 "$TASKS_DB" ".tables" | grep dispatch_requests`。没有表就**不要**在注入桥的宿主上开 flag-on；TUI 路径不注入桥（spec §8-16①）。
- `durableSchedulerDispatch` 保持 false；桥循环未接线前不写 pending 行。

### G6. 配置层与数据根一致性

- 扫描用户配置与从项目根到 cwd 的所有 `.zcode/config.json`，确认没有冲突的 `features.eventRouter` / `features.mandateGate` 值。项目配置优先，改用户配置无效是常见坑。
- 确认 Desktop 数据目录 / `ZCODE_DATA_BASE_DIR` / `bot-config.v3.json` / `super-agent.sqlite` 同根。
- 记录 bot id、workspace identity（`workspaceIdentity?.trim() || workspacePath`）与试点 repo。

### G7. 备份与回滚演练

- 停宿主后备份：`config.json`、项目 `.zcode/config.json`、`bot-config.v3.json`、`super-agent.sqlite`（用 `sqlite3 "$DB" ".backup ..."` 或停进程后复制）。
- 演练一次：把开关置回 false、重启、确认 legacy bot 消息仍能创建任务。演练通过才开始正式试点。

### G8. 观测准备

- 日志路径：`~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`；控制面错误统一带 `event=bootstrap.super_agent.error` 与 `context` 字段（`create-app.ts:1143-1149`）。
- 明确 on-call 与停止条件（§7）。没有观测人和回滚授权就不要开。

## 3. 一级：eventRouter 触发路由试点

### 3.1 开关操作

1. 确认 G1-G8 全过，尤其 G2 的 `TriggerSink` 跨进程注入。
2. 用户配置或试点项目 `.zcode/config.json` 写 `features.eventRouter=true`，`features.mandateGate=false`，另两个开关保持 false。
3. 停宿主，编辑 `bot-config.v3.json`，只给一个 bot 加 `"eventRouterEnabled": true`（其余 bot 保持缺省）。不要在宿主运行时手改该文件（`BotsRepo` 有文件锁，外部写会与运行时写竞争）。
4. 启动宿主。启动失败（缺 `options.superAgent`、tasks-index 缺表等）即回滚。
5. 验证：发一条该 bot 的真实消息；查 `trigger_events` 新增 1 行；`decision_log` 对应 `origin=fast_path`；legacy 未开的 bot 仍走旧路径。

### 3.2 观测指标

数据源 = `super-agent.sqlite`（只读 SELECT，禁止 UPDATE/DELETE）+ 宿主日志。

1. **三边路由分布**：
   `select source, coalesce(fast_path,'<null>') as fast_path, final_disposition, adjudication_status, count(*) from trigger_events where workspace_identity=? group by 1,2,3,4;`
2. **候选积压与龄**：
   `select count(*), min(created_at) from trigger_events where workspace_identity=? and fast_path='unowned_candidate' and adjudication_status='pending';`
3. **owned 投递失败/未决**：`final_disposition is null` 的 owned 行。注意 `human_explicit` 成功行也故意保持 NULL（spec §8-13），查询必须排除 `fast_path='human_explicit'`：
   `select count(*) from trigger_events where workspace_identity=? and fast_path='owned' and final_disposition is null;`
4. **decision_log 分布**（`origin × disposition`）：
   `select origin, disposition, count(*) from decision_log where workspace_identity=? group by 1,2;`
5. **重复写**：`select trigger_id, origin, count(*) c from decision_log where trigger_id is not null group by 1,2 having c>1;` 正常应为 0。
6. **would-accept 卡片数**：按控制面读面同一条件统计 `decision_log(disposition='would_accept')` 且未被 `would_accept_convert` 覆盖。
7. **leader 租约**：`select owner_id, expires_at, heartbeat_at, expires_at-heartbeat_at as ttl from control_plane_leases;` 正常每个 workspace 一行，TTL=45000（`apps/zcode-cli/packages/bootstrap/src/super-agent/trigger/control-plane-lease.ts:6-9`），心跳间隔 15s。
8. **错误日志**：`grep 'bootstrap.super_agent.error' ~/.zcode/cli/log/zcode-$(date +%F).jsonl`，按 `context` 分类：`subscription_backfill / dispatch.host_ack / leadership.heartbeat / would_accept.* / spec_run`。
9. **延迟**：仓内没有生产端到端延迟指标。一级试点用两类证据：
   - 实验室红线：`npx vitest run apps/zcode-cli/packages/bootstrap/tests/super-agent/perf-baseline.test.ts --disable-console-intercept`；参考基线（2026-11-05 报告）为裁决攒批 P95 1.382ms、owned 直通 P95 0.280ms、DB 测试吞吐约 1.62 万行/秒。只用于拦病理级回归，不是生产 SLO。
   - 现场抽样：人类 explicit 消息从宿主 transcript 的 user 消息时间戳到首个 assistant token，手工抽 ≥20 条，记录 P50/P95；对照设计目标 P95 <5s。没有样本就不宣称达标。
10. **registry**：当前 `BackgroundRunRegistry` 是进程内投影、未接生产 `create-app`（实现在 `apps/zcode-cli/packages/bootstrap/src/super-agent/watchdog/registry.ts`，“里程碑 A 进程内投影”注释在 `watchdog/contract.ts:201`）。试点期 registry 指标**不可从磁盘读取**，记录为“不可用”；不得用文件/日志冒充。若后续接线，读 `tick()` 的 `TickReport.probes`，已知 `dispatch-pending-overage / daemon-heartbeat / permission-pending-overage / restart-storm` 四个探针数据源未落地，恒 skipped。

### 3.3 失败注入演练（一级）

| 演练 | 方法 | 期望 | 类型 |
| --- | --- | --- | --- |
| 重复 providerMessageId | 同一 IM 消息重发 / 重放 webhook | `trigger_events` 单行（partial unique 吸收）；不双跑 | 现场可做 |
| bot 未开灰度 | 另一个未加 `eventRouterEnabled` 的 bot 发消息 | sink 零调用，legacy createTask 一次 | 现场可做 |
| 群内 IM 被咨询 | 在群里 @ 试点 bot 触发自动回复 | `autoReplyGuard` 桩响亮抛错，事件不被自动回复；这是未接通接缝，不是演练通过项。按事故登记并停用该 bot 的群聊面 | 现场可做（§8-10② 接通前群聊试点不开放） |
| 宿主 attachment 离线 | daemon 存活但关闭 host/窗口 | owned 投递 `delivery_failed`，行保持未决；**已知限制：没有 trigger_events 启动重放扫描，不会自动恢复**（代码只有 dispatch bridge 的 `resumePendingAfterBoot`）。现场出现即按事故处理，不等自动修复 | 现场可做（里程碑 B 下） |
| 控制面 kill / 双实例 | kill 控制面进程或再开一个宿主 | 45s 租约过期后单 leader；follower 不跑控制面循环、sink 恒 `handled:false` | 现场可做（依赖里程碑 B 的 daemon 受管子进程） |
| 裁决驱动器故障 | 断模型 provider / 注入坏 verdict（实验室） | intake 不被堵；candidate 留 pending，下一次评估点重试；`onError` 可见 | 实验室 T2/A10 |
| decision_log 写失败 | 实验室注入同库写失败 | 事务整体回滚，无“有事件无决策”半态 | 实验室 |
| 跨 workspace 事件 | 实验室构造错 workspace 的 trigger（`admission-mandate-facts.test.ts`） | 响亮拒绝 | 实验室 |

### 3.4 放量判据与停止条件

建议节奏（时长可调，判据不可省）：

- 波次 1：1 bot × 1 workspace，24h。
- 波次 2：同 workspace +2 bot，48h。
- 波次 3：同 workspace 全部试点 bot，72h；跨 workspace 暂不扩。

进入下一波次必须同时满足：

- 零重复执行、零跨 workspace 行、零双 leader；
- `final_disposition is null` 的 owned 行 = 0（除已知演练且已人工处置）；
- 重复 decision_log = 0；
- 启动/重启后无响亮失败，`leadership.heartbeat` / `dispatch.host_ack` 错误 = 0；
- 人类 explicit 抽样 ≥20 条且 P95 与现状持平（目标 <5s）；样本不足则不开下一波；
- would-accept 卡片每日有人处置，积压不持续增长。

任一停止条件触发即回滚：出现重复建任务/双跑、跨 workspace 执行、凭据出现在日志/协议、owned 未决行超过 1h 无人处置、控制面启动失败、出现两个活跃 heartbeat、silent legacy fallback。

## 4. 二级：mandateGate 试点

### 4.1 开关操作

1. 一级波次 3 稳定 72h。
2. 配置改为 `eventRouter=true` + `mandateGate=true`，另两个保持 false。**先改 mandateGate 再重启**，不要只改 eventRouter。
3. 启动必须成功；若 `eventRouter` 被项目配置压回 false，启动会因 `mandateGate=true` 依赖失败而响亮失败——这正是 fail-closed 的预期。
4. 验证：人类 explicit 事件仍按 user-origin 免 Mandate 执行；non-human_explicit 事件回合命中 mandate 门（record_only 撞写操作应 deny）。

### 4.2 观测指标

在一级指标基础上增加：

1. **mandate 行**：`select trigger_class, tier, status, expires_at, policy_version from mandate where workspace_identity=?;` 正常最多每个 `trigger_class` 一行 active。
2. **档位分布**：`select disposition, count(*) from decision_log where workspace_identity=? and origin='adjudication' group by 1;` 关注 `would_accept` 与 `record_only` 的比例。
3. **方案门拦截**：`select reason, count(*) from decision_log where reason like 'scheme_card_incomplete:%' group by 1;` 应为 0 或已解释；控制面另有 `super_agent.would_accept.scheme_gate` 错误日志。
4. **批转幂等**：`select trigger_id, count(*) from decision_log where origin='would_accept_convert' and workspace_identity=? group by 1 having count(*)>1;` 正常 0。
5. **预算/工具门**：事件回合写操作被 deny 的计数来自 Core 权限结果与日志（仓内无独立指标表）；用实验室 `permission-mandate-admission` + `create-app-admission-chain` 作为行为证据，现场用真实事件回合的工具结果抽样。
6. **重启后排队输入**：已知接缝——进程重启后已持久化队列项的提升会丢 mandate facts，退化为 user-origin（spec §8-17③/§8-18）。试点必须在观测里单独记“重启次数 + 是否发生过排队提升”；这是已知降级，不是静默通过。

### 4.3 失败注入演练（二级）

| 演练 | 方法 | 期望 |
| --- | --- | --- |
| record_only 撞写 | 实验室/真实事件回合触发 Write/Edit | deny，不建 task、不执行 |
| 过期/吊销 mandate | 实验室 `permission-mandate-admission`；现场无生产 revoke UI，需停宿主后受控改行 | 下一次 admission deny；turn 内不中断在途 |
| 缺 facts / fast_path=NULL | 实验室 `admission-mandate-facts` | 响亮抛错，不静默按 user-origin |
| 跨 workspace trigger | 实验室 | 响亮拒绝 |
| guide 车道绕过 | mandateGate 开时对非 human_explicit 事件投 guide | rejected `proto.eventGuideLaneRequiresUserOrigin` |
| promote 重复点击 | 同一 cardId 连点两次 | mandate/convert 各零新增（`BEGIN IMMEDIATE` 锁内检查） |
| 方案卡缺字段 | 裁决 accept 但缺五字段 | 降级 record_only + `scheme_card_incomplete:<字段>`，卡片不外发 |
| 重启丢 facts | 排队一条事件输入后重启 | 观测到退化为 user-origin 并记录；不得据此放宽门 |

### 4.4 放量判据与停止条件

- 波次 1：1 workspace、不 promote，24h。
- 波次 2：promote ≤5 张卡，48h。
- 波次 3：该 workspace 全部卡可批转，72h。

判据：零 record_only 越权写、零缺 facts 静默放行、零 scheme 门漏发、promote 幂等、启动无失败、无跨 workspace。停止条件：任一写操作在 record_only 下被放行、事件来源回合被误判为 user-origin、promote 产生重复 mandate、缺 facts/未路由事件不响亮、启动失败。

## 5. 三级：speculative / spec lane 试点

### 5.1 开关与当前语义

- 没有独立 flag；入口是 `mandateGate=true` + 非 record_only 的 mandate 行 + verdict accept。
- 当前生产写行入口只有 `promoteWouldAccept`（写 `tier=auto`）；`verdict-interpret.ts:215-232` 对 `speculative` 和 `auto` 都调用 `specRun.start`。因此本试点实际验证 **spec lane 执行面**，不是设计里 auto 的 createTask/resume。TUI 成功文案仍写“auto execution tier activates in a later phase”，与代码不一致，按代码行为记录。
- **零 egress only**：`create-app.ts:1106-1108` 明确 `resolveAllowHosts` 未接，缺省 `[]`，当前没有任何配置方式放开白名单。三级试点不得要求非零 egress。
- `features.specWriteLease=false`：没有写租约 admission 检查点；spec run 与活 worker 同 repo 写冲突没有机制互斥。试点规则：**同一 workspace 同一时刻只允许一个 spec run，且不得有活跃 worker 在写同一 repo**（dispatcher 按 workspace 串行 prepare→launch→stop，见 `spec-lane/dispatcher.ts:111-174`，这只能保证 spec run 之间串行，不约束活 worker）。

### 5.2 开关操作

1. 二级波次 3 稳定 72h。
2. 配置保持 `eventRouter=true` + `mandateGate=true`，另两个 false。
3. 选 1 个试点 workspace / repo，确认无活跃 worker。
4. 从 would-accept 收件箱选 1 张有完整五字段方案卡、价值低、可人工验收的卡，执行 promote。
5. 观察该 `trigger_class` 的下一次 accept 是否启动 spec run；确认 run 终态后 egress 停止（`stopSpecRunEgress`）、子进程退出。

### 5.3 观测指标

1. **执行与失败**：`select disposition, count(*) from decision_log where workspace_identity=? and disposition='accept';` 对应 accept 行；异步 spec run 失败只在 onError `super_agent.trigger.spec_run <triggerId>`（`verdict-interpret.ts:246-260`），**accept 行不会回滚**。必须把 accept 数与成功 run 数分开记，不能把 accept 当成功。
2. **工具面**：run 子进程工具应为 `Read/Glob/Grep/Write/Edit/Bash/TodoWrite/TodoRead`，`WebFetch/WebSearch/SendMessage/ReplyToChannel/Agent/CreateWorkflow/Goal*/mcp__*` 全部缺席（`core/src/subagent/tool-policy.ts`，测试 `spec-run-launch.test.ts` 有真实断言）。
3. **凭据真空**：子进程 env 只含白名单运行键 + 代理键；`GITHUB_TOKEN/ANTHROPIC_API_KEY/NPM_TOKEN/ZCODE_TOOL_ENV_PASSTHROUGH_JSON` 结构性缺席（`adapters/src/network/subprocess-env.ts`，测试 `spec-run-env.test.ts`）。
4. **egress**：代理 allowlist 为空 ⇒ 经代理的请求全 403；但 `curl --noproxy '*'` / node fetch 可直连是**已知残留**，不是回归。记录 canary 结果时写“残留在案”，不要写成“已拦截”。
5. **registry**：`BackgroundRunKind` 没有 `spec`，registry 不登记 spec run；不要从 registry 找 spec run。spec run 的观测源只有 decision_log accept + onError + 子进程日志。
6. **写冲突**：run 前后 `git status` / 关键文件 mtime 对比；发现非本 run 的并发写入即停。

### 5.4 失败注入演练（三级）

| 演练 | 方法 | 期望 |
| --- | --- | --- |
| 非白名单主机（读代理的客户端） | 实验室/现场受控 canary，Bash `curl` 默认行为 | 403/失败，run 失败可见 |
| 绕过残留 | `curl --noproxy '*'` / node fetch 到受控 canary | **成功是已知残留**；把命中写入风险接受单，不改测试断言为“拦截”；若命中真实外部服务（非受控 canary）立即停试点 |
| 缺代理 / 代理启动失败 | 实验室占用端口或删代理注入 | `SpecEgressStartupError` / `buildSpecRunEnv` 抛错，run 拒绝启动，不直连 |
| 受限 profile 被替换 | 实验室注入削弱 profile | dispatcher 拒绝启动 |
| workspace 不一致 | 实验室构造错 workspace 事件 | 拒绝启动 |
| run 崩溃 / kill -9 | kill spec 子进程 | 无自动重跑；accept 行保留；onError 可见；egress 回收 |
| 出站工具存在 | 实验室断言 child 工具面 | 零出站工具；`mcp__*` 前缀同剔 |
| 并发写冲突 | 试点中人为开一个写同一 repo 的 worker | 无租约保护，可能冲突；**这是禁止操作，不是演练通过项**；发现即停并回滚 |

### 5.5 放量判据与停止条件

- 波次 1：1 repo，10 个 run / 7 天。
- 波次 2：3 repo，20 个 run / 14 天。
- 波次 3：全部试点 repo，30 天。
- 非零 egress 在任何波次都不开；要开必须先确认目标平台围栏真实可用（`features.specEgressFence=true`，当前仅 darwin sandbox-exec 通过真跑；Linux/Windows 会 fail-closed）。

判据：零凭据字节（测试 + env 审计）、零出站工具、零对外消息、零自动 push、每个 run 失败都可见、accept 与成功 run 的差额有解释、代理终态关闭、无 repo 损坏、无并发写冲突、无非零 egress 请求。

停止条件：任一 run 对外产生副作用（canary 命中）、凭据出现在 env/日志/协议、受限 profile 被绕过、run 被误报成功、repo 出现非本 run 写入、代理未关闭、出现非零 egress 需求被“想办法”绕过。

## 6. 指标口径汇总

| 面 | 数据源 | 能回答的问题 | 不能回答的问题 |
| --- | --- | --- | --- |
| `trigger_events` | `super-agent.sqlite` | 入站量、三边分布、候选积压、owned 未决 | 投递端到端延迟（只到 admission 前） |
| `decision_log` | 同库 | fast-path/裁决/批转的处置分布、重复写、方案门拦截 | 执行是否真正成功（accept ≠ 成功） |
| `mandate` | 同库 | 档位、过期、活跃行 | 用户为何批转（需 reason/evidence 联读） |
| `control_plane_leases` | 同库 | 单 leader、心跳、租约超期 | 控制面内部线程健康 |
| 错误日志 | `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` | 控制面 onError 上下文 | 结构化指标（只有日志） |
| registry | 进程内 `BackgroundRunRegistry` | 后台 run 行级投影（若接线） | 当前未接生产、不持久、不覆盖 spec run |
| 延迟 | perf-baseline 实验室 + 现场 transcript 抽样 | 控制面内部开销、人类 explicit 端到端样本 | 无自动 P95 面板 |

## 7. 统一回滚与事故处置

### 7.1 回滚步骤（任何一级通用）

1. 记录时间、当前开关、当前 commit、复现步骤；备份配置与 DB（若宿主仍能停）。
2. 把最高优先级配置源里的 `features.mandateGate` 改为 false。
3. 把最高优先级配置源里的 `features.eventRouter` 改为 false。
4. 把试点 bot 的 `eventRouterEnabled` 改为 false / 删除该键（需停宿主后改 `bot-config.v3.json`）。
5. 重启承载进程（Desktop / `zcode tui` / daemon 子进程）。**不重启 = 不生效**。
6. 验证回 legacy：给该 bot 发消息，确认能正常建任务；`trigger_events` 不再新增；启动无 `bootstrap.super_agent.error`；`control_plane_leases` 不再心跳。
7. DB 保留。不要删；如需清理，另走停宿主 + 备份 + 明确批准。

### 7.2 事故分级与首动作

| 现象 | 首动作 |
| --- | --- |
| 重复建任务 / 同一事件双跑 | 立即回滚 eventRouter；保留 DB 供审计；查 commandId/providerMessageId 幂等面 |
| 跨 workspace 执行 | 立即回滚；隔离该 workspace；查 trigger workspace_identity 与组合根校验 |
| 凭据字节出现在日志/协议/env | 立即回滚；按泄露事件处置；轮换凭据；保留日志 |
| 控制面启动响亮失败 | 不要绕过；按错误码修宿主注入/迁移/桥表；修好再开 |
| owned 未决行长期不收敛 | 立即停量；当前无启动重放，人工处置并登记；不要改 DB 状态伪装 routed |
| 两个活跃 leader / 双控制面 | 立即停宿主之一；检查 `control_plane_leases` 与 `changes()>0` 断言；回滚 |
| spec run 对外副作用 | 立即回滚 spec 级（mandateGate=false + 重启）；隔离 repo；按 P6 围栏缺口评估 |

## 8. 已知限制清单（试点期间必须写进日报）

1. 开关启动期读点，不能热切换；回滚必须重启。
2. 里程碑 B daemon 承载未落地前，关 Desktop/关窗不继续；A8 不成立。
3. services `TriggerSink` 跨进程注入未接时，eventRouter 一级试点无法在真实 bot 消息上成立（只有测试注入证据）。
4. 没有 trigger_events 启动重放扫描；owned 投递失败行不会自动恢复。
5. registry 未接生产且不持久；spec run 不在 registry。
6. 没有自动生产延迟指标，只有实验室基线与人工抽样。
7. auto 档当前走 spec lane，不建 task；TUI 文案滞后。
8. `specWriteLease=false`：无写租约；试点必须保证同 workspace 单 spec run 且无并发活 worker。
9. `durableSchedulerDispatch=false`：派发桥循环未接，durable-wait 不可用。
10. 进程重启后排队事件输入的 mandate facts 会丢，退化为 user-origin（已知接缝）。
11. `app.close` 存在在途裁决批落在关库之后的窄竞态：onError 告警、零写入、候选留 pending（spec §8-12）。
12. env 代理残留（`--noproxy` / undici fetch）仍可直连；P6 围栏默认关闭，Linux/Windows 未实现（启用即拒绝启动），零 egress 白名单不是硬边界，不得对外宣称物理隔离。
13. 协议宿主的 `autoReplyGuard` 是桩：群内 IM 被咨询即响亮抛错（`server-operations.ts:3453-3460`），botsService 状态未随入站下沉（spec §8-10②）。**群聊试点在该接缝接通前不开放**；若误开，首条群内咨询即事故，按 §7.2“控制面启动/守卫响亮失败”处置，不得用放宽守卫的方式绕过。

## 9. 每日/每波次记录模板

```text
日期：
试点级别：1 / 2 / 3
开关：eventRouter=… mandateGate=… botId=… workspace=…
commit：
入站/候选/裁决计数：
would-accept 卡片：新增 … 处置 … 积压 …
错误日志：context → 次数 → 处理
延迟抽样：样本 … P50 … P95 … 对照基线
spec run：accept … 成功 … 失败 onError … 失败原因
异常与处置：
是否满足放量判据：是 / 否（缺哪条）
下一步：扩量 / 保持 / 回滚
```
