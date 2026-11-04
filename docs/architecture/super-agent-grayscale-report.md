# Super-Agent 灰度报告

- 分支：`long-horizon-goal-redesign`
- 日期：2026-11-05
- 结论：**flag-off 可以随版发布；flag-on 只能做单 bot、单 workspace 试点，且必须先补齐宿主准入三件与 mandateFacts 生产者。P6 暂不启动。**

## 1. 已落地内容

10 个提交（`c14c7a67` → `9bf05380`）：

- `c14c7a67` 设计定稿 + 六份实施规格
- `128807ee` bots webhook fail-closed + 出站死信 + TriggerSink 接入
- `add92e63` goal 层转正、零注入、删旧续跑循环
- `fbf6865c` 终态唤醒再投喂 + compact recoveryPointer
- `f4210ade` recall 引用图 + structured recoveryPointer
- `53b54a24` spec restricted profile + egress 代理 + 出站结构隔离
- `711b641c` watchdog 程序探针 + typed repair + registry 行级投影
- `3f56b83f` 触发子系统全模块（storage/intake/trigger/adjudication/mandate/decision-log/write-leases）
- `3fa76174` 组合根装配 + would-accept 可见面 + mandate 执行档 + 方案卡出站门
- `9bf05380` 架构治理 + lint 存量登记

验证基线（中央收口记录，`progress.md` 批量 4）：

- 架构检查：0 违规（模块依赖配对 + 契约瘦身 + 例外登记）
- `typecheck` / `lint` 双 scope：0 errors
- 全量回归：**7385 tests，0 失败**
- 本报告只复跑了 3 个定向测试文件（§3–§5 有真实输出），未重跑 7385 全量

四个灰度开关缺省全关（`packages/contracts/src/config/index.ts:340-343`，schema 均为 `optional`）：

| 开关 | 缺省 | 关时行为 |
| --- | --- | --- |
| `features.eventRouter` | false | create-app 完全不构造控制面，零行为变化 |
| `features.mandateGate` | false | mandate 恒隐式 record_only，字节兼容 |
| `features.specWriteLease` | false | 写租约只建表，无 admission 检查点 |
| `features.durableSchedulerDispatch` | false | dispatchPolicy 缺省 in-window |

域库：`~/.zcode/v2/super-agent.sqlite`，仅 `eventRouter=true` 时才打开；迁移 0001（六表 + 索引）、0002（`decision_log.card_payload` 追加列）。

交付状态：task ③ 的适配器改动仍在工作树（`git status --short` 显示 15 个 modified + 4 个 untracked，含 `spec-lane/launch.ts` 与 3 个新测试），本次未做任何 git 写操作，发布前需按流程提交。

## 2. 迁移审查结论（task ②）

按代码复核，未发现阻塞项：

