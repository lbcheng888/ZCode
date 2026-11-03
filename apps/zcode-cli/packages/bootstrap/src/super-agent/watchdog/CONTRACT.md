# super-agent-watchdog

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

意图：M8 行级所有权投影（`background_run_registry`）+ M10 看门狗（程序探针 → typed repair → 熔断升级 → progress-vs-objective）。人类与看门狗只观察一个「现在后台在跑什么」的面；写路径不动。

不变量：

- 行级所有权：`owner` register 时定死，行存在时仅 owner 写本行；异 owner 写 = 抛 `BackgroundRunOwnershipError`（第二写者响亮拒绝，不排队不合并）。行缺席的 settle/touch = no-op（投影不阻断业务路径）。registry 不是第二写者、不在准入路径上。
- watchdog 永不直写业务状态：repair 只经 `WatchdogRepairCommandSurface`（既有命令面）；`cancel-stalled` 仅允许带 `stallClockRef` 的 running 行，执行前程序复核。
- LLM 无进展裁决缺省 OFF（`llmNoProgressAdjudication: false`，不进 contracts config）；OFF 时裁决器零调用。裁决产出 `{ proposal, targetId? }`：枚举（`validateRepairAction`）与目标（targetId 解析到真实可执行的 registry 行）两级程序校验，任一不过即拒绝执行、不计入熔断。goalHint 半边缺席（端口缺席 / undefined / 空关键词）⇒ 该轮跳过比较，streak 保持，`TickReport.progressSkippedReason` 带原因。
- 看门狗无提示词/策略编辑权：progress-vs-objective 只读，模块内不存在 prompt/策略写路径。
- 熔断：连续 N（默认 3）次**状态变更类**（cancel-stalled / pause-automation）已执行 repair 失败 ⇒ `pauseGoal` + `notifyUser`；升级后冷却（默认 10min）。校验/目标拒绝不计入 N；notify-user 成败都不进计数（成功不重置、失败不累加）。
- registry-stall 只判 register 时声明 `heartbeat` 的行（owner 承诺周期回写）；running 行均未声明 ⇒ 该探针 skipped（数据源缺席不造数）。分工（spec §9 实施偏差）：仅 runtime-background-task 行声明并周期 touch（周期严格 < stalenessCapMs，留轮询粒度余量）；workflow 行禁止声明——其 updatedAt 是 20min cancel-stalled 独立时钟，心跳双计 liveness→progress 会永久压掉 cancel-stalled。
- 宿主无关：生命周期只经 `start()/stop()`；不 import 宿主 API，迁 daemon 只动组合根。

与其它模块的交集（hook 点，全部经组合根接缝，spec §7-2/§7-3）：

- 注册：core `background-task-registry.ts`、core `dynamic-workflow-run-track.ts`、`automationService.ts`、`offPeakTaskService.ts` 各自调结构兼容投影端口（`composition.ts` 的 `BackgroundRunProjectionPort`）；接缝未挂载 = 钩子 no-op。
- 数据源端口：`goalState` / `triggerBacklog` / `goalHint` / `adjudicator` 缺席时对应探针显式 skipped 或 progress 休眠。
- 升级信道绑既有 goal pause 命令面；`pause-automation` 绑 `automationService.setEnabled(false)`（组合根）。
