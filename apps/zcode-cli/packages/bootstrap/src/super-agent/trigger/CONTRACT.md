# super-agent-trigger

意图：触发子系统的确定性主干——trigger_subscriptions 仓储、EventRouter owned 直通、
human-explicit 分派器（resume/createTask 决策矩阵）、verdict 解释执行（P2 全收敛
would-accept）、per-workspace leader 租约门控。热路径零 LLM（spec A1）。

不变量：

- CommandInbox 仍是全渠道唯一 admission（M1）：routeOwned 只经注入的
  `TriggerHostDeliveryPort` 投信封（triggerId/taint additive 字段），不旁路、不直接
  import host 实例。投递幂等键 = `triggerId:subscriberSessionId`，重复路由由 inbox
  幂等吸收。
- 车道语义权威在 §3.1 车道表：订阅行 lane=followup/guide/inject 原样透传，本模块
  不改车道、不做 inject→queue 降级。
- human-explicit 免 Mandate、免攒批（§2.1）；resume 仅对「已终态且非人为停止」
  worker，无对象/被人为停止则 createTask（不复活被停会话），worker 在跑（非终态）
  走 TriggerHostDeliveryPort lane=guide 行内投递到在跑会话（M1 busy 语义，不新建
  同 threadKey 平行会话——否则双订阅双跑、findWorkerByThreadKey 消歧歧义）；投递
  被拒返回 delivery_failed 响亮暴露，不降级 createTask。fast_path 的
  decision_log routed 行由 Intake 在 ingest 时落（§3.1 步 2），分派器不重复落行。
- routeOwned 回执全为 admitted|duplicate 才落 final_disposition=routed；任一
  rejected → 终态保持未决（NULL，供启动重放扫描 §4 流五 3 覆盖）并返回
  delivery_failed，调用方不得按已路由消费。payload 带 `chengJobId` 时 fan-out 前
  求真实 gate；红 gate 返回 `gate_blocked`、final_disposition=record_only、零投递；
  缺 resolver 抛错（fail-closed）。
- applyVerdicts fail-closed：decision.triggerId 全量校验 + 写入整段包在
  BEGIN IMMEDIATE 事务内，任一行未命中或任一写失败整体 ROLLBACK 后上浮、零部分
  执行（前提：decisionLog 端口与域库同句柄）；P2 无 Mandate 行为，accept/record-only
  收敛 decision_log(would_accept) + adjudication_status=record_only，reject 落
  decision_log(reject) + rejected，不建订阅不触发执行。decision 带 `chengPlanId`
  时同一 UPDATE 写 `trigger_events.cheng_plan_id`（migration 0006），与
  `decision_log.cheng_plan_id` 同事务；引用真实性由裁决驱动器对 tool-loop 回执先行校验。
- ChengGate 出站前置：payload 带 `chengJobId` 时，非 reject 决议在事务前经
  `resolveSpecRunGate` 求 gate。红 gate = 静默丢弃：只落
  decision_log(record_only, reason=cheng_gate_blocked)、不写 would-accept 卡、不启动
  run；绿 gate 随 `TriggerSpecRunInput.chengGate` 进 dispatcher 预检。带 chengJobId
  但未注入 resolver = 事务前抛错（零写入）。
- leader 租约：BEGIN IMMEDIATE + upsert WHERE 守卫 + changes()>0 断言（§3.3）；
  断言不过 = follower（回滚，不启动控制面循环）。heartbeat 掉锁即主动降级。
- 订阅租约：唯一 active 约束（partial unique）保回填/写入幂等（§5.1）；upsert =
  INSERT OR IGNORE 首写者胜（§1.3），冲突零更新不覆盖 lane/owner（防 followup
  把 guide/inject 降级），lease 续期走 renewActiveLeases；过期由
  sweepExpiredLeases 回收（status=revoked 保留审计行）；续期只由 leader 调用。
- trigger 原文不落日志；taint 永不构成指令权威（§0/§5）。

与其它模块的交集（hook 点）：

- Intake：ingest 三态后调 routeOwned / dispatchHumanExplicit；trigger_events 的
  INSERT 与 fast_path 列归 Intake，本模块只读行 + 写 final_disposition /
  adjudication_status（trigger-events-access.ts 窄面）。
- 裁决驱动器（super-agent-adjudication）：攒批后把 per-candidate verdict 交给
  applyVerdicts；解析失败的整批 record-only 降级在驱动器侧完成。
- decision-log：本模块经结构端口 `TriggerDecisionLogPort.record` 写入，不 import
  兄弟模块文件。
- 派发桥（ws7，dispatchBridge.ts / dispatchBridgePort.ts）：dispatch_requests
  exactly-once 状态机；index.ts 按 spec §2.1 re-export 其端口；其 onHostAck 的
  数据源 = CommandInbox host 的 `onAdmissionReceipt` 回执面。
- kill-switch（§5.4）：`features.eventRouter=false`（缺省）时组合根向 TriggerSink /
  delivery 注入 no-op 直通 = legacy bots 直路；门禁在注入点，本模块内部不查 flag。
- 存量回填（§5.1）：落点在 intake/backfill.ts（ws6 分区）——遍历既有 bot
  conversation 铸造 threadKey 后循环 INSERT OR IGNORE（lane=followup，
  owner_kind=session），与本模块 upsert 同一幂等语义（首写者胜），重复执行零新增行。