1. **纯增量、不碰既有库路径**：域库是新建文件，迁移 0001 建 `trigger_events` / `trigger_subscriptions` / `mandate` / `write_leases` / `decision_log` / `control_plane_leases` 六表；既有 session/tasks-index 库不在本迁移内（`super-agent/storage/migrations.ts`）。flag-off 连文件都不会创建，回滚 = 把 `eventRouter` 置回 false。
2. **0002 兼容旧行**：`decision_log.card_payload text` 可空追加；旧行 NULL。出口门读到 NULL 时按 `mandateGate` 拦截并计数，不会把不完整卡片外发（`super-agent-control-plane.ts:739-749`）。降级无需改表。
3. **去重权威在 DB**：`trigger_events` 有 `UNIQUE(provider, provider_message_id) WHERE provider_message_id IS NOT NULL` partial index；插入冲突原样抛 SQLite 错误，调用方回查后幂等短路（`intake/trigger-events.ts:159-162`）。风险点：`isUniqueConstraintError` 只匹配错误文本 `"UNIQUE constraint failed"`，若未来给该表再加第二条唯一索引，冲突可能被误判为消息幂等。当前只有一条唯一索引，不构成现存缺陷。
4. **订阅回填幂等**：`trigger_subscriptions` 的 active partial unique + `INSERT OR IGNORE`，重复回填 `inserted=0`（`intake/backfill.ts:41-84`）。回填种子缺席 = 零新增行，不会伪造数据。
5. **mandate 批转幂等**：`(workspace_identity, trigger_class) WHERE status='active'` partial unique；批转整段 `BEGIN IMMEDIATE`，锁内重读 convert 行，同卡重复批转零新增；同 triggerClass 已有 auto 行时复用其 id，出现非 auto 显式行则响亮失败（`super-agent-control-plane.ts:771-844`）。`mandateRepo.insert` 本身不做冲突预检，重复 active 插入会抛原始 SQLite 错误——由调用点的锁内检查兜住。
6. **`write_leases` 只有表语义**：无 active-scope 唯一约束，`acquire` 不检查第二写者。这是 spec 明定的 P2 范围，`specWriteLease=false` 期间无害；Phase 5 开启前必须补 admission 检查点，否则同一 scope 可并发持租。
7. **跨库不 join**：`dispatch_requests` 落 tasks-index 库，域库迁移不建该表；桥仅在宿主注入 `tasksIndexDatabasePath` 时构造，表缺失/未迁移时构造期响亮失败（spec §8-6）。桥行延后写入，桥循环未接前 `durableSchedulerDispatch` 是死读点，保持 false。
8. **打开即迁移、失败不降级**：文件库 `journal_mode` 非 wal 直接抛错；迁移 runner 做 checksum fail-closed + 必填备份目录（`storage/database.ts:43-58`，`packages/shared/src/sqlite-migrations/runner.ts:51-112`）。迁移中途崩溃由 SQLite 事务回滚，重开重放。

## 3. specRun 生产 launch 适配器（task ③）

状态：**已实现并接入组合根**，原先登记的生产 launch 接缝关闭。

- `bootstrap/src/super-agent/spec-lane/launch.ts`：把 dispatcher 备好的 egress plan / 无凭据 env / restricted profile 接到既有 `AgentRuntime.launchSubagent`；每次 run 构造独立执行端口，终态 `finally` 关闭；profile 以显式覆盖传入，不进 agent registry。
- fail-closed：非 subagent 形态、env 代理与 `network.httpProxy` 不同源、缺 subagent 端口/执行端口工厂，全部拒绝启动，不降级直连。
- 组合根 `create-app.ts:1047-1080` 装配 `createSpecRunDispatcher`，每 workspace 串行 prepare→launch→stop；workspaceIdentity 不一致直接拒绝。

真实测试输出（`npx vitest run apps/zcode-cli/packages/bootstrap/tests/super-agent/spec-run-launch.test.ts`）：

```text
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    6.10s (transform 4.34s, setup 0ms, import 5.78s, tests 214ms)
```

该用例证明：受限 profile 的 `Bash`/`Read` 白名单生效，`WebFetch`/`WebSearch`/`SendMessage`/`Agent`/`mcp__*` 不在 child 工具面；真实子进程 `node -e "process.env"` 打印出的 env 只含代理键，`GITHUB_TOKEN` / `ANTHROPIC_API_KEY` / `NPM_TOKEN` / `ZCODE_TOOL_ENV_PASSTHROUGH_JSON` 结构性缺席；run 终态 egress 已停、`decision_log` 已落 `accepted`。

剩余接缝：`specEgress.allowHosts` 的 repo 配置 schema 未接（config lane），当前缺省 = 零 egress；`spec-lane/launch.ts` 与相关 core/adapters 改动尚未提交。

## 4. E2E 结果（task ④）

真实测试输出（`npx vitest run apps/zcode-cli/packages/bootstrap/tests/super-agent/e2e-gray-chain.test.ts`）：

```text
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    6.71s (transform 5.07s, setup 0ms, import 6.61s, tests 18ms)
```

链路要素（真临时文件域库 + 真 intake/trigger/adjudication/mandate/decision-log 模块；仅宿主边界替身）：

