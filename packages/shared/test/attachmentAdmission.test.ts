import { describe, expect, it } from "vitest";
import {
  TRUSTED_V4_CONNECTION_FIELD,
  readHostAttachmentAdmissionFacts,
} from "../src/zcode-protocol-v4/attachment-admission.js";
import { helloMessageSchema } from "../src/zcode-protocol-v4/transport.js";
import { V4_WIRE_PROTOCOL_VERSION } from "../src/zcode-protocol-v4/core.js";

function hello(extra: Record<string, unknown> = {}) {
  const { capabilities, ...rest } = extra as {
    capabilities?: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    kind: "hello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: "conn-1",
    clientMode: "desktop-continuous",
    deliveryProfile: "continuous",
    serverTime: 1,
    capabilities: {
      nativeDialogs: true,
      localTerminal: true,
      binaryFrames: false,
      compression: "none",
      ...capabilities,
    },
    auth: {},
    ...rest,
  };
}

describe("P6 host attachment admission facts", () => {
  it("carrier/attachment 缺席 = 无 attachment 语义（本地 CLI 保持现状）", () => {
    expect(readHostAttachmentAdmissionFacts({ commandId: "c1" })).toBeUndefined();
    expect(readHostAttachmentAdmissionFacts(null)).toBeUndefined();
    expect(readHostAttachmentAdmissionFacts({ [TRUSTED_V4_CONNECTION_FIELD]: {} })).toBeUndefined();
  });

  it("读取 Host 写入 carrier 的远端附件事实（角色/deviceScopeKey）", () => {
    const facts = readHostAttachmentAdmissionFacts({
      [TRUSTED_V4_CONNECTION_FIELD]: {
        connectionId: "conn-1",
        clientMode: "web-remote-replayable",
        attachment: {
          source: "remote",
          attachment: {
            attachmentId: "mobile-1",
            role: "read_mostly",
            deviceScopeKey: "ws\0web",
          },
        },
      },
    });
    expect(facts).toEqual({
      source: "remote",
      attachment: { attachmentId: "mobile-1", role: "read_mostly", deviceScopeKey: "ws\0web" },
    });
  });

  it("角色缺失保留为吊销信号（不补默认值）", () => {
    const facts = readHostAttachmentAdmissionFacts({
      [TRUSTED_V4_CONNECTION_FIELD]: {
        attachment: { source: "remote", attachment: { attachmentId: "revoked-1" } },
      },
    });
    expect(facts?.attachment).toEqual({ attachmentId: "revoked-1" });
    expect(facts?.attachment?.role).toBeUndefined();
  });

  it("attachment 在场但解析失败：fail-closed 按 remote，不落到 host", () => {
    const facts = readHostAttachmentAdmissionFacts({
      [TRUSTED_V4_CONNECTION_FIELD]: { attachment: { source: "bogus", attachment: {} } },
    });
    expect(facts).toEqual({ source: "remote" });
  });

  it("只认可信 carrier；顶层伪造的同名字段不被读取", () => {
    expect(
      readHostAttachmentAdmissionFacts({
        attachment: { source: "local-host", attachment: { attachmentId: "fake", role: "host" } },
      }),
    ).toBeUndefined();
  });

  it("远端可重放连接缺 attachment 记录：read_mostly fail-closed（D4）", () => {
    expect(
      readHostAttachmentAdmissionFacts({
        [TRUSTED_V4_CONNECTION_FIELD]: {
          connectionId: "conn-1",
          clientMode: "web-remote-replayable",
        },
      }),
    ).toEqual({ source: "remote" });
  });

  it("本地连续连接缺 attachment 记录：保持 host 现状", () => {
    expect(
      readHostAttachmentAdmissionFacts({
        [TRUSTED_V4_CONNECTION_FIELD]: {
          connectionId: "conn-1",
          clientMode: "desktop-continuous",
        },
      }),
    ).toBeUndefined();
  });
});

describe("P6 hello attachment 投影", () => {
  it("hello 在非 strict 的 capabilities 扩展位接受 additive-optional 投影", () => {
    const parsed = helloMessageSchema.parse(
      hello({
        capabilities: {
          attachment: {
            attachmentId: "mobile-1",
            role: "read_mostly",
            deviceScopeKey: "ws\0web",
            deviceKind: "web",
          },
        },
      }),
    );
    expect(parsed.capabilities.attachment?.role).toBe("read_mostly");
  });

  it("缺失 attachment 的 hello 保持合法（旧宿主字节兼容）", () => {
    expect(helloMessageSchema.parse(hello()).capabilities.attachment).toBeUndefined();
  });

  it("非法角色不被 hello 接受", () => {
    const result = helloMessageSchema.safeParse(
      hello({ capabilities: { attachment: { attachmentId: "x", role: "root" } } }),
    );
    expect(result.success).toBe(false);
  });

  it("旧客户端 hello 解析也接受未知 capability 键（不因投影断连）", () => {
    // 旧客户端 schema 的 capabilities 是非 strict：未知键被静默丢弃。
    const oldCapabilities = {
      nativeDialogs: true,
      localTerminal: true,
      binaryFrames: false,
      compression: "none",
    };
    const wire = hello({
      capabilities: {
        ...oldCapabilities,
        attachment: { attachmentId: "mobile-1", role: "read_mostly" },
      },
    });
    const parsed = helloMessageSchema.parse(wire);
    expect(parsed.capabilities.attachment?.attachmentId).toBe("mobile-1");
  });
});
