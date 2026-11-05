import type { IServerChannel } from "@zcode/rpc";
import {
  CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE,
  capabilityTicketAdmissionRelayRequestSchema,
  type AttachmentRole,
} from "@zcode/shared";
import type { CapabilityTicketBroker } from "./capabilityTicketBroker.js";

/**
 * P6 C2：Desktop Host 的票据 admission 反向频道。
 *
 * 只注册在**已鉴权 host 连接**的反向 server 上（desktop-continuous / host capability），
 * 供远端执行宿主在解析官方 MCP 身份头之前回传 `{ticketId, binding}`。真正的存在性/TTL/
 * 吊销/绑定/角色 scope 判定都在本进程的 broker 上完成；secret 永不进入频道。
 *
 * `ticketPolicy` 回答“本宿主是否启用了票据”：远端宿主据此决定无票据字段的请求是否
 * 必须拒绝。票据关闭时频道仍然注册（回答 false），保持旧路径逐字节兼容；开启时回答
 * true，远端漏带票据的请求一律 fail-closed。
 *
 * 响应中的 `credentialInjection` 只在票据 scope 明确授予 host 级官方 MCP credential
 * 资源时宣告——远端宿主据此才知道可以放行 MCP/plugin 凭据工具。
 */
export interface WindowCapabilityTicketAdmissionChannel {
  channel: IServerChannel;
  dispose(): void;
}

export function createWindowCapabilityTicketAdmissionChannel(input: {
  /** 未启用票据时为 undefined：频道仍注册，但 policy=false、admit=broker_unavailable。 */
  broker: CapabilityTicketBroker | undefined;
  resolveRole: (attachmentId: string) => AttachmentRole | undefined;
  logDenied?: (event: { attachmentId: string; code: string }) => void;
}): WindowCapabilityTicketAdmissionChannel {
  let disposed = false;
  return {
    channel: {
      async call<T>(_context: string, command: string, value?: unknown): Promise<T> {
        if (disposed) throw new Error("Capability ticket admission channel closed");
        if (command === "ticketPolicy") {
          return { ticketRequired: input.broker !== undefined } as T;
        }
        if (command !== "admit") throw new Error("Unsupported capability ticket operation");
        const parsed = capabilityTicketAdmissionRelayRequestSchema.safeParse(value);
        if (!parsed.success) {
          // 跨进程入参结构非法：按绑定失败拒绝，绝不猜测字段。
          return { ok: false, code: "ticket.binding_mismatch" } as T;
        }
        if (!input.broker) {
          // 票据未启用的宿主不存在任何可承认的票据；不伪造授权域。
          return { ok: false, code: "ticket.broker_unavailable" } as T;
        }
        const { ticketId, binding } = parsed.data;
        // 角色每次现取（角色变更/吊销在下一命令生效），不缓存入参里的任何角色事实。
        const role = input.resolveRole(binding.attachmentId);
        const result = input.broker.admit({
          ticketId,
          binding,
          ...(role !== undefined ? { role } : {}),
        });
        if (!result.ok) {
          input.logDenied?.({ attachmentId: binding.attachmentId, code: result.code });
          return result as T;
        }
        const credentialInjection = result.authorization.scope.resources?.includes(
          CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE,
        )
          ? ("host-interaction" as const)
          : undefined;
        return {
          ok: true,
          authorization: {
            ...result.authorization,
            ...(credentialInjection !== undefined ? { credentialInjection } : {}),
          },
        } as T;
      },
      listen() {
        throw new Error("Capability ticket admission events are unavailable");
      },
    },
    dispose() {
      disposed = true;
    },
  };
}
