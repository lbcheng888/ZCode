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
 * 状态（不夸大）：本批有类型/纯函数 + 宿主内存 broker + 客户端携带/兑换 + C2 凭据注入
 * 接线。凭据注入复用既有 agent→host 官方 MCP 身份头通道：CLI 工具执行 ALS 只携带公开票据
 * 句柄，宿主在 resolver 前用同一 broker 校验票据并要求 scope.resources 含本次 credential
 * 资源。无真实注入通道时 credential 类工具 typed deny（`ticket.credential_injection_unavailable`）。
 * 仍缺：SQLite `capability_tickets` 持久表、edge/headless 独立 broker 进程；
 * broker 重启即全部票据失效（C7 由内存权威天然满足）。生产组合根默认关闭票据
 * （显式 feature flag + fail-closed）。执行端 admission 已消费 capabilityTicketId：宿主入口
 * 经 broker 校验后把公开授权域随可信 carrier 下发给 CLI，CLI prompt admission 在既有权限
 * 管线之后按 scope 只收紧。
 * 已知残留：CLI 在 turn 内无宿主控制面通道复核吊销（吊销只在下一条命令 admission 生效）；
 * desktop-continuous 的 renderer 命令信封已由 messageport 包装自动携带 ticketId，web/mobile
 * relay 形态不投递 secret、不签发票据；`revocationEpoch` 在 CLI 侧是签发快照，不参与判定。
 */

/**
 * 公开票据句柄；协议帧/执行层可见，模型上下文按 §5 开放问题 6 暂不承诺可见。
 *
 * 同时是日志/协议边界约束：ticketId 由宿主生成（base64url），客户端也可能在兑换帧里
 * 自带任意 ticketId。限制字符集与长度，避免换行/超长载荷被原样拼进宿主日志（日志注入/防洪）。
 * 非法 ID 在解析阶段就失败，拒绝路径不会把它写进日志。
 */
export const capabilityTicketIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
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
 * scope 只写「允许的工具族/工具名/凭据资源」。
 *
 * - `toolClasses` / `tools` 是工具维度，维度之间是**合取**：存在的维度必须全部命中；
 *   完全不声明工具维度 ⇒ 不命中任何动作（fail-closed）。
 * - `resources` 描述**凭据通道**（`credential:official-mcp` 主机级标记，或窄票据的
 *   `credential:<mcpKey>` / `credential:<pluginId>`）。它只约束 `credential` 类动作，
 *   不参与非凭据工具的判定（否则同一票据里的 Read/Write 会被误杀）。credential 动作
 *   存在 resources 时必须有可证明的通道命中：MCP/plugin 交给宿主在读取凭据前精确复核，
 *   CUA 只接受主机级标记 + 宿主注入的 broker socket；无法证明即 fail-closed。
 */
export const capabilityTicketScopeSchema = z
  .object({
    toolClasses: z.array(attachmentToolClassSchema).min(1).optional(),
    tools: z.array(z.string().min(1)).min(1).optional(),
    resources: z.array(z.string().min(1)).min(1).optional(),
  })
  .passthrough();
export type CapabilityTicketScope = z.infer<typeof capabilityTicketScopeSchema>;

/**
 * P6 C2：官方 MCP 身份头凭据资源（精确项，不做前缀匹配）。
 *
 * 宿主官方 MCP 身份头解析器是 **host 级**通道：用户身份/JWT 与 Coding Plan 凭证是全局
 * 状态，不按 mcpKey/pluginId 分桶；签发 attachment 票据时宿主也无法枚举远端 workspace
 * 里配置了哪些官方 MCP server。因此 host 角色票据声明这个主机级资源；执行侧只认精确
 * 字符串，缺失即 fail-closed。不要用“任意 `credential:` 前缀命中”代替它。
 */
