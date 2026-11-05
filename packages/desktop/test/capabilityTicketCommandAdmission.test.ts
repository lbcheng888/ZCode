import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityTicketBinding } from "@zcode/shared";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
  CapabilityTicketCommandRejectedError,
  type IZCodeAgentService,
  type ZCodeAgentCapabilityTicketAuthority,
} from "@zcode/services";
import { createCapabilityTicketBroker } from "../src/host/capabilityTicketBroker.js";
import { postCapabilityTicketDelivery } from "../src/host/capabilityTicketChannel.js";
import { createWindowHostAttachmentRegistry } from "../src/host/windowHostAttachmentRegistry.js";

const REMOTE_SCOPE = {
  kind: "remote" as const,
  remoteSessionId: "remote-1",
  workspacePath: "/work/demo",
  workspaceIdentity: "remote:ssh:dev:/work/demo",
};

function createBase() {
  return {
    helloConversationV4: vi.fn(async () => ({
      kind: "hello" as const,
      protocolVersion: 3,
      connectionId: "host-rpc-test",
      clientMode: "desktop-continuous" as const,
      deliveryProfile: "continuous" as const,
      serverTime: 1,
      capabilities: {},
      auth: {},
    })),
    initializeConversationV4: vi.fn(async () => {}),
    sendConversationCommandV4: vi.fn(async (params: { envelope: { commandId: string } }) => ({
      commandId: params.envelope.commandId,
      status: "accepted" as const,
      revisionAtDecision: 1,
    })),
  } as unknown as IZCodeAgentService;
}

function command(envelopeOverrides: Record<string, unknown> = {}) {
  return {
    workspacePath: "/repo",
    envelope: {
      commandId: "cmd-1",
      clientId: "client-1",
      sessionId: "session-1",
      type: "sendText" as const,
      payload: { text: "hello" },
      issuedAt: 1,
      ...envelopeOverrides,
    },
  };
}

