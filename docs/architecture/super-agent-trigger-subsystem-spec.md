# Super-agent 触发子系统 Phase 2 实施规格（Trigger Intake / EventRouter / 裁决 / 派发桥）

状态：实施级 spec（对应 [super-agent-harness-design.md](./super-agent-harness-design.md) Phase 2 批；机制锚点 M1 / M2 / M3 / M7② / M9 / M12②，组件矩阵 §2.2，物理部署 §2.3）。本文只覆盖 Phase 2 触发子系统批。Mandate 执行档（Phase 3，M4）、watchdog（Phase 4，M10）、写租约执行（Phase 5，M12①）在本文只定 schema 与接缝，不启用行为。与设计文档冲突时以设计为准，差异登记在 §7 待裁决。

## 0. 范围与不变量

Phase 2 交付物（设计 §7 Phase 2 原文）：订阅表 + 准入表 + trigger 枚举（webhook / IM / schedule；git / file 预留）+ 短命裁决（**全部 record-only**）+ dispatch_requests exactly-once + 存量订阅回填 + would-accept 收件箱。控制面整体落 SourceServer daemon（含 per-workspace leader 租约与 daemon 可达性门禁）。**入站接收随 Phase 2 一并下沉 daemon**（设计 §2.2 明文：bots 入站 WebSocket/长轮询不入 daemon，「主动」在关机态不成立）——入站宿主、TriggerSink 注入点移动与 Desktop 回退期语义见 §5.2；宿主承载组合根待裁决（§7-7）。

硬不变量（每条都有 §4 测试锚）：

- CommandInbox 仍是全渠道唯一 admission，任何新事件源禁止旁路（M1）。
- 热路径零 LLM：owned 直通、human-explicit 直通分派器，均不进裁决。
- 终态窄结果唯一路径 = task-notification → CommandInbox，不回流 Intake（M2 车道归属裁定）。
- 裁决会话只读工具面 + per-candidate verdict JSON，由程序解释执行；LLM 永不持有 dispatch 工具（M3）。
- verdict 解析失败/schema 不过的批整体降级 record-only（fail-closed 到最安全档）并计数（M3）。
- trigger 行 / 订阅表唯一写者 = daemon leader 控制面；会话侧只读经 RPC（§2.3）。
- dispatch_requests：host ACK（CommandInbox admission 回执）后才 settle dispatched；skipped 结算仅由宽限定时器触发且与 push 状态 CAS 互斥（M7②）。
- Phase 2 无任何 Mandate 行为：无 mandateId 一律按隐式 record-only，只落 would-accept（M4 缺省语义，执行档 Phase 3 开）。
- EventRouter 按 bot 维度灰度 + 全局 kill-switch，kill 后一键回 legacy bots 直路（M2 存量迁移）。
- trigger 原文与凭据不落日志；taint 永不构成指令权威（§5）。

## 1. 表与物理落位（§2.3 落地）

### 1.1 库文件

| 库 | 路径 | 内容 | 写者 |
| --- | --- | --- | --- |
| daemon 域库（新） | `~/.zcode/v2/super-agent.sqlite`（WAL；路径 getter `getSuperAgentDatabasePath()` 落 bootstrap 侧 `apps/zcode-cli/packages/bootstrap/src/app/paths.ts`——`@zcode/bootstrap` 不依赖 `@zcode/services`，且 §2 层级禁令禁 super-agent 模块 import `packages/services` 实现，故不收口到 `packages/services/src/paths.ts`；dataBaseDir 按 `ZCODE_DATA_BASE_DIR`→`homedir()` 解析，与 `services/paths.ts` 同语义） | trigger_events、trigger_subscriptions、mandate、write_leases、decision_log、control_plane_leases | daemon leader 控制面（唯一）；会话/host 侧只读经 RPC |
| tasks-index 库（既有） | `~/.zcode/v2/tasks-index.sqlite`（WAL，`getTasksIndexDatabasePath()`） | automation / off-peak 既有表 + **dispatch_requests** | daemon 内 scheduler（Phase 2 从 Main electronUtilityProcess 迁入）；平台回退期 Main fork 按 §5.3 仲裁门控 |

schema 版本化走既有迁移机制（`@zcode/shared/sqlite-migrations` + 迁移数组模式，参照 `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts` 的登记方式）；daemon 域库首迁 = 建库 + 建全部表（纯增量，不影响旧路径，§2.3 尾注）。跨库不 join：decision_log→建 worker/写订阅同库原子在 daemon 域库内完成；跨库（dispatch_requests ↔ 域库）用 outbox 语义（§4 流五 4）。

#### 实施偏差（2026-11-02，ws5-storage-leaf）

- 上表括注「dataBaseDir 按 `ZCODE_DATA_BASE_DIR`→`homedir()` 解析，与 `services/paths.ts` 同语义」修正为：`packages/services/src/paths.ts` 的 `getDataBaseDir()` 优先级是 **`setDataBaseDir()` 覆盖 → `ZCODE_DATA_BASE_DIR` → `HOME`/`homedir()`**（env/HOME 在 import 期缓存）；`@zcode/bootstrap` 不依赖 `@zcode/services`，`getSuperAgentDatabasePath()` 调用期现读 env，读不到 `setDataBaseDir` 的进程内覆盖，两者仅在无覆盖时同语义。
- §7-6「与 tasks-index 同目录」的落地方式：路径解析权在宿主组合根——凡调用过 `setDataBaseDir()` 的宿主（Desktop 生产启动必经，`packages/desktop/src/main/desktopDataBaseDirBootstrap.ts`），必须把 `getDataBaseDir()` 结果作为 `baseDir` 传入 `getSuperAgentDatabasePath(baseDir)`（或自行拼接后经 `openSuperAgentDatabase({databasePath})` 显式注入），否则 super-agent.sqlite 与 tasks-index.sqlite 分根。

### 1.2 trigger_events

统一环境事件 intake/审计层（M2）。**只做 intake/审计**；task-notification 运行时投递仍走 runtime-command-queue，不入本表（M2 车道归属裁定）。`source=schedule` 行仅由 scheduler 认领时审计落（§5.2），不进三边路由/攒批，执行唯一走 dispatch_requests 桥。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | triggerId（uuid） |
| workspace_identity | TEXT NOT NULL | 身份 key（`workspaceIdentity?.trim() \|\| workspacePath`） |
| source | TEXT NOT NULL | `im` \| `webhook` \| `schedule` \| `ci`（P2 枚举；`git` \| `file` 仅类型预留，不产生行） |
| thread_key | TEXT NOT NULL | M2 归一规则：workspaceIdentity + 域键。P2 域键 = 信道域键（bot:botId+providerUserId/threadId；schedule:automationId；webhook:routeId）。PR 等跨信道域键归一 P5 黄金验收落地 |
| actor_kind | TEXT NOT NULL | `human` \| `bot` \| `system`（bot 互答守卫输入） |
| actor_id | TEXT | providerUserId / botId / scheduler |
| payload | TEXT NOT NULL | 摘要化 JSON（内容上限 64KB，超限截断 + artifact 引用）；重放（§4 流五 3）依赖此列 |
| payload_digest | TEXT NOT NULL | sha256(payload)，幂等与审计 |
| taint | INTEGER NOT NULL DEFAULT 1 | M2/§5 信封：supervisor 铸造，永不为指令权威 |
| provider | TEXT | `feishu` \| `lark` \| `weixin` \| `webhook` \| `scheduler` \| … |
| provider_message_id | TEXT | 幂等键成员 |
| fast_path | TEXT | Fast Path 三态：`owned` \| `human_explicit` \| `unowned_candidate`；NULL = 未路由/被拒 |
| adjudication_status | TEXT | NULL（非 candidate）\| `pending` \| `accepted` \| `rejected` \| `record_only` |
| final_disposition | TEXT | 路由/裁决收敛后的终态 |
| settled_at | INTEGER | |
| created_at / updated_at | INTEGER NOT NULL | |

约束与索引：

- `UNIQUE(provider, provider_message_id) WHERE provider_message_id IS NOT NULL` —— 三层幂等的持久层（M2 Fast Path）；进程内 markInboundDelivery Map 降级为快速守卫（§7-3）。
- INDEX `(workspace_identity, created_at)` —— 未决行启动扫描重放（§4 流五 3）。
- INDEX `(workspace_identity, thread_key, created_at)` —— thread 检索。

TTL（M9）：保留近 30 天 + 归档聚合（聚合行另表，P2 只实现清理任务与 `archive` 计数出口）。

### 1.3 trigger_subscriptions（+ lease）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | |
| workspace_identity | TEXT NOT NULL | |
| thread_key | TEXT NOT NULL | 与 trigger_events.thread_key 同规范 |
| session_id | TEXT NOT NULL | 订阅者（目标会话） |
| lane | TEXT NOT NULL | `followup` \| `guide` \| `inject`——M1 车道语义：busy 时 guide/inject 行内投递（inject 不唤醒、guide 步边界）；idle 时 followup 走 queue 并经 autoDrain 唤醒；watch 事件用 inject |
| filters | TEXT | JSON 可选过滤面 |
| owner_kind | TEXT NOT NULL | `session` \| `goal` \| `workflow`（终态注销依据） |
| owner_ref | TEXT | goal id / workflow run id |
| status | TEXT NOT NULL | `active` \| `revoked` |
| lease_expires_at | INTEGER NOT NULL | 随 leader 心跳续期；启动清过期 + owner 终态宽限回收（M1、§4 流五 6） |
| created_at / updated_at | INTEGER NOT NULL | |