export const CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE = "credential:official-mcp";

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
 * 必须携带**本票据**签发时的 epoch，与该票据自身的 epoch 不等即拒绝（吊销传播 fail-closed）。
 * 注意不是 broker 全局 epoch：多个 attachment 共享 broker 时，吊销别的票据不应误伤未受影响的授权。
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
  // 票据启用的 attachment 上，命令没有携带 capabilityTicketId。宿主入口 fail-closed，
  // 不把“漏带票据”静默降级成无票据旧路径。
  "ticket.required",
] as const;
export type CapabilityTicketFailureCode = (typeof CAPABILITY_TICKET_FAILURE_CODES)[number];

/**
 * 能力票据 admission 反向控制面（spec §2.5 C2）。
 *
 * 远端执行面（desktop-attached remote server）的 agent 反向请求官方 MCP 身份头时，
 * **必须**由真正持有 broker 的 Desktop Host 校验票据；server 进程只通过已鉴权的
 * host 连接私有反向频道转发 admission。请求/响应都只含公开事实，secret 永不进入该频道。
 */
export const CAPABILITY_TICKET_ADMISSION_RELAY_CHANNEL = "host-capability-ticket-admission";

export const capabilityTicketAdmissionRelayRequestSchema = z
  .object({
    ticketId: capabilityTicketIdSchema,
    binding: capabilityTicketBindingSchema,
  })
  .strict();
export type CapabilityTicketAdmissionRelayRequest = z.infer<
  typeof capabilityTicketAdmissionRelayRequestSchema
>;

/**
 * admission 授权域（公开事实，无 secret）。与 broker.admit 的返回结构一致；远端宿主
 * 拿到后还要按真正的 credential 资源复核。`credentialInjection` 由 Desktop Host 在
 * 确认执行面可回连后才宣告。
 */
export const capabilityTicketAdmissionRelayAuthorizationSchema = z
  .object({
    ticketId: capabilityTicketIdSchema,
    binding: capabilityTicketBindingSchema,
    scope: capabilityTicketScopeSchema,
    expiresAt: z.number().int().nonnegative(),
    revocationEpoch: z.number().int().nonnegative(),
    credentialInjection: z.literal("host-interaction").optional(),
  })
  .strict();
export type CapabilityTicketAdmissionRelayAuthorization = z.infer<
  typeof capabilityTicketAdmissionRelayAuthorizationSchema
>;

/**
 * 票据启用策略查询：远端执行宿主据此决定“无票据字段的身份头请求是否必须拒绝”。
 * 只有真正的 broker 持有者（Desktop Host）能回答；未注册频道的旧宿主该调用失败，
 * 远端按“无法证明票据已启用”走旧路径（不得据此伪造票据门）。
 */
export const capabilityTicketAdmissionRelayPolicySchema = z
  .object({ ticketRequired: z.boolean() })
  .strict();
export type CapabilityTicketAdmissionRelayPolicy = z.infer<
  typeof capabilityTicketAdmissionRelayPolicySchema
>;

export const capabilityTicketAdmissionRelayResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      authorization: capabilityTicketAdmissionRelayAuthorizationSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(CAPABILITY_TICKET_FAILURE_CODES),
    })
    .strict(),
]);
export type CapabilityTicketAdmissionRelayResult = z.infer<
  typeof capabilityTicketAdmissionRelayResultSchema
>;

/**
 * 兑换成功返回一次性注入句柄。句柄仍不含 secret；凭据注入（§2.5 C2）复用 agent→host
 * 官方 MCP 身份头通道，宿主只在票据 scope 明确授予对应 credential 资源时解析。
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
  /** 该票据自身的吊销 epoch（签发时快照；票据被吊销后推进）。不是 broker 全局值。 */
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
  // P6 C2：credential 资源是 host 级注入能力；非 host 即使 toolClasses 只含 read 也不能
  // 携带 credential 资源，否则执行端可绕过工具面直接拿官方 MCP 身份头（fail-closed）。
  if (
    parsedRole !== "host" &&
    scope.resources?.some((resource) => resource.startsWith("credential:"))
  ) {
    return false;
  }
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
