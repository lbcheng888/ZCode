import { z } from "zod";

/**
 * P6 设备权限矩阵的共享契约（docs/architecture/super-agent-p6-capabilities-spec.md §1）。
 *
 * 权威归属：角色只能由宿主侧 attachment 记录派生，客户端自报（clientKind / 命令信封）永远
 * 只当提示，不能提权。未知、缺失、无法解析的角色一律按 `read_mostly` fail-closed，
 * **不得**落到 `host`。
 *
 * 本批范围：角色权威 + 工具矩阵 + admission 复核所需的纯函数。能力票据与 OS egress 围栏
 * 不在本批（spec §2/§3），因此这里没有任何 ticket / fence 字段。
 *
 * 状态（不夸大）：这里只有契约与纯函数。生产 enforcement（v4 连接登记绑定 attachmentId/role、
 * core `PermissionContext.attachment` 叠加矩阵结论）尚未接线，P6 设备权限当前未生效；
 * 不得据此宣称设备矩阵已落地（spec §1.6 的 D1 类型面，D2 enforcement 仍待实现）。
 */

/** 角色枚举（spec §1.3）。`host` 只从宿主本机连接派生，不能由客户端声明。 */
export const attachmentRoleSchema = z.enum(["host", "interactive", "read_mostly"]);
export type AttachmentRole = z.infer<typeof attachmentRoleSchema>;

export const ATTACHMENT_ROLES: readonly AttachmentRole[] = [
  "host",
  "interactive",
  "read_mostly",
] as const;

/** 远端/未知 attachment 的缺省角色；也是所有解析失败的落点。 */
export const DEFAULT_REMOTE_ATTACHMENT_ROLE = "read_mostly" as const satisfies AttachmentRole;

/** clientKind 只是提示，不是身份（spec §1.1）。与 v4 transport 的 clientHello 共用同一枚举。 */
export const clientKindSchema = z.enum(["desktop", "web", "mobileRemote", "mobileApp"]);
export type ClientKind = z.infer<typeof clientKindSchema>;

/**
 * 未知角色 fail-closed：不能假设“没写就是 host”，也不能把数值 0 当 host。
 * 只有精确命名的三个角色才被接受，其余（undefined / null / 0 / 任意字符串）全部落到
 * `read_mostly`。
 */
export function parseAttachmentRole(value: unknown): AttachmentRole {
  const parsed = attachmentRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_REMOTE_ATTACHMENT_ROLE;
}

/** 宿主连接事实：clientMode 由 Main/Host 注入，不接受远端客户端输入。 */
export type HostAttachmentClientMode = "desktop-continuous" | "web-remote-replayable";

/**
 * 从宿主 attachment 记录派生角色。
 *
 * - `revoked` 为 true ⇒ **undefined**：吊销不是降级，下一次 admission 前必须拒绝全部动作
 *   （spec §1.4 / D5），不能映射成仍可读的 `read_mostly`；调用方必须按 fail-closed 处理。
 * - 宿主显式授予 `interactive`（spec：唯一可授予角色）⇒ interactive。
 * - `desktop-continuous` ⇒ host（Desktop 主进程/本机宿主会话；本地 CLI/TUI 无 attachment
 *   语义时由调用方直接按 host 处理，不经过本函数）。
 * - 其余（`web-remote-replayable`、未知/缺失）⇒ read_mostly。
 *
 * `grantedRole` 若为未知值不会提权，按未知角色 fail-closed 处理；`clientKind` 不在入参里，
 * 从结构上保证伪造 clientKind 无法参与角色计算。
 */
