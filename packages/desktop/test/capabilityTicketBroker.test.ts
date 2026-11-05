import { describe, expect, it } from "vitest";
import {
  createCapabilityTicketBroker,
  CapabilityTicketIssueError,
} from "../src/host/capabilityTicketBroker.js";
import {
  projectCapabilityTicketForModelContext,
  type CapabilityTicketBinding,
  type CapabilityTicketRedeemRequest,
} from "@zcode/shared";

const BINDING: CapabilityTicketBinding = {
  workspaceIdentity: "remote:ssh:dev:/work/demo",
  attachmentId: "mobile-1",
  deviceId: "device-1",
  surfaceKind: "mobileRemote",
  subject: { kind: "run", id: "run-1" },
};

function createClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function redeemRequest(overrides: Partial<CapabilityTicketRedeemRequest> = {}) {
  return {
    ticketId: "ticket-1",
    ticketSecret: "secret-1",
    binding: BINDING,
    action: { toolName: "Read" },
    nonce: "nonce-1",
    seq: 1,
    revocationEpoch: 0,
    ...overrides,
  } satisfies CapabilityTicketRedeemRequest;
}

describe("capability ticket broker", () => {
  it("签发返回公开票据 + 一次性 secret；status/projection 零 secret", () => {
    const clock = createClock();
    const broker = createCapabilityTicketBroker({
      now: clock.now,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    const issued = broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });

    expect(issued.ticket.ticketId).toBe("ticket-1");
    expect(issued.ticketSecret).toBe("secret-1");
    expect(issued.ticket.state).toBe("issued");

    const status = broker.status("ticket-1");
    expect(status).toBeDefined();
    expect(JSON.stringify(status)).not.toContain("secret-1");
    expect(JSON.stringify(projectCapabilityTicketForModelContext(status!))).not.toContain(
      "secret-1",
    );
    expect(broker.status("missing")).toBeUndefined();
  });

  it("sequential：首次兑换成功，seq 递增可继续，重复 nonce/乱序/倒退 deny", () => {
    const clock = createClock();
    const broker = createCapabilityTicketBroker({
      now: clock.now,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    const issued = broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });

    expect(
      broker.redeem(
        redeemRequest({ ticketId: issued.ticket.ticketId, ticketSecret: issued.ticketSecret }),
      ),
    ).toMatchObject({ ok: true, ticketId: "ticket-1" });

    // 同一 nonce 重放。
    expect(
      broker.redeem(
        redeemRequest({
          ticketId: issued.ticket.ticketId,
          ticketSecret: issued.ticketSecret,
          nonce: "nonce-1",
          seq: 2,
        }),
      ),
    ).toMatchObject({ ok: false, code: "ticket.replayed" });

    // seq 倒退。
    expect(
      broker.redeem(
        redeemRequest({
          ticketId: issued.ticket.ticketId,
          ticketSecret: issued.ticketSecret,
          nonce: "nonce-2",
          seq: 1,
        }),
      ),
    ).toMatchObject({ ok: false, code: "ticket.replayed" });

    // seq 必须携带。
    expect(
      broker.redeem(
        redeemRequest({
          ticketId: issued.ticket.ticketId,
          ticketSecret: issued.ticketSecret,
          nonce: "nonce-3",
          seq: undefined,
        }),
      ),
    ).toMatchObject({ ok: false, code: "ticket.replayed" });

    // 正常递增。
    expect(
      broker.redeem(
        redeemRequest({
          ticketId: issued.ticket.ticketId,
          ticketSecret: issued.ticketSecret,
          nonce: "nonce-4",
          seq: 2,
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(broker.status("ticket-1")?.state).toBe("active");
  });

  it("single_use：兑换后即 consumed，再次兑换 replayed", () => {
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    const issued = broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
    });
    expect(
      broker.redeem({
        ticketId: issued.ticket.ticketId,
        ticketSecret: issued.ticketSecret,
        binding: BINDING,
        action: { toolName: "Read" },
        nonce: "n1",
        revocationEpoch: 0,
      }),
    ).toMatchObject({ ok: true });
    expect(broker.status("ticket-1")?.state).toBe("consumed");
    expect(
      broker.redeem({
        ticketId: issued.ticket.ticketId,
        ticketSecret: issued.ticketSecret,
        binding: BINDING,
        action: { toolName: "Read" },
        nonce: "n2",
        revocationEpoch: 0,
      }),
    ).toMatchObject({ ok: false, code: "ticket.replayed" });
  });

  it("过期票据 deny，sweepExpired 标记 expired", () => {
    const clock = createClock(1_000);
    const broker = createCapabilityTicketBroker({
      now: clock.now,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    const issued = broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      ttlMs: 100,
    });
    clock.advance(100);
    expect(
      broker.redeem({
        ticketId: issued.ticket.ticketId,
        ticketSecret: issued.ticketSecret,
        binding: BINDING,
        action: { toolName: "Read" },
        nonce: "n1",
        revocationEpoch: 0,
      }),
    ).toMatchObject({ ok: false, code: "ticket.expired" });
    expect(broker.status("ticket-1")?.state).toBe("expired");
    expect(broker.sweepExpired(clock.now() + 1)).toBe(0);
  });

  it("绑定不匹配 deny：workspace/attachment/subject/surface 任一漂移", () => {
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    const issued = broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
    });
    const base = {
      ticketId: issued.ticket.ticketId,
      ticketSecret: issued.ticketSecret,
      action: { toolName: "Read" },
      nonce: "n1",
      revocationEpoch: 0,
    };
    for (const binding of [
      { ...BINDING, workspaceIdentity: "other" },
      { ...BINDING, attachmentId: "other" },
      { ...BINDING, deviceId: "other" },
      { ...BINDING, surfaceKind: "web" as const },
      { ...BINDING, subject: { kind: "session" as const, id: "run-1" } },
      { ...BINDING, subject: undefined },
    ]) {
      expect(broker.redeem({ ...base, binding })).toMatchObject({
        ok: false,
        code: "ticket.binding_mismatch",
      });
    }
  });

  it("secret 错误按 unknown deny，不暴露票据是否存在", () => {
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
    });
    expect(
      broker.redeem(redeemRequest({ ticketSecret: "wrong-secret" })),
    ).toMatchObject({ ok: false, code: "ticket.unknown" });
    expect(broker.redeem(redeemRequest({ ticketId: "missing" }))).toMatchObject({
      ok: false,
      code: "ticket.unknown",
    });
  });

  it("scope 越界 deny：读票据不能兑换写/命令/凭据工具", () => {
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
    });
    for (const toolName of ["Write", "Bash", "mcp__zeta__secret", "WebFetch"]) {
      expect(broker.redeem(redeemRequest({ action: { toolName } }))).toMatchObject({
        ok: false,
        code: "ticket.scope_denied",
      });
    }
  });

  it("tools-only scope 在签发时归一为工具族：credential 重分类不能兑换 read 票据", () => {
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    const issued = broker.issue({
      binding: BINDING,
      // 只声明工具名，不声明工具族。
      scope: { tools: ["Read"] },
      role: "read_mostly",
    });
    expect(issued.ticket.scope.toolClasses).toEqual(["read"]);
    expect(
      broker.redeem(
        redeemRequest({
          ticketSecret: issued.ticketSecret,
          action: { toolName: "Read", permissionGroup: "official_cua" },
        }),
      ),
    ).toMatchObject({ ok: false, code: "ticket.scope_denied" });
  });

  it("非 host 不能签发 workspace_write（D3 确认面未落地）；host 兑换不需要宿主确认", () => {
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    expect(() =>
      broker.issue({
        binding: BINDING,
        scope: { toolClasses: ["workspace_write"] },
        role: "interactive",
      }),
    ).toThrow(CapabilityTicketIssueError);
    expect(() =>
      broker.issue({
        binding: BINDING,
        scope: { toolClasses: ["workspace_write"] },
        role: "read_mostly",
      }),
    ).toThrow(CapabilityTicketIssueError);

    const hostTicket = broker.issue({
      binding: { ...BINDING, attachmentId: "host-1" },
      scope: { toolClasses: ["workspace_write"] },
      role: "host",
    });
    const result = broker.redeem({
      ticketId: hostTicket.ticket.ticketId,
      ticketSecret: hostTicket.ticketSecret,
      binding: { ...BINDING, attachmentId: "host-1" },
      action: { toolName: "Write" },
      nonce: "n1",
      seq: 1,
      revocationEpoch: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.injection.requiresHostConfirmation).toBe(false);
      expect(result.injection.revocationEpoch).toBe(0);
    }
  });

  it("兑换必须携带 revocationEpoch；缺省即 deny（不给吊销校验旁路）", () => {
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    const issued = broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });
    expect(
      broker.redeem({
        ticketId: issued.ticket.ticketId,
        ticketSecret: issued.ticketSecret,
        binding: BINDING,
        action: { toolName: "Read" },
        nonce: "n1",
        seq: 1,
      } as unknown as CapabilityTicketRedeemRequest),
    ).toMatchObject({ ok: false, code: "ticket.binding_mismatch" });
  });

  it("sweepExpired 清理超过保留窗口的终态记录，map 不会无界增长", () => {
    const clock = createClock(1_000);
    let sequence = 0;
    const broker = createCapabilityTicketBroker({
      now: clock.now,
      createTicketId: () => `ticket-${++sequence}`,
      createSecret: () => `secret-${sequence}`,
    });
    const issued = broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
    });
    broker.revoke(issued.ticket.ticketId);
    expect(broker.status(issued.ticket.ticketId)).toBeDefined();
    // 保留窗口后清理；再次查询自然 unknown（仍 deny，不复活）。
    broker.sweepExpired(clock.now() + 11 * 60_000);
    expect(broker.status(issued.ticket.ticketId)).toBeUndefined();
    expect(
      broker.redeem(redeemRequest({ revocationEpoch: broker.getRevocationEpoch() })),
    ).toMatchObject({ ok: false, code: "ticket.unknown" });
  });

  it("status 同时给出签发快照与 broker 当前 epoch，避免跨票据吊销误读", () => {
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    const issued = broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
    });
    broker.revoke(issued.ticket.ticketId);
    expect(broker.status(issued.ticket.ticketId)).toMatchObject({
      revocationEpoch: 1,
      currentRevocationEpoch: 1,
    });
  });

  it("签发侧拒绝角色越权 scope 与超硬上限 TTL", () => {
    const broker = createCapabilityTicketBroker({ now: () => 1_000 });
    expect(() =>
      broker.issue({
        binding: BINDING,
        scope: { toolClasses: ["credential"] },
        role: "read_mostly",
      }),
    ).toThrow(CapabilityTicketIssueError);
    expect(() =>
      broker.issue({
        binding: BINDING,
        scope: { toolClasses: ["read"] },
        role: "read_mostly",
        ttlMs: 61 * 60_000,
      }),
    ).toThrow(/ttl/);
  });

  it("吊销即时生效；epoch 前进后旧 epoch 兑换 deny", () => {
    const clock = createClock();
    let sequence = 0;
    const broker = createCapabilityTicketBroker({
      now: clock.now,
      createTicketId: () => `ticket-${++sequence}`,
      createSecret: () => `secret-${sequence}`,
    });
    const issued = broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });
    expect(broker.getRevocationEpoch()).toBe(0);
    const staleEpoch = broker.getRevocationEpoch();

    expect(broker.revoke("ticket-1")).toBe(true);
    expect(broker.getRevocationEpoch()).toBe(1);
    expect(broker.status("ticket-1")?.state).toBe("revoked");
    expect(broker.status("ticket-1")?.revocationEpoch).toBe(1);
    expect(broker.revoke("ticket-1")).toBe(false);

    expect(
      broker.redeem({
        ticketId: issued.ticket.ticketId,
        ticketSecret: issued.ticketSecret,
        binding: BINDING,
        action: { toolName: "Read" },
        nonce: "n1",
        seq: 1,
        revocationEpoch: broker.getRevocationEpoch(),
      }),
    ).toMatchObject({ ok: false, code: "ticket.revoked" });

    // 未定向吊销但携带旧 epoch：fail-closed 拒绝。
    const other = broker.issue({
      binding: { ...BINDING, attachmentId: "attachment-2" },
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });
    expect(
      broker.redeem({
        ticketId: other.ticket.ticketId,
        ticketSecret: other.ticketSecret,
        binding: { ...BINDING, attachmentId: "attachment-2" },
        action: { toolName: "Read" },
        nonce: "n2",
        seq: 1,
        revocationEpoch: staleEpoch,
      }),
    ).toMatchObject({ ok: false, code: "ticket.revoked" });
    expect(
      broker.redeem({
        ticketId: other.ticket.ticketId,
        ticketSecret: other.ticketSecret,
        binding: { ...BINDING, attachmentId: "attachment-2" },
        action: { toolName: "Read" },
        nonce: "n3",
        seq: 1,
        revocationEpoch: broker.getRevocationEpoch(),
      }),
    ).toMatchObject({ ok: true });
  });

  it("revokeByAttachment / revokeByDevice 批量吊销且不误伤其他绑定", () => {
    const clock = createClock();
    let nextId = 0;
    const broker = createCapabilityTicketBroker({
      now: clock.now,
      createTicketId: () => `ticket-${++nextId}`,
      createSecret: () => `secret-${nextId}`,
    });
    broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });
    broker.issue({
      binding: { ...BINDING, attachmentId: "mobile-2", deviceId: "device-2" },
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });
    broker.issue({
      binding: { ...BINDING, attachmentId: "mobile-3", deviceId: "device-1" },
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });

    expect(broker.revokeByAttachment("mobile-1")).toBe(1);
    expect(broker.status("ticket-1")?.state).toBe("revoked");
    expect(broker.status("ticket-2")?.state).toBe("issued");
    expect(broker.status("ticket-3")?.state).toBe("issued");

    expect(broker.revokeByDevice("device-1")).toBe(1);
    expect(broker.status("ticket-3")?.state).toBe("revoked");
    expect(broker.status("ticket-2")?.state).toBe("issued");
  });

  it("broker 重启（新实例）后旧票据全部 unknown，必须重新签发", () => {
    const first = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    first.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
    });
    const restarted = createCapabilityTicketBroker({ now: () => 1_000 });
    expect(restarted.status("ticket-1")).toBeUndefined();
    expect(restarted.redeem(redeemRequest())).toMatchObject({
      ok: false,
      code: "ticket.unknown",
    });
    expect(restarted.getRevocationEpoch()).toBe(0);
  });

  it("secret 不进入票据描述、模型投影或成功句柄", () => {
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    const issued = broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "sequential",
    });
    const result = broker.redeem({
      ticketId: issued.ticket.ticketId,
      ticketSecret: issued.ticketSecret,
      binding: BINDING,
      action: { toolName: "Read" },
      nonce: "n1",
      seq: 1,
      revocationEpoch: 0,
    });
    expect(result.ok).toBe(true);
    const publicPayload = JSON.stringify({
      status: broker.status("ticket-1"),
      projection: projectCapabilityTicketForModelContext(issued.ticket),
      result,
    });
    expect(publicPayload).not.toContain("secret-1");
  });
});