1. `human-explicit` 入站 → 经真 `CommandInbox` admission → `createTask` 投递，落 `decision_log(fast_path, routed)`，`final_disposition` 保持 NULL（符合 spec §8-13）。
2. unowned 候选 → 裁决 `accept` → 隐式 `record_only` 档 → `decision_log(would_accept)` 卡，`card_payload` 五字段 scheme 逐字段一致。
3. `promoteWouldAccept` → 真 `mandate(tier=auto)` 行 + `would_accept_convert` 行，卡从收件箱收敛（`listPendingWouldAccept()` 变空）。
4. 下一候选命中显式 `auto` 档 → 事务 commit 后 `specRun.start` 被调用 1 次（tier/workspace/thread/card 全匹配），无额外 CommandInbox 投递，mandate 行仍为 1。

未参与断言：`specWriteLease`、`durableSchedulerDispatch`（不在本链路）。

## 5. 性能基线（task ⑤）

真实测试输出（`npx vitest run apps/zcode-cli/packages/bootstrap/tests/super-agent/perf-baseline.test.ts --disable-console-intercept`）：

```text
[perf-baseline] adjudication.runBatch N=8 n=10 mean=0.585ms p50=0.426ms p95=1.382ms min=0.386ms max=1.382ms
[perf-baseline] db.inserts 1000 trigger_events + 1000 decision_log n=10 mean=123.465ms p50=120.535ms p95=139.197ms min=118.010ms max=139.197ms
[perf-baseline] trigger.routeOwned owned n=10 mean=0.073ms p50=0.047ms p95=0.280ms min=0.038ms max=0.280ms

Test Files  1 passed (1)
Tests       3 passed (3)
Duration    3.01s (tests 1.90s)
```

解读：

- 裁决攒批 N=8 全链路（构建 prompt → 校验 verdict → mandate → 事务落行）P95 1.382ms；脚本化 LLM 应答，测的是控制面自身开销。
- DB 写吞吐：1000 trigger_events + 1000 decision_log 单轮 mean 123.465ms，约 **1.62 万行/秒**（temp-file 真 SQLite + WAL，走生产写入点）。
- `EventRouter.routeOwned` owned 直通 P95 0.280ms，满足 spec < 1ms 预算，订阅线程零 LLM 路由。
- 红线断言：裁决 P95 < 1000ms、DB 单轮 P95 < 5s、owned P95 < 1ms，均通过；数值只用于拦病理级回归，不设为抖动敏感阈值。

## 6. 已知接缝

按代码复核更新（与 CONTEXT 的“已完成”标注有出入，以下为实际状态）：

1. **specRun 生产 launch 适配器**：已关闭（§3）。剩余 `specEgress.allowHosts` 配置未接，缺省零 egress。
2. **automation/offpeak owner 心跳**：**未接**。`AutomationRunProjectionPort.register` 无 heartbeat 字段，`touch` 只改 `ownerSession`（`packages/services/src/session/automationService.ts:33-48`）；沿用 watchdog“未声明不判活”，归 P4/Y 后续批。
3. **`PromptAdmissionOptions.mandateFacts`**：**未接**。消费侧门已存在（`permission/service.ts:306-347`，`origin=event` 且写操作时 fail-closed），但全仓没有任何生产者设置 `origin="event"` 或 `mandate`；`PromptAdmissionOptions`（`core/src/runtime/types.ts:545-555`）无该字段。结果是 M4 门在当前生产路径上处于“未激活”状态：事件回合仍按缺省 user 处理。flag-on 试点若要真正执行 mandate 档位，必须先补生产者。
4. **宿主准入三件**：协议宿主 `gateway.handleCommand` / `autoReplyGuard` 注入已接（`zcode-protocol/server-operations.ts:3623`）；services 侧 `TriggerSink` 注入与 `BotConfig.eventRouterEnabled` 读点仍未接（全仓仅 schema/测试，无生产消费者）。因此 flag-on 的“生产全链”目前只在测试注入下成立。
5. **would-accept 可见面**：TUI 查询缝与本地子命令已接（`tui-prompt-handler-queries.ts:82-93`），但 CLI 宿主 `createAppFactory` 从不注入 `options.superAgent`，flag-on 下 `zcode tui` 会在 create-app 通用门响亮失败；desktop/web `WouldAcceptInbox` 仍无渲染点。数据面 `listPendingWouldAccept` 正常。
6. **写租约 admission**：`specWriteLease=false` 下只有仓储与建表，Phase 5 才接检查点。
7. **派发桥/durable dispatch**：桥行延后写入；桥循环未接前保持 legacy 直派，`durableSchedulerDispatch` 不开。
8. **close 关机窄竞态**：`app.close` 先 abort 再 `plane.stop()`，在途裁决批可能落在关库之后，经 onError 告警、零写入、候选行留 `pending` 待下次补扫（spec §8-12，已登记不假装避免）。
9. **triggerClass 推导双处同式**：控制面与 adjudication driver 各一份，单侧改动会让 promote 落的 mandate 键错位；同步注释只在控制面一侧。

