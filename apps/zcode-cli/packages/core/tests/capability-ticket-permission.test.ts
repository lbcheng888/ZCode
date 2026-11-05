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
import type { CapabilityTicketAuthorization } from "../src/permission/capability-ticket.js";

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

const cuaCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "workspace",
  permissionCapabilityGroup: "official_cua",
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

  it("scope 命中 credential 类工具 ⇒ typed credential 注入不可达，拒绝而不是假装注入", () => {
    const service = new PermissionService();
    const ticket = authorization({ scope: { toolClasses: ["credential"] } });
    const decision = service.checkPermission(context("mcp__github__create_issue", ticket), cuaCapability);
    expect(decision.decision).toBe("deny");
    expect(decision.ruleId).toBe("capabilityTicket.credentialInjectionUnimplemented");
    expect(decision.reason).toContain("ticket.credential_injection_unimplemented");
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
