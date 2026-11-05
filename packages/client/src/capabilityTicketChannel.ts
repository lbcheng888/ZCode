import {
  CAPABILITY_TICKET_FAILURE_CODES,
  capabilityTicketBindingSchema,
  capabilityTicketRedeemRequestSchema,
  capabilityTicketScopeSchema,
  createUuid,
  type CapabilityTicketBinding,
  type CapabilityTicketFailureCode,
  type CapabilityTicketRedeemRequest,
  type CapabilityTicketRedeemResult,
  type CapabilityTicketScope,
} from "@zcode/shared";
import { z } from "zod";
import {
  createCapabilityTicketClient,
  type CapabilityTicketClient,
  type CapabilityTicketRedeemTransport,
  type CapabilityTicketSecretBundle,
} from "./capabilityTicketClient.js";

/**
 * P6 能力票据的受控 secret 交付通道（spec §2.1/§2.3）。
 *
 * 选型（与 `packages/desktop/src/host/capabilityTicketChannel.ts` 同一契约）：
 * **attachment MessagePort 上的独立控制帧**。
 *
 * - 不新增进程/端口/握手：secret 走 attachment 已经独占的 MessagePort。port 的持有者
 *   就是该 attachment 的连接身份，secret 不会出现在 v4 command/input 协议帧、RPC
 *   channel 字节流、日志、SQLite 或模型上下文。
 * - 帧是普通对象而不是 `Uint8Array`，RPC 的 `MessagePortProtocol` 只消费 `Uint8Array`
 *   与既有 flow-control 对象，未知对象一律丢弃，因此控制帧不会被误当成 RPC 反序列化。
 * - 通道是单向专用：宿主 → 客户端投递 `delivery`；客户端 → 宿主发送 `redeem`；
 *   宿主 → 客户端返回 `redeem-result`。三者都只在本 attachment 的 port 上出现。
 * - `ticketSecret` 只存在于 `delivery` 帧与 broker/客户端内存；`redeem-result` 只回
 *   注入句柄，不含 secret。模型上下文只允许 `projectCapabilityTicketForModelContext`。
 * - 失败 fail-closed：既有通道超时、重复帧、结构非法、post 失败都拒绝兑换，不重试、
 *   不缓存、不降级到无票据路径。
 *
 * 时序：宿主在 attach 时把 delivery 帧 post 到 port 的另一端；MessagePort 会为尚未
 * start 的接收端排队，因此客户端必须在 `MessagePortProtocol` 调用 `start()` 之前
 * 注册本通道监听（`createMessagePortServiceConnection` 已经按这个顺序装配）。
 *
 * 平台覆盖（不夸大）：本通道要求 attachment port 端到端到达客户端。桌面 renderer 的
 * remote attachment 是直接转移 MessagePort，覆盖；web/mobile 远控 relay 在 main 侧用
 * `MessagePortProtocol` 只搬运 `Uint8Array` RPC 帧，控制帧不会穿越 relay——该形态下
 * secret 投递**未实现**，客户端 `ticket` 保持 undefined、兑换直接拒绝（fail-closed），
 * 不得宣称 web/mobile 已覆盖票据兑换。
 */

/** 控制帧标记。`packages/desktop/src/host/capabilityTicketChannel.ts` 必须与之逐字一致。 */
export const CAPABILITY_TICKET_CHANNEL_KEY = "__zcodeCapabilityTicketChannel";
export const CAPABILITY_TICKET_CHANNEL_VERSION = "capability-ticket-v1";

/** 只要求 postMessage 的最小端口；宿主/客户端两端都满足。 */
export interface CapabilityTicketChannelPostPort {
  postMessage(message: unknown): void;
}

/** DOM/Node MessagePort 的接收面（客户端使用）。 */
export interface CapabilityTicketChannelPort extends CapabilityTicketChannelPostPort {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  /** DOM MessagePort 在 addEventListener 后需要 start；MessagePortProtocol 会调用。 */
  start?(): void;
}

const channelVersionSchema = z.literal(CAPABILITY_TICKET_CHANNEL_VERSION);