## 7. P6 排期建议

P6 属可选里程碑，不进入当前灰度批次。建议按依赖顺序排：

1. **能力票据（capability tickets）**——第一优先。flag-on 试点一旦开放 `auto` 档，就需要“短时、绑定 run/trigger/workspace、可吊销”的执行授权。进入条件：里程碑 A 宿主准入三件完成 + 试点无 sev1。验收：越权/重放/过期/跨 workspace 四类故障注入，票据与 mandate 行同事务落盘。
2. **OS 级 egress fence**——第二优先。现有 spec-lane 是“结构隔离 + 协作式代理”，不是安全边界；子进程可绕过 env 代理。进入条件：`specEgress.allowHosts` 配置落地且试点需要非零 egress。验收：macOS / Linux / Windows 三平台各自的网络隔离方案（sandbox / netns / AppContainer 等）真机故障注入，代理不可用时 run 响亮失败而非直连。
3. **设备凭据（device credentials）**——最后。仅当里程碑 B（远端 daemon / 跨设备宿主）进入范围时启动，依赖票据模型定稿。验收：凭据轮换、设备吊销、失窃模拟、跨设备重放拒绝。

不建议三项并行；每项独立提交、独立灰度，避免把安全机制与业务灰度混在一起。

## 8. 灰度建议

**可以立即随版发布（flag-off）**：

- 全部 10 个提交与 7385 测试基线。
- 四个开关缺省 false；`eventRouter=false` 时控制面不构造、域库不打开、既有 bots 直路不变。默认路径零行为变化。
- 域库迁移只在 flag-on 时执行，且为纯增量；回滚 = 置回 false，无需回滚数据库。
- 发布前唯一动作：提交 task ③ 的适配器改动（当前工作树未提交）。

**需要 flag-on 试点的能力（按顺序解锁）**：

1. **M2 触发路由试点**：`eventRouter=true` + `mandateGate=false`，单 bot、单 workspace。观察 intake 幂等、owned/human-explicit/unowned 三边路由、would-accept 卡生成。前置：services `TriggerSink` 注入 + `BotConfig.eventRouterEnabled` 读点。
2. **M4/M6 mandate 与方案卡试点**：`mandateGate=true`。前置：`PromptAdmissionOptions.mandateFacts` 生产者接通，否则门不生效；确认 would-accept 出口门与五字段卡在真实数据上不误拦。观察 promote → auto mandate 行、事件回合写操作权限。
3. **M5 spec lane 试点**：`speculative` 档 + 零 egress（`allowHosts=[]`）起步，单 repo、单 workspace。前置：§3 适配器提交完成；观察受限 profile、无凭据 env、run 终态 egress 关闭、失败原样上浮。
4. **`specWriteLease` / `durableSchedulerDispatch`**：继续关。分别在 Phase 5 admission 检查点、派发桥循环接线后单独灰度。

试点期间 kill-switch：`features.eventRouter=false` 立即回到 legacy 直路；mandate 数据与 decision_log 留在域库，不参与 legacy 路径。试点成功判据：零重复触发、零跨 workspace 执行、零凭据泄露、spec run 失败全部可见、would-accept 无静默外发。任一不满足即停止 flag-on，不靠补丁兜底。