export function resolveHostAttachmentRole(evidence: {
  clientMode: HostAttachmentClientMode;
  grantedRole?: unknown;
  revoked?: boolean;
}): AttachmentRole | undefined {
  if (evidence.revoked === true) return undefined;

  const granted = attachmentRoleSchema.safeParse(evidence.grantedRole);
  if (granted.success) {
    // 只接受宿主显式授予的 interactive / 降级 read_mostly；host 只能由本机连续连接派生。
    if (granted.data === "interactive") return "interactive";
    if (granted.data === "read_mostly") return "read_mostly";
  }

  return evidence.clientMode === "desktop-continuous"
    ? "host"
    : DEFAULT_REMOTE_ATTACHMENT_ROLE;
}

/** 规则级设备范围（additive；spec §1.3）。没有 deviceScope 的既有规则只对 host 生效。 */
export const deviceScopeSchema = z
  .object({
    /** 命中角色才应用该规则。 */
    roles: z.array(attachmentRoleSchema).min(1).optional(),
    /** 仅提示层过滤，不作权威。 */
    kinds: z.array(clientKindSchema).min(1).optional(),
    /** 宿主登记的设备指纹。 */
    deviceIds: z.array(z.string().min(1)).min(1).optional(),
    /** 精确附件。 */
    attachmentIds: z.array(z.string().min(1)).min(1).optional(),
  })
  // 前向兼容：未来的 scope 维度不应让旧解析整体失败；未知键不参与判定。
  // 判定侧见 ruleAppliesToAttachment：只有未知维度的 scope 不对非 host 生效。
  .passthrough();
export type DeviceScope = z.infer<typeof deviceScopeSchema>;

/** prompt admission 绑定的附件上下文（spec §1.3）；role 必须是宿主派生的权威值。 */
export const attachmentContextSchema = z
  .object({
    attachmentId: z.string().min(1),
    role: attachmentRoleSchema,
    deviceKind: clientKindSchema.optional(),
    deviceId: z.string().min(1).optional(),
    /** 附件所属 workspace；跨 workspace 由调用方 fail-closed。 */
    workspaceIdentity: z.string().min(1).optional(),
  })
  .passthrough();
export type AttachmentContext = z.infer<typeof attachmentContextSchema>;

/** deviceScope 的存储/索引键：`workspaceIdentity\0surfaceKind`（spec §1.3 的 workspace 绑定）。 */
export function resolveDeviceScopeKey(input: {
  workspaceIdentity: string;
  surfaceKind: ClientKind;
}): string {
  return `${input.workspaceIdentity}\u0000${input.surfaceKind}`;
}

export function parseDeviceScopeKey(
  key: string,
): { workspaceIdentity: string; surfaceKind: ClientKind } | null {
  const separator = key.lastIndexOf("\u0000");
  if (separator <= 0) return null;
  const workspaceIdentity = key.slice(0, separator);
  const surfaceKind = clientKindSchema.safeParse(key.slice(separator + 1));
  if (!workspaceIdentity || !surfaceKind.success) return null;
  return { workspaceIdentity, surfaceKind: surfaceKind.data };
}

/**
 * 附件上下文来源。必须由宿主侧连接来源显式给出，不能靠“字段是否存在”推断：
 * 本地 CLI/TUI/Desktop 进程内会话没有 attachment 语义（host）；远端连接缺失 attachment
 * 身份时按 read_mostly fail-closed（spec §1.3 规则 4 / D4）。
 */
export type AttachmentContextSource = "local-host" | "remote";

/** 当前附件上下文的权威角色；来源显式传入，避免把远端缺失记录误判成 host。 */
export function resolveAttachmentContextRole(
  context: AttachmentContext | undefined,
  source: AttachmentContextSource,
): AttachmentRole {
  if (context !== undefined) return parseAttachmentRole(context.role);
  // 远端连接但 attachmentId/role 缺失或 registry 查不到：read_mostly，绝不落到 host。
  return source === "local-host" ? "host" : DEFAULT_REMOTE_ATTACHMENT_ROLE;
}

/**
 * 规则是否适用于当前附件。无 scope 的既有规则只对 host 生效，这是防“桌面 allow 规则被手机
 * 继承”的关键（spec §1.3 匹配规则 2）。
 */
