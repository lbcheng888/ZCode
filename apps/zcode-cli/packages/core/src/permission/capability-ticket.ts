import {
  capabilityTicketScopeAllows,
  classifyAttachmentTool,
  type CapabilityTicketBinding,
  type CapabilityTicketScope,
  type AttachmentToolClass,
} from "@zcode/shared";

/**
 * P6 能力票据授权域（CLI 执行侧消费，spec §2.5 C1/C2）。
 *
 * 由宿主 broker 在命令入口校验后经可信 carrier 下发；**不含 secret**。
 * 这是命令级授权，不是连接级：只在本次 turn 的工具准入上收紧工具面，不能跨命令复用。
 */
export interface CapabilityTicketAuthorization {
  ticketId: string;
  binding: CapabilityTicketBinding;
  scope: CapabilityTicketScope;
  expiresAt: number;
  /**
   * 票据自身的吊销 epoch 快照（公开事实，无 secret）。
   *
   * 已知残留（spec §2.5 落地状态）：CLI 进程与 Desktop broker 没有控制面通道，turn
   * 运行中无法拿新 epoch 复核；该值不进判定。吊销在**下一条命令 admission** 由宿主
   * broker 生效，已在跑的 turn 按 TTL 收敛（在途长命令走既有取消/杀进程路径）。
   */
  revocationEpoch: number;
}

export interface CapabilityTicketRestriction {
  behavior: "deny";
  toolClass: AttachmentToolClass;
  ruleId: string;
  reason: string;
}

/**
 * 票据 scope 与工具准入叠加（只收紧，deny-only）。
 *
 * - 授权域过期 ⇒ `ticket.expired` deny（fail-closed，不因既有 allow 规则放行）。
 * - 吊销不在本函数内判定：`revocationEpoch` 只是签发快照，CLI 无宿主控制面通道可复核
 *   新 epoch；吊销在宿主下一条命令 admission 生效（spec §2.5 已如实登记）。
 * - 工具不在 scope 内 ⇒ `ticket.scope_denied`。
 * - scope 命中 credential 类工具 ⇒ `ticket.credential_injection_unimplemented`。
 *   spec §2.5 C2 要求执行时由宿主 broker 注入短时凭据；broker 在 Desktop main、
 *   执行在 CLI 进程，本仓没有受控凭据通道，结构不可达。**不伪造注入**：宁可拒绝，
 *   也不让工具带着“看起来有凭据”的路径执行。
 * - 其它命中 ⇒ undefined（不产生额外限制；既有管线结论保持不变）。
 */
export function evaluateCapabilityTicketRestriction(input: {
  authorization: CapabilityTicketAuthorization;
  toolName: string;
  permissionGroup?: string;
  now?: number;
}): CapabilityTicketRestriction | undefined {
  const { authorization, toolName, permissionGroup } = input;
  const at = input.now ?? Date.now();
  if (at >= authorization.expiresAt) {
    return {
      behavior: "deny",
      toolClass: classifyAttachmentTool(toolName, permissionGroup),
      ruleId: "capabilityTicket.expired",
      reason: `capability ticket ${authorization.ticketId} expired at ${authorization.expiresAt}; fail-closed`,
    };
  }
  const toolClass = classifyAttachmentTool(toolName, permissionGroup);
  const allowed = capabilityTicketScopeAllows(authorization.scope, {
    toolName,
    ...(permissionGroup !== undefined ? { permissionGroup } : {}),
  });
  if (!allowed) {
    return {
      behavior: "deny",
      toolClass,
      ruleId: "capabilityTicket.scopeDenied",
      reason: `tool ${toolName} is outside capability ticket ${authorization.ticketId} scope; fail-closed`,
    };
  }
  if (toolClass === "credential") {
    return {
      behavior: "deny",
      toolClass,
      ruleId: "capabilityTicket.credentialInjectionUnimplemented",
      reason:
        "ticket.credential_injection_unimplemented: edge broker credential injection (C2) is not reachable in this repository; the tool is denied rather than executed without injected credentials",
    };
  }
  return undefined;
}
