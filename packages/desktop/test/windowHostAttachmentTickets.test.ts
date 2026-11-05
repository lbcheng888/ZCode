import { describe, expect, it, vi } from "vitest";
import { CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE } from "@zcode/shared";
import { createWindowHostAttachmentRegistry } from "../src/host/windowHostAttachmentRegistry.js";
import { createCapabilityTicketBroker } from "../src/host/capabilityTicketBroker.js";
import type { WindowHostCapabilityTicketDelivery } from "../src/host/windowHostAttachmentRegistry.js";

function createPort() {
  let closeListener: (() => void) | null = null;
  return {
    port: {
      once(event: "close", listener: () => void) {
        if (event === "close") {
          closeListener = listener;
        }
      },
    },
    close() {
      closeListener?.();
    },
  };
}

function createTicketHarness(options: { credentialResources?: readonly string[] } = {}) {
  let sequence = 0;
  const broker = createCapabilityTicketBroker({
    now: () => 1_000,
    createTicketId: () => `ticket-${++sequence}`,
    createSecret: () => `secret-${sequence}`,
  });
  const deliveries: Array<{ attachmentId: string; delivery: WindowHostCapabilityTicketDelivery }> =
    [];
  const deliverSecret = (
    attachmentId: string,
    delivery: WindowHostCapabilityTicketDelivery,
  ): void => {
    deliveries.push({ attachmentId, delivery });
  };
  return {
    broker,
    deliveries,
    deliverSecret,
    ...(options.credentialResources !== undefined
      ? { credentialResources: options.credentialResources }
      : {}),
  };
}

const REMOTE_SCOPE = {
  kind: "remote" as const,
  remoteSessionId: "remote-1",
  workspacePath: "/work/demo",
  workspaceIdentity: "remote:ssh:dev:/work/demo",
};

