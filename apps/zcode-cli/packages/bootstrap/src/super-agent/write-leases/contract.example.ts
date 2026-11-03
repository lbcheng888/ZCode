/**
 * super-agent-write-leases 标准调用示例：spec-lane 静默 run 声明写范围时
 * acquire；worker 终态后 release；启动/定期 sweepExpired 回收过期租约（P2 仅仓储，不接检查点）。
 */
import type { SuperAgentWriteLeasesContract } from "./contract.js";

export function exampleSuperAgentWriteLeases(contract: SuperAgentWriteLeasesContract): void {
  const lease = contract.acquire({
    workspaceIdentity: "workspace-a",
    ownerRunId: "run-1",
    scope: JSON.stringify(["src/app.ts"]),
    leaseExpiresAt: Date.now() + 30 * 60_000,
  });
  contract.getActive("workspace-a");
  contract.release(lease.id);
  contract.sweepExpired(Date.now());
}