const deliveryFrameSchema = z.object({
  [CAPABILITY_TICKET_CHANNEL_KEY]: channelVersionSchema,
  kind: z.literal("delivery"),
  ticketId: z.string().min(1),
  ticketSecret: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  revocationEpoch: z.number().int().nonnegative(),
  binding: capabilityTicketBindingSchema,
  scope: capabilityTicketScopeSchema.optional(),
});

export interface CapabilityTicketDeliveryFrame {
  ticketId: string;
  ticketSecret: string;
  expiresAt: number;
  revocationEpoch: number;
  binding: CapabilityTicketBinding;
  scope?: CapabilityTicketScope;
}

export interface CapabilityTicketRedeemFrame {
  requestId: string;
  request: CapabilityTicketRedeemRequest;
}

export interface CapabilityTicketRedeemResultFrame {
  requestId: string;
  result: CapabilityTicketRedeemResult;
}

const redeemFrameSchema = z.object({
  [CAPABILITY_TICKET_CHANNEL_KEY]: channelVersionSchema,
  kind: z.literal("redeem"),
  requestId: z.string().min(1),
  request: capabilityTicketRedeemRequestSchema,
});

const injectionHandleSchema = z.object({
  ticketId: z.string().min(1),
  binding: capabilityTicketBindingSchema,
  scope: capabilityTicketScopeSchema,
  expiresAt: z.number().int().nonnegative(),
  revocationEpoch: z.number().int().nonnegative(),
  requiresHostConfirmation: z.boolean(),
});

const redeemResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    ticketId: z.string().min(1),
    injection: injectionHandleSchema,
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(CAPABILITY_TICKET_FAILURE_CODES),
    message: z.string(),
  }),
]);

const redeemResultFrameSchema = z.object({
  [CAPABILITY_TICKET_CHANNEL_KEY]: channelVersionSchema,
  kind: z.literal("redeem-result"),
  requestId: z.string().min(1),
  result: redeemResultSchema,
});

export type CapabilityTicketChannelFrame =
  | { kind: "delivery"; delivery: CapabilityTicketDeliveryFrame }
  | { kind: "redeem"; requestId: string; request: CapabilityTicketRedeemRequest }
  | { kind: "redeem-result"; requestId: string; result: CapabilityTicketRedeemResult };

function readChannelRecord(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  // Uint8Array 是 RPC 字节流，永远不是本通道帧；先按精确版本标记识别。
  if (record[CAPABILITY_TICKET_CHANNEL_KEY] !== CAPABILITY_TICKET_CHANNEL_VERSION) {
    return undefined;
  }
  return record;
}

/**
 * 解析一个控制帧。返回 undefined 表示“不是本通道帧”（RPC 帧/flow-control/未知对象），
 * 调用方应直接忽略。标记命中但结构非法时也返回 undefined；等待方会以超时 fail-closed。
 */
export function parseCapabilityTicketChannelFrame(
  data: unknown,
): CapabilityTicketChannelFrame | undefined {
  const record = readChannelRecord(data);
  if (!record) return undefined;
  switch (record["kind"]) {
    case "delivery": {
      const parsed = deliveryFrameSchema.safeParse(data);
      if (!parsed.success) return undefined;
      return {
        kind: "delivery",
        delivery: {
          ticketId: parsed.data.ticketId,
          ticketSecret: parsed.data.ticketSecret,
          expiresAt: parsed.data.expiresAt,
          revocationEpoch: parsed.data.revocationEpoch,
          binding: parsed.data.binding,
          ...(parsed.data.scope !== undefined ? { scope: parsed.data.scope } : {}),
        },
      };
    }
    case "redeem": {
      const parsed = redeemFrameSchema.safeParse(data);
      if (!parsed.success) return undefined;
      return { kind: "redeem", requestId: parsed.data.requestId, request: parsed.data.request };
    }
    case "redeem-result": {
      const parsed = redeemResultFrameSchema.safeParse(data);
      if (!parsed.success) return undefined;
      return {
        kind: "redeem-result",
        requestId: parsed.data.requestId,
        result: parsed.data.result,
      };
    }
    default:
      return undefined;
  }
}

