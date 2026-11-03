/**
 * super-agent-decision-log 标准调用示例：Intake fast-path disposition
 * 与裁决驱动器 verdict 都走这一个入口落行（唯一写者，M12②）。
 */
import type { SuperAgentDecisionLogContract } from "./contract.js";

export function exampleSuperAgentDecisionLog(contract: SuperAgentDecisionLogContract): void {
  contract.record({
    workspaceIdentity: "workspace-a",
    triggerId: "trigger-1",
    origin: "fast_path",
    disposition: "routed",
    reason: "owned 直通",
  });
  // daemon 定期（如每小时）触发一次滚动清理：
  contract.sweepRetention(Date.now());
}
