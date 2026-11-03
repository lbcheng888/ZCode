# super-agent-write-leases

意图：write_leases 表（spec §1.5）的仓储。语义收窄（M12①）：只服务 spec-lane 静默 run 与活 worker 的并发写互斥。P2 建表不启用——只提供 acquire / getActive / release / sweepExpired 仓储 API，不接 workspace 写工具 admission 检查点。

不变量：

- 表结构（含 `lease_expires_at`）由 super-agent-storage 迁移创建；本模块不建表。
- P2 不做冲突裁决：第二写者的响亮拒绝是 Phase 5 admission 检查点（`features.specWriteLease`）的职责，仓储只如实落行/回收。
- 过期回收由 `sweepExpired(now)` 统一完成（启动清过期 + 定期巡检）；仓储不做后台循环。
- 表写入只出现在本模块 `repo.ts`；句柄经组合根注入（结构类型 = node:sqlite DatabaseSync）。

与其它模块的交集（hook 点）：Phase 5 起，workspace 写工具 admission（与 permission path policy 同层）查 `getActive`；P2 阶段除测试外无调用方。
