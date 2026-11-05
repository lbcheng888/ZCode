import { MessageChannel, type MessagePort } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_TICKET_CHANNEL_KEY,
  CAPABILITY_TICKET_CHANNEL_VERSION,
  createCapabilityTicketChannelConnection,
  parseCapabilityTicketChannelFrame,
} from "@zcode/client";
import { projectCapabilityTicketForModelContext } from "@zcode/shared";
import type {
  CapabilityTicketBinding,
  CapabilityTicketRedeemRequest,
  CapabilityTicketRedeemResult,
} from "@zcode/shared";
import { createCapabilityTicketBroker } from "../src/host/capabilityTicketBroker.js";
import {
  createCapabilityTicketRedeemChannel,
  postCapabilityTicketDelivery,
} from "../src/host/capabilityTicketChannel.js";
import { createWindowHostAttachmentRegistry } from "../src/host/windowHostAttachmentRegistry.js";

const REMOTE_SCOPE = {
  kind: "remote" as const,
  remoteSessionId: "remote-1",
  workspacePath: "/work/demo",
  workspaceIdentity: "remote:ssh:dev:/work/demo",
};

function createTicketHarness() {
  const { port1, port2 } = new MessageChannel();
  let sequence = 0;
  const broker = createCapabilityTicketBroker({
    now: () => 1_000,
    createTicketId: () => `ticket-${++sequence}`,
    createSecret: () => `secret-${sequence}`,
  });
  const deliveries: Array<{
    attachmentId: string;
    ticketId: string;
    ticketSecret: string;
    binding: CapabilityTicketBinding;
    revocationEpoch: number;
  }> = [];
  let exposedParams: Record<string, unknown> | undefined;
  const registry = createWindowHostAttachmentRegistry({
    resolveScope: () => ({ services: "services", generation: 1 }),
    expose: (params) => {
      exposedParams = params as unknown as Record<string, unknown>;
      return { dispose: vi.fn() };
    },
    capabilityTickets: {
      broker,
      deliverSecret: (attachmentId, delivery, port) => {
        deliveries.push({
          attachmentId,
          ticketId: delivery.ticketId,
          ticketSecret: delivery.ticketSecret,
          binding: delivery.binding,
          revocationEpoch: delivery.revocationEpoch,
        });
        postCapabilityTicketDelivery(port, delivery);
      },
    },
  });
  return { port1, port2, broker, registry, deliveries, getExposed: () => exposedParams };
}

function redeemDirect(
  portA: MessagePort,
  portB: MessagePort,
  request: CapabilityTicketRedeemRequest,
): Promise<CapabilityTicketRedeemResult> {
  const requestId = `direct-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      portA.off("message", listener);
      reject(new Error("direct redeem timed out"));
    }, 1_000);
    const listener = (event: unknown) => {
      const frame = parseCapabilityTicketChannelFrame(event);
      if (!frame || frame.kind !== "redeem-result" || frame.requestId !== requestId) return;
      clearTimeout(timer);
      portA.off("message", listener);
      resolve(frame.result);
    };
    portA.on("message", listener);
    portB.postMessage({
      [CAPABILITY_TICKET_CHANNEL_KEY]: CAPABILITY_TICKET_CHANNEL_VERSION,
      kind: "redeem",
      requestId,
      request,
    });
  });
}

describe("capability ticket production channel (registry + MessagePort)", () => {
  it("签发→投递→兑换→吊销走真实通道；secret 零字节进入公开面", async () => {
    const harness = createTicketHarness();
    harness.registry.attach({
      requestId: "attach-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: harness.port2,
    });

    const delivery = harness.deliveries[0]!;
    expect(delivery.ticketId).toBe("ticket-1");
    expect(delivery.ticketSecret).toBe("secret-1");
    const exposed = harness.getExposed()!;
    expect(exposed["capabilityTicketId"]).toBe("ticket-1");
    // 公开面（expose 参数 / registry 投影 / 模型上下文投影）都不允许出现 secret。
    expect(JSON.stringify(exposed)).not.toContain("secret-1");
    expect(JSON.stringify(harness.registry.list())).not.toContain("secret-1");
    expect(
      JSON.stringify(projectCapabilityTicketForModelContext(harness.broker.status("ticket-1")!)),
    ).not.toContain("secret-1");
    expect(projectCapabilityTicketForModelContext({ ticketId: "ticket-1" })).toEqual({
      ticketId: "ticket-1",
    });

    const client = createCapabilityTicketChannelConnection({
      port: harness.port1,
      deliveryTimeoutMs: 1_000,
      redeemTimeoutMs: 1_000,
    });
    client.start();
    const ticket = await client.ready();
    expect(ticket.ticketId).toBe("ticket-1");
    expect(JSON.stringify(client.protocolFields())).not.toContain("secret-1");

    const redeemer = createCapabilityTicketRedeemChannel({
      port: harness.port2,
      broker: harness.broker,
      attachmentId: "remote-1",
      authoritativeBinding: delivery.binding,
    });

    const ok = await ticket.redeem({ toolName: "Read" }, "nonce-1", 1);
    expect(ok).toMatchObject({ ok: true, ticketId: "ticket-1" });
    expect(JSON.stringify(ok)).not.toContain("secret-1");

    harness.registry.detach("remote-1");
    const revoked = await ticket.redeem({ toolName: "Read" }, "nonce-2", 2);
    expect(revoked).toMatchObject({ ok: false, code: "ticket.revoked" });

    redeemer.dispose();
    client.dispose();
    harness.port1.close();
    harness.port2.close();
  });

  it("请求 binding 与宿主 attachment 记录不一致：binding_mismatch，secret 正确也不行", async () => {
    const harness = createTicketHarness();
    harness.registry.attach({
      requestId: "attach-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: harness.port2,
    });
    const delivery = harness.deliveries[0]!;
    const redeemer = createCapabilityTicketRedeemChannel({
      port: harness.port2,
      broker: harness.broker,
      attachmentId: "remote-1",
      authoritativeBinding: delivery.binding,
    });

    const result = await redeemDirect(harness.port1, harness.port1, {
      ticketId: delivery.ticketId,
      ticketSecret: delivery.ticketSecret,
      binding: {
        workspaceIdentity: "remote:ssh:dev:/work/demo",
        attachmentId: "other-attachment",
        surfaceKind: "desktop",
        subject: { kind: "session", id: "remote-1" },
      },
      action: { toolName: "Read" },
      nonce: "mismatch-nonce",
      seq: 1,
      revocationEpoch: delivery.revocationEpoch,
    });
    expect(result).toMatchObject({ ok: false, code: "ticket.binding_mismatch" });

    redeemer.dispose();
    harness.registry.detach("remote-1");
    harness.port1.close();
    harness.port2.close();
  });

  it("未配置 capabilityTickets 时不投递、不出现 ticket 字段（现状兼容）", () => {
    const { port1, port2 } = new MessageChannel();
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
    });
    registry.attach({
      requestId: "attach-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: port2,
    });
    expect(expose.mock.calls[0][0]).not.toHaveProperty("capabilityTicketId");
    expect(expose.mock.calls[0][0]).not.toHaveProperty("capabilityTicketBinding");
    expect(registry.list()[0]).not.toHaveProperty("capabilityTicketId");
    registry.dispose();
    port1.close();
    port2.close();
  });
});
