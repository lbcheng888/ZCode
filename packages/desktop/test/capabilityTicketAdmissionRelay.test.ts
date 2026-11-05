import { ChannelClient, ChannelServer, createQueuePair } from "@zcode/rpc";
import { createCapabilityTicketAdmissionPeers } from "@zcode/services/node";
import {
  CAPABILITY_TICKET_ADMISSION_RELAY_CHANNEL,
  CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE,
  type CapabilityTicketBinding,
} from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  createCapabilityTicketBroker,
  type CapabilityTicketBroker,
  type IssuedCapabilityTicket,
} from "../src/host/capabilityTicketBroker.js";
import { createWindowCapabilityTicketAdmissionChannel } from "../src/host/capabilityTicketAdmissionChannel.js";

const BINDING: CapabilityTicketBinding = {
  workspaceIdentity: "remote:ssh:dev:/work/demo",
  attachmentId: "remote-1",
  surfaceKind: "desktop",
  subject: { kind: "session", id: "session-1" },
};

function createRelayPair(options: {
  now: () => number;
  resolveRole: (attachmentId: string) => "host" | undefined;
}) {
  const broker = createCapabilityTicketBroker({
    now: options.now,
    createTicketId: (() => {
      let sequence = 0;
      return () => `ticket-${++sequence}`;
    })(),
    createSecret: (() => {
      let sequence = 0;
      return () => `secret-${++sequence}`;
    })(),
  });
  const admission = createWindowCapabilityTicketAdmissionChannel({
    broker,
    resolveRole: options.resolveRole,
  });
  const [hostProtocol, remoteProtocol] = createQueuePair();
  const hostServer = new ChannelServer(hostProtocol, "desktop-host");
  hostServer.registerChannel(CAPABILITY_TICKET_ADMISSION_RELAY_CHANNEL, admission.channel);
  const remoteClient = new ChannelClient(remoteProtocol);
  const peers = createCapabilityTicketAdmissionPeers();
  const peer = peers.attach(remoteClient.getChannel(CAPABILITY_TICKET_ADMISSION_RELAY_CHANNEL));
  return {
    broker,
    peers,
    dispose() {
      peer.dispose();
      remoteClient.dispose();
      hostServer.dispose();
      admission.dispose();
    },
  };
}

function issueHostTicket(broker: CapabilityTicketBroker): IssuedCapabilityTicket {
  return broker.issue({
    binding: BINDING,
    scope: {
      toolClasses: ["read", "credential"],
      resources: [CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE],
    },
    role: "host",
    mode: "sequential",
  });
}

describe("P6 C2 capability ticket admission relay (Desktop host ↔ remote host)", () => {
  it("relays a real broker admission over the authenticated reverse channel", async () => {
    let now = 1_000;
    const relay = createRelayPair({ now: () => now, resolveRole: () => "host" });
    try {
      const issued = issueHostTicket(relay.broker);
      const ticket = { ticketId: issued.ticket.ticketId, binding: BINDING };

      const result = await relay.peers.authority.admit(ticket);
      expect(result).toMatchObject({
        ok: true,
        authorization: {
          ticketId: issued.ticket.ticketId,
          binding: BINDING,
          scope: {
            resources: [CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE],
          },
          credentialInjection: "host-interaction",
        },
      });
      // 票据启用面：漏带票据的请求必须被拒绝，不能退回无票据旧路径。
      expect(
        await relay.peers.authority.requireTicketForRequests?.(),
      ).toBe(true);

      // 吊销在下一次 admission 立即生效。
      relay.broker.revoke(issued.ticket.ticketId);
      expect(await relay.peers.authority.admit(ticket)).toEqual({
        ok: false,
        code: "ticket.revoked",
      });

      // 过期同理由 broker 现场判定。
      const expiring = issueHostTicket(relay.broker);
      // sequential 票据 TTL 15 分钟；推进超过 TTL 让 broker 现场标记 expired。
      now += 20 * 60_000;
      expect(
        await relay.peers.authority.admit({ ticketId: expiring.ticket.ticketId, binding: BINDING }),
      ).toEqual({ ok: false, code: "ticket.expired" });
    } finally {
      relay.dispose();
    }
  });

  it("rejects unknown tickets and binding mismatches without fabricating an authorization", async () => {
    const relay = createRelayPair({ now: () => 1_000, resolveRole: () => "host" });
    try {
      expect(await relay.peers.authority.admit({ ticketId: "unknown", binding: BINDING })).toEqual({
        ok: false,
        code: "ticket.unknown",
      });
      const issued = issueHostTicket(relay.broker);
      expect(
        await relay.peers.authority.admit({
          ticketId: issued.ticket.ticketId,
          binding: { ...BINDING, attachmentId: "remote-2", subject: { kind: "session", id: "s2" } },
        }),
      ).toEqual({ ok: false, code: "ticket.binding_mismatch" });
    } finally {
      relay.dispose();
    }
  });

  it("fails closed when no Desktop host connection is attached", async () => {
    const broker = createCapabilityTicketBroker({ now: () => 1_000 });
    const issued = issueHostTicket(broker);
    const peers = createCapabilityTicketAdmissionPeers();
    expect(peers.hasPeers()).toBe(false);
    expect(await peers.authority.requireTicketForRequests?.()).toBe(false);
    expect(
      await peers.authority.admit({ ticketId: issued.ticket.ticketId, binding: BINDING }),
    ).toEqual({ ok: false, code: "ticket.broker_unavailable" });
  });

  it("ticketPolicy=false (tickets disabled) keeps the legacy no-ticket path", async () => {
    const admission = createWindowCapabilityTicketAdmissionChannel({
      broker: undefined,
      resolveRole: () => undefined,
    });
    const [hostProtocol, remoteProtocol] = createQueuePair();
    const hostServer = new ChannelServer(hostProtocol, "desktop-host");
    hostServer.registerChannel(CAPABILITY_TICKET_ADMISSION_RELAY_CHANNEL, admission.channel);
    const remoteClient = new ChannelClient(remoteProtocol);
    const peers = createCapabilityTicketAdmissionPeers();
    const peer = peers.attach(
      remoteClient.getChannel(CAPABILITY_TICKET_ADMISSION_RELAY_CHANNEL),
    );
    try {
      expect(await peers.authority.requireTicketForRequests?.()).toBe(false);
      expect(await peers.authority.admit({ ticketId: "any", binding: BINDING })).toEqual({
        ok: false,
        code: "ticket.broker_unavailable",
      });
    } finally {
      peer.dispose();
      remoteClient.dispose();
      hostServer.dispose();
      admission.dispose();
    }
  });

  it("does not declare credential injection when the ticket has no host credential resource", async () => {
    const relay = createRelayPair({ now: () => 1_000, resolveRole: () => "host" });
    try {
      const issued = relay.broker.issue({
        binding: BINDING,
        scope: { toolClasses: ["read", "credential"] },
        role: "host",
        mode: "sequential",
      });
      const result = await relay.peers.authority.admit({
        ticketId: issued.ticket.ticketId,
        binding: BINDING,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.authorization.credentialInjection).toBeUndefined();
      }
    } finally {
      relay.dispose();
    }
  });
});