约束与索引：

- `UNIQUE(workspace_identity, thread_key, session_id) WHERE status='active'` —— 回填与写入幂等（INSERT OR IGNORE）。
- INDEX `(workspace_identity, thread_key) WHERE status='active'` —— owned 直通查找。
- INDEX `(lease_expires_at) WHERE status='active'` —— 过期扫描。

fan-out（M1）：同 threadKey 多订阅者 = 事件**单播进 CommandInbox 一次**、由分派器复制为每订阅者一条带订阅者上下文的投递；投递幂等键 = `triggerId + subscriberSessionId`；重复通知由 claim-once 吸收。

### 1.4 mandate（P2 建表，不启用）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | mandateId |
| workspace_identity | TEXT NOT NULL | |
| trigger_class | TEXT NOT NULL | 如 `bot:<botId>` / `cron:<automationId>` / `webhook:<routeId>` |
| tier | TEXT NOT NULL | `record_only` \| `speculative` \| `auto` |
| scope | TEXT | JSON（信道/路径/成员范围） |
| policy_version | INTEGER NOT NULL | revalidate 依据（M4） |
| resume_after_restart | INTEGER NOT NULL DEFAULT 0 | M4 disarm 交互：缺省 0，auto 档 disarm 态只落 would-accept/通知 |
| expires_at | INTEGER | |
| status | TEXT NOT NULL | `active` \| `revoked` |
| created_at / updated_at | INTEGER NOT NULL | |

`UNIQUE(workspace_identity, trigger_class) WHERE status='active'`。**缺省 record-only 是隐式行**（查询层 UNION 缺省），不写表。P2 行为：分派器查 mandate 永远得到隐式 record-only → 全部 candidate 进 would-accept。解析契约（prompt admission 异步解析 + `checkPermission` 最前端同步 fail-closed，M4）与执行档在 Phase 3 启用；P2 只保证查询 API 与隐式缺省语义存在且被分派器调用。

### 1.5 write_leases（P2 建表，不启用）

M12① 收窄语义：只服务 spec-lane 静默 run vs 活 worker 的并发写。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | |
| workspace_identity | TEXT NOT NULL | |
| owner_run_id | TEXT NOT NULL | spec run id |
| scope | TEXT NOT NULL | JSON 文件集（run 声明） |
| status | TEXT NOT NULL | `active` \| `released` |
| lease_expires_at | INTEGER NOT NULL | 随 worker 终态 + 宽限回收；启动清过期 |
| created_at / updated_at | INTEGER NOT NULL | |

检查点（Phase 5）：workspace 写工具 admission 处查本表（与 permission path policy 同层），第二写者响亮拒绝不排队。P2 仅建表 + 仓储 API，不接检查点。

### 1.6 dispatch_requests（tasks-index.sqlite）

M7② exactly-once 派发桥的状态机载体。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | requestId（uuid） |
| run_id | TEXT NOT NULL UNIQUE | automation run / off-peak ticket 稳定 id |
| command_id | TEXT NOT NULL UNIQUE | `hash(runId)`——CommandInbox 幂等吸收键 |
| workspace_identity | TEXT NOT NULL | |
| session_id | TEXT | 目标会话 |
| payload | TEXT | 派发载荷（prompt/摘要） |
| status | TEXT NOT NULL | `pending_dispatch` \| `pushed` \| `dispatched` \| `skipped` |
| skip_reason | TEXT | `no_dispatcher` 等 |
| dispatch_policy | TEXT NOT NULL | `in_window`（缺省）\| `durable_wait`（opt-in，带最大陈旧期） |
| attempts | INTEGER NOT NULL DEFAULT 0 | |
| claimed_at / pushed_at / acked_at / settled_at | INTEGER | |
| created_at / updated_at | INTEGER NOT NULL | |

状态机（唯一写者 = daemon 派发桥；全部转移用单条 `UPDATE … WHERE id=? AND status=?` CAS）：

```
claimDue(BEGIN IMMEDIATE, running 0→1) ──► pending_dispatch ──push──► pushed ──host ACK──► dispatched
                                                    │
                                                    └──宽限定时器 CAS──► skipped(no_dispatcher)
```

- settle dispatched 仅在 host ACK（CommandInbox admission 回执，admitted 或 duplicate）后。
- skipped 仅由宽限定时器触发且与 push 状态 CAS 互斥（不可能 push 成功后又 skipped）。
- 崩溃重投：pending/pushed 停滞行按 ACK 状态续推或 skipped（§4 流五 5）；重推用同 commandId，CommandInbox 幂等吸收不双跑。
- 缺省 `in-window`：宽限内无 dispatcher → settle skipped(no_dispatcher)，与现状 misfire 语义对齐（不比现状更糟，M7②）；`durable-wait` 挂起至 host 回连 + 最大陈旧期。

INDEX `(status, updated_at)`（停滞扫描）、`(workspace_identity, status)`。

无 `failed` 终态：push RPC 异常计入 `attempts` 并按崩溃重投规则续推，最终收敛 `dispatched` 或 `skipped`（失败计数另行告警）；不设无转移语义的死枚举。

TTL（M9）：终态行（dispatched / skipped）保留 30 天。

### 1.7 decision_log

统一命名（§2.1：勿再生别名）。**唯一写者模块 = decision-log 子系统**；调用点有两个（Intake 的 fast-path disposition、裁决驱动器的 verdict / would-accept→auto 转化，M12②），全部经 decision-log 仓储 API 写入，不存在第二写者。注意：设计 §2.1 状态所有者表写的是「decision_log 归裁决驱动器」，本 spec 将唯一写者改判为独立 decision-log 模块（Intake 为调用方之一）——依据 M12② 要求 fast-path disposition 落 decision_log，属设计缺口类变更，已登记 §7-8 待设计方确认，确认前不视为已裁定。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | |
| workspace_identity | TEXT NOT NULL | |
| trigger_id | TEXT | FK trigger_events.id（would-accept→auto 转化行可为 NULL，记 mandateId） |
| origin | TEXT NOT NULL | `fast_path` \| `adjudication` \| `would_accept_convert` |
| disposition | TEXT NOT NULL | `accept` \| `reject` \| `record_only` \| `would_accept` \| `routed`（仅 origin=`fast_path`：owned/human_explicit 直通行已路由，M12②；不用于 adjudication verdict） |
| batch_id | TEXT | 裁决批分组（同 workspace 一批，M3） |
| model_tier | TEXT | `adjudicator`（轻量档）等，M12③ 分档记录 |
| reason | TEXT | |
| evidence | TEXT | JSON 数组（verdict evidence 引用） |
| created_at | INTEGER NOT NULL | |

INDEX `(workspace_identity, created_at)`、`(trigger_id)`、`(batch_id)`。TTL（M9）：滚动窗口 90 天。eval 闭环（M12② off-peak 导出）读本表，P2 只落行不交付导出。

### 1.8 control_plane_leases（leader 租约；§7-1 待裁决确认表名）

§2.2 单实例仲裁：per-workspace leader 租约（SQLite BEGIN IMMEDIATE + 心跳续期）。设计未命名承载表，本 spec 提议：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| workspace_identity | TEXT PK | |
| owner_id | TEXT NOT NULL | daemon 实例 id |
| role | TEXT NOT NULL | `control_plane`（intake/router/分派/裁决/scheduler 统一 leader） |
| expires_at | INTEGER NOT NULL | TTL = 3 × 心跳周期 |
| heartbeat_at | INTEGER NOT NULL | |

## 2. 模块边界（contract < domain < app < adapters < ui）

新文件必须落在 managed 模块根内（`unmanaged-new-file` 门禁）。设计 Add 清单目录（§7 Add）：`apps/zcode-cli/packages/bootstrap/src/super-agent/{trigger,intake,adjudication,mandate,write-leases,decision-log}/`。控制面模块随 daemon 生命周期运行（§2.2），但**「daemon 内嵌 bootstrap 组合根」不是仓库现状**：`zcode serve --daemon` 是 `@zcode/server-cli` 的 bin（→ Server Core = `packages/server`），`packages/server` / `zcode-server-cli` 均不依赖 `@zcode/bootstrap`，bootstrap 也无 daemon 入口。模块最终落 daemon 的装配方式登记为待裁决第 7 项（§7-7）；在拍板前，§2 模块表按「bootstrap 侧实现 + daemon 宿主接线点待定」执行，禁止按「已内嵌」假设直接写 server→bootstrap 依赖。