export function ruleAppliesToAttachment(
  scope: DeviceScope | undefined,
  context: AttachmentContext | undefined,
  source: AttachmentContextSource,
): boolean {
  const role = resolveAttachmentContextRole(context, source);
  if (scope === undefined) return role === "host";
  /**
   * `deviceScope` 只带未来/未知维度时，旧代码无法判定命中；非 host 一律不参与匹配，
   * 防止一条只声明未知维度的 allow 规则被所有远端角色继承（未知字段是前向兼容，
   * 不是扩大命中面）。host 保持与“无 scope”一致。
   */
  const hasKnownDimension =
    scope.roles !== undefined ||
    scope.kinds !== undefined ||
    scope.deviceIds !== undefined ||
    scope.attachmentIds !== undefined;
  if (!hasKnownDimension) return role === "host";
  if (scope.roles && !scope.roles.includes(role)) return false;
  // kinds 只是提示层过滤：上下文没有 deviceKind 时不命中需要 kinds 的规则。
  if (scope.kinds && !(context?.deviceKind && scope.kinds.includes(context.deviceKind))) {
    return false;
  }
  if (scope.deviceIds && !(context?.deviceId && scope.deviceIds.includes(context.deviceId))) {
    return false;
  }
  if (
    scope.attachmentIds &&
    !(context && scope.attachmentIds.includes(context.attachmentId))
  ) {
    return false;
  }
  return true;
}

/** 工具族（spec §1.3 矩阵的行）。 */
export type AttachmentToolClass =
  | "read"
  | "workspace_write"
  | "command_exec"
  | "network"
  | "channel"
  | "credential"
  | "permission_management"
  | "goal_control"
  | "unknown";

const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "TodoRead",
  "List",
  "GoalRead",
  "OffPeakList",
  "CronList",
]);

const WORKSPACE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "ApplyPatch",
  "NotebookEdit",
  // 会话内状态写入同样是有副作用的写操作；远端角色按“降级为需要确认”处理。
  "TodoWrite",
]);

const COMMAND_EXEC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Bash",
  "BashOutput",
  "KillShell",
  "Terminal",
  "js",
]);

const NETWORK_TOOL_NAMES: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);

const CHANNEL_TOOL_NAMES: ReadonlySet<string> = new Set(["SendMessage", "ReplyToChannel"]);

const GOAL_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
  "Skill",
  "Workflow",
  "CreateWorkflow",
  "AmendWorkflow",
  "FillWorkflowHole",
  "EvalWorkflowSnippet",
  "CronCreate",
  "CronUpdate",
  "CronDelete",
  "GoalCreate",
  "GoalUpdate",
  "GoalBlock",
  "OffPeakCreate",
  "Escalate",
]);

const PERMISSION_MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "PermissionUpdate",
  "PermissionRule",
  "PermissionGrant",
  "AlwaysAllow",
]);

function isCredentialTool(toolName: string, permissionGroup?: string): boolean {
  if (permissionGroup === "official_cua") return true;
  if (toolName.startsWith("mcp__") || toolName.startsWith("plugin_")) return true;
  return /cua|computeruse|credential/i.test(toolName);
}

/**
 * 工具分类。未知工具按 `unknown` 处理，远端角色在矩阵里对 unknown 一律 deny（fail-closed），
 * 不靠“看起来像读”放行。
 */
export function classifyAttachmentTool(
  toolName: string,
  permissionGroup?: string,
): AttachmentToolClass {
  if (isCredentialTool(toolName, permissionGroup)) return "credential";
  if (READ_TOOL_NAMES.has(toolName)) return "read";
  if (WORKSPACE_WRITE_TOOL_NAMES.has(toolName)) return "workspace_write";
  if (COMMAND_EXEC_TOOL_NAMES.has(toolName)) return "command_exec";
  if (NETWORK_TOOL_NAMES.has(toolName)) return "network";
  if (CHANNEL_TOOL_NAMES.has(toolName)) return "channel";
  if (PERMISSION_MANAGEMENT_TOOL_NAMES.has(toolName)) return "permission_management";
  if (GOAL_CONTROL_TOOL_NAMES.has(toolName)) return "goal_control";
  return "unknown";
}

