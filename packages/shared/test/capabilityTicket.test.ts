import { describe, expect, it } from "vitest";
import {
  CAPABILITY_TICKET_FAILURE_CODES,
  CAPABILITY_TICKET_MAX_TTL_MS,
  CAPABILITY_TICKET_RUN_TTL_MS,
  CAPABILITY_TICKET_TOOL_TTL_MS,
  capabilityTicketBindingSchema,
  capabilityTicketBindingsMatch,
  capabilityTicketRedeemRequestSchema,
  capabilityTicketSchema,
  capabilityTicketScopeAllows,
  capabilityTicketScopeWithinRole,
  deriveCapabilityTicketScopeForRole,
  normalizeCapabilityTicketScope,
  projectCapabilityTicketForModelContext,
  projectCapabilityTicketForProtocol,
  resolveCapabilityTicketTtlMs,
  serializeCapabilityTicketBinding,
  type CapabilityTicketBinding,
  type CapabilityTicketScope,
} from "../src/capability-ticket.js";
import { commandEnvelopeSchema } from "../src/zcode-protocol-v4/command.js";
import { conversationInputIntentSchema } from "../src/zcode-protocol-v4/input-intent.js";

const BINDING: CapabilityTicketBinding = {
  workspaceIdentity: "remote:ssh:dev:/work/demo",
  attachmentId: "mobile-1",
  deviceId: "device-1",
  surfaceKind: "mobileRemote",
  subject: { kind: "run", id: "run-1" },
};

function ticket(overrides: Record<string, unknown> = {}) {
  return capabilityTicketSchema.parse({
    ticketId: "ticket-1",
    binding: BINDING,
    scope: { toolClasses: ["read"] },
    issuedAt: 1_000,
    expiresAt: 2_000,
    revocationEpoch: 0,
    state: "issued",
    ...overrides,
  });
}

