# super-agent-intake

意图：统一环境事件 intake/审计层（M2，spec super-agent-trigger-subsystem-spec §2.1 / §3.1）。`ingest` 落 `trigger_events`（intake 写入点 = INSERT + fast_path/rejected 收敛；后续终态收敛归 trigger/adjudication）+ Fast Path 确定性准入 → 输出三边路由决策（owned / human_explicit / unowned_candidate / rejected）。路由**动作**归 super-agent-trigger；本模块不派发、不建订阅（回填除外，见下）。

不变量：

- 热路径零 LLM：Fast Path 是纯确定性表（来源白名单 → 域键 → 订阅命中过守卫→owned / 无订阅 observed 直接拒不进守卫 / 无订阅 addressed 过守卫 → 三态），任何分支都不触达模型。
- `taint !== true` 直接抛错：信封只认可信出口铸造（botsService processProviderCallback），客户端不可伪造；taint 永不构成指令权威（§5）。
- 幂等权威 = DB：`UNIQUE(provider, provider_message_id)` 部分索引冲突 → 返回已收敛 triggerId，不重复落 decision_log（裁定 3；进程内 markInboundDelivery Map 只是快速守卫）。崩溃缝（行在 Fast Path 收敛前中断）按行状态重算 Fast Path。
- 三边规则：命中 active 订阅 → owned；未命中且 observed（群内未 @/非交互）→ rejected（与 legacy 丢弃旁听对齐）；addressed 且 actor=人 → human_explicit；addressed 且非人（environment-triggered explicit）→ unowned_candidate（adjudication_status=pending）。
- decision_log 经端口写（唯一写者 = super-agent-decision-log，裁定 8）：routed / reject / record_only；幂等短路不落第二行。
- `thread_key` 格式 = `<workspaceIdentity>|bot:<botId>+<peer>[/<threadId>]`；peer 槽与 `botDeliveryTarget.providerUserId` 同语义（群=chatId，私聊=providerUserId）。出口（services `triggerSink.buildBotTriggerThreadKeyHint`）与 `backfill.ts` 必须逐字节同格式，否则回填订阅匹配不上。
- 订阅表只读（owned 判定）；写仅 `backfill.ts` 的幂等 `INSERT OR IGNORE`（落点声明见该文件头：spec §6 把回填列在 trigger，本分区放 intake/backfill.ts，共用同一 partial unique index）。

与其它模块的交集（hook 点）：

- 组合根（§7-7 控制面宿主）open 域库后注入 `db` + `decisionLog`（super-agent-decision-log 的 `record`）+ `autoReplyGuard`（botsService `admitAutoReplyTurn` 包装：非适用面返回 true，占额语义原样复用）；本模块三者全走结构类型端口，不 import 兄弟模块实现。
- `TriggerEnvelope` 与 `packages/services` 的 `TriggerSink` port 形状对齐（services 不依赖 bootstrap，组合根适配器负责对表）；flag 关（`features.eventRouter=false`）时注入 no-op 直通 = legacy 直路，本模块不被调用。
