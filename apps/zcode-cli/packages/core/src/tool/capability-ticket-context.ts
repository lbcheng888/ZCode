import { AsyncLocalStorage } from "node:async_hooks";
import type { CapabilityTicketAuthorization } from "../permission/capability-ticket.js";

/**
 * P6 C2：工具执行期间的能力票据授权域（公开事实，**不含 secret**）。
 *
 * 来源是 prompt admission 已从宿主可信 carrier 绑定的 TurnPermissionFacts；工具执行
 * 调度时读取并放进该 AsyncLocalStorage，使 MCP adapter / 官方 MCP 身份头端口在
 * handler 内部能取到本回合的票据句柄，把它附带进 interaction/requestOfficialMcpAuthHeaders。
 *
 * 边界：
 * - 只放公开授权域（ticketId/binding/scope/expiry/epoch/通道宣告），绝不放 secret；
 * - 每个工具调用在独立 `run` 作用域内执行，不会跨工具/跨 turn 泄漏；
 * - 无票据（旧路径）时 store 为空，官方 MCP 身份头端口行为字节兼容。
 */
const storage = new AsyncLocalStorage<CapabilityTicketAuthorization>();

export function getCurrentCapabilityTicketAuthorization():
  | CapabilityTicketAuthorization
  | undefined {
  return storage.getStore();
}

/** 在本次工具执行作用域内激活票据授权域；无票据时直接执行，零额外上下文。 */
export function runWithCapabilityTicketAuthorization<T>(
  authorization: CapabilityTicketAuthorization | undefined,
  fn: () => T,
): T {
  return authorization === undefined ? fn() : storage.run(authorization, fn);
}
