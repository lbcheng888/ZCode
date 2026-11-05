import { describe, expect, it, vi } from "vitest";
import { createCapabilityTicketClient } from "../src/capabilityTicketClient.js";
import type {
  CapabilityTicketBinding,
  CapabilityTicketRedeemRequest,
  CapabilityTicketRedeemResult,
} from "@zcode/shared";

const BINDING: CapabilityTicketBinding = {
  workspaceIdentity: "remote:ssh:dev:/work/demo",
  attachmentId: "mobile-1",
  surfaceKind: "web",
  subject: { kind: "session", id: "session-1" },
};

describe("capability ticket client", () => {
  it("协议字段只有公开 ticketId，零 secret 字节", () => {
    const transport = { redeem: vi.fn() };
    const client = createCapabilityTicketClient({
      bundle: {
        ticketId: "ticket-1",
        ticketSecret: "secret-1",
        binding: BINDING,
        expiresAt: 2_000,
        revocationEpoch: 0,
      },
      transport,
    });
    const fields = client.protocolFields();
    expect(fields).toEqual({ capabilityTicketId: "ticket-1" });
    expect(JSON.stringify(fields)).not.toContain("secret-1");
    expect(client.ticketId).toBe("ticket-1");
    expect(client.expiresAt).toBe(2_000);
  });

  it("兑换把 ticketId+secret+binding+nonce 只送进 broker 受控 transport", async () => {
    const result: CapabilityTicketRedeemResult = {
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
    const redeem = vi.fn((_request: CapabilityTicketRedeemRequest) => result);
    const client = createCapabilityTicketClient({
      bundle: {
        ticketId: "ticket-1",
        ticketSecret: "secret-1",
        binding: BINDING,
        expiresAt: 2_000,
        revocationEpoch: 0,
      },
      transport: { redeem },
    });

    const actual = await client.redeem({ toolName: "Read" }, "nonce-1", 1);
    expect(redeem).toHaveBeenCalledOnce();
    expect(redeem.mock.calls[0][0]).toEqual({
      ticketId: "ticket-1",
      ticketSecret: "secret-1",
      binding: BINDING,
      action: { toolName: "Read" },
      nonce: "nonce-1",
      seq: 1,
      revocationEpoch: 0,
    });
    expect(actual).toBe(result);
  });

  it("revocationEpoch 恒由 bundle 携带，调用方不能省略；未提供 seq 时不伪造 seq", async () => {
    const redeem = vi.fn((_request: CapabilityTicketRedeemRequest) => ({
      ok: false,
      code: "ticket.unknown" as const,
      message: "ticket.unknown",
    }));
    const client = createCapabilityTicketClient({
      bundle: {
        ticketId: "ticket-1",
        ticketSecret: "secret-1",
        binding: BINDING,
        expiresAt: 2_000,
        revocationEpoch: 3,
      },
      transport: { redeem },
    });
    await client.redeem({ toolName: "Grep" }, "nonce-1");
    expect(redeem.mock.calls[0][0]).not.toHaveProperty("seq");
    expect(redeem.mock.calls[0][0]).toMatchObject({ revocationEpoch: 3 });
  });

  it("dispose 释放本地 secret 副本；之后兑换抛错而不是降级", async () => {
    const transport = { redeem: vi.fn() };
    const client = createCapabilityTicketClient({
      bundle: {
        ticketId: "ticket-1",
        ticketSecret: "secret-1",
        binding: BINDING,
        expiresAt: 2_000,
        revocationEpoch: 0,
      },
      transport,
    });
    client.dispose();
    await expect(client.redeem({ toolName: "Read" }, "n1")).rejects.toThrow(
      "Capability ticket client disposed",
    );
    expect(transport.redeem).not.toHaveBeenCalled();
  });
});
