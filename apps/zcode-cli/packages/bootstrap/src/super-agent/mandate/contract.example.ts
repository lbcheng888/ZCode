/**
 * super-agent-mandate 标准调用示例：分派器每批 candidate 先 resolveFor。
 * - flag 关（工厂未注入 repo）：恒隐式 record_only → 全部收敛 would-accept；
 * - flag 开（工厂注入 repo + workspaceIdentity）：显式 active 行 UNION 隐式缺省（M4 三档）。
 * 仓储 insert 留给收件箱一键批转 auto（P2 允许写行，auto 执行档 Phase 3 才生效）。
 */
import type { SuperAgentMandateContract, SuperAgentMandateRepo } from "./contract.js";

export function exampleSuperAgentMandate(
  contract: SuperAgentMandateContract,
  repo: SuperAgentMandateRepo,
): void {
  // 未注入 repo 时返回 { tier: "record_only", source: "implicit" }：卡片收敛，不执行。
  contract.resolveFor("bot:bot-1");
  repo.insert({
    workspaceIdentity: "workspace-a",
    triggerClass: "bot:bot-1",
    tier: "auto",
    policyVersion: 1,
  });
}