describe("capability ticket contract", () => {
  it("公开票据描述结构上没有 secret 字段", () => {
    expect(Object.keys(capabilityTicketSchema.shape)).not.toContain("ticketSecret");
    expect(Object.keys(ticket())).not.toContain("ticketSecret");
  });

  it("未知字段 additive 兼容，但模型投影会剥离任何夹带的 secret", () => {
    const parsed = ticket({
      futureDimension: "x",
      ticketSecret: "super-secret-value",
      binding: { ...BINDING, futureBindingDimension: "b" },
      scope: { toolClasses: ["read"], futureScopeDimension: "s" },
    });
    expect(parsed.futureDimension).toBe("x");
    expect(parsed.binding.futureBindingDimension).toBe("b");
    expect(parsed.scope.futureScopeDimension).toBe("s");

    const projected = projectCapabilityTicketForModelContext(parsed as never);
    expect(projected).toEqual({ ticketId: "ticket-1" });
    expect(JSON.stringify(projected)).not.toContain("super-secret-value");
  });

  it("协议投影只给 capabilityTicketId", () => {
    const projected = projectCapabilityTicketForProtocol({ ticketId: "ticket-1" });
    expect(projected).toEqual({ capabilityTicketId: "ticket-1" });
  });

  it("角色缺省 scope：非 host 只给 read；host 覆盖全部工具族", () => {
    expect(deriveCapabilityTicketScopeForRole("read_mostly")).toEqual({
      toolClasses: ["read"],
    });
    expect(deriveCapabilityTicketScopeForRole("interactive")).toEqual({
      toolClasses: ["read"],
    });
    expect(deriveCapabilityTicketScopeForRole("host").toolClasses).toContain("credential");
  });

  it("D3 确认面未落地前非 host 一律不能申请写 scope；凭据永远不可申请", () => {
    expect(
      capabilityTicketScopeWithinRole("read_mostly", { toolClasses: ["read"] }),
    ).toBe(true);
    expect(
      capabilityTicketScopeWithinRole("read_mostly", { toolClasses: ["workspace_write"] }),
    ).toBe(false);
    expect(
      capabilityTicketScopeWithinRole("read_mostly", { toolClasses: ["command_exec"] }),
    ).toBe(false);
    expect(
      capabilityTicketScopeWithinRole("read_mostly", { toolClasses: ["credential"] }),
    ).toBe(false);
    // workspace_write 在矩阵里是 ask；宿主确认路由未接线前签发即拒绝（fail-closed）。
    expect(
      capabilityTicketScopeWithinRole("interactive", { toolClasses: ["workspace_write"] }),
    ).toBe(false);
    expect(
      capabilityTicketScopeWithinRole("interactive", { toolClasses: ["read"] }),
    ).toBe(true);
    expect(
      capabilityTicketScopeWithinRole("interactive", { toolClasses: ["credential"] }),
    ).toBe(false);
  });

  it("只声明 resources、没有工具维度的 scope 一律 fail-closed", () => {
    expect(capabilityTicketScopeWithinRole("host", { resources: ["repo:1"] })).toBe(false);
    expect(
      capabilityTicketScopeAllows(
        { resources: ["repo:1"] },
        { toolName: "Read", resource: "repo:1" },
      ),
    ).toBe(false);
  });

  it("scope 匹配按工具族/工具名/资源合取，未知工具不放行", () => {
    const scope: CapabilityTicketScope = { toolClasses: ["read"] };
    expect(capabilityTicketScopeAllows(scope, { toolName: "Read" })).toBe(true);
    expect(capabilityTicketScopeAllows(scope, { toolName: "Grep" })).toBe(true);
    expect(capabilityTicketScopeAllows(scope, { toolName: "Write" })).toBe(false);
    expect(capabilityTicketScopeAllows(scope, { toolName: "Bash" })).toBe(false);
    expect(capabilityTicketScopeAllows(scope, { toolName: "mcp__zeta__secret" })).toBe(false);
    expect(
      capabilityTicketScopeAllows({ tools: ["Read"] }, { toolName: "Read" }),
    ).toBe(true);
    // tools-only scope 不能靠兑换时传入 permissionGroup 重算分类逃逸：Read 按工具名是
    // read，permissionGroup=official_cua 让它变成 credential，必须 deny。
    expect(
      capabilityTicketScopeAllows(
        { tools: ["Read"] },
        { toolName: "Read", permissionGroup: "official_cua" },
      ),
    ).toBe(false);
    expect(
      capabilityTicketScopeAllows({ tools: ["Read"] }, { toolName: "Grep" }),
    ).toBe(false);
    expect(
      capabilityTicketScopeAllows(
        { toolClasses: ["read"], tools: ["Read"], resources: ["repo:1"] },
        { toolName: "Read", resource: "repo:2" },
      ),
    ).toBe(false);
    expect(
      capabilityTicketScopeAllows(
        { toolClasses: ["read"], tools: ["Read"], resources: ["repo:1"] },
        { toolName: "Read" },
      ),
    ).toBe(false);
  });

  it("绑定比较覆盖 workspace/attachment/device/surface/subject，且缺失不能放宽", () => {
    expect(capabilityTicketBindingsMatch(BINDING, { ...BINDING })).toBe(true);
    expect(
      capabilityTicketBindingsMatch(BINDING, { ...BINDING, workspaceIdentity: "other" }),
    ).toBe(false);
    expect(
      capabilityTicketBindingsMatch(BINDING, { ...BINDING, attachmentId: "other" }),
    ).toBe(false);
    expect(capabilityTicketBindingsMatch(BINDING, { ...BINDING, surfaceKind: "web" })).toBe(
      false,
    );
    expect(capabilityTicketBindingsMatch(BINDING, { ...BINDING, deviceId: "device-2" })).toBe(
      false,
    );
    expect(
      capabilityTicketBindingsMatch(BINDING, { ...BINDING, deviceId: undefined }),
    ).toBe(false);
    expect(
      capabilityTicketBindingsMatch(BINDING, {
        ...BINDING,
        subject: { kind: "trigger", id: "run-1" },
      }),
    ).toBe(false);
    expect(
      capabilityTicketBindingsMatch(
        BINDING,
        { ...BINDING, subject: undefined } as unknown as CapabilityTicketBinding,
      ),
    ).toBe(false);
    // subject 必须在签发时给出；双方都缺省不是“匹配”，解析直接失败。
    expect(
      capabilityTicketBindingSchema.safeParse({
        workspaceIdentity: "ws",
        attachmentId: "a",
        surfaceKind: "desktop",
      }).success,
    ).toBe(false);
  });

  it("tools-only scope 在签发前归一为 toolClasses，票据自带族约束", () => {
    const normalized = normalizeCapabilityTicketScope({ tools: ["Read"] });
    expect(normalized.toolClasses).toEqual(["read"]);
    expect(
      normalizeCapabilityTicketScope({ tools: ["Read"], toolClasses: ["read"] }),
    ).toEqual({ tools: ["Read"], toolClasses: ["read"] });
  });

  it("绑定序列化稳定且不含 secret", () => {
    const key = serializeCapabilityTicketBinding(BINDING);
    expect(key).toBe(
      "remote:ssh:dev:/work/demo\u0000mobile-1\u0000device-1\u0000mobileRemote\u0000run:run-1",
    );
  });

  it("TTL 草案按 mode 取值，硬上限可被调用方检查", () => {
    expect(resolveCapabilityTicketTtlMs("single_use")).toBe(CAPABILITY_TICKET_TOOL_TTL_MS);
    expect(resolveCapabilityTicketTtlMs("sequential")).toBe(CAPABILITY_TICKET_RUN_TTL_MS);
    expect(resolveCapabilityTicketTtlMs("single_use", 123)).toBe(123);
    expect(CAPABILITY_TICKET_MAX_TTL_MS).toBe(60 * 60_000);
  });

  it("兑换请求 schema 要求 stable binding/action/nonce 且强制携带 revocationEpoch", () => {
    const parsed = capabilityTicketRedeemRequestSchema.safeParse({
      ticketId: "t1",
      ticketSecret: "s",
      binding: BINDING,
      action: { toolName: "Read" },
      nonce: "n1",
      revocationEpoch: 0,
    });
    expect(parsed.success).toBe(true);
    // 省略 epoch 等于提供吊销校验旁路，必须解析失败。
    expect(
      capabilityTicketRedeemRequestSchema.safeParse({
        ticketId: "t1",
        ticketSecret: "s",
        binding: BINDING,
        action: { toolName: "Read" },
        nonce: "n1",
      }).success,
    ).toBe(false);
    expect(
      capabilityTicketRedeemRequestSchema.safeParse({
        ticketId: "t1",
        ticketSecret: "s",
        binding: { workspaceIdentity: "ws" },
        action: { toolName: "Read" },
        nonce: "n1",
        revocationEpoch: 0,
      }).success,
    ).toBe(false);
  });

  it("ticketId 有长度/字符集上限：换行或超长载荷在解析阶段失败，不能进宿主日志", () => {
    const base = {
      ticketSecret: "s",
      binding: BINDING,
      action: { toolName: "Read" },
      nonce: "n1",
      revocationEpoch: 0,
    };
    expect(
      capabilityTicketRedeemRequestSchema.safeParse({
        ...base,
        ticketId: "forged\ncapability ticket delivered attachmentId=x",
      }).success,
    ).toBe(false);
    expect(
      capabilityTicketRedeemRequestSchema.safeParse({
        ...base,
        ticketId: "t".repeat(129),
      }).success,
    ).toBe(false);
    expect(
      capabilityTicketRedeemRequestSchema.safeParse({ ...base, ticketId: "ticket-1" }).success,
    ).toBe(true);
  });

  it("协议帧 additive 携带 capabilityTicketId，未知 secret 键被丢弃", () => {
    const envelope = commandEnvelopeSchema.parse({
      commandId: "c1",
      clientId: "client-1",
      sessionId: null,
      type: "sendText",
      payload: { text: "hi" },
      issuedAt: 1_000,
      capabilityTicketId: "ticket-1",
      ticketSecret: "should-be-stripped",
    });
    expect(envelope.capabilityTicketId).toBe("ticket-1");
    expect(envelope).not.toHaveProperty("ticketSecret");
    expect(
      commandEnvelopeSchema.parse({
        commandId: "c2",
        clientId: "client-1",
        sessionId: null,
        type: "sendText",
        payload: { text: "hi" },
        issuedAt: 1_000,
      }),
    ).not.toHaveProperty("capabilityTicketId");
  });

  it("输入意图 additive 携带 capabilityTicketId", () => {
    const intent = conversationInputIntentSchema.parse({
      sourceCommandId: "c1",
      queueItemId: "q1",
      clientId: "client-1",
      kind: "sendText",
      text: "hi",
      delivery: { requested: "auto", admitted: "queue" },
      order: { admissionSeq: 1 },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
      admittedAt: 1_000,
      capabilityTicketId: "ticket-1",
    });
    expect(intent.capabilityTicketId).toBe("ticket-1");
  });

  it("失败码集合覆盖 spec §2.3 的全部 deny 码", () => {
    expect([...CAPABILITY_TICKET_FAILURE_CODES].sort()).toEqual(
      [
        "ticket.binding_mismatch",
        "ticket.broker_unavailable",
        "ticket.expired",
        "ticket.replayed",
        "ticket.revoked",
        "ticket.scope_denied",
        "ticket.unknown",
      ].sort(),
    );
  });
});