describe("capability ticket command admission (real broker + MessagePort)", () => {
  it("有效票据命令：宿主校验后授权域随可信 carrier 下发，secret 零字节", async () => {
    const { port1, port2 } = new MessageChannel();
    let sequence = 0;
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => `ticket-${++sequence}`,
      createSecret: () => `secret-${sequence}`,
    });
    const deliveries: Array<{
      ticketId: string;
      binding: CapabilityTicketBinding;
    }> = [];
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
      capabilityTickets: {
        broker,
        deliverSecret: (attachmentId, delivery, port) => {
          deliveries.push({ ticketId: delivery.ticketId, binding: delivery.binding });
          postCapabilityTicketDelivery(port, delivery);
        },
      },
    });
    registry.attach({
      requestId: "attach-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: REMOTE_SCOPE,
      port: port2,
    });
    // 真实 MessagePort 上收到一次 secret delivery（客户端侧握有 secret；宿主不把它下发）。
    const delivery = await new Promise<{ ticketSecret: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("delivery timeout")), 1_000);
      port1.on("message", (event: unknown) => {
        const record = event as { kind?: string; ticketSecret?: string };
        if (record.kind !== "delivery") return;
        clearTimeout(timer);
        resolve(record as { ticketSecret: string });
      });
    });
    const delivered = deliveries[0]!;
    expect(delivery.ticketSecret).toBe("secret-1");

    const authority: ZCodeAgentCapabilityTicketAuthority = {
      admit: ({ ticketId }) => {
        const role = registry.getRole("remote-1");
        return broker.admit({
          ticketId,
          binding: delivered.binding,
          ...(role !== undefined ? { role } : {}),
        });
      },
    };
    const base = createBase();
    const scope = createZCodeAgentConnectionScope(
      base,
      {
        connectionId: "host-rpc-test",
        clientMode: "desktop-continuous",
        attachment: {
          source: "remote",
          attachment: { attachmentId: "remote-1", role: "host" },
        },
      },
      { capabilityTicket: authority },
    );
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "client-1",
      appVersion: "4.0.0",
    });

    await expect(
      scope.service.sendConversationCommandV4(
        command({ capabilityTicketId: delivered.ticketId }),
      ),
    ).resolves.toMatchObject({ commandId: "cmd-1", status: "accepted" });

    const forwarded = vi.mocked(base.sendConversationCommandV4).mock.calls.at(-1)?.[0];
    const carrier = readTrustedZCodeAgentV4Connection(forwarded);
    expect(carrier?.capabilityTicket).toMatchObject({
      ticketId: delivered.ticketId,
      expiresAt: 1_000 + 15 * 60_000,
      revocationEpoch: 0,
    });
    // 授权域只有公开事实；secret 绝不出现在 CLI 入参/可信 carrier。
    expect(JSON.stringify(forwarded)).not.toContain("secret-1");

    registry.detach("remote-1");
    port1.close();
    port2.close();
    await scope.dispose();
  });

  it("过期/吊销票据命令在宿主入口拒绝（typed code，fail-closed）", async () => {
    const binding: CapabilityTicketBinding = {
      workspaceIdentity: REMOTE_SCOPE.workspaceIdentity,
      attachmentId: "remote-1",
      surfaceKind: "desktop",
      subject: { kind: "session", id: REMOTE_SCOPE.remoteSessionId },
    };

    // 过期：admission 拒绝，且命令不会被转发到 CLI。
    let current = 1_000;
    const expiringBroker = createCapabilityTicketBroker({
      now: () => current,
      createTicketId: () => "ticket-exp",
      createSecret: () => "secret-exp",
    });
    const expiring = expiringBroker.issue({
      binding,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });
    current = expiring.ticket.expiresAt;
    const base = createBase();
    const expiringScope = createZCodeAgentConnectionScope(
      base,
      { connectionId: "host-rpc-test", clientMode: "desktop-continuous" },
      {
        capabilityTicket: {
          admit: ({ ticketId }) => expiringBroker.admit({ ticketId, binding, role: "read_mostly" }),
        },
      },
    );
    await expiringScope.service.helloConversationV4();
    await expiringScope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "client-1",
      appVersion: "4.0.0",
    });
    await expect(
      expiringScope.service.sendConversationCommandV4(
        command({ capabilityTicketId: expiring.ticket.ticketId }),
      ),
    ).rejects.toMatchObject({ code: "ticket.expired" });
    expect(base.sendConversationCommandV4).not.toHaveBeenCalled();
    await expiringScope.dispose();

    // 吊销：下一命令立即拒绝，错误类型带 typed code。
    const revokedBroker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-rev",
      createSecret: () => "secret-rev",
    });
    const revocable = revokedBroker.issue({
      binding,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });
    revokedBroker.revoke(revocable.ticket.ticketId);
    const revokedBase = createBase();
    const revokedScope = createZCodeAgentConnectionScope(
      revokedBase,
      { connectionId: "host-rpc-test", clientMode: "desktop-continuous" },
      {
        capabilityTicket: {
          admit: ({ ticketId }) => revokedBroker.admit({ ticketId, binding, role: "read_mostly" }),
        },
      },
    );
    await revokedScope.service.helloConversationV4();
    await revokedScope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "client-1",
      appVersion: "4.0.0",
    });
    await expect(
      revokedScope.service.sendConversationCommandV4(
        command({ capabilityTicketId: revocable.ticket.ticketId }),
      ),
    ).rejects.toBeInstanceOf(CapabilityTicketCommandRejectedError);
    expect(revokedBase.sendConversationCommandV4).not.toHaveBeenCalled();
    await revokedScope.dispose();
  });

  it("无 ticketId 保持字节兼容；伪造顶层 capabilityTicket 被清理；无校验端口时拒绝", async () => {
    const base = createBase();
    const withoutTickets = createZCodeAgentConnectionScope(base, {
      connectionId: "host-rpc-test",
      clientMode: "desktop-continuous",
    });
    await withoutTickets.service.helloConversationV4();
    await withoutTickets.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "client-1",
      appVersion: "4.0.0",
    });
    await withoutTickets.service.sendConversationCommandV4(command());
    const forwarded = vi.mocked(base.sendConversationCommandV4).mock.calls.at(-1)?.[0];
    expect(readTrustedZCodeAgentV4Connection(forwarded)?.capabilityTicket).toBeUndefined();
    expect(forwarded).not.toHaveProperty("capabilityTicket");

    // 客户端伪造顶层字段：facade 必须丢弃，不能凭它绕过宿主校验。
    await expect(
      withoutTickets.service.sendConversationCommandV4({
        ...command({ capabilityTicketId: "forged-ticket" }),
        capabilityTicket: { ticketId: "forged-ticket", scope: { toolClasses: ["read"] } },
      } as never),
    ).rejects.toMatchObject({ code: "ticket.broker_unavailable" });
    expect(vi.mocked(base.sendConversationCommandV4).mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "capabilityTicket",
    );
    await withoutTickets.dispose();
  });
});
