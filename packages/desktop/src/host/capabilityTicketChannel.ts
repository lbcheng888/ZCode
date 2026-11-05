import {
  capabilityTicketBindingsMatch,
  capabilityTicketRedeemRequestSchema,
  type CapabilityTicketBinding,
  type CapabilityTicketFailureCode,
  type CapabilityTicketRedeemResult,
} from "@zcode/shared";
import {
  CAPABILITY_TICKET_CHANNEL_KEY,
  CAPABILITY_TICKET_CHANNEL_VERSION,
  postCapabilityTicketRedeemResultFrame,
} from "@zcode/client";
import type { CapabilityTicketBroker } from "./capabilityTicketBroker.js";
import type { WindowHostCapabilityTicketDelivery } from "./windowHostAttachmentRegistry.js";

/**
 * P6 能力票据受控通道的宿主侧（CONTRACT，spec §2.1/§2.3）。
 *
 * 线格式与安全边界由 `packages/client/src/capabilityTicketChannel.ts` 定义，本文件只做
 * 宿主端实现；两边常量必须逐字一致（`capability-ticket-v1`）。
 *
 * 选型：**attachment MessagePort 上的独立控制帧**，不新建进程/端口/服务。
 * - secret 只出现在 attach 时的一次性 `delivery` 帧；不写 RPC 参数、command/input
 *   信封、日志、SQLite、模型上下文。
 * - 兑换帧由**该 attachment 自己的 port** 送入；broker 之外再叠一层宿主权威绑定校验：
 *   请求里的 binding 必须与该 attachment 记录（workspaceIdentity + attachmentId +
 *   surfaceKind + subject）完全一致，否则 `ticket.binding_mismatch`。即使 secret 泄漏到
 *   别的 attachment，也无法在另一条连接上兑换。
 * - 返回帧只有一次性注入句柄，不含 secret。
 * - fail-closed：结构非法/绑定不符/端口已关闭都不回退；客户端按超时拒绝兑换。
 *
 * 平台覆盖（不夸大）：控制帧要求 port 端到端到达客户端。桌面 renderer 的 remote
 * attachment 直接转移 MessagePort，覆盖；web/mobile 远控 relay 在 main 侧只转发
 * `Uint8Array` RPC 帧，delivery 帧会被忽略，该形态下票据兑换未实现（客户端不会拿到
 * secret，兑换 fail-closed），不得按“所有平台已生效”宣传或按平台降级放行。
 */

/** 宿主端 port：Electron MessagePortMain 用 on/off；测试用 node:worker_threads 的 MessagePort。 */
export interface CapabilityTicketChannelHostPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: unknown) => void): unknown;
  off(event: "message", listener: (event: unknown) => void): unknown;
}

/** Electron 的 message 事件是 `{ data }`；Node MessagePort 的 EventEmitter 直接给原始消息。 */
function readMessageData(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "data" in event) {
    return (event as { data?: unknown }).data;
  }
  return event;
}

export function postCapabilityTicketDelivery(
  port: { postMessage(message: unknown): void },
  delivery: WindowHostCapabilityTicketDelivery,
): void {
  // 独立控制对象（非 Uint8Array），RPC MessagePortProtocol 会忽略；只有本通道消费。
  port.postMessage({
    [CAPABILITY_TICKET_CHANNEL_KEY]: CAPABILITY_TICKET_CHANNEL_VERSION,
    kind: "delivery",
    ...delivery,
  });
}

function redeemFailure(
  code: CapabilityTicketFailureCode,
): CapabilityTicketRedeemResult {
  return { ok: false, code, message: code };
}

export interface CapabilityTicketRedeemChannel {
  dispose(): void;
}

/**
 * 为一个 attachment 建立兑换监听。必须在 attachment port 的 RPC 协议建立前/同时挂载；
 * 端口关闭时由 registry 的 dispose 链路回收（该 attachment 的票据同时被吊销）。
 */
export function createCapabilityTicketRedeemChannel(options: {
  port: CapabilityTicketChannelHostPort;
  broker: CapabilityTicketBroker;
  attachmentId: string;
  /** registry 在 attach 时写入的权威绑定；兑换请求必须与它一致。 */
  authoritativeBinding: CapabilityTicketBinding;
  /** 拒绝审计：只允许传公开事实（attachmentId/ticketId/code），禁止传 secret 或原始请求。 */
  logDenied?: (event: {
    attachmentId: string;
    ticketId?: string;
    code: CapabilityTicketFailureCode;
  }) => void;
}): CapabilityTicketRedeemChannel {
  const { port, broker, attachmentId, authoritativeBinding, logDenied } = options;

  const handleMessage = (event: unknown): void => {
    const data = readMessageData(event);
    if (typeof data !== "object" || data === null) return;
    const record = data as Record<string, unknown>;
    if (record[CAPABILITY_TICKET_CHANNEL_KEY] !== CAPABILITY_TICKET_CHANNEL_VERSION) return;
    if (record["kind"] !== "redeem") return;
    const requestId =
      typeof record["requestId"] === "string" && record["requestId"].length > 0
        ? record["requestId"]
        : undefined;
    if (requestId === undefined) return;

    const parsed = capabilityTicketRedeemRequestSchema.safeParse(record["request"]);
    let result: CapabilityTicketRedeemResult;
    if (!parsed.success) {
      result = redeemFailure("ticket.binding_mismatch");
    } else if (
      parsed.data.binding.attachmentId !== attachmentId ||
      !capabilityTicketBindingsMatch(authoritativeBinding, parsed.data.binding)
    ) {
      result = redeemFailure("ticket.binding_mismatch");
    } else {
      result = broker.redeem(parsed.data);
    }
    if (!result.ok) {
      logDenied?.({
        attachmentId,
        ...(parsed.success ? { ticketId: parsed.data.ticketId } : {}),
        code: result.code,
      });
    }
    try {
      postCapabilityTicketRedeemResultFrame(port, requestId, result);
    } catch {
      // port 已关闭：客户端超时后按 fail-closed 拒绝，不回退到无票据路径。
    }
  };

  port.on("message", handleMessage);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      port.off("message", handleMessage);
    },
  };
}
