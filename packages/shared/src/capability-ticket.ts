import { z } from "zod";
import {
  attachmentRoleSchema,
  attachmentToolClassSchema,
  classifyAttachmentTool,
  clientKindSchema,
  parseAttachmentRole,
  type AttachmentRole,
  type AttachmentToolClass,
} from "./attachment-role.js";

/**
 * P6 能力票据的共享契约（docs/architecture/super-agent-p6-capabilities-spec.md §2）。
 *
 * 边界与权威：
 * - 票据是「设备/附件 → 执行面」的一次受限授权句柄，不是配额票据、不是模型并发槽位。
 * - 签发/兑换/吊销的权威在宿主侧 broker（本批落 `packages/desktop/src/host/` 的内存权威）；
 *   daemon 不承载签发凭据的 broker（spec §2.5）。
 * - `ticketSecret` **绝不**出现在本模块的任何协议结构里：这里只定义公开票据描述、兑换请求
 *   （兑换请求是 broker 专用受控通道，不是协议帧）与模型上下文投影。
 * - 未知字段 additive 兼容；未知 scope 维度不放大命中面，判定侧 fail-closed。
 *
 * 状态（不夸大）：本批只有类型/纯函数 + 宿主内存 broker + 客户端携带/兑换。凭据注入
 * （spec §2.5 C2）、SQLite `capability_tickets` 持久表、edge/headless 独立 broker 进程均
 * 未实现；broker 重启即全部票据失效（C7 由内存权威天然满足）。生产组合根默认关闭票据
 * （显式 feature flag + fail-closed），执行端 admission 尚未消费 capabilityTicketId。
 */

/** 公开票据句柄；协议帧/执行层可见，模型上下文按 §5 开放问题 6 暂不承诺可见。 */
export const capabilityTicketIdSchema = z.string().min(1);
export type CapabilityTicketId = z.infer<typeof capabilityTicketIdSchema>;

/**
 * 票据绑定主体。spec §2.3 写作 `workspaceIdentity + attachmentId + deviceId? + subject(...)`。
 * `subject` **必须**由签发方在执行期给出（run/trigger/session 之一）。把它定义成 optional
 * 会让“签发时缺省、兑换时也缺省”的双方缺省判定成匹配，等价于票据只绑定 attachment，
 * 同一附件上任意 run/session/trigger 都能复用；因此这里改为必填，缺失一律解析失败。
 * 附件建立时尚无 run 时，宿主用所属 session id 签发（见 windowHostAttachmentRegistry）。
 */
export const capabilityTicketSubjectSchema = z
  .object({
    kind: z.enum(["run", "trigger", "session"]),
    id: z.string().min(1),
  })
  .passthrough();
export type CapabilityTicketSubject = z.infer<typeof capabilityTicketSubjectSchema>;

export const capabilityTicketBindingSchema = z
  .object({
    workspaceIdentity: z.string().min(1),
    attachmentId: z.string().min(1),
    deviceId: z.string().min(1).optional(),
    /** 连接面形态；由宿主派生，不接受客户端自报。 */
    surfaceKind: clientKindSchema,
    subject: capabilityTicketSubjectSchema,
  })
  .passthrough();
export type CapabilityTicketBinding = z.infer<typeof capabilityTicketBindingSchema>;

/**
 * scope 只写「允许的工具族/工具名/资源」。维度之间是**合取**：任何存在的维度都必须命中；
 * 完全不声明工具维度 ⇒ 不命中任何动作（fail-closed，不靠“资源看起来对”放行）。
 */
export const capabilityTicketScopeSchema = z
  .object({
    toolClasses: z.array(attachmentToolClassSchema).min(1).optional(),
    tools: z.array(z.string().min(1)).min(1).optional(),
    resources: z.array(z.string().min(1)).min(1).optional(),
  })
  .passthrough();
export type CapabilityTicketScope = z.infer<typeof capabilityTicketScopeSchema>;

export const capabilityTicketModeSchema = z.enum(["single_use", "sequential"]);
export type CapabilityTicketMode = z.infer<typeof capabilityTicketModeSchema>;

