import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  createCapabilityTicketChannelConnection,
  parseCapabilityTicketChannelFrame,
  postCapabilityTicketDeliveryFrame,
  postCapabilityTicketRedeemResultFrame,
} from "../src/capabilityTicketChannel.js";
import { createMessagePortServiceConnection } from "../src/messageport.js";
import type { CapabilityTicketBinding, CapabilityTicketRedeemResult } from "@zcode/shared";

const BINDING: CapabilityTicketBinding = {
  workspaceIdentity: "remote:ssh:dev:/work/demo",
  attachmentId: "mobile-1",
  surfaceKind: "web",
  subject: { kind: "session", id: "remote-1" },
};

function delivery(ticketId: string, ticketSecret: string, revocationEpoch = 0) {
  return {
    ticketId,
    ticketSecret,
    expiresAt: 2_000,
    revocationEpoch,
    binding: BINDING,
    scope: { toolClasses: ["read" as const] },
  };
}

const OK_RESULT: CapabilityTicketRedeemResult = {
  ok: true,
  ticketId: "ticket-1",
  injection: {
    ticketId: "ticket-1",
    binding: BINDING,
    scope: { toolClasses: ["read"] },
    expiresAt: 2_000,
    revocationEpoch: 0,
    requiresHostConfirmation: false,
  },
};

