import { describe, expect, it } from "vitest";
import {
  attachmentContextSchema,
  attachmentRoleSchema,
  classifyAttachmentTool,
  composeAttachmentPermissionDecision,
  deviceScopeSchema,
  evaluateAttachmentToolRestriction,
  parseAttachmentRole,
  parseDeviceScopeKey,
  resolveAttachmentContextRole,
  resolveDeviceScopeKey,
  resolveHostAttachmentRole,
  ruleAppliesToAttachment,
  type AttachmentContext,
} from "../src/attachment-role.js";
import {
  V4_WIRE_PROTOCOL_VERSION,
  clientHelloSchema,
} from "../src/zcode-protocol-v4/index.js";

const REMOTE_CONTEXT: AttachmentContext = {
  attachmentId: "mobile-1",
  role: "read_mostly",
  deviceKind: "mobileRemote",
  deviceId: "device-1",
  workspaceIdentity: "workspace-1",
};

describe("attachment role authority", () => {
  it("只接受精确的三个角色；未知值不落到 host", () => {
    expect(parseAttachmentRole("host")).toBe("host");
    expect(parseAttachmentRole("interactive")).toBe("interactive");
    expect(parseAttachmentRole("read_mostly")).toBe("read_mostly");
    // 数值 0 / 未知字符串 / 缺失都不能被当成 host（不能默认放行）。
    expect(parseAttachmentRole(0)).toBe("read_mostly");
    expect(parseAttachmentRole(undefined)).toBe("read_mostly");
    expect(parseAttachmentRole("full")).toBe("read_mostly");
    expect(parseAttachmentRole({ role: "host" })).toBe("read_mostly");
    expect(attachmentRoleSchema.safeParse("write_with_confirm").success).toBe(false);
  });

  it("宿主角色由 clientMode + 显式授予派生；clientKind 不参与", () => {
    expect(resolveHostAttachmentRole({ clientMode: "desktop-continuous" })).toBe("host");
    expect(resolveHostAttachmentRole({ clientMode: "web-remote-replayable" })).toBe("read_mostly");
    expect(
      resolveHostAttachmentRole({
        clientMode: "web-remote-replayable",
        grantedRole: "interactive",
      }),
    ).toBe("interactive");
    expect(
      resolveHostAttachmentRole({
        clientMode: "desktop-continuous",
        grantedRole: "read_mostly",
      }),
    ).toBe("read_mostly");
    // 未知授予值不提权。
    expect(
      resolveHostAttachmentRole({
        clientMode: "web-remote-replayable",
        grantedRole: "full",
      }),
    ).toBe("read_mostly");
    // host 的授予不能把远端连接升级成 host。
    expect(
      resolveHostAttachmentRole({
        clientMode: "web-remote-replayable",
        grantedRole: "host",
      }),
    ).toBe("read_mostly");
    // 吊销不是降级：不得映射成仍可读的 read_mostly，调用方必须直接拒绝。
    expect(
      resolveHostAttachmentRole({ clientMode: "desktop-continuous", revoked: true }),
    ).toBeUndefined();
  });

  it("本地宿主会话按 host；远端缺失附件上下文按 read_mostly fail-closed", () => {
    expect(resolveAttachmentContextRole(undefined, "local-host")).toBe("host");
    expect(resolveAttachmentContextRole(undefined, "remote")).toBe("read_mostly");
    expect(resolveAttachmentContextRole(REMOTE_CONTEXT, "remote")).toBe("read_mostly");
    // 本地来源但上下文里是远端角色时，仍以权威角色为准，不因来源升级成 host。
    expect(resolveAttachmentContextRole(REMOTE_CONTEXT, "local-host")).toBe("read_mostly");
    expect(
      resolveAttachmentContextRole(
        {
          attachmentId: "stale",
          role: undefined as unknown as AttachmentContext["role"],
        },
        "remote",
      ),
    ).toBe("read_mostly");
  });
});

