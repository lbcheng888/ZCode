/**
 * Daemon ↔ super-agent control-plane child 协议（spec super-agent-milestone-b-spec
 * §2.4 / §3.1–§3.3 / §3.8）。
 *
 * 两层契约共用本模块，但版本号不同：
 * - **生命周期协议**（Supervisor ↔ child 的 IPC）：ready/health/stopped/fatal、
 *   shutdown 命令与 `CONTROL_PLANE_PROTOCOL_VERSION`。本模块从
 *   `packages/zcode-server-cli/src/contracts.ts` 原样迁移，server-cli 改为 re-export；
 * - **数据面 RPC**（Core ↔ child 的本地 socket）：JSONL 帧信封、方法表、错误码。
 *   帧版本固定 `v:1`（§3.1），不能与生命周期协议版本混用。
 *
 * 结构镜像（禁止 import 其它包）：trigger 信封与 `packages/services/src/bots/triggerSink.ts`
 * 的 `TriggerSinkEnvelope` 结构同源，行为差异由两侧注释钉住；本模块不 import
 * `@zcode/services`、`@zcode/bootstrap`、`@zcode/server-cli`。schema 变更必须与镜像源
 * 同批修改，否则跨进程校验会静默错位。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { commandAckSchema, commandEnvelopeSchema } from "./zcode-protocol-v4/command.js";

/**
 * 生命周期协议版本：schema 增删字段必须同批 bump（server-cli 严格解析依赖它）。
 * v3：health 增加 leaderWorkspaceCount / pendingDispatchCount / degraded /
 * workspaceErrors / rejectedPeerCount / protocolErrorCount / followerIngestCount /
 * notEnsuredIngestCount（§2.4/§2.5/§3.8）。
 * v4：`host.autoReplyGuard` 增加 additive-optional 的发送者/寻址事实（senderType /
 * mentionedBot / groupCardAction / elicitation / providerMessageId / commandText /
 * chatType），使 Core 能复用 `admitAutoReplyTurn` 的占额语义；旧 child 仍按缺省值工作。
 */
export const CONTROL_PLANE_PROTOCOL_VERSION = 4;

/** JSONL RPC 帧版本（spec §3.1 `v:1`）；与生命周期协议版本正交。 */
export const CONTROL_PLANE_RPC_VERSION = 1;

/** 单帧上限 256 KiB（spec §3.1）；超限断开并计错。 */
export const CONTROL_PLANE_MAX_FRAME_BYTES = 256 * 1024;

/** 方法超时预算（spec §3.2 / §3.3；调用方未显式给出时使用）。 */
export const CONTROL_PLANE_RPC_TIMEOUTS_MS = {
  "workspace.ensure": 10_000,
  "trigger.ingest": 30_000,
  "schedule.audit": 5_000,
  "lease.list": 2_000,
  "lease.get": 2_000,
  "mandate.resolve": 5_000,
  "wouldAccept.list": 5_000,
  "wouldAccept.promote": 10_000,
  "control.status": 5_000,
  "runs.list": 5_000,
  "host.command": 30_000,
  "host.watchdogCommand": 30_000,
  "host.worker.find": 10_000,
  "host.worker.resume": 60_000,
  "host.worker.createTask": 60_000,
  "host.autoReplyGuard": 5_000,
  "backfill.seeds": 10_000,
} as const satisfies Record<string, number>;

/** 方法名闭集（§3.2 Core→child 与 §3.3 child→Core 合并；方向由注册表区分）。 */
export const CONTROL_PLANE_RPC_METHODS = [
  "workspace.ensure",
  "trigger.ingest",
  "schedule.audit",
  "lease.list",
  "lease.get",
  "mandate.resolve",
  "wouldAccept.list",
  "wouldAccept.promote",
  "control.status",
  "runs.list",
  "host.command",
  "host.watchdogCommand",
  "host.worker.find",
  "host.worker.resume",
  "host.worker.createTask",
  "host.autoReplyGuard",
  "backfill.seeds",
] as const;

export type ControlPlaneRpcMethod = (typeof CONTROL_PLANE_RPC_METHODS)[number];

/**
 * `runs.list`：background_run_registry 的只读投影（S0 可见性出口）。
 * 过滤键都是开集字符串：新增 subsystem 不改协议；limit 由调用方显式给出，服务端仍封顶。
 */