| 模块（拟 adopt id） | 根 | 层 | 职责 |
| --- | --- | --- | --- |
| `super-agent-intake` | `bootstrap/src/super-agent/intake/` | app | envelope 归一（taint 铸造、payload 摘要）、Fast Path 确定性准入表（来源白名单、群范围、addressed-vs-observed、admitAutoReplyTurn 互答守卫、providerMessageId 幂等）、三态输出、trigger_events 唯一写入点 |
| `super-agent-trigger` | `bootstrap/src/super-agent/trigger/` | app | trigger_subscriptions 仓储、EventRouter（owned 直通）、程序分派器（human-explicit resume/createTask；verdict 解释执行）、dispatch bridge（dispatch_requests 状态机 + push/ACK 协议端）、存量回填 |
| `super-agent-adjudication` | `bootstrap/src/super-agent/adjudication/` | app | 裁决驱动器（阈值 N=8 / SLA T=60s / 评估点 5min 攒批，与 goal 存在性解耦）、verdict schema、短窗 KV 复用会话管理、独立微预算计量点 |
| `super-agent-mandate` | `bootstrap/src/super-agent/mandate/` | app | mandate 仓储 + 隐式 record-only 解析 API（P2 仅查询语义；解析契约/执行档 P3） |
| `super-agent-write-leases` | `bootstrap/src/super-agent/write-leases/` | app | write_leases 仓储（P2 仅建表） |
| `super-agent-decision-log` | `bootstrap/src/super-agent/decision-log/` | app | decision_log 唯一写入口 + 保留清理 |

每个模块五件套：`module.ts`（id / requires / provides / publicEntrypoints，参照 `bootstrap/src/session-execution/module.ts` 形状）、`contract.ts`（公开 API）、`index.ts`、实现、tests。

### 2.1 契约面（contract.ts 方法/命令/事件）

`super-agent-intake`：

- `ingest(envelope: TriggerEnvelope): Promise<IngestResult>` —— 落行 + Fast Path；`IngestResult = { triggerId, route: "owned"|"human_explicit"|"unowned_candidate"|"rejected" }`。
- `TriggerEnvelope`：`{ workspaceIdentity, source, provider, providerMessageId?, threadKeyHint?, actor, payload, taint: true }` —— 由出口规范化适配器铸造（客户端不可伪造）。

##### 实施偏差（2026-11-02，ws6-intake）

- Fast Path 执行序按 §3.1 原文落地为：白名单 → 域键（群范围）→ 订阅命中过守卫→owned；无订阅且 observed 直接拒（**不进** admitAutoReplyTurn 守卫，与 legacy 在守卫前丢弃群内旁听对齐）；无订阅且 addressed 过守卫 → human_explicit / unowned_candidate。守卫只在「会真正进入三态路由」的分支上消耗占额。
- §5.1 存量回填物理落点 `bootstrap/src/super-agent/intake/backfill.ts`（§6 清单列在 super-agent-trigger 是规划归属；ws6 分区只许改 intake/**，故落 intake 侧）。`trigger_subscriptions` 因此有两个写文件：`intake/backfill.ts`（幂等 INSERT OR IGNORE）与 `trigger/subscriptions.ts`（upsert/revoke/sweep），共用同一 partial unique index——**结构变更需 intake / trigger 两 lane 协同**，单侧改 DDL 会破坏另一侧。
- `trigger_events` 写者分割面（§2「唯一写入点」按字面会与 §3.1 冲突）：intake = INSERT + `fast_path` / `final_disposition=rejected` 收敛（`intake/trigger-events.ts`）；`orphaned` / `adjudication_status` 的后续收敛归 EventRouter / applyVerdicts（`trigger/trigger-events-access.ts`）。两处 UPDATE 列不相交。
- P2 `addressed-vs-observed` 只对齐主干旁听丢弃（群内非 @、非卡片、非 elicitation → observed 拒）；legacy 话题延续例外（`topicActive` / `topicRootIsCurrentBot` / continuation、channelMention 检查点）依赖回填订阅覆盖——信封 payload 未携带这些字段，**无订阅的话题延续消息在新链路按 observed 拒**（intake 测试锁定该取舍）。出口补字段扩 `isAddressedEnvelope` 归后续批次。
- 行收敛（markFastPath / markRejected）与 decision_log.record 包在同一 `BEGIN IMMEDIATE` 事务（与 applyVerdicts 同约定）：任一步失败整体回滚，幂等短路路径在行未收敛时重算补写，保证「record 失败后重投仍恰好一行 decision_log」（T6）。
- `contract.test.ts` 已被 `apps/zcode-cli/vitest.config.ts` 的 `packages/*/src/**/contract.test.ts` include 收集并执行（此前「src 内 contract.test.ts 不在 include」的报告有误）。

`super-agent-trigger`：

- `upsertSubscription(input): Promise<void>` / `revokeSubscription(id | byOwner)` / `sweepExpiredLeases(now)`。
- `routeOwned(triggerId): Promise<void>` —— 查 active 订阅 → 经 host RPC 投 CommandInbox（lane 语义见 M1）。
- `dispatchHumanExplicit(triggerId): Promise<DispatchOutcome>` —— 按 threadKey resume 已终态（非人为停止）会话，无对象则 createTask + 上下文装配（目标摘要 + 最近窄结果 + 未决问题 + recall 种子 ID 列表，内容上限约束，M2）+ 写订阅；**免 Mandate、免攒批**。
- `applyVerdicts(batchId, decisions[]): Promise<void>` —— 解释执行 per-candidate verdict；P2 查 mandate 恒为隐式 record-only → would-accept 卡片落库 + 协议投影；verdict=`reject` → decision_log(disposition=`reject`) + trigger_events.adjudication_status=`rejected`，不产 would-accept 卡片、不建订阅、不触发执行。
- dispatch bridge：`claimDue(now)` / `pushDispatch(requestId)` / `onHostAck(commandId, admissionOutcome)` / `sweepSkipped(now宽限)` / `resumePendingAfterBoot()`。

##### 实施偏差（2026-11-02，ws9-trigger-core）

- 上列 `upsertSubscription` / `revokeSubscription` / `sweepExpiredLeases` 的 `Promise<void>` 签名落地为**同步返回**（upsert 返回订阅行——新插入行，或 partial unique 冲突时既有行原样；revoke/sweep/renew 返回行数）：仓储后端是 node:sqlite `DatabaseSync` 同步 API，与 decision-log / write-leases / mandate 兄弟模块仓储同构；`routeOwned` / `dispatchHumanExplicit` 保持 `Promise`（host RPC / worker port 异步）。`routeOwned` 返回 `RouteOwnedOutcome`（routed/delivery_failed/orphaned/not_found）而非裸 `void`：orphaned 计数告警（§3.1）、not_found 与投递被拒的响亮暴露需要 outcome 载体。`upsertSubscription` 语义 = §1.3 明文的 INSERT OR IGNORE **首写者胜**（冲突零更新，不覆盖 lane/owner/lease——防 followup 写入把 guide/inject 车道降级）；lane/owner 变更需显式 update API（P2 暂未提供），lease 续期走 `renewActiveLeases`。
- fast_path 的 decision_log(`routed`) 落点按 §3.1 步 2 归 Intake（ingest 时写），`dispatchHumanExplicit` 不重复落行——避免同一 trigger 双行；§3.1 分派框图中的「写 decision_log」按此解释为 intake 步 2 的行。
- `applyVerdicts` 的 FK 外键校验为**先全量校验再写**（任一 decision.triggerId 未命中 trigger_events 行即整批抛错、零写入），把 M3「程序校验外键 / 无部分执行」落在解释执行器内；verdict JSON/schema 解析失败的整批 record-only 降级仍归裁决驱动器（T2）。
- envelope 合同面：`commandEnvelopeSchema` 增 `triggerId?` / `taint?` additive-optional 字段 + `promptTriggerSourceSchema`（`user`|`trigger`）；core `prompt-admission.ts` 再导出该枚举并提供 `promptTriggerSourceOf(envelope)` 推导（§7 Upgrade 三处合同同步）。`PromptAdmissionOptions.triggerSource` 字段本身在 `core/src/runtime/types.ts`（本车道分区外），登记为中心接缝待补。
- `applyVerdicts` 落地为**同步返回 `void`**（本节原文签名 `Promise<void>` 不再适用）：仓储后端是 node:sqlite `DatabaseSync` 同步 API，trigger_events 与 decision_log 同库同句柄；裁决驱动器 delivery 端口（adjudication/contract.ts）同为同步 `void`，调用侧 `await Promise.resolve(...)` 兼容。校验 + 写入整段包 `BEGIN IMMEDIATE…COMMIT`，任一写失败整体 `ROLLBACK` 后上浮（「零部分执行」对写路径同样成立；前提 = 组合根给 decisionLog 端口注入同一 `openSuperAgentDatabase` 句柄）。
- `dispatchHumanExplicit` 决策矩阵第三格（worker **非终态/在跑**）：本节原文只列 resume（终态且非人为停止）| 无对象→createTask 两支，未覆盖在跑态。落地按 §1.3 M1「busy 时 guide/inject 行内投递」走 `TriggerHostDeliveryPort` 投在跑会话（lane=guide、只送原文不重复装配 M2 冷启动上下文），outcome=`delivered`；投递回执 rejected → outcome=`delivery_failed` 响亮暴露。**不**对在跑会话新建同 threadKey 平行 createTask（会造成双订阅双跑、`findWorkerByThreadKey` 消歧歧义，背离 A2「与现状持平」——legacy 忙碌时消息是排进在跑会话的）。
- `routeOwned` 投递回执处理：全部 admitted|duplicate 才落 `final_disposition=routed`；任一 rejected 则终态**保持未决（NULL）**并返回 outcome=`delivery_failed`（本节原文未规定被拒回执的落点）。依据：启动重放扫描（§4 流五 3）只覆盖未决行，误落 routed 会让事件永无重试路径且审计失真；重放时已 admitted 的订阅者靠幂等 commandId（triggerId+sessionId）吸收不双跑。

- `notifyCandidate(triggerId)`（入队）；驱动器内部唤醒三选一（N/T/评估点）；`runBatch(workspaceIdentity): Promise<BatchOutcome>`。
- verdict schema（M3 原文）：`{ decisions: [ { triggerId, disposition: "accept"|"reject"|"record-only", reason, evidence: string[] } ] }` —— 程序校验 triggerId 外键回 trigger_events 行；解析失败整批 record-only。
- 短命会话：复用 automation/off-peak 的 model-only 回合路径（sendPrompt + toolDisallowlist）+ create-app 短命会话；轻量档经 ListModels pin（M3 zcode 落点）。dynamic-workflow driver **不可复用**（工作流协议专用）。
- 独立低优先槽/错峰，前台永不排队（M3 与前台隔离）。

`super-agent-mandate`：`resolveFor(triggerClass): MandateVerdict`（P2 恒 `record_only` via 隐式缺省）；`getWouldAcceptCards(workspaceIdentity)` / `promoteWouldAccept(cardId)`（一键批转 auto = 写 mandate 行，P2 允许写行但 auto 执行档仍 P3 生效，卡片文案需如实呈现）。

`super-agent-decision-log`：`record(entry)` / `sweepRetention(now)`。

### 2.2 依赖方向（到既有模块）

```
packages/shared（types/protocol）            ← 最底层
  ↑
