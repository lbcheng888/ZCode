# super-agent-storage

意图：daemon 域库 `~/.zcode/v2/super-agent.sqlite` 的唯一打开点——建父目录、WAL、全量迁移（§1.1–§1.8 六表）。本模块不读写任何业务表；六表的写入权归各自模块的仓储（decision-log / write-leases / mandate，以及 trigger 侧的 trigger_events / trigger_subscriptions / control_plane_leases），经组合根注入本模块返回的句柄。

不变量：

- 打开即迁移：`openSuperAgentDatabase` resolve 时 `SUPER_AGENT_MIGRATIONS` 已提交；文件库 `journal_mode` 非 wal 直接抛错，不降级。
- 幂等：重复打开已迁移库零副作用（迁移账本 `schema_migration` 校验 + checksum fail-closed）。
- 路径解析不在本模块：生产路径由组合根解析后传入（调用过 services `setDataBaseDir()` 的宿主必须传 `getDataBaseDir()` 结果，可经 `getSuperAgentDatabasePath(baseDir)` 拼接；无覆盖的宿主可直接 `getSuperAgentDatabasePath()`）；本模块不 import 兄弟模块、不 import app/paths。
- 多进程并发打开：WAL + runner 的 BEGIN IMMEDIATE 串行化；崩溃在迁移中途由 SQLite 事务回滚，重开重放。

与其它模块的交集（hook 点）：组合根（create-app / daemon 控制面宿主，§7-7）进程启动时 open 一次 → 注入各仓储工厂 → 进程退出 close；兄弟模块只认 `SuperAgentDatabaseHandle`（= node:sqlite `DatabaseSync`）这一结构类型，不 import 本模块文件。
