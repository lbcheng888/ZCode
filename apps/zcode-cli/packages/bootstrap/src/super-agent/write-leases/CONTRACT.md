# super-agent-write-leases

意图：write_leases 表（spec §1.5）的仓储。语义收窄（M12①）：只服务 spec-lane 静默 run 与活 worker 的并发写互斥。S1 起同 workspace 只允许一条 active 租约；第二写者由仓储 typed conflict + DB partial unique index 双重拒绝，不排队、不合并。

不变量：

- 表结构（含 `lease_expires_at`）由 super-agent-storage 迁移创建；本模块不建表。
- `acquire` 先回收过期行，再拒绝同 workspace 的其它 active 行（`WriteLeaseConflictError`）；`write_leases_single_active_uidx` 是跨进程竞态兜底。
- 过期回收由 `sweepExpired(now)` 统一完成（启动清过期 + 定期巡检 + acquire 前回收）；仓储不做后台循环。
- 表写入只出现在本模块 `repo.ts`；句柄经组合根注入（结构类型 = node:sqlite DatabaseSync）。

与其它模块的交集（hook 点）：

- spec-lane dispatcher：`features.specWriteLease=true` 时在 queue/egress 之前 acquire，run 终态/失败 finally release（spec run 作为第二写者会被立即拒绝）。
- workspace 写工具 admission（S1）：`Write/Edit/ApplyPatch` 在 handler 入口经 `WorkspaceWriteLeaseAdmissionPort` 查 canonical workspace 的 `getActive`；Bash 的非只读命令（core 现有 `isBashReadOnlyCommand` 分类器判定）在 spawn 前走同一闸，只读命令放行。手动 session/subagent/workflow child 无 owner → 拒绝；spec child 带 `triggerId=ownerRunId` 豁免。这是工具/命令分类层，不是 OS 写沙箱：分类为只读但实际有副作用的命令、以及未接入的内部写路径仍是已知残留。