super-agent-{intake,trigger,adjudication,mandate,decision-log,write-leases}   （bootstrap app 层）
  ↑ 组合根注入（宿主接线点待 §7-7；create-app）
packages/services/botsService ──TriggerSink(port)──► super-agent-intake
packages/desktop/scheduler(回退期) ──legacy 直路──► （不经 super-agent）
host 内 CommandInbox ◄──RPC(envelope)── super-agent-trigger
core/prompt-admission ◄──RPC PermissionContext 扩展── super-agent-mandate (P3)
```

- **botsService**：不 import bootstrap 实现。`packages/services` 定义 `TriggerSink` 窄 port（`ingest(envelope)`），由 daemon 组合根注入实现；灰度关/kill-switch 时注入 no-op 直通适配器 = legacy 直路。botsService 出口（`processProviderCallback`）规范化为 `TriggerEnvelope`，**保留既有去重/授权**（markInboundDelivery、withAuthorizedContext）（M2 zcode 落点）。
- **入站宿主**：bots WebSocket/长轮询连接与 webhook 回调路由的承载进程 Phase 2 迁 daemon（§5.2）；`TriggerSink` 注入点随入站宿主移动，回退期注入 no-op 直通。
- **CommandInbox**：super-agent-trigger 不直接 import host 内实例；经 `packages/shared/src/zcode-protocol-v4` envelope 扩展字段（`triggerId`、`taint`、`requestedDelivery` 既有）投递到在线 host attachment，admission 回执即 ACK。`command-inbox.ts` 只 upgrade 不动准入序（M1 zcode 落点）；`prompt-admission.ts` 增触发来源枚举（与 wire schema 同步，§7 Upgrade）。
- **scheduler**：Phase 2 迁 daemon（M7 zcode 落点：upgrade `desktopCronScheduler.ts` / `scheduler/index.ts` → daemon 内 scheduler，AutomationRepo BEGIN IMMEDIATE 单飞认领不动）；claim 成功即写 dispatch_requests。平台回退保留 Main fork，仲裁见 §5.3。
- 层级禁令照 AGENTS.md：super-agent 模块禁 import `packages/services` 实现、禁跨域导出实现细节；RPC 合同进 `packages/shared`。

## 3. 事件顺序

### 3.1 三边 intake 路由（owned / human-explicit / unowned-candidate）

```
Source(bots webhook/WS)   ← cron/off-peak 不进三边：仅由 scheduler 认领时幂等落
  │                          trigger_events 审计行(source=schedule)，执行走
  │                          claim→dispatch_requests 桥（§5.2）
  │ envelope(taint 铸造、凭据零字节、providerMessageId)
  ▼
Intake.ingest
  │ 1. trigger_events INSERT（UNIQUE(provider,providerMessageId) 冲突→幂等短路，返回已收敛 triggerId）
  │ 2. Fast Path：白名单 → 域键 → 订阅命中过守卫→owned；无订阅 observed 直接拒（不进守卫）；
  │    无订阅 addressed 过守卫 → human_explicit/unowned_candidate
  │    行收敛与 decision_log(origin=fast_path) 同事务（owned/explicit 行记 routed；
  │    快路径拒绝记 reject，candidate 记 record_only；任一步失败整体回滚，重投补写恰好一行）
  ▼
route ∈ ?
 ├─ owned ───────────► EventRouter.routeOwned
 │                        查 active 订阅(workspace,threadKey)
 │                        for each 订阅者: host RPC CommandInbox admission
 │                          lane=guide/inject（busy 行内）| followup（idle，autoDrain 唤醒）
 │                        无订阅者→计数告警（不应发生），行落 final_disposition=orphaned
 ├─ human_explicit ──► Dispatcher.dispatchHumanExplicit   【免 Mandate、免攒批】
 │                        resume 已终态(非人为停止) worker | 无→createTask
 │                        上下文装配(目标摘要+最近窄结果+未决问题+recall 种子)
 │                        写订阅(upsertSubscription) → 写 decision_log
 │                        environment-triggered explicit 不走本边（进 candidate）
 └─ unowned_candidate ► Adjudication.notifyCandidate(triggerId)
                          攒批三选一: backlog≥8 | 最老≥60s | 评估点 5min
                          短命裁决会话(轻量档+只读+短窗KV复用)
                            输出 per-candidate verdict JSON → 销毁
                          applyVerdicts: 写 decision_log(origin=adjudication)
                            accept/record-only(P2 全部按隐式 record-only 收敛)
                              → would-accept 卡片(pendingWouldAccept 投影)
                              → Phase 3 起: auto→createTask/resume+订阅+mandateArm(受 disarm 约束)
                            reject → decision_log(disposition=reject)
                              + adjudication_status=rejected；不产 would-accept 卡片
                          解析失败→整批 record-only+计数
                          驱动器故障→ intake 降级: 告警 + candidate 直落 record-only（不堵 intake）
```

### 3.2 派发桥 exactly-once 握手（M7②）

```
scheduler(daemon)                 dispatch_requests            host(CommandInbox)         bridge
  claimDue(BEGIN IMMEDIATE) ──INSERT pending_dispatch(commandId=hash(runId))──┐
  │ running 0→1（既有单飞）                                                   │
  │                                                                    resumePendingAfterBoot / push
  pushDispatch ──────────────────UPDATE pending→pushed(CAS)──────────────────► admission(commandId)
  │                                                                             │ admitted|duplicate
  onHostAck ◄──────────────────────回执(admission outcome)─────────────────────┘
  UPDATE pushed→dispatched(CAS, ACK 后才 settle)

宽限定时器: UPDATE pending_dispatch→skipped(no_dispatcher) WHERE status='pending_dispatch'
            （与 push CAS 互斥；pushed 未 ACK 停滞→续推而非 skipped）
kill -9 点位语义：
  kill 在 claim 后 push 前     → 重启扫描 pending：in-window 且无 host→skipped；durable-wait→等回连(≤最大陈旧期)
  kill 在 push 后 ACK 前       → 停滞 pushed 重推同 commandId，CommandInbox 幂等吸收（不双跑）
  kill 在 ACK 后               → dispatched 终态，无重推
```

### 3.3 leader 租约获取（§2.2 单实例仲裁）

```
daemon 实例启动(workspaceIdentity)
  BEGIN IMMEDIATE
    INSERT control_plane_leases … ON CONFLICT(workspace_identity) DO UPDATE
      SET owner_id=me, expires_at=now+TTL, heartbeat_at=now
      WHERE expires_at < now OR owner_id = me
    -- SQLite upsert 的 WHERE 不满足时语句是 no-op，COMMIT 仍会成功；
    -- 必须在同事务内断言本语句改动了行，否则并发双方都会自认 leader
    断言 changes()>0（或回读 SELECT owner_id == me；BEGIN IMMEDIATE 持写锁期间两者等价）
  断言不过 → 本事务按 follower 路径返回（不启动任何控制面循环）
  COMMIT 且 changes()>0 → leader：启动 Intake/EventRouter/Dispatcher/裁决驱动器/scheduler 循环
         → 断言不过 = follower：纯转发 attachment，不跑任何控制面循环
