# progress — super-agent-harness-design 落地

## 批量 1（Phase 0/1）✅ 2026-11-02 验证全绿
- Phase 0 webhook fail-closed 统一（botsService.ts:3838 空值 fail-open 修复 + 4 用例回归）
- M7③ bot 出站死信与重试权威（首败 backoff、群授权快照重放门、typed outcome 计数、损坏文件重建、11+237+55 测试过）
- goal 层转正（默认开、删 target-continuation-loop/inject 降级、goal-state-reminder 零注入）
- M7① 终态唤醒再投喂（账本驱动 + journal 校验、claim-first、refeed_<taskId> 幂等；设计措辞已同步）
- 收口：architecture 例外 2 条、storageCatalog 注册死信文件、typecheck/lint 绿、1041+62 测试过

## 批量 2（Phase 2 触发子系统）✅ 2026-11-02 落地（里程碑 A）
- 规格 `docs/architecture/super-agent-trigger-subsystem-spec.md` §7 八项裁决完成（组合根=daemon 受管子进程里程碑 A/B、两锁分清、off-peak 不进桥、decision_log 唯一写者改判等）
- 7 个 managed 模块 adopt 登记（storage/intake/trigger/adjudication/mandate/write-leases/decision-log）
- land-phase2 工作流波 1 中断后续跑，最终 19 agents 全链完成
- 波 1/波 2 六工作流全链完成（19 agents）：storage 六表+叶模块+flags、UI would-accept、intake 三边路由、dispatch bridge exactly-once、trigger 核心、裁决驱动器
- 中央收口 ✅：architecture 0 违规（policy 配对+7 文件例外）、双 scope typecheck/lint 绿、adapters 四开关回填、egress-proxy 类型修、watchdog 契约瘦身；243+111+132 测试过

## 车道（2026-11-02）✅ 全部落地
- P3 spec-lane 受限档案 + egress 代理 ✅（8 项评审修复收口；裁定：Phase 3 仅 subagent 路径、egress=结构隔离+协作式代理）
- P4 watchdog + BackgroundRun registry 投影 ✅（评审 3 项修复；契约拆 ports.ts 过治理上限）
- P5 recall + compact recoveryPointer ✅（评审 3 项修复；rewind 回归绿）


## 批量 3（最后一公里）▶
- W 组合根接线 ✅（`bootstrap/src/app/super-agent-control-plane.ts` + create-app 装配/关闭对称 stop + session-mapper pendingWouldAccept 投影 + spec §8 实施偏差 9 条；owned/human-explicit/would-accept 装配级真 DB 测试 + flag 开关语义测试全绿——super-agent 16 文件 96 测、zcode-protocol 117 测、生命周期 3 文件 21 测、create-app 3 文件 103 测过。跨层缺口登记 outOfScopeNotes：botsService sink 注入与 gateway.handleCommand 注入随入站宿主/协议宿主批）
- Y 接缝（workflow 路径 profile 接线-裁定 A、owner 心跳接线）▶
- X mandate 执行档 + spec-trigger 注册 + verdict 出站门（W 后）⏳

## 批量 4（最后一批）✅ 2026-11-03 收官
- A workflow-child spec profile ✅（417 测试绿）
- B 协议宿主准入 + would-accept 可见面/promote ✅
- C mandate 执行档 + spec-trigger + M6 出站门 + 心跳 ✅（378 测试过，修复链接手实施）
- 中央收口 ✅：architecture 0 违规（模块依赖配对+契约瘦身 298 行+例外登记）、typecheck/lint 双 scope 0 errors、io-boundary 边界修正、全量回归 7385 测试 0 失败

## 灰度接缝批次（2026-11-05）✅
- mandateFacts admission 生产者接通（事件回合 → TriggerId → Core admission → PermissionContext）✅
- TUI 宿主 options.superAgent 注入 + commandId 幂等 ✅
- would-accept 收件箱挂载（v4 状态面板）+ promote RPC + delta 生产者 ✅
- BotConfig.eventRouterEnabled 逐 bot 灰度读点 ✅
- automation/offpeak 心跳与 TriggerSink 生产注入：跨进程结构不可达，按设计归里程碑 B（入站宿主下沉），拒绝假接线 ✅（spec §8 登记）
- 验证：双 scope typecheck/lint 绿、architecture 0、定向 240 测试绿；累计 16 提交

