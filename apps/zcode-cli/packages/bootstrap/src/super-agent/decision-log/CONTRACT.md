# super-agent-decision-log

意图：decision_log（spec §1.7）的唯一写入口。两个调用点——Intake fast-path disposition、裁决驱动器 verdict / would-accept 转化（M12②）——都必须经本模块 `record()` 落行，杜绝第二写者；TTL 滚动窗口（90 天）由 `sweepRetention(now)` 统一清理。

不变量：

- 唯一写者：`decision_log` 表的 INSERT 只出现在本模块 `repo.ts`；任何模块不得绕过契约直写。
- 保留窗口：`created_at < now − 90天` 的行在 sweep 后不可恢复；调用方（daemon 控制面循环）负责周期触发，P2 只提供 API。
- 同步落库：`record` / `sweepRetention` 返回即已持久化（node:sqlite 同步语义），不假装异步。
- 表结构（列/索引）由 super-agent-storage 迁移创建；本模块不建表、不迁移。

与其它模块的交集（hook 点）：组合根 open 域库后以 `createDecisionLog(db)` 注入 Intake 与裁决驱动器；两者只依赖 `SuperAgentDecisionLogContract`，不 import 本模块实现。