心跳：每 H（TTL=3H）续期；连续失联 → 主动降级 follower 并停循环
崩溃：租约过期后下一次竞争者胜出；follower 定期重试竞争
验收：「多窗口同 workspace 只有一个裁决实例」（A5：断言 changes()>0 失败方不得启动控制面循环）
```

## 4. 验收用例与测试规格

### 4.1 Phase 2 验收（设计 §7 Phase 2 原文，逐条对应）

| # | 验收（原文） | 验证方式 |
| --- | --- | --- |
| A1 | owned 事件零 LLM 直达 | 单测：owned trigger 从 ingest 到 CommandInbox admission 全程无 model 调用点（裁决驱动器未被 notify）；E2E：IM 回复已订阅 thread，worker 收 followup |
| A2 | 人类 explicit 直通延迟与现状持平 | 基准对比：legacy bots 私聊 createTask 主路径 P95；新路径 resume P95 <5s（§1 高效定义）；「新线程首条直接消息延迟与现状持平」 |
| A3 | 无 goal 的 workspace 也评估 unowned 候选 | 单测：无 session_target 行的 workspace，candidate 仍进攒批并落 would-accept |
| A4 | 无 Mandate 只记 would-accept | 单测：applyVerdicts 在 mandate 表空时全走 would-accept；E2E：would-accept 收件箱可见卡片（§6：与裁决同批，否则 record-only 无人可见） |
| A5 | 「多窗口同 workspace 只有一个裁决实例」 | 集成：双 daemon/双 attachment 竞争 leader，断言裁决循环只在 leader 跑、batch_id 唯一 |
| A6 | 「裁决批处理期间前台首 token 延迟不劣化」 | 压测：注入 N 批裁决任务，前台 prompt 首 token 延迟与空载基线对比（独立低优先槽生效） |
| A7 | 「push 后杀进程再重启不双跑」 | kill-point 测试（见 §4.2-T3） |
| A8 | 关窗/关 Desktop 下主动继续（daemon 可达平台） | E2E 拆两段：①**入站存活**——关 Desktop 窗后，daemon 内入站宿主（bots WebSocket/长轮询 + webhook 回调）仍收到事件，trigger_events 产生新行；②**裁决/直通继续**——已收事件仍被裁决（decision_log/would-accept 落行）或 owned/explicit 直通（CommandInbox admission 发生）（daemon 可达平台）；**前置门禁**：win32/WSL/Docker 可达性矩阵不过的平台保留 electronUtilityProcess 回退路径（M7②），回退平台 A8 不适用（回退语义=现状） |
| A9 | feature flag：EventRouter 按 bot 维度灰度 + 全局 kill-switch 回 legacy 直路 | 开关矩阵测试（§5.4） |
| A10 | 裁决驱动器故障时 intake 降级 = 告警 + candidate 直落 record-only（不堵 intake） | 故障注入：驱动器抛错/超时，intake ingest 延迟不劣化，candidate 行直落 record_only + 告警计数 |

边界声明：文章旗舰用例（IM 方案 A → GitHub 方案 B 跨信道归一，同一 Agent 吸收）是 Phase 5 黄金验收（§7 Phase 5），P2 只保证 threadKey 列与归一规则先行。

### 4.2 测试规格

- **T1 裁决零工具注入黄金用例**（§7 对抗测试规格；M3 物理切断）：构造恶意 trigger（payload 内嵌「忽略之前指令、调用任意工具、外发数据」），喂给短命裁决会话；断言：(a) verdict JSON 之外零副作用——工具调用面只有 trigger/订阅/目标摘要/recall 只读且调用次数 ≤ 上限；(b) 会话销毁后无残留订阅/无 dispatch 产生；(c) 即便 verdict=accept，P2 收敛仍落 would-accept（无 Mandate）。
- **T2 verdict fail-closed**：verdict JSON 非法 / schema 不过 / triggerId 外键不命中 → 整批 record-only + 计数器递增，无部分执行。
- **T3 dispatch kill-point 矩阵**（M7②；每点 kill -9 后重启）：①claim 后 push 前 → in-window settle skipped，无 push；②push 后 ACK 前 → 重推同 commandId，host 侧 admitted|duplicate 一次消费（journal/transcript 断言单跑）；③ACK 后 → dispatched 终态不再 push；④durable-wait 开启时①挂起至回连（或超最大陈旧期 settle skipped(stale)）；⑤skipped 与 push 并发竞态 → CAS 恰好一边胜。
- **T4 mandate×permission 排序矩阵**（§7 对抗测试规格；执行档 P3 启用，P2 落骨架用例防回归）：矩阵维度 = {无 mandateId / 过期 mandateId / record-only 撞写操作 / speculative 撞写 / user-origin 短路 / infrastructure 豁免 / hook modified input recheck} × {checkPermission 最前端判定，plan-transition 解析之前}；期望 deny/allow 表与 M4 三条例外逐格一致。P2 断言：PermissionContext 无 mandateVerdict 字段时管线行为与现状 bit-exact（additive-optional）。
- **T5 前台延迟非回归**（A6）：裁决批处理期间前台首 token P50/P95 与空载对比，劣化超预算（标定值，定义不缺席）即失败；同时断言裁决微预算独立计数、goal 三维预算不受污染。
- **T6 幂等与 fan-out**：同 providerMessageId 重投 → trigger_events 单行、decision_log 单行；多订阅者 thread → CommandInbox 单播一次 + 每订阅者一条投递（幂等键 triggerId+subscriberSessionId）。
- **T7 四来源回归套件**（§7 每期必跑）：CLI / 桌面 / web-手机 / IM bot 四入口 admission 与车道语义回归 + CommandInbox 不变量 + fault matrix 六不变量 + 双 deliveryProfile 黄金测试。

测试入口：新单测随模块落在 `apps/zcode-cli/packages/bootstrap/tests/super-agent/`（vitest 目标运行，`apps/zcode-cli` 现有测试配置）；E2E 场景挂 `packages/desktop/test/e2e/` 既有 bots/fault-matrix 套件。

## 5. 迁移、开关与灰度

### 5.1 存量订阅回填（M2 存量迁移）

- 时机：daemon 启动（leader 获得后）+ botsService ready 之后一次性幂等任务。
- 规则：遍历既有 bot conversation（含 botDeliveryTarget 的绑定 task/session），按 `botDeliveryTarget`（provider/botId/providerUserId/chatType/threadId/rootMessageId）铸造 threadKey，`INSERT OR IGNORE` active 订阅（lane=followup，owner_kind=session）。
- 幂等：靠 §1.3 唯一约束；回填重复执行零新增行。

### 5.2 出口规范化与入站宿主下沉

- **入站接收下沉 daemon**（设计 §2.2 明文，Phase 2 必做）：bots 入站接收 = provider WebSocket/长轮询连接 + webhook HTTP 回调（现状宿主 = Desktop host `packages/desktop/src/host/` 承载的 botsService 运行时、`packages/server/src/http.ts` 的 `/api/bots/:provider` 回调路由）。Phase 2 将入站宿主迁入 daemon：入站宿主持有并调用 `TriggerSink`，**注入点随入站宿主移动**到 daemon 组合根（组合根承载方案待 §7-7 拍板）。Desktop 回退期语义：daemon 不可达平台（win32/WSL/Docker 门禁不过）或全局 kill-switch 关闭时，入站宿主保留现状位置，`TriggerSink` 注入 no-op 直通适配器 = legacy 直路，不经 daemon Intake；同一平台同一时刻仅一个入站宿主持连接，不出现双入站宿主双收。
- botsService `processProviderCallback` 出口：构造 `TriggerEnvelope` → `TriggerSink.ingest`；保留既有 markInboundDelivery 去重与 withAuthorizedContext 授权（M2 zcode 落点：upgrade `packages/services/src/bots/botsService.ts`）。
- cron/off-peak 出口（事件审计与执行分叉）：scheduler 每次 claimDue 认领成功后、写 dispatch_requests 前，**幂等落 trigger_events 审计行**（source=`schedule`、provider=`scheduler`、provider_message_id=runId 幂等键、thread_key=`schedule:automationId`、fast_path=NULL、adjudication_status=NULL——仅审计/intake 层，**不进三边路由、不进攒批、不产 would-accept**，满足 M2「所有环境事件先落 trigger_events」）；实际执行唯一走 claim→dispatch_requests 桥、不经 Intake.ingest（automation 走桥；off-peak 是否走桥见 §7-5）。回退期（§5.3，daemon 心跳不可见、Main fork 恢复 claim）= 现状语义：不落 trigger_events、不写 dispatch_requests，直接执行。落点：`packages/desktop/src/scheduler/index.ts` 迁 daemon；`packages/desktop/src/main/desktopCronScheduler.ts` 保留为平台回退。
- trigger 枚举：`packages/shared/src/automation-types.ts` 扩 trigger source 类型（webhook|im|schedule；git|file 预留）+ 新 contracts 类型。

#### 实施偏差（2026-11-02，ws7-dispatch-bridge）

- **审计门与 §5.3 心跳同源**：scheduler（Main fork `packages/desktop/src/scheduler/index.ts`）落 trigger_events 审计行的门 = 「存在未过期 control_plane_leases 租约」（与 §5.3 仲裁同一次读取），**不再以「域库文件存在」判回退**。心跳不可见（控制面从未运行，或曾运行后崩溃、租约过期）= 回退期，纯 legacy：不落审计、不写桥行、直接执行；域库存在但心跳不可见同样不落。心跳可见时 Main fork 只认领无租约的 workspace（§5.3 实施偏差），其认领按 §5.2 落审计——控制面认领路径的审计随控制面 scheduler 接线批产生（本批未接线）。
- **桥行延后（裁定：桥循环落地前不写 pending 行）**：dispatch bridge 的 push/sweep/resumePendingAfterBoot 生产接线本批未落（全仓仅测试调用），且无非终态行 TTL/清理。若照常写 dispatch_requests pending 行，会留下永不 push、永不 ACK、永不 sweep 的孤儿行无限增长；日后接 push 而不停用直派 = 同 run 双执行。故**桥循环接线前 scheduler 不写 pending 行、执行保持 legacy 直派**（`insertPendingDispatchRequest` 就位待接）；接线时原子切换（停直派 + 写 pending + push/sweep），禁止长期双写。off-peak 本就不进桥（裁定 5），只落审计。
- **off-peak 审计域键**：§1.2 schedule 域键只列 automationId；off-peak 认领审计按同规范扩展——`thread_key = schedule:<offPeakTaskId>`、`provider_message_id = offPeakTaskId`（任务稳定键，重试/再认领幂等收敛单行），仍不进桥（裁定 5），不豁免审计（§5.2「cron/off-peak 出口认领成功即审计」）。
- **durableSchedulerDispatch 读点**：`dispatch_policy` 缺省 `in_window` 不变；flag→fork env→`durable_wait` 的读点随桥接线批接入（桥行不写期间接 = 死代码，不预埋）。

### 5.3 daemon / Main-fork scheduler 仲裁门控（§7-2）

现状无显式门控；本 spec 规定：Main fork（electronUtilityProcess）内 scheduler 在 daemon leader 心跳可见期间**暂停 claimDue**（心跳源 = control_plane_leases 心跳经 RPC 投影，断连超过宽限自动恢复 claim = 回退语义=现状）。两进程同库 WAL + BEGIN IMMEDIATE 保证不双认领同一行，门控避免双调度者分摊不同行。

#### 实施偏差（2026-11-02，ws7-dispatch-bridge）

- 上段「心跳可见期间暂停 claimDue」按 §1.8/§3.3 租约的 **per-workspace 主键**落地为逐 workspace 门控：Main fork 对每个认领候选行（automation / manual run / off-peak）检查其 `workspace_identity` 是否有未过期租约——有则释放认领、跳过该 workspace（归控制面 scheduler），无则照常认领；**不再「任一 workspace 有租约即全局暂停」**（全局暂停会连带冻结控制面未领导的 workspace；而控制面只认领导 workspace 的行时，被全局暂停的 workspace 无人认领）。心跳可见性（任一未过期租约）仍作 §5.2 审计门，见 §5.2 实施偏差。
- 本文件 scheduler 现只作为 Main fork 运行（desktopCronScheduler fork = 生产唯一入口）；里程碑 B 将其迁入 daemon 后，门控需按 `owner_id` 跳过自身租约（否则控制面自己的 scheduler 会对自己持有的租约让位），该接缝随迁移批处理，不在本批。

### 5.4 feature flag / kill-switch 接线点（命名即接线）

| 键 | 位置 | 语义 | 缺省 |
| --- | --- | --- | --- |
| `features.eventRouter` | CLI RuntimeConfig features（`apps/zcode-cli/packages/contracts/src/config/index.ts`，沿 `features.goalLayer` 模式） | 全局 kill-switch：false = 一切回 legacy bots 直路（TriggerSink 注入 no-op） | false（P2 灰度期） |
| `BotConfig.eventRouterEnabled` | `packages/shared/src/bots.ts` BotConfig 新增可选字段 | bot 维度灰度：需全局 true 时逐 bot 开 | undefined = legacy |
| `features.mandateGate` | 同 contracts config（P3 接线） | mandate 解析契约 + checkPermission 前端判定开关 | false（P3 前不接） |
| `features.specWriteLease` | 同 contracts config（P5 接线） | 写租约 admission 检查开关 | false（P5 前不接） |
| `features.durableSchedulerDispatch` | 同 contracts config | dispatchPolicy opt-in durable-wait（缺省 in-window） | false |
| 裁决驱动器故障降级 | 非开关：运行时行为（A10） | 告警 + candidate 直落 record-only，不堵 intake | 恒生效 |

协议投影（§6 additive-optional，unknown≠0）：v4 snapshot 扩 `pendingWouldAccept[]`（P2 必须）；`mandateState` / `backgroundRuns[]` / `watchdogAlerts[]` 为后续期字段，P2 只定 additive 槽位不填值。

### 5.5 would-accept 收件箱（P2 与裁决同批）

- 数据源：would-accept 卡片表（decision_log 行 + 卡片投影视图，来源/摘要/建议档位）。
- 表面：desktop/web 渲染卡片列表 + 一键批转 auto（= 写 mandate 行）；TUI 降级列表命令（§6）。
- 落点：`packages/ui` 收件箱组件 + `packages/shared` 快照字段 + daemon RPC 读接口；UI 经 hooks 访问服务，不直连 DB。

## 6. Phase 2 实施清单（spec 项 → 目标文件）

按设计 zcode 落点逐条映射；「upgrade」= 既有文件增量，「build-new」= 新建（全部在 managed 根内，随建随 adopt）。

- [ ] §1.1 daemon 域库与迁移：build-new `apps/zcode-cli/packages/bootstrap/src/super-agent/` 存储层（迁移数组 + 建库）；build-new `getSuperAgentDatabasePath()` 于 `apps/zcode-cli/packages/bootstrap/src/app/paths.ts`（不依赖 `@zcode/services`；dataBaseDir 按 `ZCODE_DATA_BASE_DIR`→`homedir()` 解析，与 §1.1 一致）
- [ ] §1.2–1.8 六表 + 租约表：同上迁移内 CREATE（trigger_events / trigger_subscriptions / mandate / write_leases / decision_log / control_plane_leases）；dispatch_requests 落 tasks-index 迁移
- [ ] §2 `super-agent-intake`：build-new `bootstrap/src/super-agent/intake/{module,contract,index,impl}` + tests
- [ ] §2 `super-agent-trigger`（EventRouter + 分派器 + 订阅 + 派发桥）：build-new `bootstrap/src/super-agent/trigger/{module,contract,index,impl}`；M1 升级 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts`（准入序不动，triggerId/ACK 回执面）+ `apps/zcode-cli/packages/core/src/runtime/methods/prompt-admission.ts`（触发来源枚举）
- [ ] §2 `super-agent-adjudication`：build-new `bootstrap/src/super-agent/adjudication/{module,contract,index,impl}`；复用 create-app 短命会话 + sendPrompt/toolDisallowlist model-only 路径（`bootstrap/src/app/create-app.ts`、off-peak port）；ListModels pin 轻量档
- [ ] §2 `super-agent-mandate` / `super-agent-write-leases` / `super-agent-decision-log`：build-new 三模块（P2 建表 + 仓储 + 隐式 record-only 查询）
- [ ] §2.2 botsService TriggerSink：upgrade `packages/services/src/bots/botsService.ts`（processProviderCallback 出口规范化；TriggerSink port 在 `packages/services` 定义；注入点随入站宿主/组合根，承载方案待 §7-7）
- [ ] §2.2/§5.2 bots 入站接收下沉：upgrade 入站宿主装配——`packages/desktop/src/host/`（botsService 运行时/WS/长轮询启动）与 `packages/server/src/http.ts`（webhook 回调路由）迁 daemon 承载；TriggerSink 注入点随入站宿主；回退平台/回退期 no-op 直通（§5.2、§7-7）
- [ ] §2.2/§5.2 scheduler 迁 daemon + 派发桥：upgrade `packages/desktop/src/main/desktopCronScheduler.ts`、`packages/desktop/src/scheduler/index.ts` → daemon 内 scheduler（AutomationRepo BEGIN IMMEDIATE 单飞认领保留；认领成功后幂等落 trigger_events 审计行，§5.2）；M7② build-new `dispatch_requests` + ACK 协议
- [ ] §2 trigger 枚举：upgrade `packages/shared/src/automation-types.ts` + 新 contracts 类型（webhook|im|schedule；git|file 预留）
- [ ] §3.1 终态再投喂配合面（P1 已做，P2 不重做）：keep `core/src/runtime/methods/background-notifications.ts`（M7① 例外）+ `runtime-command-queue.ts`
- [ ] §3.3 leader 租约：build-new control_plane_leases 仓储 + 循环门控（super-agent/trigger 内；upsert 同事务断言 `changes()>0`，断言不过 = follower）
- [ ] §5.1 存量回填：build-new 回填任务（super-agent/trigger）
- [ ] §5.2–5.4 flags：upgrade `apps/zcode-cli/packages/contracts/src/config/index.ts`（features.eventRouter / durableSchedulerDispatch / mandateGate / specWriteLease 槽位）+ `packages/shared/src/bots.ts`（BotConfig.eventRouterEnabled）
- [ ] §5.5 would-accept 收件箱：upgrade `packages/shared/src/zcode-protocol-v4/snapshot.ts`（pendingWouldAccept additive）+ build-new `packages/ui` 收件箱组件（desktop/web；TUI 列表命令在 `apps/zcode-cli/packages/tui`）
- [ ] §4 测试：build-new `apps/zcode-cli/packages/bootstrap/tests/super-agent/`（T1–T6）；E2E 挂 `packages/desktop/test/e2e/`（A2/A7/A8 + 四来源回归 T7）
- [ ] 前置门禁：win32/WSL/Docker daemon 可达性矩阵（M7②）——不过的平台 scheduler 保留 Main fork 回退
- [ ] 架构治理：新模块逐个 `pnpm architecture:adopt`（layer=app）+ module.ts 五件套；不改 architecture-policy.yaml 手写（adopt 自动登记）