describe("deviceScope", () => {
  it("键 = workspaceIdentity\\0surfaceKind，可往返解析", () => {
    const key = resolveDeviceScopeKey({ workspaceIdentity: "ws-a", surfaceKind: "mobileApp" });
    expect(key).toBe("ws-a\u0000mobileApp");
    expect(parseDeviceScopeKey(key)).toEqual({
      workspaceIdentity: "ws-a",
      surfaceKind: "mobileApp",
    });
    expect(parseDeviceScopeKey("ws-b\u0000desktop")).not.toEqual(
      parseDeviceScopeKey("ws-a\u0000desktop"),
    );
    expect(parseDeviceScopeKey("ws-a\u0000unknown")).toBeNull();
    expect(parseDeviceScopeKey("ws-a")).toBeNull();
  });

  it("无 scope 的既有规则只对 host 生效，防止桌面规则被手机继承", () => {
    expect(ruleAppliesToAttachment(undefined, undefined, "local-host")).toBe(true);
    expect(ruleAppliesToAttachment(undefined, undefined, "remote")).toBe(false);
    expect(ruleAppliesToAttachment(undefined, REMOTE_CONTEXT, "remote")).toBe(false);
  });

  it("角色/附件/设备范围逐项匹配", () => {
    expect(ruleAppliesToAttachment({ roles: ["read_mostly"] }, REMOTE_CONTEXT, "remote")).toBe(
      true,
    );
    expect(ruleAppliesToAttachment({ roles: ["host"] }, REMOTE_CONTEXT, "remote")).toBe(false);
    expect(
      ruleAppliesToAttachment(
        { roles: ["read_mostly"], attachmentIds: ["mobile-other"] },
        REMOTE_CONTEXT,
        "remote",
      ),
    ).toBe(false);
    expect(
      ruleAppliesToAttachment(
        { roles: ["read_mostly"], attachmentIds: ["mobile-1"] },
        REMOTE_CONTEXT,
        "remote",
      ),
    ).toBe(true);
    expect(ruleAppliesToAttachment({ deviceIds: ["device-1"] }, REMOTE_CONTEXT, "remote")).toBe(
      true,
    );
    expect(ruleAppliesToAttachment({ deviceIds: ["device-2"] }, REMOTE_CONTEXT, "remote")).toBe(
      false,
    );
    expect(ruleAppliesToAttachment({ kinds: ["mobileApp"] }, REMOTE_CONTEXT, "remote")).toBe(false);
  });

  it("未知字段兼容：scope / attachment context 的额外键不破坏解析，也不参与判定", () => {
    const scope = deviceScopeSchema.parse({
      roles: ["read_mostly"],
      futureDimension: "ignored",
    });
    expect(ruleAppliesToAttachment(scope, REMOTE_CONTEXT, "remote")).toBe(true);

    const context = attachmentContextSchema.parse({
      attachmentId: "mobile-1",
      role: "read_mostly",
      futureField: "ignored",
    });
    expect(resolveAttachmentContextRole(context, "remote")).toBe("read_mostly");
  });

  it("只有未知维度的 deviceScope 对非 host 不参与匹配，未知字段不扩大命中面", () => {
    const futureOnlyScope = deviceScopeSchema.parse({ futureDimension: "x" });
    // 远端角色不能命中只看未来维度的规则（否则一条 allow 会被所有远端继承）。
    expect(ruleAppliesToAttachment(futureOnlyScope, REMOTE_CONTEXT, "remote")).toBe(false);
    expect(ruleAppliesToAttachment(futureOnlyScope, undefined, "remote")).toBe(false);
    // host 与“无 scope”保持一致的既有语义。
    expect(ruleAppliesToAttachment(futureOnlyScope, undefined, "local-host")).toBe(true);
  });

  it("clientHello 的 clientKind 仍是提示位且形状不变", () => {
    const hello = clientHelloSchema.parse({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      clientId: "client-1",
      clientKind: "mobileRemote",
      appVersion: "unknown",
    });
    expect(hello.clientKind).toBe("mobileRemote");
    // 角色不在握手帧里：客户端没有自报角色的入口。
    expect("attachmentRole" in hello).toBe(false);
  });
});