describe("attachment capability tickets", () => {
  it("attachment 建立即签发；expose 参数只有 ticketId，secret 只经受控通道投递", () => {
    const tickets = createTicketHarness();
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
      capabilityTickets: {
        broker: tickets.broker,
        deliverSecret: tickets.deliverSecret,
      },
    });
    registry.attach({
      requestId: "remote-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: createPort().port,
    });

    expect(tickets.deliveries).toHaveLength(1);
    expect(tickets.deliveries[0].attachmentId).toBe("remote-1");
    expect(tickets.deliveries[0].delivery.ticketId).toBe("ticket-1");
    expect(tickets.deliveries[0].delivery.ticketSecret).toBe("secret-1");
    expect(tickets.deliveries[0].delivery.revocationEpoch).toBe(0);
    expect(tickets.deliveries[0].delivery.binding).toEqual({
      workspaceIdentity: "remote:ssh:dev:/work/demo",
      attachmentId: "remote-1",
      surfaceKind: "desktop",
      subject: { kind: "session", id: "remote-1" },
    });

    const exposed = expose.mock.calls[0][0];
    expect(exposed.capabilityTicketId).toBe("ticket-1");
    // expose 参数会进入宿主服务暴露面：绝不允许 secret 字节出现在这里。
    expect(JSON.stringify(exposed)).not.toContain("secret-1");
    expect(registry.list()[0].capabilityTicketId).toBe("ticket-1");
  });

  it("P6 C2：只有宿主声明的 credential 资源写进 host 角色 scope，非 host 不授予", () => {
    const tickets = createTicketHarness({
      credentialResources: [CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE],
    });
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
      capabilityTickets: {
        broker: tickets.broker,
        ...(tickets.credentialResources !== undefined
          ? { credentialResources: tickets.credentialResources }
          : {}),
        deliverSecret: tickets.deliverSecret,
      },
    });
    registry.attach({
      requestId: "remote-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: createPort().port,
    });

    // 签发侧不再伪造 per-mcpKey 清单：host 级官方 MCP resolver 是真实可注入资源。
    expect(tickets.deliveries[0].delivery.scope.resources).toEqual([
      CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE,
    ]);
    expect(tickets.deliveries[0].delivery.scope.toolClasses).toContain("credential");

    // 角色降级后重新签发 read-only scope，不得继承 credential 资源。
    registry.setRole("remote-1", "interactive");
    expect(tickets.deliveries[1].delivery.scope).toEqual({ toolClasses: ["read"] });
  });

  it("未配置 broker 时保持现状：expose/list 不出现 ticket 字段", () => {
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
    });
    registry.attach({
      requestId: "remote-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: createPort().port,
    });
    expect(expose.mock.calls[0][0]).not.toHaveProperty("capabilityTicketId");
    expect(registry.list()[0]).not.toHaveProperty("capabilityTicketId");
  });

  it("detach / port close 即时吊销票据（下一次兑换 revoked）", () => {
    const tickets = createTicketHarness();
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
      capabilityTickets: {
        broker: tickets.broker,
        deliverSecret: tickets.deliverSecret,
      },
    });
    const port = createPort();
    registry.attach({
      requestId: "remote-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: port.port,
    });
    const delivery = tickets.deliveries[0].delivery;

    expect(
      tickets.broker.redeem({
        ticketId: delivery.ticketId,
        ticketSecret: delivery.ticketSecret,
        binding: delivery.binding,
        action: { toolName: "Read" },
        nonce: "before-detach",
        seq: 1,
        revocationEpoch: delivery.revocationEpoch,
      }),
    ).toMatchObject({ ok: true });

    registry.detach("remote-1");
    expect(tickets.broker.status(delivery.ticketId)?.state).toBe("revoked");
    expect(
      tickets.broker.redeem({
        ticketId: delivery.ticketId,
        ticketSecret: delivery.ticketSecret,
        binding: delivery.binding,
        action: { toolName: "Read" },
        nonce: "after-detach",
        seq: 2,
        // 旧 epoch 与新票据快照都不再是“可兑换”的授权，仍必须 deny。
        revocationEpoch: delivery.revocationEpoch,
      }),
    ).toMatchObject({ ok: false, code: "ticket.revoked" });

    // port close 路径同样即时。
    const secondPort = createPort();
    registry.attach({
      requestId: "remote-2",
      attachmentId: "remote-2",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: secondPort.port,
    });
    const second = tickets.deliveries[1].delivery;
    secondPort.close();
    expect(tickets.broker.status(second.ticketId)?.state).toBe("revoked");
    expect(registry.size()).toBe(0);
  });

  it("同 attachmentId 替换：旧票据吊销，新票据签发", () => {
    const tickets = createTicketHarness();
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
      capabilityTickets: {
        broker: tickets.broker,
        deliverSecret: tickets.deliverSecret,
      },
    });
    registry.attach({
      requestId: "remote-old",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: createPort().port,
    });
    const oldTicket = tickets.deliveries[0].delivery;

    registry.attach({
      requestId: "remote-new",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: createPort().port,
    });
    expect(tickets.deliveries).toHaveLength(2);
    expect(tickets.deliveries[1].delivery.ticketId).not.toBe(oldTicket.ticketId);
    expect(tickets.broker.status(oldTicket.ticketId)?.state).toBe("revoked");
    expect(tickets.broker.status(tickets.deliveries[1].delivery.ticketId)?.state).toBe(
      "issued",
    );
  });

  it("角色变更重新签发并按新 scope 绑定，旧票据吊销", () => {
    const tickets = createTicketHarness();
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
      capabilityTickets: {
        broker: tickets.broker,
        deliverSecret: tickets.deliverSecret,
      },
    });
    registry.attach({
      requestId: "remote-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: createPort().port,
    });
    const readTicket = tickets.deliveries[0].delivery;

    registry.setRole("remote-1", "interactive");
    expect(tickets.deliveries).toHaveLength(2);
    const interactiveTicket = tickets.deliveries[1].delivery;
    expect(interactiveTicket.ticketId).not.toBe(readTicket.ticketId);
    expect(interactiveTicket.scope).toEqual({ toolClasses: ["read"] });
    // epoch 按票据自身判定：新票据快照就是它自己的兑换凭证。
    expect(interactiveTicket.revocationEpoch).toBe(tickets.broker.getRevocationEpoch());
    expect(tickets.broker.status(readTicket.ticketId)?.state).toBe("revoked");
    expect(
      tickets.broker.redeem({
        ticketId: interactiveTicket.ticketId,
        ticketSecret: interactiveTicket.ticketSecret,
        binding: interactiveTicket.binding,
        action: { toolName: "Read" },
        nonce: "after-role-change",
        seq: 1,
        revocationEpoch: interactiveTicket.revocationEpoch,
      }),
    ).toMatchObject({ ok: true });
    expect(registry.getRole("remote-1")).toBe("interactive");
    expect(registry.list()[0].capabilityTicketId).toBe(interactiveTicket.ticketId);
  });

  it("deliverSecret 失败时回滚已签发票据：attach 原样抛错，不留孤儿授权", () => {
    const tickets = createTicketHarness();
    let deliveryCount = 0;
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
      capabilityTickets: {
        broker: tickets.broker,
        deliverSecret: (attachmentId, delivery) => {
          deliveryCount += 1;
          tickets.deliveries.push({ attachmentId, delivery });
          throw new Error("controlled channel closed");
        },
      },
    });

    expect(() =>
      registry.attach({
        requestId: "remote-1",
        attachmentId: "remote-1",
        clientMode: "desktop-continuous",
        scope: REMOTE_SCOPE,
        port: createPort().port,
      }),
    ).toThrow("controlled channel closed");

    expect(deliveryCount).toBe(1);
    const delivery = tickets.deliveries[0].delivery;
    // secret 已在 broker 签发过，失败路径必须立即 revoke，不能留在 TTL 内可兑换。
    expect(tickets.broker.status(delivery.ticketId)?.state).toBe("revoked");
    expect(registry.size()).toBe(0);
    expect(registry.getRole("remote-1")).toBeUndefined();
  });

  it("setRole 新票据投递失败时角色与旧票据保持原状（fail-closed）", () => {
    const tickets = createTicketHarness();
    let failNextDelivery = false;
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
      capabilityTickets: {
        broker: tickets.broker,
        deliverSecret: (attachmentId, delivery) => {
          tickets.deliveries.push({ attachmentId, delivery });
          if (failNextDelivery) throw new Error("controlled channel closed");
        },
      },
    });
    registry.attach({
      requestId: "remote-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: createPort().port,
    });
    const oldTicket = tickets.deliveries[0].delivery;

    failNextDelivery = true;
    expect(() => registry.setRole("remote-1", "interactive")).toThrow(
      "controlled channel closed",
    );

    expect(registry.getRole("remote-1")).toBe("host");
    expect(registry.list()[0].capabilityTicketId).toBe(oldTicket.ticketId);
    // 角色切换顺序是先吊销旧票据再签发新票据（新票据快照才能等于当前 epoch）。签发/投递
    // 失败时新票据被回滚、角色保持原值，旧票据已吊销 → 该附件没有可用授权（fail-closed）。
    expect(tickets.broker.status(oldTicket.ticketId)?.state).toBe("revoked");
    expect(
      tickets.broker.redeem({
        ticketId: oldTicket.ticketId,
        ticketSecret: oldTicket.ticketSecret,
        binding: oldTicket.binding,
        action: { toolName: "Read" },
        nonce: "n-old",
        seq: 1,
        revocationEpoch: oldTicket.revocationEpoch,
      }),
    ).toMatchObject({ ok: false, code: "ticket.revoked" });
    // 新票据已签发但未投递成功，必须回滚。
    const failedNewTicket = tickets.deliveries[1].delivery;
    expect(tickets.broker.status(failedNewTicket.ticketId)?.state).toBe("revoked");
  });

  it("local scope 没有执行侧 subject，不签发票据（保持现状字节兼容）", () => {
    const tickets = createTicketHarness();
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
      capabilityTickets: {
        broker: tickets.broker,
        deliverSecret: tickets.deliverSecret,
      },
    });
    registry.attach({
      requestId: "local-1",
      attachmentId: "local-1",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });
    expect(tickets.deliveries).toHaveLength(0);
    expect(expose.mock.calls[0][0]).not.toHaveProperty("capabilityTicketId");
    expect(registry.list()[0]).not.toHaveProperty("capabilityTicketId");
  });

  it("web/mobile relay 形态不签发、不投递 secret，并记录 typed transport-unimplemented", () => {
    const tickets = createTicketHarness();
    const skipped: Array<{ attachmentId: string; clientMode: string; reason: string }> = [];
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
      capabilityTickets: {
        broker: tickets.broker,
        deliverSecret: tickets.deliverSecret,
        onSecretDeliveryUnsupported: (event) => skipped.push(event),
      },
    });
    registry.attach({
      requestId: "web-1",
      attachmentId: "web-1",
      clientMode: "web-remote-replayable",
      scope: REMOTE_SCOPE,
      port: createPort().port,
    });

    // relay 只转发 Uint8Array，控制帧到不了 web/mobile 客户端：不签发、不投递、不宣称成功。
    expect(tickets.deliveries).toHaveLength(0);
    expect(expose.mock.calls[0][0]).not.toHaveProperty("capabilityTicketId");
    expect(expose.mock.calls[0][0]).not.toHaveProperty("capabilityTicketBinding");
    expect(registry.list()[0]).not.toHaveProperty("capabilityTicketId");
    expect(skipped).toEqual([
      {
        attachmentId: "web-1",
        clientMode: "web-remote-replayable",
        reason: "transport-unimplemented",
      },
    ]);
  });

  it("同一 broker 的多个 attachment 吊销互不误伤：B 用签发时 epoch 仍可兑换", () => {
    const tickets = createTicketHarness();
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
      capabilityTickets: {
        broker: tickets.broker,
        deliverSecret: tickets.deliverSecret,
      },
    });
    registry.attach({
      requestId: "attach-a",
      attachmentId: "attachment-a",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: createPort().port,
    });
    registry.attach({
      requestId: "attach-b",
      attachmentId: "attachment-b",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: createPort().port,
    });
    const a = tickets.deliveries[0].delivery;
    const b = tickets.deliveries[1].delivery;
    expect(b.revocationEpoch).toBe(0);

    registry.detach("attachment-a");
    expect(tickets.broker.status(a.ticketId)?.state).toBe("revoked");
    expect(tickets.broker.getRevocationEpoch()).toBeGreaterThan(b.revocationEpoch);

    // B 未被吊销：用签发快照兑换仍然成功（不会被 A 吊销推进的全局 epoch 误伤）。
    expect(
      tickets.broker.redeem({
        ticketId: b.ticketId,
        ticketSecret: b.ticketSecret,
        binding: b.binding,
        action: { toolName: "Read" },
        nonce: "b-1",
        seq: 1,
        revocationEpoch: b.revocationEpoch,
      }),
    ).toMatchObject({ ok: true });

    // 伪造/追新的全局 epoch 不能替票据“续命”：按票据自身快照判定，仍 deny。
    expect(
      tickets.broker.redeem({
        ticketId: b.ticketId,
        ticketSecret: b.ticketSecret,
        binding: b.binding,
        action: { toolName: "Read" },
        nonce: "b-2",
        seq: 1,
        revocationEpoch: tickets.broker.getRevocationEpoch(),
      }),
    ).toMatchObject({ ok: false, code: "ticket.revoked" });
  });
});