export const capabilityTicketStateSchema = z.enum([
  "issued",
  "active",
  "consumed",
  "expired",
  "revoked",
]);
export type CapabilityTicketState = z.infer<typeof capabilityTicketStateSchema>;

/**
 * 公开票据描述。没有 secret 字段是结构性的：即使调用方塞进未知字段（passthrough 为前向
 * 兼容），投影/日志路径必须用 `projectCapabilityTicketForModelContext` 剥离。
 */
export const capabilityTicketSchema = z
  .object({
    ticketId: capabilityTicketIdSchema,
    binding: capabilityTicketBindingSchema,
    scope: capabilityTicketScopeSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    /** broker 的单调吊销 epoch 在签发时的快照；吊销后推进。 */
    revocationEpoch: z.number().int().nonnegative(),
    state: capabilityTicketStateSchema,
    redeemedAt: z.number().int().nonnegative().optional(),
    revokedAt: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type CapabilityTicket = z.infer<typeof capabilityTicketSchema>;

export const issueCapabilityTicketRequestSchema = z
  .object({
    binding: capabilityTicketBindingSchema,
    scope: capabilityTicketScopeSchema,
    /** 宿主派生的权威角色；决定可申请的 scope 上限。 */
    role: attachmentRoleSchema,
    mode: capabilityTicketModeSchema.optional(),
    ttlMs: z.number().int().positive().optional(),
  })
  .passthrough();
export type IssueCapabilityTicketRequest = z.infer<typeof issueCapabilityTicketRequestSchema>;

/** 兑换动作面：工具名 + 可选权限组/资源。 */
export const capabilityTicketActionSchema = z
  .object({
    toolName: z.string().min(1),
    permissionGroup: z.string().min(1).optional(),
    resource: z.string().min(1).optional(),
  })
  .passthrough();
export type CapabilityTicketAction = z.infer<typeof capabilityTicketActionSchema>;

/**
 * 兑换请求只在 broker 受控通道上传输（含 secret），**不得**作为协议帧或模型上下文内容。
 * `nonce` 单票去重；`seq` 为 sequential 票据的单调序号；`revocationEpoch` **必填**，调用端
 * 必须携带签发时拿到的 epoch，broker 与当前 epoch 不等即拒绝（吊销传播 fail-closed）。
 * 允许省略就等于给出“跳过吊销校验”的旁路，因此这里不接受缺省。
 */
export const capabilityTicketRedeemRequestSchema = z
  .object({
    ticketId: capabilityTicketIdSchema,
    ticketSecret: z.string().min(1),
    binding: capabilityTicketBindingSchema,
    action: capabilityTicketActionSchema,
    nonce: z.string().min(1),
    seq: z.number().int().positive().optional(),
    revocationEpoch: z.number().int().nonnegative(),
  })
  .passthrough();
export type CapabilityTicketRedeemRequest = z.infer<typeof capabilityTicketRedeemRequestSchema>;

export const CAPABILITY_TICKET_FAILURE_CODES = [
  "ticket.unknown",
  "ticket.expired",
  "ticket.revoked",
  "ticket.binding_mismatch",
  "ticket.replayed",
  "ticket.scope_denied",
  "ticket.broker_unavailable",
] as const;
export type CapabilityTicketFailureCode = (typeof CAPABILITY_TICKET_FAILURE_CODES)[number];

/**
 * 兑换成功返回一次性注入句柄。句柄仍不含 secret；凭据注入属于 §2.5 C2，本批不接线。
 *
 * `requiresHostConfirmation` 表达 spec §1.3 矩阵里 workspace_write 的 `ask`：兑换成功**不等于**
 * 自动放行，执行端必须把这次动作路由到宿主确认面。D3 确认面未落地前，非 host 角色不允许
 * 申请 workspace_write scope（签发侧直接拒绝），此字段是执行端不得省略的兜底契约。
 */
export interface CapabilityTicketInjectionHandle {
  ticketId: string;
  binding: CapabilityTicketBinding;
  scope: CapabilityTicketScope;
  expiresAt: number;
  /** 兑换时 broker 的当前吊销 epoch；签发时快照与当前值必须相等才会成功。 */
  revocationEpoch: number;
  requiresHostConfirmation: boolean;
}

export type CapabilityTicketRedeemResult =
  | { ok: true; ticketId: string; injection: CapabilityTicketInjectionHandle }
  | { ok: false; code: CapabilityTicketFailureCode; message: string };

/** TTL 草案（spec §2.3 规则 5，未标定值，按上限实现，不写成承诺）。 */
export const CAPABILITY_TICKET_TOOL_TTL_MS = 5 * 60_000;
export const CAPABILITY_TICKET_RUN_TTL_MS = 15 * 60_000;
export const CAPABILITY_TICKET_MAX_TTL_MS = 60 * 60_000;

export function resolveCapabilityTicketTtlMs(
  mode: CapabilityTicketMode,
  requestedTtlMs?: number,
): number {
  if (requestedTtlMs !== undefined) return requestedTtlMs;
  return mode === "sequential"
    ? CAPABILITY_TICKET_RUN_TTL_MS
    : CAPABILITY_TICKET_TOOL_TTL_MS;
}

const ALL_TOOL_CLASSES: readonly AttachmentToolClass[] = attachmentToolClassSchema.options;

/**
 * 角色可**申请**的工具族上限（spec §1.3 矩阵 + §2.5）：
 * - host：沿用既有权限管线，票据可覆盖全部工具族。
 * - interactive：当前只允许 read。矩阵里 workspace_write 是 `ask`，但宿主确认路由（D3）
 *   未落地，票据兑换无法表达/执行“先 ask”；在确认面接线前不允许非 host 申请写 scope
 *   （fail-closed），避免执行端把兑换成功误当授权。
 * - read_mostly：只能申请 read；凭据/裸命令等永远不可申请。
 */
const REQUESTABLE_TOOL_CLASSES_BY_ROLE: Record<
  AttachmentRole,
  readonly AttachmentToolClass[]
> = {
  host: ALL_TOOL_CLASSES,
  interactive: ["read"],
  read_mostly: ["read"],
};

/**
 * 角色缺省 scope。写操作在矩阵里是 `ask`（必须宿主确认），票据本身不能替代确认面，
 * 因此非 host 的缺省 scope 只给 `read`。D3 宿主确认路由落地前，非 host 连显式
 * workspace_write scope 都不能申请（见 REQUESTABLE_TOOL_CLASSES_BY_ROLE）。
 */
export function deriveCapabilityTicketScopeForRole(
  role: AttachmentRole,
): CapabilityTicketScope {
  const parsed = parseAttachmentRole(role);
  if (parsed === "host") return { toolClasses: [...ALL_TOOL_CLASSES] };
  return { toolClasses: ["read"] };
}

/** scope 是否在角色允许的上限内；不合法一律 false（调用方 fail-closed）。 */
export function capabilityTicketScopeWithinRole(
  role: unknown,
  scope: CapabilityTicketScope,
): boolean {
  const parsedRole = parseAttachmentRole(role);
  const allowed = REQUESTABLE_TOOL_CLASSES_BY_ROLE[parsedRole];
  // 完全不声明工具维度（只写 resources）无法证明动作面，非 host 一律拒绝。
  if (scope.toolClasses === undefined && scope.tools === undefined) return false;
  if (
    scope.toolClasses !== undefined &&
    scope.toolClasses.some((toolClass) => !allowed.includes(toolClass))
  ) {
    return false;
  }
  if (scope.tools !== undefined) {
    for (const toolName of scope.tools) {
      const toolClass = classifyAttachmentTool(toolName);
      if (!allowed.includes(toolClass)) return false;
    }
  }
  return true;
}

/**
 * 把 tools-only scope 归一为带 toolClasses 的 scope：按工具名（不看调用方给的 permissionGroup）
 * 分类。签发侧必须调用，保证票据自身携带工具族约束，兑换时不能靠重算分类绕过。
 */
export function normalizeCapabilityTicketScope(
  scope: CapabilityTicketScope,
): CapabilityTicketScope {
  if (scope.toolClasses !== undefined || scope.tools === undefined) return scope;
  const toolClasses = Array.from(
    new Set(scope.tools.map((toolName) => classifyAttachmentTool(toolName))),
  );
  return { ...scope, toolClasses };
}

/**
 * 动作是否命中 scope。存在的维度必须全部命中；没有工具维度即拒绝。
 *
 * tools-only scope 也必须校验工具族：调用方可以在兑换时提供 `permissionGroup`，若只看
 * `tools` 名单，`{toolName:"Read", permissionGroup:"official_cua"}` 会被分类为 credential
 * 却仍命中 `{tools:["Read"]}`。这里在 scope 缺 toolClasses 时按工具名重建族约束。
 */
export function capabilityTicketScopeAllows(
  scope: CapabilityTicketScope,
  action: CapabilityTicketAction,
): boolean {
  if (scope.toolClasses === undefined && scope.tools === undefined) return false;
  const toolClass = classifyAttachmentTool(action.toolName, action.permissionGroup);
  if (scope.toolClasses !== undefined && !scope.toolClasses.includes(toolClass)) return false;
  if (scope.tools !== undefined) {
    if (!scope.tools.includes(action.toolName)) return false;
    if (scope.toolClasses === undefined) {
      const declaredClasses = new Set(
        scope.tools.map((toolName) => classifyAttachmentTool(toolName)),
      );
      if (!declaredClasses.has(toolClass)) return false;
    }
  }
  if (scope.resources !== undefined) {
    if (action.resource === undefined) return false;
    if (!scope.resources.includes(action.resource)) return false;
  }
  return true;
}

/**
 * 绑定比较。`subject` 是必填维度；schema 已保证签发侧给出，但这里仍对运行期缺省做
 * fail-closed（任一侧缺 subject 即不匹配），不能把“双方都缺省”当成匹配。
 * `deviceId` 保持 optional；只在一侧声明时同样不匹配（缺失不能放宽绑定）。
 */
export function capabilityTicketBindingsMatch(
  expected: CapabilityTicketBinding,
  actual: CapabilityTicketBinding,
): boolean {
  if (expected.workspaceIdentity !== actual.workspaceIdentity) return false;
  if (expected.attachmentId !== actual.attachmentId) return false;
  if (expected.surfaceKind !== actual.surfaceKind) return false;
  if (expected.deviceId !== undefined || actual.deviceId !== undefined) {
    if (expected.deviceId === undefined || actual.deviceId === undefined) return false;
    if (expected.deviceId !== actual.deviceId) return false;
  }
  if (expected.subject === undefined || actual.subject === undefined) return false;
  if (expected.subject.kind !== actual.subject.kind) return false;
  if (expected.subject.id !== actual.subject.id) return false;
  return true;
}

/** 绑定的稳定序列化键，用于索引/审计；不包含 secret。 */
export function serializeCapabilityTicketBinding(binding: CapabilityTicketBinding): string {
  return [
    binding.workspaceIdentity,
    binding.attachmentId,
    binding.deviceId ?? "",
    binding.surfaceKind,
    `${binding.subject.kind}:${binding.subject.id}`,
  ].join("\u0000");
}

/**
 * 模型上下文投影：只保留公开 ticketId。模型拿不到 secret，ticketId 单独不可用（spec §2.1）。
 * 调用方不得直接把 `CapabilityTicket` 原样塞进 prompt/rollout。
 */
export function projectCapabilityTicketForModelContext(ticket: {
  ticketId: string;
}): { ticketId: string } {
  return { ticketId: ticket.ticketId };
}

/** 协议帧只允许公开 ticketId；secret 任何情况下都不进协议（spec §2.3 规则 7）。 */
export function projectCapabilityTicketForProtocol(ticket: {
  ticketId: string;
}): { capabilityTicketId: string } {
  return { capabilityTicketId: ticket.ticketId };
}