export const runsListParamsSchema = z
  .object({
    kind: z.string().min(1).optional(),
    owner: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    workspaceKey: z.string().min(1).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

export const backgroundRunRowSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    owner: z.string().min(1),
    ownerSession: z.string().min(1).optional(),
    workspaceKey: z.string().min(1).optional(),
    state: z.string().min(1),
    narrowResultRef: z.string().min(1).optional(),
    stallClockRef: z.string().min(1).optional(),
    stalledSince: z.number().int().nonnegative().optional(),
    heartbeat: z.boolean().optional(),
    registeredAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    terminalAt: z.number().int().nonnegative().optional(),
    terminalReason: z.string().min(1).optional(),
  })
  .strict();

export const runsListResultSchema = z.object({ runs: z.array(backgroundRunRowSchema) }).strict();

/**
 * 错误码闭集。`retriable` 由调用方随 code 一并判断：EOF/超时/child 不可达是可重试
 * 503 语义（§3.6），协议的非法形状不可重试。
 */
export const CONTROL_PLANE_RPC_ERROR_CODES = {
  /** 尚未实现的 Core 侧能力（不伪造接线）；retriable=false。 */
  unimplemented: "proto.unimplemented",
  /** params/result 不符合本模块 schema。 */
  invalidParams: "proto.invalidParams",
  /** 该连接/方向未注册此方法。 */
  methodNotSupported: "proto.methodNotSupported",
  /** 帧不是合法 JSON/信封；断开并计错。 */
  protocol: "proto.protocol",
  /** 连接首帧凭据缺失/不匹配；断开并计错（§3.8）。 */
  authFailed: "proto.authFailed",
  /** v4 wire 无 inject 车道（§3.4）。 */
  deliveryLaneUnsupported: "proto.deliveryLaneUnsupported",
  /** 目标 host（Core）当前无可用连接；retriable=true。 */
  hostUnreachable: "proto.hostUnreachable",
  /** 前置 `workspace.ensure` 未完成；装配错误，不重试。 */
  workspaceNotEnsured: "workspace.notEnsured",
  /** 单 workspace 执行异常（§2.6），已计入 health workspaceErrors。 */
  workspaceFailed: "workspace.failed",
} as const;

// ── 生命周期 IPC（Supervisor ↔ child）────────────────────────────────────────

/** health 里 per-workspace 错误摘要条数上限（§2.4 workspaceErrors）。 */
export const CONTROL_PLANE_MAX_WORKSPACE_ERRORS = 32;

const controlPlaneDegradedSchema = z
  .object({
    reason: z.string().min(1).max(500),
    since: z.number().int().nonnegative(),
  })
  .strict();
const controlPlaneWorkspaceErrorSchema = z
  .object({
    workspaceIdentity: z.string().min(1).max(512),
    error: z.string().min(1).max(500),
  })
  .strict();

/**
 * health 字段集（§2.4 B 期扩展）。消息层额外带 `type`，`control-plane-status` 快照
 * 直接复用本 schema，避免两侧严格 schema 漂移（新增字段必须同批 bump 协议版本）。
 */
