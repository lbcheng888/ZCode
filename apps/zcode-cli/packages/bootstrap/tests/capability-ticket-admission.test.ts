// P6 能力票据授权域的 CLI 执行侧读取（spec §2.5 C1/C2）。
// 关键约束：只读可信 carrier；结构非法（包括夹带 secret 字段）一律不进入 CLI。
import { describe, expect, it } from "vitest";
import {
  capabilityTicketAuthorizationSchema,
  readDeclaredCapabilityTicketId,
  readHostCapabilityTicketAuthorization,
  V4CapabilityTicketAuthorizationError,
  TRUSTED_V4_CAPABILITY_TICKET_FIELD,
} from "../src/zcode-protocol-v4/capability-ticket-admission.js";

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
});