/** 宿主 → 客户端：投递 secret。只允许在 attachment port 上调用。 */
export function postCapabilityTicketDeliveryFrame(
  port: CapabilityTicketChannelPostPort,
  delivery: CapabilityTicketDeliveryFrame,
): void {
  port.postMessage({
    [CAPABILITY_TICKET_CHANNEL_KEY]: CAPABILITY_TICKET_CHANNEL_VERSION,
    kind: "delivery",
    ...delivery,
  });
}

/** 宿主 → 客户端：兑换结果。结构里没有 secret。 */
export function postCapabilityTicketRedeemResultFrame(
  port: CapabilityTicketChannelPostPort,
  requestId: string,
  result: CapabilityTicketRedeemResult,
): void {
  port.postMessage({
    [CAPABILITY_TICKET_CHANNEL_KEY]: CAPABILITY_TICKET_CHANNEL_VERSION,
    kind: "redeem-result",
    requestId,
    result,
  });
}

/** 通道失败统一用 shared 的失败码，调用方不得把 transport 错误降级成“无票据继续”。 */
export class CapabilityTicketChannelError extends Error {
  readonly code: CapabilityTicketFailureCode;

  constructor(code: CapabilityTicketFailureCode, message: string) {
    super(message);
    this.name = "CapabilityTicketChannelError";
    this.code = code;
  }
}

export interface CapabilityTicketChannelConnection {
  /** 当前票据客户端；首次 delivery 前为 undefined，角色变更重新投递时替换旧客户端。 */
  readonly ticket: CapabilityTicketClient | undefined;
  /** 协议信封公开字段（只含 ticketId）；未收到 delivery 时 undefined。 */
  protocolFields(): { capabilityTicketId: string } | undefined;
  /** 首次 delivery 的 Promise；超时/释放即 reject（fail-closed）。 */
  ready(): Promise<CapabilityTicketClient>;
  /** 每次 delivery（含角色变更重签）都通知；返回的句柄用于退订。 */
  onDidDeliver(listener: (client: CapabilityTicketClient) => void): { dispose(): void };
  /** DOM MessagePort 需要显式 start；与 MessagePortProtocol 共用同一端口时不必重复调用。 */
  start(): void;
  dispose(): void;
}

export interface CreateCapabilityTicketChannelConnectionOptions {
  port: CapabilityTicketChannelPort;
  /** 首次 delivery 的等待上限；宿主在 attach 时同步投递，缺失即接线错误。 */
  deliveryTimeoutMs?: number;
  /** 单次兑换的响应上限；超时按 `ticket.broker_unavailable` 拒绝。 */
  redeemTimeoutMs?: number;
}

interface PendingRedeem {
  resolve: (result: CapabilityTicketRedeemResult) => void;
  reject: (error: CapabilityTicketChannelError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createCapabilityTicketChannelConnection(
  options: CreateCapabilityTicketChannelConnectionOptions,
): CapabilityTicketChannelConnection {
  const { port } = options;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? 10_000;
  const redeemTimeoutMs = options.redeemTimeoutMs ?? 5_000;

  let disposed = false;
  let ticket: CapabilityTicketClient | undefined;
  let readyPromise: Promise<CapabilityTicketClient> | undefined;
  let readyResolve: ((client: CapabilityTicketClient) => void) | undefined;
  let readyReject: ((error: CapabilityTicketChannelError) => void) | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const deliveryListeners = new Set<(client: CapabilityTicketClient) => void>();
  const pendingRedeems = new Map<string, PendingRedeem>();

  function rejectReady(error: CapabilityTicketChannelError): void {
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer);
      readyTimer = undefined;
    }
    const reject = readyReject;
    readyResolve = undefined;
    readyReject = undefined;
    // 不能永久缓存 rejected Promise：超时后迟到的 delivery（慢 attach/排队/重投递）仍必须
    // 能被后续 ready() 观察到，否则调用方会永久把该 attachment 当成无票据。
    readyPromise = undefined;
    reject?.(error);
  }

