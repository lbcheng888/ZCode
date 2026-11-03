/**
 * super-agent-intake 标准调用示例：出口铸造信封 → ingest 拿三边路由 →
 * 把 route 交给 super-agent-trigger 执行动作（本模块不派发）。
 */
import type { SuperAgentIntakeContract, TriggerEnvelope } from "./contract.js";

export async function exampleSuperAgentIntake(contract: SuperAgentIntakeContract): Promise<void> {
  const envelope: TriggerEnvelope = {
    workspaceIdentity: "remote:server:owner:/tmp/workspace",
    source: "im",
    provider: "feishu",
    providerMessageId: "om_abc123",
    threadKeyHint: "bot:feishu-1+chat-9/thread-1",
    actor: { kind: "human", id: "ou_user" },
    payload: {
      botId: "feishu-1",
      chatType: "group",
      chatId: "chat-9",
      threadId: "thread-1",
      mentionedBot: true,
      senderType: "user",
      text: "继续上次的任务",
    },
    taint: true,
  };
  const { triggerId, route } = await contract.ingest(envelope);
  switch (route) {
    case "owned":
    case "human_explicit":
    case "unowned_candidate":
      // 组合根把 triggerId+route 交给 super-agent-trigger 的对应动作；幂等重投返回同一 triggerId。
      console.log(triggerId, route);
      break;
    case "rejected":
      // 快路径拒绝：行已终态，无路由动作。
      break;
  }
}
