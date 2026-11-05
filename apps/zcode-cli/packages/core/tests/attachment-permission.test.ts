// P6 设备权限矩阵在生产准入层的叠加行为（spec §1.3 矩阵 + §1.5 D1/D4/D5）。
// 只测 PermissionService 的最终结论：附件限制必须叠加在既有有序管线之后，且只能收紧。
import { describe, expect, it } from "vitest";
import type { HostAttachmentAdmissionFacts } from "@zcode/shared/zcode-protocol-v4";
import {
  PermissionService,
  type PermissionContext,
  type PermissionToolCapability,
} from "../src/permission/service.js";

const readCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: false,
  readOnly: true,
  riskLevel: "low",
  sideEffectScope: "none",
};

const writeCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "workspace",
};

const bashCapability: PermissionToolCapability = {
  destructive: true,
  needsApproval: true,
  readOnly: false,
  riskLevel: "high",
  sideEffectScope: "workspace",
};

const mcpCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "workspace",
};

function context(
  toolName: string,
  attachment?: HostAttachmentAdmissionFacts,
  mode: PermissionContext["mode"] = "yolo",
): PermissionContext {
  return {
    toolName,
    input: {},
    riskLevel: "low",
    mode,
    ...(attachment ? { attachment } : {}),
  };
}

const readMostlyRemote: HostAttachmentAdmissionFacts = {
  source: "remote",
  attachment: { attachmentId: "mobile-1", role: "read_mostly" },
};

const hostLocal: HostAttachmentAdmissionFacts = {
  source: "local-host",
  attachment: { attachmentId: "desktop-1", role: "host" },
};

describe("P6 attachment 角色叠加", () => {
  it("read_mostly 远端附件：Bash/凭据工具 deny，纯读仍 allow", () => {
    const service = new PermissionService();
    expect(service.checkPermission(context("Bash", readMostlyRemote), bashCapability).decision).toBe(
      "deny",
    );
    expect(
      service.checkPermission(context("mcp__github__create_issue", readMostlyRemote), mcpCapability)
        .decision,
    ).toBe("deny");
    expect(service.checkPermission(context("Read", readMostlyRemote), readCapability).decision).toBe(
      "allow",
    );
  });

  it("read_mostly 写操作从 yolo allow 收紧为 ask（不是自动放行）", () => {
    const service = new PermissionService();
    const decision = service.checkPermission(
      context("Write", readMostlyRemote),
      writeCapability,
    );
    expect(decision.decision).toBe("ask");
    expect(decision.allowed).toBe(false);
    expect(decision.ruleId).toContain("attachment.matrix.read_mostly.workspace_write");
  });

  it("既有 deny 不会被附件矩阵放宽", () => {
    const service = new PermissionService();
    const denied = service.checkPermission(
      context("Read", readMostlyRemote, "build"),
      readCapability,
      { version: 1, deny: [{ toolName: "Read" }] },
    );
    expect(denied.decision).toBe("deny");
    expect(denied.ruleId).toBe("rule.project.deny");
  });

  it("base ask + 附件 deny 收紧为 deny", () => {
    const service = new PermissionService();
    const decision = service.checkPermission(
      context("Bash", readMostlyRemote, "build"),
      bashCapability,
    );
    expect(decision.decision).toBe("deny");
  });

  it("interactive 角色同样不放开命令执行", () => {
    const service = new PermissionService();
    const decision = service.checkPermission(
      context("Bash", {
        source: "remote",
        attachment: { attachmentId: "ipad-1", role: "interactive" },
      }, "guarded"),
      bashCapability,
    );
    expect(decision.decision).toBe("deny");
  });

  it("host 角色沿用既有管线（yolo allow 保持 allow）", () => {
    const service = new PermissionService();
    expect(service.checkPermission(context("Bash", hostLocal), bashCapability).decision).toBe(
      "allow",
    );
  });

  it("无 attachment 事实的本地 CLI 保持现状（字节兼容）", () => {
    const service = new PermissionService();
    expect(service.checkPermission(context("Bash"), bashCapability).decision).toBe("allow");
    expect(service.checkPermission(context("Write"), writeCapability).decision).toBe("allow");
  });

  it("远端来源但 attachment 元数据缺失：fail-closed read_mostly（不落到 host）", () => {
    const service = new PermissionService();
    const facts: HostAttachmentAdmissionFacts = { source: "remote" };
    expect(service.checkPermission(context("Bash", facts), bashCapability).decision).toBe("deny");
    expect(service.checkPermission(context("Read", facts), readCapability).decision).toBe("allow");
  });

  it("角色被吊销（元数据在场但 role 缺失）：直接 deny，连纯读也拒绝", () => {
    const service = new PermissionService();
    const facts: HostAttachmentAdmissionFacts = {
      source: "remote",
      attachment: { attachmentId: "revoked-1" },
    };
    const decision = service.checkPermission(context("Read", facts), readCapability);
    expect(decision.decision).toBe("deny");
    expect(decision.ruleId).toBe("attachment.revoked");
  });

  it("read_mostly 纯读限 workspace：越界路径 fail-closed，workspace 内仍 allow", () => {
    const service = new PermissionService();
    const readContext = (input: unknown, attachment = readMostlyRemote) =>
      ({
        toolName: "Read",
        input,
        riskLevel: "low",
        mode: "yolo",
        workingDirectory: "/workspace",
        attachment,
      }) satisfies PermissionContext;
    expect(
      service.checkPermission(readContext({ file_path: "/workspace/src/a.ts" }), readCapability)
        .decision,
    ).toBe("allow");
    expect(
      service.checkPermission(readContext({ file_path: "/Users/mac/.ssh/id_rsa" }), readCapability)
        .decision,
    ).toBe("deny");
    expect(
      service.checkPermission(readContext({ file_path: "../secrets.env" }), readCapability).decision,
    ).toBe("deny");
    expect(
      service.checkPermission(readContext({ path: "/tmp" }), readCapability).decision,
    ).toBe("deny");
    // host 角色不额外收紧（矩阵按既有规则）。
    expect(
      service.checkPermission(
        readContext({ file_path: "/Users/mac/.ssh/id_rsa" }, hostLocal),
        readCapability,
      ).decision,
    ).toBe("allow");
  });

  it("角色变更即时生效：同一上下文改成 read_mostly 后下一次判定收紧", () => {
    const service = new PermissionService();
    expect(service.checkPermission(context("Bash", hostLocal), bashCapability).decision).toBe(
      "allow",
    );
    const downgraded: HostAttachmentAdmissionFacts = {
      source: "local-host",
      attachment: { attachmentId: "desktop-1", role: "read_mostly" },
    };
    expect(service.checkPermission(context("Bash", downgraded), bashCapability).decision).toBe(
      "deny",
    );
  });
});