export type PermissionBehavior = "allow" | "ask" | "deny";

export interface AttachmentToolRestriction {
  behavior: PermissionBehavior;
  role: AttachmentRole;
  toolClass: AttachmentToolClass;
  ruleId: string;
  reason: string;
}

const MATRIX: Record<
  Exclude<AttachmentRole, "host">,
  Record<AttachmentToolClass, PermissionBehavior>
> = {
  // spec §1.3 矩阵。写操作是“降级为需要确认”，不是自动放行；交互设备是否能在设备上回答
  // ask 属于确认面路由（D3），不在本批决定 behavior。
  //
  // 限制（不夸大）：D3 确认面路由尚未实现，interactive 与 read_mostly 目前矩阵同值，
  // 授予 interactive 当前只是标签，没有任何行为提升；产品面不得把它描述成更高权限角色。
  interactive: {
    read: "allow",
    workspace_write: "ask",
    command_exec: "deny",
    network: "deny",
    channel: "deny",
    credential: "deny",
    permission_management: "deny",
    goal_control: "deny",
    unknown: "deny",
  },
  read_mostly: {
    read: "allow",
    workspace_write: "ask",
    command_exec: "deny",
    network: "deny",
    channel: "deny",
    credential: "deny",
    permission_management: "deny",
    goal_control: "deny",
    unknown: "deny",
  },
} as const;

/**
 * 附件角色的工具矩阵复核。`host` 返回 undefined = 不产生额外限制，沿用既有权限管线；
 * 其余角色返回一条**只能收紧、不能放宽**的限制，调用方用 `composeAttachmentPermissionDecision`
 * 与既有结论合并。
 *
 * 角色未知时按 `read_mostly` 处理并在 ruleId 上留痕，便于审计“角色缺失 fail-closed”。
 */
export function evaluateAttachmentToolRestriction(input: {
  role: unknown;
  toolName: string;
  permissionGroup?: string;
}): AttachmentToolRestriction | undefined {
  const parsed = attachmentRoleSchema.safeParse(input.role);
  const role = parsed.success ? parsed.data : DEFAULT_REMOTE_ATTACHMENT_ROLE;
  if (role === "host") return undefined;

  const toolClass = classifyAttachmentTool(input.toolName, input.permissionGroup);
  const behavior = MATRIX[role][toolClass];
  const ruleId = parsed.success
    ? `attachment.matrix.${role}.${toolClass}`
    : `attachment.role.unknown.${toolClass}`;
  const roleDescription = parsed.success ? role : `${String(input.role)} (unknown -> read_mostly)`;
  return {
    behavior,
    role,
    toolClass,
    ruleId,
    reason:
      behavior === "allow"
        ? `Attachment role ${roleDescription} may run ${toolClass} within the workspace`
        : behavior === "ask"
          ? `Attachment role ${roleDescription} requires host confirmation for ${toolClass}`
          : `Attachment role ${roleDescription} denies ${toolClass}`,
  };
}

const BEHAVIOR_RESTRICTIVENESS: Record<PermissionBehavior, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * 把附件限制叠加到既有权限结论上。只允许收紧（deny > ask > allow），保证设备矩阵不会把
 * 桌面 allow 规则或 hook 放行重新放宽。
 */
export function composeAttachmentPermissionDecision(
  base: PermissionBehavior,
  restriction: AttachmentToolRestriction | undefined,
): PermissionBehavior {
  if (restriction === undefined) return base;
  return BEHAVIOR_RESTRICTIVENESS[restriction.behavior] >
    BEHAVIOR_RESTRICTIVENESS[base]
    ? restriction.behavior
    : base;
}
