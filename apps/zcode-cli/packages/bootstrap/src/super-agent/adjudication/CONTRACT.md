# super-agent-adjudication

意图：unowned 环境候选的攒批裁决驱动器（spec §2.1 / design M3 短命批量裁决回合）。
pending 行即事实队列，唤醒三选一（backlog≥8 / 最老≥60s / 5min 评估点）攒批 →
短命 model-only 会话产出 per-candidate verdict JSON → fail-closed 校验 → mandate
裁定 → delivery 端口交付。与 goal 存在性完全解耦（A3）；前台永不排队（低优先槽，
A6）；独立每日微预算（M12③）。

不变量：

- 队列即事实：`fast_path='unowned_candidate' AND adjudication_status='pending'`
  是唯一队列源（candidates.ts 对 trigger_events 零写入），驱动器无内存队列状态——
  崩溃/重启天然恢复；启动扫描 = `start()` 对 `listPendingWorkspaces` 补评估
  （spec §1.2 索引）。notifyCandidate 只是唤醒信号：行缺失抛错（装配错误），
  已收敛/非 candidate 幂等忽略，未 start()（非 leader）仅校验不唤醒，同步返回
  永不等待模型。
- verdict 校验 fail-closed（T2）：JSON/schema/外键/覆盖任一失败 = 整批降级
  record-only（reason 标 `verdict-validation-failed:<failure>`），无部分执行，
  `schemaFailures` 计数；确定性提取只剥单层 markdown 围栏（verdict.ts，非启发式）。
  chengPlanId 未命中本批真实 ChengPlan 工具回执（`cheng-plan://<jobId>`）同样整批
  降级 record-only，`verdictDegraded=cheng_plan`、`planReferenceFailures` 计数。
- 交付接缝 = spec §2.1 `super-agent-trigger.applyVerdicts`（结构端口
  AdjudicationDeliveryPort，组合根直接接线）：accept/record-only →
  decision_log(would_accept) + adjudication_status=record_only，reject →
  decision_log(reject) + rejected。decision_log 唯一写者是 super-agent-decision-log
  （裁定 8），本模块零直写；交付后按 `countStillPending` 校验结算，零结算经
  onError 响亮暴露（接线错误不静默重试）。
- mandate 裁定锚点（spec §1.4「被分派器调用」）：每 candidate 经
  AdjudicationMandatePort.resolveFor 推导 trigger_class（`bot:<botId>` /
  `<source>:<域键>`）并记录 `mandateTier`；P2 恒隐式 record_only，执行档分流
  是 Phase 3 的事。
- 工具面双闸（T1 零副作用锚点）：toolAllowlist（会话级 fail-closed 主闸）只放行
  `Recall`/`GoalRead`/`ChengInspect`/`ChengPlan`（M3 + S2 只读面，未知未来工具默认
  排除）；toolDisallowlist（turn 级纵深，automation/off-peak sendPrompt 同型）枚举
  全部已知执行/副作用工具，并显式禁用 ChengGenerate/ChengVerify/ChengExplain。
  verdict JSON 之外零副作用。ChengInspect/ChengPlan 已注册为 core 只读工具。
  **前台 `create-app` 已切到 `createToolAdjudicationSession`**：每批一个隔离 AgentRuntime，
  按 allowlist 过滤 tool contracts，模型 toolCalls 复核后执行并把结果回灌。daemon headless
  在 `ZCODE_CHENG_ROOT`/host entry 在场时走同一 tool-loop（只读 Cheng host 端口），
  否则保持 `createRuntimeAdjudicationSession` 的 `tools=[]` model-only——host 缺席是
  能力缺席，此时 plan 引用无回执可命中并 fail-closed 降级。
- verdict 可选 `chengPlanId`：非空字符串才合法；前台 tool-loop 把实际执行的
  `ChengPlan` 回执收进 `AdjudicationModelSessionResult.chengPlanReceipts`（成功且
  输出 `status=ok`；planId 由入参 jobId 派生），驱动器逐条比对。命中才允许执行，
  并在同一事务落 `trigger_events.cheng_plan_id`（migration 0006）与
  `decision_log.cheng_plan_id`（migration 0005）；未命中不写引用列、整批 record-only。
- 前台隔离（A6）：modelTier=`adjudicator` 轻量档 pin + scheduling=
  `background-low-priority` 低优先/错峰槽，裁决批不占前台首 token 延迟。
- 微预算（M12③）：`recordUsage` 按 workspace×UTC 日换桶，耗尽 → 不调模型、
  候选留 pending（`budget_exhausted`，下个 UTC 日由评估点重试）；会话结果自带
  usage 由驱动器自动计量，宿主勿重复上报。
- 失败路径：会话故障 → `session_error` outcome + 60s 冷却（防热循环）+ onError
  告警，候选留 pending；delivery/DB 错误原样 reject（自动唤醒路径经 onError，
  手动调用方自行处理）；预算耗尽不告警（预期内节流）。
- 短窗 KV 复用：同 workspace 5min 窗内复用同一短命 sessionKey（共享 prefill），
  窗末/stop() 销毁；宿主必须容忍在途回合后的 destroySession 调用。
- 同 workspace 在途批合流（返回同一 Promise），不并发双跑；stop() 不取消在途批
  （自然收尾，收尾后的唤醒被 running 门控拦下）。

与其它模块的交集（hook 点）：

- Intake：ingest 判 `unowned_candidate` 后由组合根调 `notifyCandidate(triggerId)`
  （行校验 + 唤醒）；trigger_events 的 INSERT 与 fast_path 列归 Intake。
- super-agent-trigger：delivery 端口的实现方 = `applyVerdicts`；本模块只依赖
  结构签名，不 import 兄弟模块文件（requires: []）。
- super-agent-mandate：每 candidate 调 `resolveFor`（裁定 1 的查询侧调用者之一）。
- super-agent-decision-log：不直接依赖——decision_log 写入由 delivery 接缝的
  实现方经其仓储 API 完成（裁定 8 唯一写者）。
- 组合根：接线 model-only 会话端口（复用 automation/off-peak sendPrompt +
  toolDisallowlist 路径，非 dynamic-workflow driver；**toolAllowlist 必须经会话创建期
  `runtimeConfig.toolAllowlist` 注入**——sendPrompt/SteerTurn 只透传 turn 级
  toolDisallowlist，没有会话级白名单面，双闸缺一不可，否则 T1 fail-closed 主闸
  不生效）、usage 事件 → `recordUsage`、
  启动扫描重喂 pending 行 → `notifyCandidate`、leader 资格 → `start()`/`stop()`。
- kill-switch（§5.4）：flags 缺省 OFF 时组合根**不 `start()` / 不调
  `notifyCandidate`**（或经 sanctioned no-op TriggerSink 使 intake 不产 candidate——
  legacy 直路驱动器根本不被喂，这才是任务书裁决的 kill-switch，非 mock）。**不得**向
  在跑的驱动器注入 no-op 会话/交付端口：no-op 交付 → 候选永不结算、5min 评估点每轮
  空烧预算并反复触发零结算 onError；no-op 会话 → 整批 json 降级 record-only、
  would-accept 静默失效。门禁在注入点，本模块内部不查 flag。