  const transport: CapabilityTicketRedeemTransport = {
    redeem(request) {
      if (disposed || ticket === undefined) {
        return Promise.reject(
          new CapabilityTicketChannelError(
            "ticket.broker_unavailable",
            "capability ticket channel is not ready",
          ),
        );
      }
      // requestId 只是通道内的关联键；nonce 由调用方提供并进入 broker 重放校验。
      const requestId = createUuid();
      return new Promise<CapabilityTicketRedeemResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRedeems.delete(requestId);
          reject(
            new CapabilityTicketChannelError(
              "ticket.broker_unavailable",
              "capability ticket redeem timed out",
            ),
          );
        }, redeemTimeoutMs);
        pendingRedeems.set(requestId, { resolve, reject, timer });
        try {
          port.postMessage({
            [CAPABILITY_TICKET_CHANNEL_KEY]: CAPABILITY_TICKET_CHANNEL_VERSION,
            kind: "redeem",
            requestId,
            request,
          });
        } catch {
          clearTimeout(timer);
          pendingRedeems.delete(requestId);
          reject(
            new CapabilityTicketChannelError(
              "ticket.broker_unavailable",
              "capability ticket redeem channel post failed",
            ),
          );
        }
      });
    },
  };

  function applyDelivery(delivery: CapabilityTicketDeliveryFrame): void {
    if (disposed) return;
    // 角色变更会重新签发并重投同一 port：先释放旧 secret，再换新客户端。
    const previous = ticket;
    const bundle: CapabilityTicketSecretBundle = {
      ticketId: delivery.ticketId,
      ticketSecret: delivery.ticketSecret,
      binding: delivery.binding,
      expiresAt: delivery.expiresAt,
      revocationEpoch: delivery.revocationEpoch,
      ...(delivery.scope !== undefined ? { scope: delivery.scope } : {}),
    };
    ticket = createCapabilityTicketClient({ bundle, transport });
    previous?.dispose();
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer);
      readyTimer = undefined;
    }
    const resolve = readyResolve;
    readyResolve = undefined;
    readyReject = undefined;
    const current = ticket;
    resolve?.(current);
    // 每次都丢弃缓存的 ready Promise：角色变更会替换客户端，后续 ready() 必须拿到当前
    // ticket，而不是首次投递时已 dispose 的旧客户端。
    readyPromise = undefined;
    for (const listener of deliveryListeners) listener(current);
  }

  function onMessage(event: { data: unknown }): void {
    if (disposed) return;
    const frame = parseCapabilityTicketChannelFrame(event.data);
    if (!frame) return;
    if (frame.kind === "delivery") {
      applyDelivery(frame.delivery);
      return;
    }
    if (frame.kind === "redeem-result") {
      const pending = pendingRedeems.get(frame.requestId);
      if (!pending) return;
      pendingRedeems.delete(frame.requestId);
      clearTimeout(pending.timer);
      pending.resolve(frame.result);
    }
  }

  port.addEventListener("message", onMessage);

  return {
    get ticket() {
      return ticket;
    },
    protocolFields() {
      return ticket?.protocolFields();
    },
    ready() {
      if (readyPromise !== undefined) return readyPromise;
      readyPromise = new Promise<CapabilityTicketClient>((resolve, reject) => {
        if (disposed) {
          reject(
            new CapabilityTicketChannelError(
              "ticket.broker_unavailable",
              "capability ticket channel disposed",
            ),
          );
          return;
        }
        if (ticket !== undefined) {
          resolve(ticket);
          return;
        }
        readyResolve = resolve;
        readyReject = reject;
        readyTimer = setTimeout(() => {
          readyTimer = undefined;
          rejectReady(
            new CapabilityTicketChannelError(
              "ticket.broker_unavailable",
              "capability ticket delivery timed out",
            ),
          );
        }, deliveryTimeoutMs);
      });
      return readyPromise;
    },
    onDidDeliver(listener) {
      deliveryListeners.add(listener);
      return { dispose: () => deliveryListeners.delete(listener) };
    },
    start() {
      port.start?.();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      port.removeEventListener("message", onMessage);
      rejectReady(
        new CapabilityTicketChannelError(
          "ticket.broker_unavailable",
          "capability ticket channel disposed",
        ),
      );
      for (const [requestId, pending] of pendingRedeems) {
        clearTimeout(pending.timer);
        pending.reject(
          new CapabilityTicketChannelError(
            "ticket.broker_unavailable",
            "capability ticket channel disposed",
          ),
        );
        pendingRedeems.delete(requestId);
      }
      deliveryListeners.clear();
      ticket?.dispose();
      ticket = undefined;
    },
  };
}
