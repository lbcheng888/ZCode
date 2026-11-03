import type { DatabaseSync } from "node:sqlite";

/**
 * super-agent-storage 对外契约：daemon 域库（super-agent.sqlite）的唯一打开点。
 * 六张表（trigger_events / trigger_subscriptions / mandate / write_leases /
 * decision_log / control_plane_leases）的读写不归本模块：兄弟模块仓储各自拥有自己的表，
 * 经组合根把这里返回的句柄注入（见 CONTRACT.md）。
 */

/** daemon 域库句柄（node:sqlite）。兄弟模块仓储以同一类型为注入参数，结构类型即端口。 */
export type SuperAgentDatabaseHandle = DatabaseSync;

export interface OpenSuperAgentDatabaseOptions {
  /**
   * 绝对路径或 ":memory:"（测试/短命进程）。生产路径由组合根解析：调用过
   * services setDataBaseDir() 的宿主必须传 getDataBaseDir() 结果（可经
   * getSuperAgentDatabasePath(baseDir) 拼接），无覆盖的宿主可直接
   * getSuperAgentDatabasePath()——路径解析权在宿主，不在本模块。
   */
  databasePath: string;
}

export interface SuperAgentStorageContract {
  /**
   * 打开域库并跑全量迁移（建目录 + WAL + §1.2–§1.8 六表）。
   * 前置：databasePath 所在目录可写。后置：迁移已提交，返回句柄可直接注入兄弟模块仓储；
   * 文件库 journal_mode 必须为 wal，否则抛错（不降级）。幂等：重复打开已迁移库零副作用。
   * 同步写库、异步迁移（备份 I/O）；resolve 时迁移已持久化。不发事件；关闭由调用方 db.close()。
   */
  openSuperAgentDatabase(options: OpenSuperAgentDatabaseOptions): Promise<SuperAgentDatabaseHandle>;
}