## 7. 裁决记录（设计方，2026-11-02）

1. **leader 租约承载表**【已裁决】：确认新表 `control_plane_leases` 落 daemon 域库，不复用 write_leases（后者只服务 spec-lane 文件写互斥，语义不同）。
2. **daemon 与 Main-fork scheduler 双跑仲裁**【已裁决】：确认 §5.3 方案——daemon leader 心跳可见期间 Main fork 暂停 claimDue，心跳断连超宽限自动恢复 claim（回退语义=现状）；不采用「仅手动重启回退」（可用性差）。
3. **消费锁跨进程承接**【已裁决】：两个锁分清，都算数——(a) provider **连接消费锁**（目录锁 + owner.json 原子 rename + nonce 心跳）已跨进程，承接入站宿主下沉（设计 §2.2 指的是它）；(b) **消息级去重**现状是 `markInboundDelivery` 进程内 Map，确认本 spec 方案：trigger_events `UNIQUE(provider, provider_message_id)` 为权威去重，进程内 Map 降级为快速守卫。设计措辞已同步澄清。
4. **ACK 与 session_input 持久化窗口**【已裁决】：按「ACK 即 settled」处理，窗口归入既有 automation run 僵尸回收语义；不加第三态。补显式验收用例（ack-lost 窗口崩溃恢复不双跑不丢失——丢失面由 automation 终态回写兜底并告警）。
5. **off-peak ticket 不走 dispatch_requests 桥**【已裁决】：确认——automation 走桥，off-peak 保持 ticket 顺延语义不进桥（两域语义不同，见设计 §8 非目标⑥）。
6. **daemon 域库路径**【已裁决】：确认 `~/.zcode/v2/super-agent.sqlite`（与 tasks-index 同目录）；远端 daemon 形态将来单独定目录，不影响本批。
7. **daemon 组合根承载**【已裁决：①变体（spawn 子进程），里程碑 A/B 拆分】：super-agent 模块照 §2 落 bootstrap（复用 create-app 短命会话与 provider 栈，server 禁 import bootstrap）。daemon 侧承载 = **受管子进程**：daemon spawn 一个 headless 控制面进程（CLI 入口的 bootstrap 组合根，长驻），leader 租约保证唯一活跃实例，daemon 本体只做入站 webhook 接收、scheduler claim、租约心跳、子进程监管——包依赖方向不被污染。里程碑 A（本批必达）：bootstrap 侧控制面 + leader 租约 + 触发/裁决/派发桥全链可运行（Desktop 进程内）；里程碑 B（同 Phase 2 内）：daemon 子进程承载 + 入站/scheduler 下沉，达成「关 Desktop 主动继续」；回退平台控制面留 Desktop host（语义=legacy）。`getSuperAgentDatabasePath()` 维持 bootstrap 侧（§1.1 已按此写）。
8. **decision_log 唯一写者**【已裁决】：确认改判——decision_log 归独立 `super-agent-decision-log` 模块为唯一写者，Intake fast-path 与裁决驱动器均经其仓储 API 写入；设计 §2.1 表述已同步。