describe("attachment tool matrix", () => {
  it("read_mostly：纯读放行、写操作降确认、裸命令与凭据工具拒绝", () => {
    const setup = (toolName: string, permissionGroup?: string) =>
      evaluateAttachmentToolRestriction({
        role: "read_mostly",
        toolName,
        ...(permissionGroup !== undefined ? { permissionGroup } : {}),
      });

    expect(setup("Read")).toMatchObject({ behavior: "allow", toolClass: "read" });
    expect(setup("Grep")).toMatchObject({ behavior: "allow", toolClass: "read" });
    expect(setup("Write")).toMatchObject({ behavior: "ask", toolClass: "workspace_write" });
    expect(setup("Edit")).toMatchObject({ behavior: "ask", toolClass: "workspace_write" });
    expect(setup("TodoWrite")).toMatchObject({ behavior: "ask", toolClass: "workspace_write" });
    expect(setup("Bash")).toMatchObject({ behavior: "deny", toolClass: "command_exec" });
    expect(setup("WebFetch")).toMatchObject({ behavior: "deny", toolClass: "network" });
    expect(setup("SendMessage")).toMatchObject({ behavior: "deny", toolClass: "channel" });
    expect(setup("mcp__github__get_token")).toMatchObject({
      behavior: "deny",
      toolClass: "credential",
    });
    expect(setup("ReadCredential")).toMatchObject({
      behavior: "deny",
      toolClass: "credential",
    });
    expect(setup("ComputerUse", "official_cua")).toMatchObject({
      behavior: "deny",
      toolClass: "credential",
    });
    expect(setup("PermissionUpdate")).toMatchObject({
      behavior: "deny",
      toolClass: "permission_management",
    });
    expect(setup("GoalCreate")).toMatchObject({ behavior: "deny", toolClass: "goal_control" });
    expect(setup("UnclassifiedTool")).toMatchObject({
      behavior: "deny",
      toolClass: "unknown",
    });
  });

  it("interactive 同样禁裸命令/凭据，写操作仍 ask", () => {
    expect(
      evaluateAttachmentToolRestriction({ role: "interactive", toolName: "Bash" })?.behavior,
    ).toBe("deny");
    expect(
      evaluateAttachmentToolRestriction({ role: "interactive", toolName: "Write" })?.behavior,
    ).toBe("ask");
    expect(
      evaluateAttachmentToolRestriction({ role: "interactive", toolName: "mcp__x" })?.behavior,
    ).toBe("deny");
  });

  it("host 不产生额外限制（沿用既有权限管线）", () => {
    expect(
      evaluateAttachmentToolRestriction({ role: "host", toolName: "Bash" }),
    ).toBeUndefined();
  });

  it("未知角色 fail-closed 到 read_mostly，并在 ruleId 留痕", () => {
    const restriction = evaluateAttachmentToolRestriction({
      role: "full",
      toolName: "Bash",
    });
    expect(restriction).toMatchObject({
      behavior: "deny",
      role: "read_mostly",
      ruleId: "attachment.role.unknown.command_exec",
    });
    expect(
      evaluateAttachmentToolRestriction({ role: undefined, toolName: "Read" })?.behavior,
    ).toBe("allow");
  });

  it("叠加只收紧不放宽", () => {
    const denyBash = evaluateAttachmentToolRestriction({
      role: "read_mostly",
      toolName: "Bash",
    });
    const askWrite = evaluateAttachmentToolRestriction({
      role: "read_mostly",
      toolName: "Write",
    });
    expect(composeAttachmentPermissionDecision("allow", undefined)).toBe("allow");
    expect(composeAttachmentPermissionDecision("allow", denyBash)).toBe("deny");
    expect(composeAttachmentPermissionDecision("deny", askWrite)).toBe("deny");
    expect(composeAttachmentPermissionDecision("allow", askWrite)).toBe("ask");
    expect(composeAttachmentPermissionDecision("ask", askWrite)).toBe("ask");
  });

  it("工具分类对 MCP/插件/CUA 一律归凭据类，避免“看起来只读”的扩展工具放行", () => {
    expect(classifyAttachmentTool("mcp__fs__read")).toBe("credential");
    expect(classifyAttachmentTool("plugin_item")).toBe("credential");
    expect(classifyAttachmentTool("OfficialCua")).toBe("credential");
    expect(classifyAttachmentTool("Read")).toBe("read");
    expect(classifyAttachmentTool("SomeNewTool")).toBe("unknown");
  });
});
