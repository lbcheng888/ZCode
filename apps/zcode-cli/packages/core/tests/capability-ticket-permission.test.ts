// P6 能力票据授权域在工具准入层的叠加（spec §2.5 C1/C2）。
// 只测 PermissionService 最终结论：票据 scope 必须在既有管线之后只收紧，过期/越界/
// 凭据注入不可达一律 deny，且没有票据时字节兼容。
import { describe, expect, it } from "vitest";
import type { HostAttachmentAdmissionFacts } from "@zcode/shared/zcode-protocol-v4";
import {
  PermissionService,
  type PermissionContext,
  type PermissionToolCapability,
} from "../src/permission/service.js";
import {
  evaluateCapabilityTicketRestriction,
  type CapabilityTicketAuthorization,
} from "../src/permission/capability-ticket.js";

const readCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: false,
  readOnly: true,
  riskLevel: "low",
  sideEffectScope: "none",
};

const bashCapability: PermissionToolCapability = {
  destructive: true,
  needsApproval: true,
  readOnly: false,
  riskLevel: "high",
  sideEffectScope: "system",
};

const mcpCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "workspace",
};

function authorization(
  overrides: Partial<CapabilityTicketAuthorization> = {},
): CapabilityTicketAuthorization {
  return {
    ticketId: "ticket-1",
    binding: {
      workspaceIdentity: "remote:ssh:dev:/work/demo",
      attachmentId: "remote-1",
      surfaceKind: "desktop",
      subject: { kind: "session", id: "session-1" },
    },
    scope: { toolClasses: ["read"] },
    expiresAt: Date.now() + 60_000,
    revocationEpoch: 0,
    ...overrides,
  };
}

function context(
  toolName: string,
  capabilityTicket?: CapabilityTicketAuthorization,
  attachment?: HostAttachmentAdmissionFacts,
  mode: PermissionContext["mode"] = "yolo",
): PermissionContext {
  return {
    toolName,
    input: {},
    riskLevel: "low",
    mode,
    ...(attachment ? { attachment } : {}),
    ...(capabilityTicket ? { capabilityTicket } : {}),
  };
}

describe("P6 capability ticket 工具准入叠加", () => {
  it("scope 内工具保持既有结论；scope 外工具即使 yolo allow 也必须 deny", () => {
    const service = new PermissionService();
    const ticket = authorization();
    expect(service.checkPermission(context("Read", ticket), readCapability).decision).toBe(
      "allow",
    );
    const denied = service.checkPermission(context("Bash", ticket), bashCapability);
    expect(denied.decision).toBe("deny");
    expect(denied.ruleId).toBe("capabilityTicket.scopeDenied");
  });

  it("显式 tools 名单同样只收紧：名单外工具拒绝", () => {
    const service = new PermissionService();
    const ticket = authorization({ scope: { tools: ["Read"] } });
    expect(service.checkPermission(context("Read", ticket), readCapability).decision).toBe(
      "allow",
    );
    expect(service.checkPermission(context("Glob", ticket), readCapability).decision).toBe(
      "deny",
    );
  });

  it("过期授权域 fail-closed，既有 allow/yolo 不能放行", () => {
    const service = new PermissionService();
    const expired = authorization({ expiresAt: Date.now() - 1 });
    const decision = service.checkPermission(context("Read", expired), readCapability);
    expect(decision.decision).toBe("deny");
    expect(decision.ruleId).toBe("capabilityTicket.expired");
  });

  it("MCP/plugin 凭据工具：宿主宣告 host-interaction 且 scope 命中才放行", () => {
    const service = new PermissionService();
    const ticket = authorization({
      scope: { toolClasses: ["credential"], resources: ["credential:github"] },
      credentialInjection: "host-interaction",
    });
    const allowed = service.checkPermission(
      context("mcp__github__create_issue", ticket),
      mcpCapability,
    );
    expect(allowed.decision).toBe("allow");
    expect(allowed.ruleId).not.toBe("capabilityTicket.credentialInjectionUnavailable");
  });

  it("无真实注入通道的 credential 工具 ⇒ typed deny，不放行、不假装注入", () => {
    const service = new PermissionService();
    const ticket = authorization({
      scope: { toolClasses: ["credential"], resources: ["credential:github"] },
    });
    const decision = service.checkPermission(
      context("mcp__github__create_issue", ticket),
      mcpCapability,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.ruleId).toBe("capabilityTicket.credentialInjectionUnavailable");
    expect(decision.reason).toContain("ticket.credential_injection_unavailable");
  });

  it("CUA 凭据工具只认宿主注入的 CUA broker socket；缺失即 deny", () => {
    const ticket = authorization({
      scope: { toolClasses: ["credential"], resources: ["credential:official-mcp"] },
      credentialInjection: "host-interaction",
    });
    const cua = { toolName: "mcp__computer-use__click", permissionGroup: "official_cua" };
    expect(
      evaluateCapabilityTicketRestriction({
        authorization: ticket,
        ...cua,
        cuaBrokerAvailable: true,
      }),
    ).toBeUndefined();
    const denied = evaluateCapabilityTicketRestriction({
      authorization: ticket,
      ...cua,
      cuaBrokerAvailable: false,
    });
    expect(denied?.ruleId).toBe("capabilityTicket.credentialInjectionUnavailable");
    // host-interaction 不能替代 CUA broker socket。
    expect(denied).toBeDefined();
  });

  it("窄资源票据不能借 CUA broker socket 执行未声明的凭据通道", () => {
    const narrow = authorization({
      scope: { toolClasses: ["credential"], resources: ["credential:github"] },
      credentialInjection: "host-interaction",
    });
    const denied = evaluateCapabilityTicketRestriction({
      authorization: narrow,
      toolName: "mcp__computer-use__click",
      permissionGroup: "official_cua",
      cuaBrokerAvailable: true,
    });
    expect(denied?.ruleId).toBe("capabilityTicket.credentialInjectionUnavailable");
  });

  it("resources 只约束 credential 动作：同一 host 票据内非凭据工具仍按工具维度放行", () => {
    const hostTicket = authorization({
      scope: {
        toolClasses: ["read", "credential"],
        resources: ["credential:official-mcp"],
      },
      credentialInjection: "host-interaction",
    });
    const service = new PermissionService();
    expect(
      service.checkPermission(context("Read", hostTicket), readCapability).decision,
    ).toBe("allow");
  });

  it("与 attachment 矩阵叠加：只收紧，不互相放宽", () => {
    const service = new PermissionService();
    const readMostly: HostAttachmentAdmissionFacts = {
      source: "remote",
      attachment: { attachmentId: "remote-1", role: "read_mostly" },
    };
    const ticket = authorization({ scope: { toolClasses: ["read"] } });
    expect(
      service.checkPermission(context("Read", ticket, readMostly), readCapability).decision,
    ).toBe("allow");
    expect(
      service.checkPermission(context("Bash", ticket, readMostly), bashCapability).decision,
    ).toBe("deny");
    // 附件矩阵 deny 不会被票据 scope 的 allow 覆盖（票据只能 deny）。
    const writeTicket = authorization({ scope: { toolClasses: ["workspace_write"] } });
    expect(
      service.checkPermission(context("Write", writeTicket, readMostly), {
        destructive: false,
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      }).decision,
    ).toBe("ask");
  });

  it("无票据授权域时保持既有语义（字节兼容）", () => {
    const service = new PermissionService();
    expect(service.checkPermission(context("Bash"), bashCapability).decision).toBe("allow");
  });
});