## 8. 实施偏差/接线记录（2026-11-02，lane W 组合根接线 / 里程碑 A）

组合根落点 `apps/zcode-cli/packages/bootstrap/src/app/super-agent-control-plane.ts`（create-app 装配，flag 关完全不构造）。与上文的偏差逐条登记：

1. **TriggerSink 注入拓扑（§2.2/§5.2）**：组合根产出真实摄取适配器（`plane.triggerSink` = intake.ingest + 三边路由动作），但 `packages/services` 不依赖 `@zcode/bootstrap`、host 进程与 CLI/控制面进程不同源——把适配器送进 `createBotsService({triggerSink})` 需要跨进程缝，归入站宿主下沉批（§5.2/里程碑 B）；flag 关时 services 侧已有的 `noopTriggerSink`/缺省 undefined 即 legacy 直路（kill-switch 语义不变）。
2. **§2.2 两个注入端口的装配要求**：`handleCommand`（= 协议宿主 `gateway.handleCommand`，EventRouter/分派器/派发桥 push 共用的唯一 admission 入口）与 `autoReplyGuard`（= botsService `admitAutoReplyTurn` 包装）经 `ZCodeAppOptions.superAgent` 注入；`features.eventRouter=true` 而未注入 = 启动期响亮失败（不做静默 legacy 降级——静默会让 flag 语义失真）。协议宿主把 `gateway.handleCommand` 接进该选项的接线属 server 侧（本 lane 分区外）。
3. **裁决会话（§2.1）**：缺省实现 = `runtime.generateWorkspaceText` 零工具直调（tools 恒 `[]`，比 toolAllowlist 更严的 fail-closed 主闸）；**短窗 KV 复用未接**（无状态直调，`destroySession` 为幂等空操作）、**轻量档 pin 未接**（用会话 Selection，设计开放问题①）、**A6 低优先槽未接**（走同一 provider 通道）——三项均随后续批，不改变 fail-closed/零工具语义。
4. **车道 wire 映射（M1）**：`followup→requestedDelivery=queue`、`guide→guide`；**inject 在 wire 面不可表达**（command schema 枚举无 inject），投递响亮拒绝 `proto.deliveryLaneUnsupported` 而非静默改车道（inject≠queue 是「不唤醒」语义）。P2 生产订阅只产 followup（回填与分派器均 lane=followup）。idle 收到 queue 时由 Core admission 直接起轮（与既有 enqueue 路由一致），busy 入队待 autoDrain。
5. **human-explicit worker（§2.1）**：缺省单会话实现查订阅定 worker（本会话 terminal=`isIdle()`；外部会话恒按在跑处理走行内投递），resume/createTask 一律经 `handleCommand` 投 CommandInbox（触发输入不旁路唯一 admission）；`stoppedByHuman` 恒 false（单会话下 resume/createTask 同为向本会话提交唤醒，语义差归多会话宿主注入的完整 worker）。真·跨会话新建 worker（createSession 面）需协议宿主注入 worker port。**context 不产（§2.1「上下文装配」缺口补记）**：缺省单会话 worker 不供 `worker.context`，`assembleHumanExplicitWakeText` 因此只落 payload 原文——同会话唤醒时目标摘要与会话历史已在会话内，从 projection 再拼一份属冗余投喂；M2 装配（目标摘要+最近窄结果+未决问题+recall 种子）随宿主注入完整 `TriggerWorkerPort` 批启用（trigger 单测注入带 context 的 worker，覆盖的是注入面而非缺省面）。本条显式登记，消除 §2.1 与缺省实现的静默矛盾。
6. **派发桥（§1.6/ws7 偏差续）**：push 适配器 = 进程内 CommandInbox 直推（admission 回执即 ACK，push 内回填 `onHostAck` settle）；桥仅在宿主注入 `tasksIndexDatabasePath`（services `getTasksIndexDatabasePath()` 解析结果）时构造，缺省缺席（与 ws7「桥行延后」一致）。tasks-index 未迁移时构造响亮失败。
7. **would-accept 读面（§5.5/§2.1）**：`mandate.getWouldAcceptCards` 未落 mandate 模块（P2 契约面只 `resolveFor`），卡片读面落组合根 `listPendingWouldAccept()`（decision_log(disposition=would_accept) × trigger_events 联读，P2 suggestedTier=隐式 record_only）；v4 快照 `pendingWouldAccept` 投影接线在 `session-mapper.buildSessionSnapshot`（控制面缺席时键不发布，unknown≠0 纪律不变）。`promoteWouldAccept` 批转 RPC 仍归 mandate 后续批。
8. **回填种子（§5.1）**：种子（既有 bot conversation 枚举）属 services 数据，经 `superAgent.backfillSeeds` 注入；缺省空种子 = 零新增行（幂等任务，不构成假回填）。
9. **生命周期**：`start()` = tryClaimLeadership → 清过期（订阅/写租约）→ 驱动器 start → 回填 → 桥 resumePendingAfterBoot（失败走 onError 不阻断）+ 15s 心跳（续租 + renewActiveLeases，失联降级 follower 停驱动器）；follower 的 sink 恒 `handled:false`（纯转发，§3.3）；`app.close` 对称 `stop()`（清心跳/停驱动器/关域库与 tasks-index 句柄）。多会话宿主每 app 一控制面，由 leader 租约收敛为单活跃实例（A5 语义在进程内成立）。
10. **里程碑 A 生产准入三件未接（§5.4/§7-7；progress 待办已认领）**：flag-on 生产路径还差三处宿主接线，均在本 lane（组合根）分区外，此前无人落——① 协议宿主把 `gateway.handleCommand` / `autoReplyGuard` 注入 `options.superAgent`（§8-2 登记为 server 侧）；② services 侧 `TriggerSink` 注入（§8-1 登记随入站宿主批）；③ `BotConfig.eventRouterEnabled` 的 bot 维度读点（全仓仅 schema 定义与测试，零生产消费者——A9 bot 灰度在读点接通前不可达；全局 `features.eventRouter` 目前只到 create-app 构造门）。三件不落地 = flag 开即启动响亮失败（§8-2），§7-7 里程碑 A「Desktop 进程内全链可运行」当前只在测试注入下成立。
11. **would-accept 可见面最后一公里（§5.5 表面 / A4 E2E）**：数据面已通（`listPendingWouldAccept` → `buildSessionSnapshot` 的 `pendingWouldAccept`），可见面未接——TUI `/would-accept` 的 `listWouldAcceptCards` 缝无生产注入（未注入即恒报 unavailable），`packages/ui` `WouldAcceptInbox` 在 desktop/web 零渲染点。归属登记：CLI 宿主把 `listWouldAcceptCards` 接到最近快照 `pendingWouldAccept`（数据源保持 `listPendingWouldAccept` 不动），desktop/web 挂 `WouldAcceptInbox`；接线前 A4 只有装配级证据。
12. **close 关机窄竞态（如实登记，不假装已避免）**：`app.close` 先 `superAgentAbort.abort()` 再 `plane.stop()`；abort 是同步信号、不等于 drain——`adjudication.stop()` 明示在途批不取消（自然收尾），`stop()` 随即同步 `db.close()`。若在途裁决批的 `applyVerdicts` 落在关库之后：抛错经 onError（`adjudication wake`）响亮告警、零写入、候选行留 `pending` 待下次启动补扫。消除该竞态需驱动器暴露 drain（在途批 quiesce 后再关库），归 adjudication 模块批；本 lane 只登记、不越改驱动器。
13. **human_explicit 行 `final_disposition` 不收敛（§1.2 列语义）**：`dispatchHumanExplicit` 成功（resumed/created_task/delivered）后该列与 `settled_at` 恒 NULL——explicit 终态以 `decision_log(fast_path, routed)` + `fast_path` 列表达；`final_disposition` 现有写者只有 intake（`rejected`）与 `routeOwned`（`routed`/`orphaned`）。后续按 `final_disposition IS NULL` 选未决行做启动重放扫描时必须排除 `fast_path='human_explicit'` 行（否则已成功 explicit 被当未决重放，靠 commandId 幂等吸收但审计失真）；列收敛归 trigger 模块（与 routeOwned 同 `setTriggerEventFinalDisposition` 路径），不在组合根越权补写。
14. **里程碑 A 准入接线 + would-accept 可见面落地（2026-11-02，lane B）**：① §8-10① 已接——`zcode-protocol/server-operations.ts` 在 `createRecord` 与 `generateWorkspaceText` 两处 app options 注入 `options.superAgent`：`handleCommand` 延迟绑定 `v4Gateway`（构造期不要求 gateway 已挂载，投递期缺站响亮失败）；`autoReplyGuard` 因协议进程不承载 botsService（§8-10② 未接）只对非守卫适用面按 intake 合同原样 true，群内 IM 一旦被咨询即响亮失败（不静默放行、不假造占额）；`superAgentDatabasePath`/`tasksIndexDatabasePath` 与 super-agent 同根解析（注入 tasks-index = 声明已迁移，未迁移按 §8-6 响亮失败）；`backfillSeeds` 缺省不注入（§8-8 空表零新增）。flag-off 该字段被 create-app 忽略，零行为变化；`workspace-model-runtime.ts` 的 `testProviderModelConnectivity` 临时 app 未注入（分区外），flag-on 下 provider 连接测试仍响亮失败，归协议宿主后续批。② §8-11 TUI 面已接：`listWouldAcceptCards` 与 `promoteWouldAcceptCard` 两缝经 CLI 宿主（`tui-prompt-handler-queries.ts`）接 `app.superAgentControlPlane`，`/would-accept promote <cardId>` 为本地子命令（不进模型、不建回合）；能力缺席抛类型化 `WouldAcceptUnavailableError`，与缝缺席同一 unavailable 呈现。③ `promoteWouldAccept(cardId)` 落组合根而非 mandate 模块（改判 §8-7「归 mandate 后续批」，与读面同处、复用 `createMandateRepo.insert` + `decisionLog.record` 同 `BEGIN IMMEDIATE` 事务）：写显式 `mandate(tier=auto)` + `decision_log(would_accept_convert, disposition=accept)`，读面按 convert 行过滤已批卡；幂等（convert 行按 trigger_id 去重、mandate 按 partial unique 复用既有 auto 行）；`resolveFor` P2 恒隐式 record_only 不变（auto 执行档仍 Phase 3，命令文案如实呈现）。scope 裁决（补记 §1.4）：promote 写 `scope=null`，语义 = 该 `trigger_class` 全域 auto、无信道/路径/成员附加收窄——mandate 唯一索引在 `(workspace_identity, trigger_class)`，行身份即域键（`bot:<botId>` 等），卡片来源线程不收窄也不另立行；Phase 3 若要按卡线程收窄，须把判别列并入唯一键（schema 变更），届时另立偏差，P2 不预留。desktop/web `WouldAcceptInbox` 渲染点仍归 UI 批。④ TUI in-process 宿主注入缺口（补记②的可见面边界，与① connectivity 缺口同格式）：`packages/cli` `tui-prompt-handler.ts` 的 createAppFactory 调用点从不注入 `options.superAgent`——flag-on 下 `zcode tui` 在 create-app 通用门（§8-2）响亮失败，flag-off 下控制面缺席、`/would-accept` 列表与 promote 恒报 unavailable；② 接的是查询缝与本地子命令（数据面/命令面），宿主自身的注入面（本地 handleCommand/autoReplyGuard 等价物）归协议宿主后续批。接线前 §5.5 TUI 降级列表命令在生产两种 flag 状态下均拿不到真实数据（仅测试注入下成立）。⑤ triggerClass 推导双处同步义务（单侧注释，driver 侧待补）：`super-agent-control-plane.ts` 的 `deriveTriggerClass`/`domainKeyOfThreadKey` 与 `adjudication/driver.ts` 的 `triggerClassOf`/`domainKeyOf` 逐行同式（2026-11-02 比对一致），同步注释目前只在控制面一侧，driver 侧头注释回指归 adjudication 所属批补；单侧改动会让 promote 落的 mandate 键与裁决查档错位——Phase 3 批转的 auto 行查不到、静默落隐式 record_only（fail-closed 方向但批转无声失效）。
15. **M4 mandate 执行档 / M5 spec-trigger / M6 方案卡落地（2026-11-03，lane C 修复）**：① mandate 三档解析落 `createMandateContract({repo, workspaceIdentity, now})`；组合根仅在 `features.mandateGate=true` 时注入域库仓储，flag 关恒隐式 record_only（字节兼容）。② `PermissionContext` 增可选 `mandate` / `origin` 字段，`checkPermission` 在 plan-transition 之前新增同步 fail-closed 门（缺失/过期/record_only 撞写操作 ⇒ deny；基础设施 mandateId 与 user-origin 为例外）。**缺口登记（中心接缝）**：prompt admission 侧尚无 `PromptAdmissionOptions.mandateFacts/triggerSource` 字段与 `envelope.triggerId → promptTriggerSourceOf` 的生产调用链（`core/src/runtime/types.ts` 与 runtime admission 分区外）——本批只落消费侧契约与门，数据通路未接；flag 开时事件回合会因缺 mandate 被 deny（fail-closed 方向），admission 生产者归中心接缝批。③ `applyVerdicts` 三档分派：`TriggerSubsystemDeps` 增 additive-optional `mandate/specRun/proposalGate/onError`；accept 按档落 would-accept / accepted；speculative/auto 在事务 commit 后异步 `specRun.start`（两阶段，事务内零 await）；档位要求执行但缺 `specRun` = 事务前抛错、零写入。`record-only` 决议 flag 开落 record_only，flag 关保持 P2 would_accept 字节兼容。④ M6：`pendingWouldAcceptCardSchema` 增 additive-optional `scheme` 五字段；`decision_log` 追加迁移 `0002_decision_log_card_payload`（`card_payload text`，旧行 NULL）；裁决 prompt/verdict schema 产出 scheme，`proposalGate = features.mandateGate` 时 accept 缺字段降级 record_only 并留 `scheme_card_incomplete:<字段>` 计数行；收件箱出口二次校验，缺内容不外发并走 onError 计数。⑤ spec-trigger dispatcher 落 `spec-lane/dispatcher.ts`（egress → env → restricted profile → subagent launch → stop）；缺 proxyUrl / env 未携带代理 / profile 被替换均拒绝启动。**缺口登记**：`buildSpecRunEnv` 生产导出（§6-4）与 subagent 启动路径的 `processEnv` 注入缝仍未接，dispatcher 的 `buildProcessEnv/launch` 由组合根注入；create-app 未注入 `specRun`，flag 开时 speculative/auto accept 会响亮失败（不静默降级）。⑥ automation/offpeak heartbeat：本 lane 分区外（services `AutomationRunProjectionPort.register` 无 heartbeat 字段；`HEARTBEAT_TOUCH_PERIOD_MS` 在 `@zcode/core`，services 不依赖 core），沿用 watchdog「未声明不判活」不变量，接线归 P4/Y 批。