## 里程碑 B + P6 批次（2026-11-05）✅
- 里程碑 B 实施规格（662 行）：daemon 受管子进程拓扑/RPC 方法表/租约归属/入站下沉/验收矩阵 B-A1..B-A18
- daemon control-plane 子进程骨架：独立代际/崩溃预算/ready 门/协议版本/对称 stop；真 spawn 测试 + 全量 221 测试绿
- P6 能力规格（设备权限/能力票据/OS egress 围栏，均标注未实现）+ 灰度试点手册（三级开关/观测/回滚/放量判据）
- 验证：根 typecheck 过、architecture 0、lint 0 errors、server-cli 221 测试绿；累计 19 提交

## 里程碑 B 核心实现（2026-11-05）✅
- 共享协议契约 `@zcode/shared/super-agent-control-plane-protocol`（生命周期消息/RPC 帧/15 方法 zod schema/端点推导）
- headless 控制面入口 `zcode control-plane`：socket bind（0600/0700、陈旧清理）、首帧认证、IPC ready/health/shutdown、per-workspace plane（Core ready 门后抢租约）、RPC 方法集 + 反向 host.* 客户端
- daemon 侧：默认 launcher（release/dev 解析，无入口响亮失败）+ JSONL RPC 客户端（256KiB/超时/zod/断线审计）
- 真子进程+真 socket+真 sqlite 集成测试：ready→ensure→ingest 幂等→lease→shutdown 对称、不可信 peer 拒绝、协议版本 fatal
- 验证：根+CLI typecheck 过、architecture 0、lint 0 errors、bootstrap super-agent 171 + daemon 集成 21 + server-cli 33 测试绿；累计 23 提交

## 里程碑 B Core↔child 数据面闭环（2026-11-05）✅
- services RPC-backed TriggerSink/schedule auditor（窄端口，shared wire 契约，无 bootstrap 依赖）✅
- runServerCore 门禁投影 + 构造控制面端口 + §3.6 代际门 + workspace.ensure（leader 缓存）✅
- 生产 client + 真 socket + §3.8 握手套件；services 25 / server-cli 27 测试绿 ✅
- desktop 租约门不可达注入层按评审删除（如实延后 daemon scheduler 迁移批）✅
- 验证：双 scope typecheck、architecture 0、lint 0 errors；累计 26 提交

## 里程碑 B 第二批（2026-11-05）✅
- headless 裁决模型会话装配（解除 UNIMPLEMENTED）：真 provider 链 + tools 恒空 + 惰性 Registry + typed 不可用
- daemon scheduler B3：lease 门控（daemon 只 claim child leader 租约内 workspace）+ schedule.audit RPC + pending_dispatch 行
- 测试：裁决 6 例（真 fake-provider）+ scheduler 8 单测 + 3 真 child 集成；server-cli 266 / bootstrap 242 全绿
- 验证：双 scope typecheck、architecture 0、lint 0 errors；累计 30 提交

## 已知接缝（登记、非阻塞）
- specRun dispatcher 生产 launch 适配器（flag 开时 speculative/auto 响亮失败——fail-closed 如设计）
- automation/offpeak owner 心跳接线（packages/services 分区）
- PromptAdmissionOptions.mandateFacts 接缝
- processEnv 注入 workflow child（Phase 3 禁 workflow spec run）
- P6 设备凭据/能力票据（可选里程碑）

## 待办
- 里程碑 A 生产准入接线（认领，spec §8-10；分区=协议宿主/入站宿主，W 分区外）：`gateway.handleCommand`+`autoReplyGuard` → `options.superAgent` 注入、services 侧 `plane.triggerSink` 注入、`BotConfig.eventRouterEnabled` 读点（bot 灰度）
- would-accept 可见面最后一公里（认领，spec §8-11；分区=CLI 宿主/ desktop-web UI，W 分区外）：TUI `listWouldAcceptCards` ← 快照 `pendingWouldAccept`、desktop/web 挂 `WouldAcceptInbox`（数据源 `listPendingWouldAccept` 不动）
- 全车道收口：中央 typecheck/lint/architecture/tests + 新文件 policy 例外
- P6 设备凭据（可选里程碑）排期
- git 提交：等用户指令（铁律：取 git_write_gate 闸）
