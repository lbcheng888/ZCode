import type {
  CapabilityTicketAction,
  CapabilityTicketBinding,
  CapabilityTicketRedeemRequest,
  CapabilityTicketRedeemResult,
  CapabilityTicketScope,
} from "@zcode/shared";

/**
 * P6 能力票据的客户端携带/兑换（spec §2.3）。
 *
 * 受控通道的选择（明确注明）：secret **不**进 v4 command/input 协议帧，也不进模型上下文。
 * 客户端只把 `capabilityTicketId` 放进协议信封；`ticketId + ticketSecret + binding + nonce`
 * 只走 broker 专用的兑换调用（本模块的 `redeem` → transport）。transport 由宿主连接层实现，
 * 必须是连接级受控面；本模块不做任何日志、不落盘、不重试缓存。
 *
 * 状态（不夸大）：本批只覆盖「携带 + 兑换调用」；凭据注入（C2）与远端 edge broker 兑换
 * 未接线（结构不可达）。
 */

export interface CapabilityTicketSecretBundle {
  ticketId: string;
  ticketSecret: string;
  binding: CapabilityTicketBinding;
  expiresAt: number;
  /**
   * 签发时 broker 的吊销 epoch。兑换必须原样携带；调用端不得省略或在本地缓存后继续使用
   * 旧值（broker 会以 ticket.revoked 拒绝）。
   */
  revocationEpoch: number;
  scope?: CapabilityTicketScope;
}

export interface CapabilityTicketRedeemTransport {
  redeem(
    request: CapabilityTicketRedeemRequest,
  ): Promise<CapabilityTicketRedeemResult> | CapabilityTicketRedeemResult;
}

export interface CapabilityTicketClient {
  /** 唯一可进协议帧/模型的公开句柄。 */
  readonly ticketId: string;
  readonly expiresAt: number;
  /** 协议信封 additive 字段；永远不含 secret。 */
  protocolFields(): { capabilityTicketId: string };
  /**
   * 兑换。`revocationEpoch` 由 bundle 自动携带，调用方无法省略或伪造（省略 epoch 会绕过
   * 吊销传播，所以这里不留可选参数）。
   */
  redeem(
    action: CapabilityTicketAction,
    nonce: string,
    seq?: number,
  ): Promise<CapabilityTicketRedeemResult>;
  /** 释放本地 secret 副本；释放后再兑换直接抛错，不降级到无票据路径。 */
  dispose(): void;
}

export interface CreateCapabilityTicketClientOptions {
  bundle: CapabilityTicketSecretBundle;
  transport: CapabilityTicketRedeemTransport;
}

export function createCapabilityTicketClient(
  options: CreateCapabilityTicketClientOptions,
): CapabilityTicketClient {
  const { ticketId, expiresAt, binding, revocationEpoch } = options.bundle;
  const transport = options.transport;
  let secret: string | null = options.bundle.ticketSecret;

  return {
    ticketId,
    expiresAt,
    protocolFields() {
      return { capabilityTicketId: ticketId };
    },
    async redeem(action, nonce, seq) {
      if (secret === null) {
        throw new Error("Capability ticket client disposed");
      }
      // secret 只出现在这次受控兑换请求里；不复制到任何其他结构。
      // epoch 恒为签发时快照，不能省、不能被调用方覆盖。
      return transport.redeem({
        ticketId,
        ticketSecret: secret,
        binding,
        action,
        nonce,
        revocationEpoch,
        ...(seq !== undefined ? { seq } : {}),
      });
    },
    dispose() {
      secret = null;
    },
  };
}