export const controlPlaneHealthFieldsSchema = z
  .object({
    at: z.number().int().nonnegative(),
    pendingEventCount: z.number().int().nonnegative().optional(),
    /** 当前 leader plane 数（§2.4）。 */
    leaderWorkspaceCount: z.number().int().nonnegative().optional(),
    /** dispatch_requests 非终态行数；未注入桥（tasksIndexReady=false）时缺席。 */
    pendingDispatchCount: z.number().int().nonnegative().optional(),
    /** 只在「曾 ready 后降级」出现（§2.4）。 */
    degraded: controlPlaneDegradedSchema.optional(),
    /** 最近 per-plane 错误摘要（按 workspace 去重，最多 N 条）。 */
    workspaceErrors: z
      .array(controlPlaneWorkspaceErrorSchema)
      .max(CONTROL_PLANE_MAX_WORKSPACE_ERRORS)
      .optional(),
    /** §3.8 peer 认证失败计数（凭据不匹配/无法取得身份）。 */
    rejectedPeerCount: z.number().int().nonnegative().optional(),
    /** §3.1 帧解析/超大帧等协议错误计数。 */
    protocolErrorCount: z.number().int().nonnegative().optional(),
    /** §2.5 follower/未启动 plane 的纯转发 ingest 计数。 */
    followerIngestCount: z.number().int().nonnegative().optional(),
    /** §3.6 启动窗口内尚无 plane 的 ingest 计数（handled:false，legacy 单跑）。 */
    notEnsuredIngestCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ControlPlaneHealthFields = z.infer<typeof controlPlaneHealthFieldsSchema>;

export const controlPlaneMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      protocolVersion: z.number().int().nonnegative(),
      generation: z.number().int().nonnegative(),
      version: z.string().min(1).optional(),
      releaseId: z.string().min(1).optional(),
    })
    .strict(),
  controlPlaneHealthFieldsSchema.extend({ type: z.literal("health") }).strict(),
  z.object({ type: z.literal("stopped"), reason: z.string().max(500) }).strict(),
  // spec §2.3：启动级不可恢复错误由 child 上报 fatal；Supervisor 按崩溃预算处理。
  z.object({ type: z.literal("fatal"), message: z.string().max(500) }).strict(),
]);
export type ControlPlaneMessage = z.infer<typeof controlPlaneMessageSchema>;

export const controlPlaneCommandSchema = z.object({ command: z.literal("shutdown") }).strict();
export type ControlPlaneCommand = z.infer<typeof controlPlaneCommandSchema>;

// ── 数据面 RPC 信封（§3.1）──────────────────────────────────────────────────

export const controlPlaneRpcRequestSchema = z
  .object({
    v: z.literal(CONTROL_PLANE_RPC_VERSION),
    id: z.string().trim().min(1).max(128),
    method: z.enum(CONTROL_PLANE_RPC_METHODS),
    params: z.unknown(),
  })
  .strict();
export type ControlPlaneRpcRequest = z.infer<typeof controlPlaneRpcRequestSchema>;

export const controlPlaneRpcErrorSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: z.string().max(500),
    retriable: z.boolean(),
  })
  .strict();
export type ControlPlaneRpcError = z.infer<typeof controlPlaneRpcErrorSchema>;

