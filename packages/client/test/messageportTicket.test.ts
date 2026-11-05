import { MessageChannel } from "node:worker_threads";
import {
  ChannelServer,
  MessagePortProtocol,
  ProxyChannel,
  type MessagePortLike,
} from "@zcode/rpc";
import { IZCodeAgentService } from "@zcode/services";
import type { CapabilityTicketBinding } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { postCapabilityTicketDeliveryFrame } from "../src/capabilityTicketChannel.js";
import { createMessagePortServiceConnection } from "../src/messageport.js";

const BINDING: CapabilityTicketBinding = {
  workspaceIdentity: "remote:ssh:dev:/work/demo",
  attachmentId: "remote-1",
  surfaceKind: "desktop",
  subject: { kind: "session", id: "remote-1" },
};

function delivery(ticketId: string, ticketSecret: string) {
  return {
    ticketId,
    ticketSecret,
    expiresAt: 2_000,
    revocationEpoch: 0,
    binding: BINDING,
    scope: { toolClasses: ["read" as const] },
  };
}

function command(commandId: string) {
  return {
    workspacePath: "/repo",
    envelope: {
      commandId,
      clientId: "client-1",
      sessionId: "session-1",
      type: "sendText" as const,
      payload: { text: "hello" },
      issuedAt: 1,
    },
  };
}

interface Harness {
  services: ReturnType<typeof createMessagePortServiceConnection>["services"];
  capabilityTickets: ReturnType<
    typeof createMessagePortServiceConnection
  >["capabilityTickets"];
  receivedCommands: Array<{ envelope: Record<string, unknown> }>;
  receivedQueries: Array<Record<string, unknown>>;
  dispose(): void;
}

/**
 * 真实的 MessagePort 连接：另一端跑 ChannelServer + ProxyChannel，宿主侧可投递 ticket。
 * 每个 harness 独占端口，因此能验证 ticket 按连接隔离。
 */
function connect(options: { ticketId?: string; ticketSecret?: string } = {}): Harness {
  const { port1, port2 } = new MessageChannel();
  const receivedCommands: Array<{ envelope: Record<string, unknown> }> = [];
  const receivedQueries: Array<Record<string, unknown>> = [];
  const serverProtocol = new MessagePortProtocol(port2 as unknown as MessagePortLike);
  const server = new ChannelServer(serverProtocol, "host", 1_000, true);
  server.registerChannel(
    IZCodeAgentService.channelName,
    ProxyChannel.fromService({
      sendConversationCommandV4: async (params: { envelope: Record<string, unknown> }) => {
        receivedCommands.push(params);
        return {
          commandId: String(params.envelope["commandId"]),
          status: "accepted",
          revisionAtDecision: 1,
        };
      },
      queryConversationCommandsV4: async (params: Record<string, unknown>) => {
        receivedQueries.push(params);
        return { results: [] };
      },
    }),
  );
  server.ready();

  const connection = createMessagePortServiceConnection(port1 as unknown as MessagePort);
  if (options.ticketId !== undefined && options.ticketSecret !== undefined) {
    postCapabilityTicketDeliveryFrame(
      port2 as unknown as MessagePortLike,
      delivery(options.ticketId, options.ticketSecret),
    );
  }

  return {
    services: connection.services,
    capabilityTickets: connection.capabilityTickets,
    receivedCommands,
    receivedQueries,
    dispose() {
      connection.dispose();
      server.dispose();
      serverProtocol.disconnect();
    },
  };
}

describe("MessagePort service connection ticket-aware command envelope", () => {
  it("base connection 收到 ticket 后把公开 protocolFields 合并进命令信封，secret 不出现", async () => {
    const h = connect({ ticketId: "ticket-base", ticketSecret: "secret-base" });
    try {
      await h.capabilityTickets.ready();
      await h.services.zcodeAgentService.sendConversationCommandV4(command("cmd-base"));

      expect(h.receivedCommands).toHaveLength(1);
      expect(h.receivedCommands[0]).toMatchObject({
        workspacePath: "/repo",
        envelope: {
          commandId: "cmd-base",
          capabilityTicketId: "ticket-base",
        },
      });
      expect(JSON.stringify(h.receivedCommands)).not.toContain("secret-base");
    } finally {
      h.dispose();
    }
  });

  it("remote workspace connection 使用自己的 ticket，不串到别的连接", async () => {
    const base = connect({ ticketId: "ticket-base", ticketSecret: "secret-base" });
    const remote = connect({ ticketId: "ticket-remote", ticketSecret: "secret-remote" });
    try {
      await Promise.all([base.capabilityTickets.ready(), remote.capabilityTickets.ready()]);
      await base.services.zcodeAgentService.sendConversationCommandV4(command("cmd-base"));
      await remote.services.zcodeAgentService.sendConversationCommandV4(command("cmd-remote"));

      expect(base.receivedCommands[0]?.envelope).toMatchObject({
        commandId: "cmd-base",
        capabilityTicketId: "ticket-base",
      });
      expect(remote.receivedCommands[0]?.envelope).toMatchObject({
        commandId: "cmd-remote",
        capabilityTicketId: "ticket-remote",
      });
      expect(JSON.stringify([base.receivedCommands, remote.receivedCommands])).not.toContain(
        "secret-",
      );
    } finally {
      base.dispose();
      remote.dispose();
    }
  });

  it("未收到 delivery 时信封保持原样，其它方法继续透传", async () => {
    const h = connect();
    try {
      const params = command("cmd-no-ticket");
      await h.services.zcodeAgentService.sendConversationCommandV4(params);

      expect(h.receivedCommands).toHaveLength(1);
      expect(h.receivedCommands[0]).toStrictEqual(params);
      expect(h.receivedCommands[0]?.envelope).not.toHaveProperty("capabilityTicketId");

      const query = {
        workspacePath: "/repo",
        commands: [{ sessionId: "session-1", commandId: "cmd-no-ticket" }],
      };
      await h.services.zcodeAgentService.queryConversationCommandsV4(query);
      expect(h.receivedQueries[0]).toStrictEqual(query);
    } finally {
      h.dispose();
    }
  });
});
