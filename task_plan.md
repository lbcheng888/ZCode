# task_plan — super-agent-harness-design 全期落地（工作流并行最大化）

目标：落地 `docs/architecture/super-agent-harness-design.md`（Phase 0–6）。
指挥原则：车道文件分区互斥；spec 先行；无 fallback/mock；全车道完成后中央验证。

## 车道总表

| 车道 | 内容 | 分区（唯写） | 状态 |
| --- | --- | --- | --- |
| P0/P1 | webhook fail-closed、bot 死信、goal 转正+零注入、唤醒再投喂 | 见 progress.md 批量 1 | ✅ 已落地（验证全绿） |
| P2 | 触发子系统：storage/叶子模块/flags、UI 投影、intake、dispatch bridge、trigger 核心、裁决 | bootstrap/src/super-agent/{storage,intake,trigger,adjudication,mandate,write-leases,decision-log}、botsService 出口、tasksDatabase 迁移、desktop scheduler、command-inbox、prompt-admission、shared snapshot/envelope、ui、tui | ▶ 恢复中（land-phase2 续跑） |
| P3 | spec restricted profile + egress 代理 + 对抗验收 | bootstrap/src/super-agent/spec-lane/**、core/src/tool/**（除 result-serialization、compact）、subprocess env 通道 | ⏳ 随 P2 后并行 |
| P4 | watchdog + BackgroundRun registry 行级投影 + typed repair | bootstrap/src/super-agent/watchdog/**、dynamic-workflow-run-track.ts、background task registry 注册钩子、automationService 注册钩子 | ⏳ 并行 |
| P5 | recall 引用图工具 + compact recoveryPointer | core/src/tool/handlers/recall.ts（新）、contracts 资源 ID、compact/prompt.ts、compact-persistence.ts、result-serialization.ts | ⏳ 并行 |
| P6 | deviceScope/能力票据（可选里程碑） | 待 P2-P5 收口后排期 | ⏸ 未启动 |

## 验证矩阵（每车道 + 收口）

- targeted vitest（车道自带）
- 收口：`pnpm typecheck` + `pnpm lint` + `pnpm architecture:check --changed` + 受影响测试全量
- 新文件 unmanaged-new-file 门禁：managed 模块内或收口时补 policy 例外（沿批量 1 先例）