describe("capability ticket MessagePort channel", () => {
  it("真实 MessagePort：delivery 后取 secret，协议字段只有 ticketId，兑换走通道", async () => {
    const { port1, port2 } = new MessageChannel();
    const connection = createCapabilityTicketChannelConnection({
      port: port1,
      deliveryTimeoutMs: 1_000,
      redeemTimeoutMs: 1_000,
    });
    connection.start();

    postCapabilityTicketDeliveryFrame(port2, delivery("ticket-1", "secret-1"));
    const ticket = await connection.ready();

    expect(ticket.ticketId).toBe("ticket-1");
    const fields = connection.protocolFields();
    expect(fields).toEqual({ capabilityTicketId: "ticket-1" });
    expect(JSON.stringify(fields)).not.toContain("secret-1");

    // 宿主端：读 redeem 帧并回结果。secret 只在通道内。
    const seenRequests: unknown[] = [];
    port2.on("message", (event: unknown) => {
      const frame = parseCapabilityTicketChannelFrame(event);
      if (!frame || frame.kind !== "redeem") return;
      seenRequests.push(frame.request);
      postCapabilityTicketRedeemResultFrame(port2, frame.requestId, OK_RESULT);
    });

    const result = await ticket.redeem({ toolName: "Read" }, "nonce-1", 1);
    // MessagePort 结构化克隆：内容等值即可，不要求对象同一性。
    expect(result).toStrictEqual(OK_RESULT);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]).toMatchObject({
      ticketId: "ticket-1",
      ticketSecret: "secret-1",
      revocationEpoch: 0,
      nonce: "nonce-1",
      seq: 1,
    });
    // 兑换结果（回给客户端）不含 secret。
    expect(JSON.stringify(result)).not.toContain("secret-1");

    connection.dispose();
    port1.close();
    port2.close();
  });

  it("角色变更重投递：替换客户端并释放旧 secret，旧客户端兑换直接抛错", async () => {
    const { port1, port2 } = new MessageChannel();
    const connection = createCapabilityTicketChannelConnection({
      port: port1,
      deliveryTimeoutMs: 1_000,
      redeemTimeoutMs: 1_000,
    });
    connection.start();
    port2.on("message", () => {});

    postCapabilityTicketDeliveryFrame(port2, delivery("ticket-1", "secret-1"));
    const first = await connection.ready();

    const redelivered = new Promise<void>((resolve) => {
      const subscription = connection.onDidDeliver(() => {
        subscription.dispose();
        resolve();
      });
    });
    postCapabilityTicketDeliveryFrame(port2, delivery("ticket-2", "secret-2", 1));
    await redelivered;
    const second = connection.ticket;
    expect(second?.ticketId).toBe("ticket-2");
    expect(connection.protocolFields()).toEqual({ capabilityTicketId: "ticket-2" });
    await expect(first.redeem({ toolName: "Read" }, "n-old")).rejects.toThrow(
      "Capability ticket client disposed",
    );

    connection.dispose();
    port1.close();
    port2.close();
  });

  it("没有 delivery 时 ready 超时 fail-closed，不降级到无票据路径", async () => {
    const { port1, port2 } = new MessageChannel();
    const connection = createCapabilityTicketChannelConnection({
      port: port1,
      deliveryTimeoutMs: 50,
    });
    connection.start();
    await expect(connection.ready()).rejects.toMatchObject({
      code: "ticket.broker_unavailable",
    });
    expect(connection.ticket).toBeUndefined();
    expect(connection.protocolFields()).toBeUndefined();
    connection.dispose();
    port1.close();
    port2.close();
  });

  it("ready 超时后才收到 delivery：后续 ready() 不再缓存旧拒绝，能拿到迟到票据", async () => {
    const { port1, port2 } = new MessageChannel();
    const connection = createCapabilityTicketChannelConnection({
      port: port1,
      deliveryTimeoutMs: 50,
      redeemTimeoutMs: 1_000,
    });
    connection.start();
    await expect(connection.ready()).rejects.toMatchObject({
      code: "ticket.broker_unavailable",
    });

    // 迟到 delivery（慢 attach/排队/重投递）：不能被缓存的 rejected Promise 永久挡掉。
    postCapabilityTicketDeliveryFrame(port2, delivery("ticket-1", "secret-1"));
    await expect(connection.ready()).resolves.toMatchObject({ ticketId: "ticket-1" });
    expect(connection.ticket?.ticketId).toBe("ticket-1");
    expect(connection.protocolFields()).toEqual({ capabilityTicketId: "ticket-1" });
    connection.dispose();
    port1.close();
    port2.close();
  });

  it("兑换无响应时超时拒绝，不重试/不缓存", async () => {
    const { port1, port2 } = new MessageChannel();
    const connection = createCapabilityTicketChannelConnection({
      port: port1,
      deliveryTimeoutMs: 1_000,
      redeemTimeoutMs: 50,
    });
    connection.start();
    postCapabilityTicketDeliveryFrame(port2, delivery("ticket-1", "secret-1"));
    const ticket = await connection.ready();
    // 宿主端只监听但不回结果，模拟 broker 不可达。
    port2.on("message", () => {});
    await expect(ticket.redeem({ toolName: "Read" }, "n1")).rejects.toMatchObject({
      code: "ticket.broker_unavailable",
    });
    connection.dispose();
    port1.close();
    port2.close();
  });

  it("MessagePort service connection 建立即接收 delivery（监听先于 protocol.start）", async () => {
    const { port1, port2 } = new MessageChannel();
    // delivery 在客户端连接建立前就已入队：验证 createMessagePortServiceConnection 的
    // 监听注册顺序不会丢帧。
    postCapabilityTicketDeliveryFrame(port2, delivery("ticket-1", "secret-1"));
    const connection = createMessagePortServiceConnection(port1 as unknown as MessagePort);
    const ticket = await connection.capabilityTickets.ready();
    expect(ticket.ticketId).toBe("ticket-1");
    expect(connection.capabilityTickets.protocolFields()).toEqual({
      capabilityTicketId: "ticket-1",
    });
    connection.dispose();
    port1.close();
    port2.close();
  });

  it("非本通道消息（RPC 字节流/未知对象）被忽略", async () => {
    const { port1, port2 } = new MessageChannel();
    const connection = createCapabilityTicketChannelConnection({
      port: port1,
      deliveryTimeoutMs: 1_000,
    });
    connection.start();
    port2.postMessage(new Uint8Array([1, 2, 3]));
    port2.postMessage({ hello: "rpc" });
    postCapabilityTicketDeliveryFrame(port2, delivery("ticket-1", "secret-1"));
    const ticket = await connection.ready();
    expect(ticket.ticketId).toBe("ticket-1");
    connection.dispose();
    port1.close();
    port2.close();
  });
});