export const controlPlaneRpcSuccessResponseSchema = z
  .object({
    v: z.literal(CONTROL_PLANE_RPC_VERSION),
    id: z.string().trim().min(1).max(128),
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

export const controlPlaneRpcErrorResponseSchema = z
  .object({
    v: z.literal(CONTROL_PLANE_RPC_VERSION),
    id: z.string().trim().min(1).max(128),
    ok: z.literal(false),
    error: controlPlaneRpcErrorSchema,
  })
  .strict();

export const controlPlaneRpcResponseSchema = z.union([
  controlPlaneRpcSuccessResponseSchema,
  controlPlaneRpcErrorResponseSchema,
]);
export type ControlPlaneRpcResponse = z.infer<typeof controlPlaneRpcResponseSchema>;

/**
 * 连接首帧认证（§3.8 的显式凭据握手）。
 *
 * Node 公共 API 不暴露 SO_PEERCRED/LOCAL_PEERPID/GetNamedPipeClientProcessId，且原生绑定
 * 尚未落地；改用 Supervisor 在 daemon 启动期铸造、只写入 0600 文件的共享凭据：client
 * 连接后首帧提交凭据，child 校验通过前不接受任何业务帧。同 UID 可读文件的攻击面仍是
 * 设计 §5 登记的范围；它替代的是「恒拒绝」的 peer resolver，不是内核级 peer 身份。
 */
export const controlPlaneAuthFrameSchema = z
  .object({
    v: z.literal(CONTROL_PLANE_RPC_VERSION),
    auth: z.string().min(16).max(512),
  })
  .strict();
export type ControlPlaneAuthFrame = z.infer<typeof controlPlaneAuthFrameSchema>;

/**
 * 帧 JSON 解析后再走 schema；JSON 本身非法属于协议错误，断开连接。
 */
export function parseControlPlaneRpcRequest(raw: unknown): ControlPlaneRpcRequest {
  return controlPlaneRpcRequestSchema.parse(raw);
}

export function parseControlPlaneRpcResponse(raw: unknown): ControlPlaneRpcResponse {
  return controlPlaneRpcResponseSchema.parse(raw);
}

// ── trigger 信封（结构镜像 packages/services/src/bots/triggerSink.ts）──────────

export const controlPlaneTriggerEnvelopeSchema = z
  .object({
    workspaceIdentity: z.string(),
    source: z.enum(["im", "webhook", "schedule", "ci"]),
    provider: z.string().min(1),
    providerMessageId: z.string().min(1).optional(),
    /** `bot:<botId>+<peer>[/<threadId>]`（intake CONTRACT.md 铸造规则）。 */
    threadKeyHint: z.string().min(1).optional(),
    actor: z
      .object({
        kind: z.enum(["human", "bot", "system"]),
        id: z.string().min(1).optional(),
      })
      .strict(),
    payload: z.record(z.string(), z.unknown()),
    /** 可信出口铸造标记；反序列化后必须为 true（§3.8）。 */
    taint: z.literal(true),
  })
  .strict();
export type ControlPlaneTriggerEnvelope = z.infer<typeof controlPlaneTriggerEnvelopeSchema>;

export const controlPlaneTriggerRouteSchema = z.enum([
  "owned",
  "human_explicit",
  "unowned_candidate",
  "rejected",
]);
export type ControlPlaneTriggerRoute = z.infer<typeof controlPlaneTriggerRouteSchema>;

/** §3.4：ACK 附带投递结果（additive）；candidate/rejected 不带。 */
export const controlPlaneDeliveryStateSchema = z.enum(["routed", "delivery_failed"]);
export type ControlPlaneDeliveryState = z.infer<typeof controlPlaneDeliveryStateSchema>;

/**
 * §3.4 ACK：与 `TriggerSinkOutcome` 同构的判别联合。
 * - handled=true 必须带 triggerId + route（delivery 可选）；
 * - handled=false 不得携带任一字段。
 * 旧实现用可选字段对象，畸形 ACK（如 `{handled:true}` 缺 triggerId）也能通过校验，
 * 会让 Core 按错误分支跳 legacy 或双跑；这里按 handled 判别，fail-closed。
 */
export const controlPlaneTriggerIngestResultSchema = z.discriminatedUnion("handled", [
  z
    .object({
      handled: z.literal(true),
      triggerId: z.string().min(1),
      route: controlPlaneTriggerRouteSchema,
      delivery: controlPlaneDeliveryStateSchema.optional(),
    })
    .strict(),
  z.object({ handled: z.literal(false) }).strict(),
]);
export type ControlPlaneTriggerIngestResult = z.infer<typeof controlPlaneTriggerIngestResultSchema>;

// ── 方法 params/result schema（§3.2 Core→child）──────────────────────────────

export const workspaceEnsureParamsSchema = z
  .object({
    workspaceIdentity: z.string().trim().min(1),
    workspacePath: z.string().trim().min(1).optional(),
    /** Core 已 ready 且 tasks-index 迁移完成；true 才允许构造派发桥（§3.2/§4.4）。 */
    tasksIndexReady: z.boolean().optional(),
    /**
     * Core 自己解析出的 tasks-index 绝对路径（§2.3 跨进程同根校验）。child 用它精确
     * 比对自身推导路径；不一致 = 两进程写不同库，必须 fatal，不能静默用错库。
     * 省略该字段 = Core 尚未上报（保持旧调用方兼容，但无法做跨进程校验）。
     */
    tasksIndexDatabasePath: z.string().trim().min(1).optional(),
  })
  .strict();
export type WorkspaceEnsureParams = z.infer<typeof workspaceEnsureParamsSchema>;

export const workspaceEnsureResultSchema = z
  .object({
    state: z.enum(["leader", "follower"]),
    leaseExpiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type WorkspaceEnsureResult = z.infer<typeof workspaceEnsureResultSchema>;

export const controlPlaneTriggerIngestParamsSchema = controlPlaneTriggerEnvelopeSchema;

export const scheduleAuditParamsSchema = z
  .object({
    workspaceIdentity: z.string().trim().min(1),
    domainKey: z.string().trim().min(1),
    providerMessageId: z.string().trim().min(1),
    payloadSummary: z.record(z.string(), z.unknown()),
    now: z.number().int().nonnegative(),
  })
  .strict();
export type ScheduleAuditParams = z.infer<typeof scheduleAuditParamsSchema>;

export const scheduleAuditResultSchema = z.object({ inserted: z.boolean() }).strict();

export const leaseListParamsSchema = z.object({}).strict();
export const leaseEntrySchema = z
  .object({
    workspaceIdentity: z.string().min(1),
    ownerId: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export const leaseListResultSchema = z.object({ workspaces: z.array(leaseEntrySchema) }).strict();
export type LeaseListResult = z.infer<typeof leaseListResultSchema>;

export const leaseGetParamsSchema = z
  .object({ workspaceIdentity: z.string().trim().min(1) })
  .strict();
export const leaseGetResultSchema = z
  .object({
    ownerId: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict()
  .nullable();

export const mandateResolvePurposeSchema = z.enum(["delivery_precheck", "admission"]);
export const mandateResolveParamsSchema = z
  .object({
    triggerId: z.string().trim().min(1),
    purpose: mandateResolvePurposeSchema,
    sessionId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
  })
  .strict();
export type MandateResolveParams = z.infer<typeof mandateResolveParamsSchema>;

/** 结构镜像 core `PermissionMandateFacts` + triggerId。 */
export const controlPlaneMandateFactsSchema = z
  .object({
    triggerId: z.string().min(1),
    tier: z.enum(["record_only", "speculative", "auto"]),
    mandateId: z.string().min(1).optional(),
    expiresAt: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const controlPlaneMandateResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mandate"), facts: controlPlaneMandateFactsSchema }).strict(),
  z.object({ kind: z.literal("human_explicit_exempt") }).strict(),
]);
export type ControlPlaneMandateResolution = z.infer<typeof controlPlaneMandateResolutionSchema>;

/**
 * `mandate.resolve` 的 wire result（§3.2：`SuperAgentAdmissionMandateResolution | undefined`）。
 * JSON 无法表达 undefined，缺失解析结果固定编码为 null；client 与 child 必须从同一
 * schema 派生，禁止一侧省略 result、另一侧读 null（那是协议错误而非"无结果"）。
 */
export const controlPlaneMandateResolveResultSchema = z.union([
  controlPlaneMandateResolutionSchema,
  z.null(),
]);
export type ControlPlaneMandateResolveResult = z.infer<
  typeof controlPlaneMandateResolveResultSchema
>;

const wouldAcceptSourceSchema = z.enum(["im", "webhook", "schedule", "ci", "git", "file"]);
const wouldAcceptSuggestedTierSchema = z.enum(["record_only", "speculative", "auto"]);
const schemeCardSchema = z.object({
  currentEvidence: z.string().min(1),
  candidateOptions: z
    .array(z.object({ option: z.string().min(1), cost: z.string().min(1) }))
    .min(2),
  recommendation: z.string().min(1),
  impact: z.string().min(1),
  verification: z.string().min(1),
});
export const controlPlaneWouldAcceptCardSchema = z.object({
  cardId: z.string().min(1),
  source: wouldAcceptSourceSchema,
  summary: z.string(),
  suggestedTier: wouldAcceptSuggestedTierSchema,
  createdAt: z.number().int().nonnegative(),
  scheme: schemeCardSchema.optional(),
});
export type ControlPlaneWouldAcceptCard = z.infer<typeof controlPlaneWouldAcceptCardSchema>;

export const wouldAcceptListParamsSchema = z
  .object({ workspaceIdentity: z.string().trim().min(1) })
  .strict();
export const wouldAcceptListResultSchema = z
  .object({ cards: z.array(controlPlaneWouldAcceptCardSchema) })
  .strict();

export const wouldAcceptPromoteParamsSchema = z.object({ cardId: z.string().min(1) }).strict();
export const wouldAcceptPromoteResultSchema = z.object({}).strict();

export const controlStatusParamsSchema = z.object({}).strict();
export const controlStatusPlaneSchema = z
  .object({
    workspaceIdentity: z.string().min(1),
    leader: z.boolean(),
    pendingEventCount: z.number().int().nonnegative(),
    lastError: z.string().max(500).optional(),
  })
  .strict();
export const controlStatusResultSchema = z
  .object({ planes: z.array(controlStatusPlaneSchema) })
  .strict();
export type ControlStatusResult = z.infer<typeof controlStatusResultSchema>;

// ── 方法 params/result schema（§3.3 child→Core）──────────────────────────────

export const hostDeliveryLaneSchema = z.enum(["guide", "followup"]);
export type HostDeliveryLane = z.infer<typeof hostDeliveryLaneSchema>;

export const hostCommandParamsSchema = z
  .object({
    workspaceIdentity: z.string().trim().min(1),
    commandId: z.string().min(1),
    triggerId: z.string().min(1).optional(),
    taint: z.boolean().optional(),
    lane: hostDeliveryLaneSchema,
    sessionId: z.string().min(1).nullable().optional(),
    envelope: commandEnvelopeSchema,
  })
  .strict();
export type HostCommandParams = z.infer<typeof hostCommandParamsSchema>;

export const hostCommandResultSchema = commandAckSchema;

/**
 * daemon watchdog 的窄命令面（S3）：child 只请求宿主既有 owner 命令，
 * 不在 child 复制 workflow/automation 状态机。
 * - cancel-workflow → Core 向 owner session 投 V4 `cancelBackgroundWork`（workId=runId）；
 * - pause-automation → Core 调 automationService.pause（automationId 已由 child 从 runId 解析）；
 * - notify-user → Core 向 owner session 投 V4 `notifyUser`，CLI 直驱 runtime
 *   task-notification 队列（真实用户通知，不是 daemon onError）。
 */
export const hostWatchdogCommandParamsSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("cancel-workflow"),
      workspaceIdentity: z.string().trim().min(1),
      runId: z.string().min(1),
      sessionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("pause-automation"),
      workspaceIdentity: z.string().trim().min(1),
      automationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("notify-user"),
      workspaceIdentity: z.string().trim().min(1),
      sessionId: z.string().min(1),
      message: z.string().min(1).max(2000),
      /** 稳定通知幂等键：daemon 重试/Core 转发重试用同一 commandId。 */
      commandId: z.string().min(1).max(200),
    })
    .strict(),
]);
export type HostWatchdogCommandParams = z.infer<typeof hostWatchdogCommandParamsSchema>;

export const hostWatchdogCommandResultSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().min(1).max(500).optional(),
  })
  .strict();
export type HostWatchdogCommandResult = z.infer<typeof hostWatchdogCommandResultSchema>;

export const hostWorkerFindParamsSchema = z
  .object({
    workspaceIdentity: z.string().trim().min(1),
    threadKey: z.string().min(1),
  })
  .strict();
export const hostWorkerContextSchema = z
  .object({
    goalSummary: z.string().optional(),
    recentNarrowResults: z.array(z.string()).optional(),
    openQuestions: z.array(z.string()).optional(),
    recallSeedIds: z.array(z.string()).optional(),
  })
  .strict();
export const hostResumableWorkerSchema = z
  .object({
    sessionId: z.string().min(1),
    terminal: z.boolean(),
    stoppedByHuman: z.boolean(),
    context: hostWorkerContextSchema.optional(),
  })
  .strict()
  .nullable();
export const hostWorkerFindResultSchema = hostResumableWorkerSchema;

export const hostWorkerResumeParamsSchema = z
  .object({
    workspaceIdentity: z.string().trim().min(1),
    sessionId: z.string().min(1),
    triggerId: z.string().min(1),
  })
  .strict();
export const hostWorkerResumeResultSchema = z.object({ sessionId: z.string().min(1) }).strict();

export const hostWorkerCreateTaskParamsSchema = z
  .object({
    workspaceIdentity: z.string().trim().min(1),
    threadKey: z.string().min(1),
    triggerId: z.string().min(1),
    payload: z.string().min(1),
    context: hostWorkerContextSchema.optional(),
  })
  .strict();
export const hostWorkerCreateTaskResultSchema = z.object({ sessionId: z.string().min(1) }).strict();

/**
 * `host.autoReplyGuard` params。除定位事实外，additive-optional 携带出口已规范化的
 * 发送者/寻址事实（与 `TriggerSinkEnvelope.payload` 同源）：Core 用它们复用
 * `admitAutoReplyTurn` 的占额判定，而不是只看 actorId 猜发送者身份。旧 child 不传时
 * senderType 缺省按 `"user"`（与 legacy `message.senderType !== "app"` 同义）。
 */
export const hostAutoReplyGuardParamsSchema = z
  .object({
    workspaceIdentity: z.string().trim().min(1),
    botId: z.string().min(1),
    threadKey: z.string().min(1),
    actorId: z.string().min(1),
    chatType: z.enum(["private", "group"]).optional(),
    senderType: z.enum(["user", "app"]).optional(),
    mentionedBot: z.boolean().optional(),
    groupCardAction: z.boolean().optional(),
    elicitation: z.boolean().optional(),
    providerMessageId: z.string().min(1).optional(),
    commandText: z.string().optional(),
  })
  .strict();
export const hostAutoReplyGuardResultSchema = z.object({ admitted: z.boolean() }).strict();

/** 结构镜像 bootstrap `super-agent-intake` 的 SubscriptionBackfillSeed。 */
export const subscriptionBackfillSeedSchema = z
  .object({
    workspaceIdentity: z.string().min(1),
    sessionId: z.string().min(1),
    botId: z.string().min(1),
    peerId: z.string().min(1),
    threadId: z.string().min(1).optional(),
  })
  .strict();
export type SubscriptionBackfillSeedWire = z.infer<typeof subscriptionBackfillSeedSchema>;

export const backfillSeedsParamsSchema = z
  .object({ workspaceIdentity: z.string().trim().min(1) })
  .strict();
export const backfillSeedsResultSchema = z.object({
  seeds: z.array(subscriptionBackfillSeedSchema),
});

// ── 端点解析与 id 铸造 ─────────────────────────────────────────────────────

export const CONTROL_PLANE_SOCKET_DIRNAME = "run";
export const CONTROL_PLANE_SOCKET_FILENAME = "super-agent.sock";
export const CONTROL_PLANE_WINDOWS_PIPE_PREFIX = "zcode-super-agent-";
/** Supervisor 铸造、Core/child 共同读取的 0600 认证凭据文件（§3.8 显式握手）。 */
export const CONTROL_PLANE_AUTH_TOKEN_FILENAME = "super-agent.auth";

export function resolveControlPlaneAuthTokenPath(serverRoot: string): string {
  return join(serverRoot, CONTROL_PLANE_SOCKET_DIRNAME, CONTROL_PLANE_AUTH_TOKEN_FILENAME);
}

/**
 * 受管 child 数据面端点（§3.1）：
 * - POSIX：`<serverRoot>/run/super-agent.sock`（目录 0700 / socket 0600）；
 * - Windows：`\\.\pipe\zcode-super-agent-<stablePathId(serverRoot)>`。
 * stablePathId 取 serverRoot 规范化后的 sha256 前 16 位；不把原始路径塞进 pipe 名，
 * 避免分隔符/大小写差异在 pipe 命名空间里分裂出两个端点。
 */
export function resolveControlPlaneEndpoint(
  serverRoot: string,
  options: { platform?: NodeJS.Platform; stablePathId?: string } = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const id = options.stablePathId ?? stablePathId(serverRoot);
    return `\\\\.\\pipe\\${CONTROL_PLANE_WINDOWS_PIPE_PREFIX}${id}`;
  }
  return resolveControlPlaneSocketPath(serverRoot, platform);
}

/** POSIX 端点推导用 path.join；Windows 分支不读它。调用方传绝对 serverRoot。 */
export function resolveControlPlaneSocketPath(
  serverRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return resolveControlPlaneEndpoint(serverRoot, {
      platform,
      stablePathId: stablePathId(serverRoot),
    });
  }
  return join(serverRoot, CONTROL_PLANE_SOCKET_DIRNAME, CONTROL_PLANE_SOCKET_FILENAME);
}

export function stablePathId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * 稳定 ownerId（§2.5）：同一 serverRoot + workspace 的重启实例立即重抢，不必等 45s
 * TTL。安全前提是 Supervisor 已观察到旧 child 终态（§8-2），本函数只负责铸键。
 */
export function controlPlaneOwnerId(serverRoot: string, workspaceIdentity: string): string {
  return `control-plane:${createHash("sha256").update(serverRoot).digest("hex")}:${createHash(
    "sha256",
  )
    .update(workspaceIdentity)
    .digest("hex")}`;
}
