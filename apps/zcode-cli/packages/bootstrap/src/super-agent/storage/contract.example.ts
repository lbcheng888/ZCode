/**
 * super-agent-storage 标准调用示例：组合根（daemon 控制面宿主）打开一次，
 * 把句柄注入 decision-log / write-leases / mandate 仓储后才开始业务循环。
 */
import type { SuperAgentStorageContract } from "./contract.js";

export async function exampleSuperAgentStorage(
  contract: SuperAgentStorageContract,
  databasePath: string,
): Promise<void> {
  const db = await contract.openSuperAgentDatabase({ databasePath });
  try {
    // db 随后注入各仓储工厂（createDecisionLog(db) / createWriteLeases(db) / createMandateRepo(db)）。
  } finally {
    db.close();
  }
}
