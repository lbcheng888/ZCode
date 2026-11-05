// P6 能力票据授权域的 CLI 执行侧读取（spec §2.5 C1/C2）。
// 关键约束：只读可信 carrier；结构非法（包括夹带 secret 字段）一律不进入 CLI。
import { describe, expect, it } from "vitest";
import { runWithCapabilityTicketAuthorization } from "@zcode/core";
import {
  capabilityTicketAuthorizationSchema,
  readDeclaredCapabilityTicketId,
  readHostCapabilityTicketAuthorization,
  V4CapabilityTicketAuthorizationError,
  TRUSTED_V4_CAPABILITY_TICKET_FIELD,
} from "../src/zcode-protocol-v4/capability-ticket-admission.js";
import {
  createOfficialMcpAuthHeadersPort,
  type OfficialMcpAuthRequestContext,
} from "../src/zcode-protocol/official-mcp-auth-port.js";

const AUTHORIZATION = {
  ticketId: "ticket-1",
  binding: {
    workspaceIdentity: "remote:ssh:dev:/work/demo",
    attachmentId: "remote-1",
    surfaceKind: "desktop" as const,
    subject: { kind: "session" as const, id: "remote-1" },
  },
  scope: { toolClasses: ["read" as const] },
  expiresAt: 2_000,
  revocationEpoch: 0,
};

function carrier(value: unknown): Record<string, unknown> {
  return {
    __zcodeTrustedV4Connection: {
      connectionId: "connection-1",
      clientMode: "desktop-continuous",
      [TRUSTED_V4_CAPABILITY_TICKET_FIELD]: value,
    },
  };
}

describe("capability ticket authorization carrier (CLI)", () => {
  it("读取宿主写入的授权域；无 carrier/无字段 = 旧路径", () => {
    expect(readHostCapabilityTicketAuthorization(carrier(AUTHORIZATION))).toEqual(AUTHORIZATION);
    expect(readHostCapabilityTicketAuthorization({})).toBeUndefined();
    expect(
      readHostCapabilityTicketAuthorization({
        __zcodeTrustedV4Connection: { connectionId: "c", clientMode: "desktop-continuous" },
      }),
    ).toBeUndefined();
  });

  it("授权域结构非法（含夹带 secret 字段）⇒ 不进入 CLI", () => {
    expect(
      readHostCapabilityTicketAuthorization(
        carrier({ ...AUTHORIZATION, ticketSecret: "secret-1" }),
      ),
    ).toBeUndefined();
    expect(
      readHostCapabilityTicketAuthorization(
        carrier({ ...AUTHORIZATION, scope: { toolClasses: ["bogus"] } }),
      ),
    ).toBeUndefined();
    // schema 本身也不接受 secret 字段，杜绝“顺手透传”。
    expect(
      capabilityTicketAuthorizationSchema.safeParse({
        ...AUTHORIZATION,
        ticketSecret: "secret-1",
      }).success,
    ).toBe(false);
  });

  it("命令信封声明读取：只有字符串才算声明；接线错误有 typed reasonCode", () => {
    expect(readDeclaredCapabilityTicketId({ capabilityTicketId: "ticket-1" })).toBe("ticket-1");
    expect(readDeclaredCapabilityTicketId({ capabilityTicketId: 42 })).toBeUndefined();
    expect(readDeclaredCapabilityTicketId({})).toBeUndefined();
    expect(new V4CapabilityTicketAuthorizationError("missing").reasonCode).toBe(
      "ticket.authorization_missing",
    );
  });

  it("宿主宣告的 credentialInjection 是合法公开字段；secret 仍被 schema 拒绝", () => {
    const withChannel = capabilityTicketAuthorizationSchema.safeParse({
      ...AUTHORIZATION,
      credentialInjection: "host-interaction",
    });
    expect(withChannel.success).toBe(true);
    expect(
      capabilityTicketAuthorizationSchema.safeParse({
        ...AUTHORIZATION,
        credentialInjection: "self-fabricated",
      }).success,
    ).toBe(false);
  });
});

describe("official MCP auth port ticket context (agent → host)", () => {
  type Ticket = NonNullable<Parameters<typeof runWithCapabilityTicketAuthorization>[0]>;

  function makePort(calls: Array<Record<string, unknown>>) {
    const requestClient = async (_method: string, params: unknown) => {
      calls.push(params as Record<string, unknown>);
      return { ok: true as const, headers: { Authorization: "Bearer jwt" } };
    };
    return createOfficialMcpAuthHeadersPort({
      resolveContext: () =>
        ({ requestClient } as unknown as OfficialMcpAuthRequestContext),
      resolveWorkspace: () => ({
        workspaceKey: "/workspace/app",
        workspacePath: "/workspace/app",
      }),
    });
  }

  it("工具执行 ALS 有票据：请求只附带 ticketId+binding，零 secret 字节", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const port = makePort(calls);
    // 即使 ALS 里被人塞了 secret 字段（模拟错误来源），端口也只投影公开事实。
    const ticket = {
      ...AUTHORIZATION,
      ticketSecret: "secret-sentinel",
    } as unknown as Ticket;
    const result = await runWithCapabilityTicketAuthorization(ticket, () =>
      port.resolveHeaders({
        mcpKey: "image-search",
        pluginId: "zcode-tools@zcode-plugins-official",
        targetOrigin: "https://mcp.zcode.example",
      }),
    );
    expect(result).toEqual({ ok: true, headers: { Authorization: "Bearer jwt" } });
    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    expect(params["capabilityTicketId"]).toBe("ticket-1");
    expect(params["capabilityTicketBinding"]).toEqual(AUTHORIZATION.binding);
    expect(JSON.stringify(params)).not.toContain("secret-sentinel");
    expect(JSON.stringify(params)).not.toContain("ticketSecret");
  });

  it("无票据 ALS：请求不带任何 ticket 字段（旧路径字节兼容）", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const port = makePort(calls);
    await port.resolveHeaders({
      mcpKey: "image-search",
      pluginId: "zcode-tools@zcode-plugins-official",
      targetOrigin: "https://mcp.zcode.example",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("capabilityTicketId");
    expect(calls[0]).not.toHaveProperty("capabilityTicketBinding");
  });
});
