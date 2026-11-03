/**
 * super-agent-write-leases 对外契约：write_leases 仓储（spec §1.5，P2 建表不启用）。
 * 语义收窄（M12①）：只服务 spec-lane 静默 run 与活 worker 的并发写互斥；
 * P2 只提供仓储 API，不接 workspace 写工具 admission 检查点（Phase 5 才接 features.specWriteLease）。
 */

export type WriteLeaseStatus = "active" | "released";

export interface WriteLeaseRow {
  id: string;
  workspaceIdentity: string;
  /** spec run id（占用方）。 */
  ownerRunId: string;
  /** run 声明的文件集，JSON 文本原样存储。 */
  scope: string;
  status: WriteLeaseStatus;
  leaseExpiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface AcquireWriteLeaseInput {
  workspaceIdentity: string;
  ownerRunId: string;
  /** run 声明的文件集，调用方序列化为 JSON 字符串传入。 */
  scope: string;
  /** 租约到期时间（epoch ms）；随 worker 终态 + 宽限回收。 */
  leaseExpiresAt: number;
  /** 落行时间；缺省 Date.now()。 */
  now?: number;
}

export interface SuperAgentWriteLeasesContract {
  /**
   * 插入一条 active 租约并返回落行。前置：scope 已序列化。
   * P2 仅建表语义：不查第二写者冲突（响亮拒绝是 Phase 5 admission 检查点的职责）。
   * 同步执行，返回即已持久化；不发事件。
   */
  acquire(input: AcquireWriteLeaseInput): WriteLeaseRow;
  /**
   * 列出 workspace 当前 active 租约（含未过期与待回收行，回收由 sweepExpired 负责）。
   * 同步执行，只读。
   */
  getActive(workspaceIdentity: string): WriteLeaseRow[];
  /**
   * 释放租约（status=released）。幂等：id 不存在或已释放时返回 false。同步执行。
   */
  release(id: string, now?: number): boolean;
  /**
   * 回收 lease_expires_at < now 的 active 租约（启动清过期 / 定期巡检），返回回收数。
   * 幂等：无过期行时返回 0。同步执行。
   */
  sweepExpired(now: number): number;
}
