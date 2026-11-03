# super-agent-mandate

意图：mandate 表（spec §1.4）的查询语义与隐式 record-only 缺省（M4）。P2 flag 关时恒隐式 record-only → 全部 candidate 进 would-accept；flag 开后才启用三档解析。

不变量：

- **flag 关（缺省，`createMandateContract()` 不注入 repo）**：`resolveFor(triggerClass)` 恒返回 `{ tier: "record_only", source: "implicit" }`——即便仓储已写入显式行也不改变裁定，P2 字节兼容（spec §0）。
- **flag 开（`features.mandateGate`，注入 `repo` + `workspaceIdentity`）**：按 `(workspace_identity, trigger_class)` 查 active 且未过期行；命中返回 `{ tier, source: "explicit", mandateId }`，未命中回退隐式 record_only（查询层 UNION 缺省，不写表）。`expires_at` 过滤在仓储 `getActive` 内完成。
- 隐式缺省不写表；`insert` 只服务显式行（收件箱一键批转 auto 等）。
- `resolveFor` 同步、无副作用：checkPermission 最前端同步 fail-closed 的调用形态（M4）原样消费本结论。
- 表结构（含 `(workspace, trigger_class)` active partial unique index）由 super-agent-storage 迁移创建；表写入只出现在本模块 `repo.ts`。

与其它模块的交集（hook 点）：分派器（super-agent-trigger）每批 candidate 调 `resolveFor`；would-accept 收件箱经组合根注入的 `SuperAgentMandateRepo` 写显式行。两者都只依赖本契约，不 import 实现。
