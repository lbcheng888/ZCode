/**
 * super-agent-trigger 标准调用示例：组合根（daemon 控制面宿主 / Desktop 里程碑 A）
 * 拿到域库句柄与三个注入端口后，按「订阅 → 竞争 leader → 路由」的最常见顺序调用。
 * agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { SuperAgentTriggerContract } from "./contract.js";

export async function exampleSuperAgentTrigger(
  contract: SuperAgentTriggerContract,
  workspaceIdentity: string,
): Promise<void> {
  // 1. 竞争 per-workspace leader：失败 = follower，纯转发，不启动控制面循环。
  const claim = contract.tryClaimLeadership({ workspaceIdentity, ownerId: "daemon-1" });
  if (claim.kind !== "leader") return;

  // 2. 订阅（幂等；存量回填 §5.1 也走同一 upsert，重复执行零新增行）。
  contract.upsertSubscription({
    workspaceIdentity,
    threadKey: "bot:bot-1:user-9:thread-3",
    sessionId: "session-42",
    lane: "followup",
    ownerKind: "session",
  });

  // 3. Intake 判 owned 后直通：零 LLM，按订阅车道投 CommandInbox。
  const outcome = await contract.routeOwned("6f1d2c3a-0000-7000-8000-000000000001");
  if (outcome.kind === "orphaned") {
    // 不应发生：无订阅者的 owned 事件，调用方按 outcome 计数告警。
  }
  if (outcome.kind === "delivery_failed") {
    // 投递被拒：final_disposition 保持未决（NULL），交给启动重放/告警，不当已路由消费。
  }

  // 4. Intake 判 human_explicit 后分派：免攒批——终态 resume / 无对象 createTask /
  //    在跑 guide 行内投递 + 写订阅。
  await contract.dispatchHumanExplicit("6f1d2c3a-0000-7000-8000-000000000002");
}
