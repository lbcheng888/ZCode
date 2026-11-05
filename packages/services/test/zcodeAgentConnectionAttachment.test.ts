import { describe, expect, it, vi } from "vitest";
import {
  V4_WIRE_PROTOCOL_VERSION,
  type HostAttachmentAdmissionFacts,
} from "@zcode/shared/zcode-protocol-v4";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
} from "../src/zcode-agent/zcodeAgentConnectionScope.js";

function helloMessage() {
  return {
    kind: "hello" as const,
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: "conn-1",
    clientMode: "web-remote-replayable" as const,
    deliveryProfile: "replayable" as const,
    serverTime: Date.now(),
    capabilities: {
      nativeDialogs: false,
      localTerminal: false,
      binaryFrames: false,
      compression: "none" as const,
    },
    auth: {},
  };
}

function clientHello() {
  return {
    kind: "clientHello" as const,
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    clientId: "client-1",
    appVersion: "test",
  };
}

describe("P6 attachment 连接元数据（services facade）", () => {
  it("hello 投影附件角色，但命令入参不能伪造事实", async () => {
    const base = {
      helloConversationV4: vi.fn(async () => helloMessage()),
      initializeConversationV4: vi.fn(async () => undefined),
      sendConversationCommandV4: vi.fn(async (params: unknown) => params),
    };
    const attachment: HostAttachmentAdmissionFacts = {
      source: "remote",
      attachment: { attachmentId: "mobile-1", role: "read_mostly", deviceKind: "web" },
    };
    const scope = createZCodeAgentConnectionScope(base as never, {
      connectionId: "conn-1",
      clientMode: "web-remote-replayable",
      attachment,
    });

    const hello = await scope.service.helloConversationV4();
    // 投影在 capabilities 扩展位：旧客户端（非 strict capabilities）会静默丢弃。
    expect(hello.capabilities.attachment).toEqual({
      attachmentId: "mobile-1",
      role: "read_mostly",
      deviceKind: "web",
    });

    await scope.service.initializeConversationV4(clientHello() as never);
    const forged = {
      attachment: { source: "local-host", attachment: { attachmentId: "fake", role: "host" } },
      envelope: { commandId: "c1", clientId: "client-1" },
    };
    await scope.service.sendConversationCommandV4(forged as never);

    const forwarded = base.sendConversationCommandV4.mock.calls[0]?.[0];
    // 调用方传的同名键被清掉；可信 carrier 里是 Host 写入的事实。
    expect(forwarded).not.toHaveProperty("attachment");
    expect(readTrustedZCodeAgentV4Connection(forwarded)?.attachment).toEqual(attachment);
  });

  it("角色吊销（缺 role）时 hello 不投影，carrier 仍保留吊销事实", async () => {
    const base = {
      helloConversationV4: vi.fn(async () => helloMessage()),
      initializeConversationV4: vi.fn(async () => undefined),
      sendConversationCommandV4: vi.fn(async (params: unknown) => params),
    };
    const attachment: HostAttachmentAdmissionFacts = {
      source: "remote",
      attachment: { attachmentId: "mobile-1", deviceKind: "web" },
    };
    const scope = createZCodeAgentConnectionScope(base as never, {
      connectionId: "conn-1",
      clientMode: "web-remote-replayable",
      attachment,
    });

    const hello = await scope.service.helloConversationV4();
    expect(hello.capabilities.attachment).toBeUndefined();

    await scope.service.initializeConversationV4(clientHello() as never);
    await scope.service.sendConversationCommandV4({
      envelope: { commandId: "c1", clientId: "client-1" },
    } as never);
    const forwarded = base.sendConversationCommandV4.mock.calls[0]?.[0];
    expect(readTrustedZCodeAgentV4Connection(forwarded)?.attachment).toEqual(attachment);
  });
});
