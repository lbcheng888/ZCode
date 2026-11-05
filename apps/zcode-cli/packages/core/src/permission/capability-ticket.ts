import {
  CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE,
  capabilityTicketScopeAllows,
  classifyAttachmentTool,
  getCapturedZCodeCuaBrokerCredentials,
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
  /**
   * 宿主在 admission 时宣告的真实凭据注入通道（公开事实，不是授权本身）。
   * `host-interaction` = 宿主装配了官方 MCP 身份头解析器，agent 可在工具执行期间经
   * interaction/requestOfficialMcpAuthHeaders 索取本次请求的身份头；宿主仍会按票据
   * scope.resources 复核后才解析。缺失 = 宿主未宣告，CLI 对凭据类工具 fail-closed。
   */
  credentialInjection?: "host-interaction";
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
 * - scope 命中 credential 类工具 ⇒ 只有存在**真实注入通道**才放行：
 *   1. MCP/plugin 工具且授权域宣告 `credentialInjection: "host-interaction"`；
 *   2. CUA 工具且进程内捕获到宿主注入的 CUA broker socket（host 侧 broker 是注入通道）。
 *   两个通道都不存在 ⇒ typed `ticket.credential_injection_unavailable` deny。
 *   **不伪造注入**：CLI 绝不自己造凭据；真正解析仍由宿主在票据 scope 校验后完成。
 * - 其它命中 ⇒ undefined（不产生额外限制；既有管线结论保持不变）。
 */
export function evaluateCapabilityTicketRestriction(input: {
  authorization: CapabilityTicketAuthorization;
  toolName: string;
  permissionGroup?: string;
  now?: number;
  /**
   * 注入点：测试可显式给出 CUA broker 通道是否可用。生产缺省读进程内捕获的 broker
   * 凭证（CLI 入口在 sanitize 前捕获，process.env 里可能已被剔除）。
   */
  cuaBrokerAvailable?: boolean;
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
  const resources = authorization.scope.resources;
  // 工具维度的判定不看 `resources`：resources 描述的是**凭据通道**资源
  // （`credential:official-mcp` / `credential:<mcpKey>`），不是工具本身的资源字段。
  // 若对所有工具族都按 resources 判定，会把同票据内合法的 Read/Write 等动作误杀。
  // 但 credential 类动作必须按 resources 复核（见下），不能整体剥离。
  const toolScopedAuthorization =
    resources === undefined ? authorization.scope : stripResourceScope(authorization.scope);
  const allowed = capabilityTicketScopeAllows(toolScopedAuthorization, {
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
    const cuaBrokerAvailable = input.cuaBrokerAvailable ?? hasCapturedCuaBrokerSocket();
    if (isCuaTool(toolName, permissionGroup)) {
      // CUA 的凭据通道是宿主注入的 broker socket。权限域声明 resources 时，只接受
      // host 级 `credential:official-mcp`（宿主真实注入能力的标记）；只声明某个
      // `credential:<mcpKey>` 的窄票据不得借 CUA broker 执行。
      const resourceAllows =
        resources === undefined ||
        resources.includes(CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE);
      if (cuaBrokerAvailable && resourceAllows) return undefined;
    } else if (isMcpOrPluginTool(toolName)) {
      // MCP/plugin 的精确资源（mcpKey/pluginId）只有宿主在解析身份头前知道；CLI 只确认
      // 存在宿主宣告的注入通道，resources 精确匹配由宿主在读取凭据前强制执行。
      if (authorization.credentialInjection === "host-interaction") return undefined;
    }
    return {
      behavior: "deny",
      toolClass,
      ruleId: "capabilityTicket.credentialInjectionUnavailable",
      reason:
        "ticket.credential_injection_unavailable: no real host credential channel is available for this ticket (need credentialInjection=host-interaction for MCP/plugin tools or a captured CUA broker socket for CUA tools, with ticket resources allowing that channel); failing closed",
    };
  }
  return undefined;
}

function stripResourceScope(scope: CapabilityTicketScope): CapabilityTicketScope {
  const { resources: _resources, ...rest } = scope;
  return rest;
}

function hasCapturedCuaBrokerSocket(): boolean {
  return getCapturedZCodeCuaBrokerCredentials().socket !== undefined;
}

const CUA_TOOL_NAME_PATTERN = /cua|computer-use|computeruse/i;

function isCuaTool(toolName: string, permissionGroup?: string): boolean {
  return permissionGroup === "official_cua" || CUA_TOOL_NAME_PATTERN.test(toolName);
}

/** 与 shared attachment 分类保持同一命名面：MCP server 工具与插件工具。 */
function isMcpOrPluginTool(toolName: string): boolean {
  return toolName.startsWith("mcp__") || toolName.startsWith("plugin_");
}
