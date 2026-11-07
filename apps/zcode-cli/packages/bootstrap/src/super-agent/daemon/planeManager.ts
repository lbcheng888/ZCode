/**
 * headless child 的 per-workspace plane 管理与 RPC 方法实现（milestone-b-spec
 * §1.4 / §2.5 / §3.2–§3.4）。
 *
 * 单 child 多 plane：`super-agent.sqlite` 的唯一写者仍是本进程；每个 workspace 一套
 * intake/router/adjudicator/dispatch bridge/leader 租约。Core ready 之前不 claim：
 * plane 只在首次 `workspace.ensure`（Core 已 ready）时构造并 start。
 *
 * 禁止 import `@zcode/services` / `@zcode/server-cli`：host 能力全部经 §3.3 RPC。
 * 尚未存在的 Core 侧方法不在 child 伪造——host.client 直接请求，Core 回
 * methodNotSupported/unimplemented 时错误原样上浮。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  commandAckSchema,
  commandEnvelopeSchema,
  type CommandAck,
} from "@zcode/shared/zcode-protocol-v4";
import {
  CONTROL_PLANE_RPC_ERROR_CODES,
  CONTROL_PLANE_RPC_TIMEOUTS_MS,
  backfillSeedsResultSchema,
  controlPlaneMandateResolveResultSchema,
  controlPlaneOwnerId,
  controlPlaneTriggerEnvelopeSchema,
  controlPlaneTriggerIngestResultSchema,
  controlPlaneWouldAcceptCardSchema,
  hostAutoReplyGuardResultSchema,
  hostCommandParamsSchema,
  hostResumableWorkerSchema,
  hostWorkerCreateTaskResultSchema,
  hostWorkerResumeResultSchema,
  leaseGetResultSchema,
  leaseListResultSchema,
  mandateResolveParamsSchema,
  scheduleAuditParamsSchema,
  scheduleAuditResultSchema,
  workspaceEnsureParamsSchema,
  workspaceEnsureResultSchema,
  wouldAcceptListResultSchema,
  wouldAcceptPromoteParamsSchema,
  type ControlPlaneRpcMethod,
  type HostDeliveryLane,
} from "@zcode/shared/super-agent-control-plane-protocol";
import { z } from "zod";

import {
  createSuperAgentControlPlane,
  type SuperAgentControlPlane,
} from "../../app/super-agent-control-plane.js";
import { getSuperAgentDatabasePath } from "../../app/paths.js";
import { runsList } from "../runs-list.js";
import type { AdjudicationModelSessionPort } from "../adjudication/index.js";
import type { AutoReplyGuardPort, SubscriptionBackfillSeed, TriggerEnvelope } from "../intake/index.js";
import { triggerDeliveryCommandId, type TriggerWorkerPort } from "../trigger/index.js";
import { ControlPlaneRpcCallError as RpcError } from "./rpcServer.js";
import type { ControlPlanePeerChannel } from "./rpcServer.js";

/** dispatch bridge 只认已迁移的 tasks-index；路径由 dataBaseDir 同根推导（§2.3）。 */
export const TASKS_INDEX_RELATIVE_PATH = join(".chengcode", "v2", "tasks-index.sqlite");

export function resolveTasksIndexDatabasePath(dataBaseDir: string): string {
  return join(dataBaseDir, TASKS_INDEX_RELATIVE_PATH);
}

/** 守护进程内没有用户会话；resume/createTask 一律经 Core 的 worker 投影。 */
export interface DaemonPlaneManagerOptions {
  dataBaseDir: string;
  serverRoot: string;
  /** 启动时已打开的域库句柄：枚举/租约读面/审计/状态（写入仍是本进程唯一写者）。 */
  database: DatabaseSync;
  /** 裁决模型会话：headless 生成面未装配时 run 恒响亮失败（§8-7 阻塞项）。 */
  adjudicationSession: AdjudicationModelSessionPort;
  /** `features.mandateGate` 的启动方投影（缺省 false = P2 兼容）。 */
  mandateGate: boolean;
  /** 派发桥周期（push/sweep）轮询间隔；缺省取控制面常量（测试可缩短）。 */
  dispatchIntervalMs?: number;
  /** in_window 行宽限；缺省取控制面常量（测试可缩短）。 */
  dispatchGraceMs?: number;
  now?: () => number;
  onPlaneError: (workspaceIdentity: string | undefined, error: unknown, context: string) => void;
  lastErrorFor?: (workspaceIdentity: string) => string | undefined;
  /**
   * 启动级不可恢复错误（§2.3 库路径跨进程不一致）：child 必须发 fatal 并收口，
   * 不是普通 RPC error。
   */
  onFatal?: (message: string) => void;
  /**
   * 当前任一未关闭的 Core 数据面通道（RPC server 活跃集合）。§3.5：派发桥可达性
   * 不得只看该 plane 最近一次 ensure/ingest 的通道——Core 重连后若首个请求是
   * `lease.list` / `schedule.audit`，旧通道已关闭会让桥停推并把 pending 行误结算
   * skipped(no_dispatcher)。任一经认证的活跃通道都应视为可达。
   */
  activeHostChannel?: () => ControlPlanePeerChannel | undefined;
}

interface PlaneRecord {
  workspaceIdentity: string;
  workspacePath?: string;
  tasksIndexReady: boolean;
  plane: SuperAgentControlPlane;
  /** host.command 回调的目标通道：最近一次发出 ensure/ingest 的 Core 连接。 */
  coreChannel?: ControlPlanePeerChannel;
}

/**
 * 当前 RPC 父请求的剩余预算（§3.1 嵌套反向请求约束）。
 *
 * 必须按请求调用栈作用域：`AsyncLocalStorage` 的 store 随 await 传播，因此并发
 * ingest 各自看到自己的 deadline，不会互相覆盖。派发桥的后台 push 不在任何父请求
 * 栈内，必须经独立端口显式不传 deadline——绝不继承入站请求早已过期的预算
 * （旧实现把 deadline 存进 plane 且从不清空，ensure 10s 后所有后台 push 都抛
 * `parent request deadline already elapsed`）。
 */
const requestDeadline = new AsyncLocalStorage<{ deadlineAt: number | undefined }>();

/** 结构镜像 intake autoReplyGuard 的适用面：非 IM 恒 true，不消耗 Core 守卫占额。 */
const AUTO_REPLY_GUARD_IM_SOURCE = "im";

/** 与 super-agent-host-ports 的 SUPER_AGENT_CLIENT_ID 同值（跨进程 wire 面）。 */
const CONTROL_PLANE_TRIGGER_CLIENT_ID = "super-agent-trigger";

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function laneFromEnvelope(envelope: z.infer<typeof commandEnvelopeSchema>): HostDeliveryLane {
  const payload = envelope.payload;
  if (typeof payload === "object" && payload !== null && "requestedDelivery" in payload) {
    const requested = (payload as { requestedDelivery?: unknown }).requestedDelivery;
    if (requested === "guide") return "guide";
  }
  return "followup";
}

export class DaemonPlaneManager {
  private readonly planes = new Map<string, PlaneRecord>();
  private knownWorkspaces = new Set<string>();
  private readonly tasksIndexDatabasePath: string;
  private readonly now: () => number;
  private stopped = false;
  /**
   * tasks-index 只读句柄（health `pendingDispatchCount`）。派发桥在 plane 内另持一个
   * 写句柄；这里只读不写，仍满足 §4.5「pending INSERT 由 Core、CAS 由 bridge」的单写者。
   */
  private tasksIndexDb: DatabaseSync | undefined;
  /** §2.5 follower/未启动 plane 的纯转发 ingest 计数（health 上报）。 */
  private followerIngestTotal = 0;
  /** §3.6 启动窗口内尚无 plane 的 ingest 计数（health 上报）。 */
  private notEnsuredIngestTotal = 0;
  /** ensure 串行化：并发首次 ensure 会各开一次域库句柄/跑迁移，必须排队避免迁移竞争。 */
  private ensureQueue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: DaemonPlaneManagerOptions) {
    this.tasksIndexDatabasePath = resolveTasksIndexDatabasePath(options.dataBaseDir);
    this.now = options.now ?? Date.now;
  }

  /**
   * 启动期自枚举域库已有 workspace（只登记，不构造 plane、不抢租约，§2.5/§4.4）。
   * 构造推迟到 `workspace.ensure`：派发桥是否建立由该请求的 `tasksIndexReady` 决定，
   * 启动时还不知道 tasks-index 迁移是否完成；提前构造会让桥永久缺席（§2.3 启动顺序）。
   */
  public enumerateKnownWorkspaces(): void {
    const identities = new Set<string>();
    for (const table of ["trigger_events", "trigger_subscriptions", "control_plane_leases"]) {
      const rows = this.options.database
        .prepare(`select distinct workspace_identity as id from ${table}`)
        .all() as unknown as Array<{ id: string }>;
      for (const row of rows) {
        if (row.id) identities.add(row.id);
      }
    }
    this.knownWorkspaces = identities;
  }

  public workspaceIdentities(): string[] {
    return [...new Set([...this.planes.keys(), ...this.knownWorkspaces])].sort();
  }

  public pendingEventCount(workspaceIdentity?: string): number {
    const sql =
      workspaceIdentity === undefined
        ? "select count(*) as n from trigger_events where final_disposition is null"
        : "select count(*) as n from trigger_events where final_disposition is null and workspace_identity = ?";
    const row =
      workspaceIdentity === undefined
        ? (this.options.database.prepare(sql).get() as { n?: number } | undefined)
        : (this.options.database.prepare(sql).get(workspaceIdentity) as { n?: number } | undefined);
    return Number(row?.n ?? 0);
  }

  /** health §2.4：当前 leader plane 数。 */
  public leaderWorkspaceCount(): number {
    let count = 0;
    for (const record of this.planes.values()) {
      if (record.plane.isLeader()) count += 1;
    }
    return count;
  }

  /**
   * health §2.4：`dispatch_requests` 非终态行数（pending_dispatch + pushed）。
   * 没有 plane 声明 tasksIndexReady 时返回 undefined（未接桥，字段缺席而非假 0）。
   */
  public pendingDispatchCount(): number | undefined {
    let hasBridgePlane = false;
    for (const record of this.planes.values()) {
      if (record.tasksIndexReady) {
        hasBridgePlane = true;
        break;
      }
    }
    if (!hasBridgePlane) return undefined;
    if (!existsSync(this.tasksIndexDatabasePath)) {
      // 不先落 0 字节空库污染「未迁移」现场（与组合根 bridge 构造同一判据）。
      throw new Error(`tasks-index 数据库不存在：${this.tasksIndexDatabasePath}`);
    }
    this.tasksIndexDb ??= new DatabaseSync(this.tasksIndexDatabasePath);
    const row = this.tasksIndexDb
      .prepare(
        "select count(*) as n from dispatch_requests where status in ('pending_dispatch','pushed')",
      )
      .get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** health §2.4：最近 per-plane 错误摘要（按 workspace 去重，最多由 entry 截断）。 */
  public workspaceErrors(): Array<{ workspaceIdentity: string; error: string }> {
    const errors: Array<{ workspaceIdentity: string; error: string }> = [];
    for (const workspaceIdentity of this.workspaceIdentities()) {
      const error = this.options.lastErrorFor?.(workspaceIdentity);
      if (error) errors.push({ workspaceIdentity, error });
    }
    return errors;
  }

  public followerIngestCount(): number {
    return this.followerIngestTotal;
  }

  public notEnsuredIngestCount(): number {
    return this.notEnsuredIngestTotal;
  }

  public planeStatus(): Array<{
    workspaceIdentity: string;
    leader: boolean;
    pendingEventCount: number;
    lastError?: string;
  }> {
    return this.workspaceIdentities().map((workspaceIdentity) => {
      const plane = this.planes.get(workspaceIdentity);
      const lastError = this.options.lastErrorFor?.(workspaceIdentity);
      return {
        workspaceIdentity,
        leader: plane?.plane.isLeader() ?? false,
        pendingEventCount: this.pendingEventCount(workspaceIdentity),
        ...(lastError ? { lastError } : {}),
      };
    });
  }

  public async handle(
    method: string,
    rawParams: unknown,
    channel: ControlPlanePeerChannel,
    deadlineAt?: number,
  ): Promise<unknown> {
    // 父请求预算只在本请求的异步调用栈内可见（嵌套 host.* 回调取它）；后台派发桥
    // push 不在该栈内，走 hostPorts.dispatchHandleCommand 显式不传 deadline。
    return await requestDeadline.run({ deadlineAt }, () =>
      this.dispatchRequest(method, rawParams, channel, deadlineAt),
    );
  }

  /**
   * child 后台任务（watchdog）向 Core 发起窄请求。没有父请求栈，因此必须显式传
   * 目标 workspace 与超时；通道优先该 plane 最近连接，退回任一活跃 Core 连接。
   */
  public requestHost(
    workspaceIdentity: string,
    method: ControlPlaneRpcMethod,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const planeChannel = this.planes.get(workspaceIdentity)?.coreChannel;
    const channel =
      planeChannel !== undefined && !planeChannel.closed
        ? planeChannel
        : this.options.activeHostChannel?.();
    if (!channel || channel.closed) {
      throw new RpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.hostUnreachable,
        `Core host channel closed（workspace=${workspaceIdentity}）`,
        true,
      );
    }
    return channel.request(method, params, timeoutMs);
  }

  private async dispatchRequest(
    method: string,
    rawParams: unknown,
    channel: ControlPlanePeerChannel,
    deadlineAt?: number,
  ): Promise<unknown> {
    switch (method as ControlPlaneRpcMethod) {
      case "workspace.ensure": {
        const next = this.ensureQueue.then(() =>
          this.ensureWorkspace(rawParams, channel, deadlineAt),
        );
        this.ensureQueue = next.catch(() => undefined);
        return await next;
      }
      case "trigger.ingest":
        return await this.ingest(rawParams, channel);
      case "schedule.audit":
        return this.scheduleAudit(rawParams);
      case "lease.list":
        return this.leaseList();
      case "lease.get":
        return this.leaseGet(rawParams);
      case "mandate.resolve":
        return this.mandateResolve(rawParams);
      case "wouldAccept.list":
        return this.wouldAcceptList(rawParams);
      case "wouldAccept.promote":
        return await this.wouldAcceptPromote(rawParams);
      case "control.status":
        return { planes: this.planeStatus() };
      case "runs.list":
        return runsList(this.options.database, rawParams);
      default:
        // host.* / backfill.seeds 是 child→Core 方向；Core 反向调用属于方向错误，
        // 返回 typed 错误，不静默实现第二份语义（§3.3）。
        throw new RpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.methodNotSupported,
          `method ${method} is not served by the control-plane child`,
          false,
        );
    }
  }

  public async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const record of this.planes.values()) {
      try {
        // 优雅释放本人租约（§2.5），再对称 stop 心跳/驱动器/关库。
        record.plane.releaseLeadership();
      } catch (error) {
        this.options.onPlaneError(record.workspaceIdentity, error, "daemon.lease.release");
      }
      try {
        record.plane.stop();
      } catch (error) {
        this.options.onPlaneError(record.workspaceIdentity, error, "daemon.plane.stop");
      }
    }
    this.planes.clear();
    try {
      this.tasksIndexDb?.close();
      this.tasksIndexDb = undefined;
    } catch (error) {
      this.options.onPlaneError(undefined, error, "daemon.tasks_index.close");
    }
  }

  private async ensureWorkspace(
    rawParams: unknown,
    channel: ControlPlanePeerChannel,
    deadlineAt?: number,
  ): Promise<z.infer<typeof workspaceEnsureResultSchema>> {
    const params = workspaceEnsureParamsSchema.parse(rawParams);
    // §2.3 跨进程同根校验：Core 在 ensure 里带上它自己解析的 tasks-index 绝对路径。
    // child 自身推导路径是唯一权威；不一致说明两进程写不同库（Core 覆盖了 dataBaseDir），
    // 必须 fatal，不能只靠「两边都从同一个 dataBaseDir 推导」的同义反复自我证明。
    if (
      params.tasksIndexDatabasePath !== undefined &&
      resolve(params.tasksIndexDatabasePath) !== resolve(this.tasksIndexDatabasePath)
    ) {
      const message = `super-agent 库路径不一致：Core tasks-index=${resolve(
        params.tasksIndexDatabasePath,
      )}，child tasks-index=${resolve(this.tasksIndexDatabasePath)}（拒绝服务，spec §2.3）`;
      this.options.onFatal?.(message);
      throw new RpcError(CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed, message, false);
    }
    const existing = this.planes.get(params.workspaceIdentity);
    if (existing) {
      // tasksIndexReady 单调：构造时无桥、之后又不能补桥。显式翻转（true↔false）
      // 必须响亮失败；调用方省略该字段表示「不改变」，允许幂等重发。
      if (
        params.tasksIndexReady !== undefined &&
        params.tasksIndexReady !== existing.tasksIndexReady
      ) {
        throw new RpcError(
          CONTROL_PLANE_ERROR_WORKSPACE_FAILED,
          `workspace.ensure tasksIndexReady 在 plane 构造后变化：${params.workspaceIdentity}（拒绝重建，fail-closed）`,
          false,
        );
      }
      existing.coreChannel = channel;
      return this.ensureResult(existing);
    }
    if (this.stopped) {
      throw new RpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
        "control-plane daemon is shutting down",
        true,
      );
    }

    const workspaceIdentity = params.workspaceIdentity;
    const tasksIndexReady = params.tasksIndexReady === true;
    // §3.3 backfill.seeds：leader 接管时向 Core 取最新种子（替代启动期静态快照）。
    // 取不到（Core 未实现/超时）记 workspace 错误但不阻断 ensure：域库中已有订阅仍可用。
    const seeds = await this.loadBackfillSeeds(workspaceIdentity, channel, deadlineAt);
    const ownerId = controlPlaneOwnerId(this.options.serverRoot, workspaceIdentity);
    const plane = await createSuperAgentControlPlane({
      workspaceIdentity,
      ownerId,
      onError: (error, context) => this.options.onPlaneError(workspaceIdentity, error, context),
      hostPorts: this.hostPorts(workspaceIdentity, channel, tasksIndexReady, seeds),
      adjudicationSession: this.options.adjudicationSession,
      now: this.now,
      mandateGate: this.options.mandateGate,
      reconcileChengJobsOnStartup: true,
      ...(this.options.dispatchIntervalMs !== undefined
        ? { dispatchIntervalMs: this.options.dispatchIntervalMs }
        : {}),
      ...(this.options.dispatchGraceMs !== undefined
        ? { dispatchGraceMs: this.options.dispatchGraceMs }
        : {}),
    });
    const record: PlaneRecord = {
      workspaceIdentity,
      tasksIndexReady,
      plane,
      coreChannel: channel,
      ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
    };
    this.planes.set(workspaceIdentity, record);
    this.knownWorkspaces.add(workspaceIdentity);
    try {
      await plane.start();
    } catch (error) {
      this.planes.delete(workspaceIdentity);
      try {
        plane.stop();
      } catch {
        // stop 失败不覆盖 start 的原始错误。
      }
      throw error;
    }
    return this.ensureResult(record);
  }

  private ensureResult(record: PlaneRecord): z.infer<typeof workspaceEnsureResultSchema> {
    const lease = this.options.database
      .prepare(
        "select owner_id, expires_at from control_plane_leases where workspace_identity = ?",
      )
      .get(record.workspaceIdentity) as { owner_id?: string; expires_at?: number } | undefined;
    return {
      state: record.plane.isLeader() ? "leader" : "follower",
      leaseExpiresAt: lease ? Number(lease.expires_at ?? 0) : 0,
    };
  }

  private async loadBackfillSeeds(
    workspaceIdentity: string,
    channel: ControlPlanePeerChannel,
    deadlineAt?: number,
  ): Promise<readonly SubscriptionBackfillSeed[]> {
    // 取种子失败不得降级成空种子继续 ensure（那会把订阅回填静默丢失）；错误原样上浮，
    // Core 按可重试错误重发 ensure。反向请求受父 workspace.ensure 剩余 deadline 约束，
    // 避免嵌套 10s 超时把父请求整体拖到超时（§3.1）。
    const raw = await channel.request(
      "backfill.seeds",
      { workspaceIdentity },
      CONTROL_PLANE_RPC_TIMEOUTS_MS["backfill.seeds"],
      deadlineAt,
    );
    const parsed = backfillSeedsResultSchema.parse(raw);
    return parsed.seeds.map((seed) => ({
      workspaceIdentity: seed.workspaceIdentity,
      sessionId: seed.sessionId,
      botId: seed.botId,
      peerId: seed.peerId,
      ...(seed.threadId ? { threadId: seed.threadId } : {}),
    }));
  }

  private async ingest(
    rawParams: unknown,
    channel: ControlPlanePeerChannel,
  ): Promise<z.infer<typeof controlPlaneTriggerIngestResultSchema>> {
    const envelope = controlPlaneTriggerEnvelopeSchema.parse(rawParams) as TriggerEnvelope;
    const record = this.planes.get(envelope.workspaceIdentity);
    if (!record) {
      // §3.6 rule 2：child 已 ready 但 Core 尚未 ensure 的启动窗口，以及从未 leader 的
      // workspace，都按「纯转发/legacy」处理，不能变成可重试错误让别人以为业务已消费。
      this.notEnsuredIngestTotal += 1;
      return { handled: false };
    }
    record.coreChannel = channel;
    let outcome;
    try {
      outcome = await record.plane.triggerSink.ingest(envelope);
    } catch (error) {
      // 单条 ingest 失败（DB busy/裁决异常）必须可重试：provider 重投由
      // trigger_events UNIQUE 与 commandId 幂等吸收（§3.4/§3.6）。
      throw new RpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
    if (!outcome.handled) {
      // follower / 未启动 plane 的纯转发：真实计数，health 可见（§2.5）。
      this.followerIngestTotal += 1;
      return { handled: false };
    }
    return controlPlaneTriggerIngestResultSchema.parse({
      handled: true,
      triggerId: outcome.triggerId,
      route: outcome.route,
      ...(outcome.delivery ? { delivery: outcome.delivery } : {}),
    });
  }

  private scheduleAudit(rawParams: unknown): { inserted: boolean } {
    const params = scheduleAuditParamsSchema.parse(rawParams);
    // §4.4：只有 leader 才 claim 并请求审计；follower 写域库会破坏「唯一写者/不跑循环」。
    const record = this.planes.get(params.workspaceIdentity);
    if (!record) {
      throw new RpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.workspaceNotEnsured,
        `schedule.audit before workspace.ensure: ${params.workspaceIdentity}`,
        false,
      );
    }
    if (!record.plane.isLeader()) {
      throw new RpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
        `follower plane 不写调度审计（workspace=${params.workspaceIdentity}）`,
        true,
      );
    }
    // 审计行形状与 desktop scheduler `recordScheduleTriggerAudit` 逐列一致（§4.4：
    // 本改动后 child 是 trigger_events 唯一写者）。
    const payload = JSON.stringify({ ...params.payloadSummary, trigger: "schedule" });
    const digest = createHash("sha256").update(payload).digest("hex");
    const result = this.options.database
      .prepare(
        `insert into trigger_events (
          id, workspace_identity, source, thread_key, actor_kind, actor_id,
          payload, payload_digest, taint, provider, provider_message_id,
          fast_path, adjudication_status, final_disposition, settled_at, created_at, updated_at
        ) values (?, ?, 'schedule', ?, 'system', 'scheduler', ?, ?, 1, 'scheduler', ?,
          NULL, NULL, NULL, NULL, ?, ?)
        on conflict do nothing`,
      )
      .run(
        randomUUID(),
        params.workspaceIdentity,
        `schedule:${params.domainKey}`,
        payload,
        digest,
        params.providerMessageId,
        params.now,
        params.now,
      );
    return scheduleAuditResultSchema.parse({ inserted: Number(result.changes) > 0 });
  }

  private leaseList(): z.infer<typeof leaseListResultSchema> {
    const rows = this.options.database
      .prepare(
        "select workspace_identity, owner_id, expires_at from control_plane_leases order by workspace_identity",
      )
      .all() as unknown as Array<{
      workspace_identity: string;
      owner_id: string;
      expires_at: number;
    }>;
    return leaseListResultSchema.parse({
      workspaces: rows.map((row) => ({
        workspaceIdentity: row.workspace_identity,
        ownerId: row.owner_id,
        expiresAt: Number(row.expires_at),
      })),
    });
  }

  private leaseGet(rawParams: unknown): z.infer<typeof leaseGetResultSchema> {
    const params = z.object({ workspaceIdentity: z.string().trim().min(1) }).strict().parse(rawParams);
    const row = this.options.database
      .prepare(
        "select owner_id, expires_at from control_plane_leases where workspace_identity = ?",
      )
      .get(params.workspaceIdentity) as { owner_id?: string; expires_at?: number } | undefined;
    if (!row) return null;
    return leaseGetResultSchema.parse({
      ownerId: row.owner_id,
      expiresAt: Number(row.expires_at ?? 0),
    });
  }

  private mandateResolve(rawParams: unknown): unknown {
    const params = mandateResolveParamsSchema.parse(rawParams);
    const record = this.planeForTrigger(params.triggerId);
    const resolution = record.plane.resolveAdmissionMandateFacts(params.triggerId);
    // purpose 只决定调用时点（delivery_precheck/admission 都重新解析，§3.7）；
    // child 不做缓存，sessionId/turnId 不参与解析。无结果固定编码 null；
    // schema 与 client 同源于 shared，禁止一侧省略字段一侧读 null。
    return controlPlaneMandateResolveResultSchema.parse(
      resolution === undefined ? null : resolution,
    );
  }

  private wouldAcceptList(rawParams: unknown): unknown {
    const params = z
      .object({ workspaceIdentity: z.string().trim().min(1) })
      .strict()
      .parse(rawParams);
    const record = this.planes.get(params.workspaceIdentity);
    if (!record) {
      throw new RpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.workspaceNotEnsured,
        `wouldAccept.list before workspace.ensure: ${params.workspaceIdentity}`,
        false,
      );
    }
    const cards = record.plane.listPendingWouldAccept().map((card) =>
      controlPlaneWouldAcceptCardSchema.parse({
        cardId: card.cardId,
        source: card.source,
        summary: card.summary,
        suggestedTier: card.suggestedTier,
        createdAt: card.createdAt,
        ...(card.scheme ? { scheme: card.scheme } : {}),
      }),
    );
    return wouldAcceptListResultSchema.parse({ cards });
  }

  private async wouldAcceptPromote(rawParams: unknown): Promise<Record<string, never>> {
    const params = wouldAcceptPromoteParamsSchema.parse(rawParams);
    const row = this.options.database
      .prepare("select workspace_identity from decision_log where id = ?")
      .get(params.cardId) as { workspace_identity?: string } | undefined;
    const workspaceIdentity = row?.workspace_identity;
    const record = workspaceIdentity ? this.planes.get(workspaceIdentity) : undefined;
    if (!record) {
      throw new RpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.workspaceNotEnsured,
        `wouldAccept.promote 找不到卡的 workspace plane: cardId=${params.cardId}`,
        false,
      );
    }
    if (!record.plane.isLeader()) {
      // follower 不写域库（§2.5）：返回可重试错误，Core 释放弃 claim、下一 tick 重试。
      throw new RpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
        `follower plane 不允许 wouldAccept.promote（cardId=${params.cardId}）`,
        true,
      );
    }
    await record.plane.promoteWouldAccept(params.cardId);
    return {};
  }

  private planeForTrigger(triggerId: string): PlaneRecord {
    const row = this.options.database
      .prepare("select workspace_identity from trigger_events where id = ?")
      .get(triggerId) as { workspace_identity?: string } | undefined;
    const record = row?.workspace_identity ? this.planes.get(row.workspace_identity) : undefined;
    if (!record) {
      throw new RpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.workspaceNotEnsured,
        `mandate.resolve 目标 trigger 无 plane: triggerId=${triggerId}`,
        false,
      );
    }
    return record;
  }

  /**
   * §3.3 child→Core 的 host 端口：全部经调用方给的 Core 连接反向请求，child 不自建
   * 平行 admission、不读 session 库。Core 若未实现对应方法，RPC 错误原样上浮。
   */
  private hostPorts(
    workspaceIdentity: string,
    initialChannel: ControlPlanePeerChannel,
    tasksIndexReady: boolean,
    backfillSeeds: readonly SubscriptionBackfillSeed[],
  ) {
    const currentDeadlineAt = (): number | undefined => requestDeadline.getStore()?.deadlineAt;
    // worker 端口是对象字面量，不能依赖 this 绑定到 manager；时钟先捕获。
    const nowFn = this.now;

    /**
     * 目标 Core 通道：优先本 plane 最近一次 ensure/ingest 的连接；它已关闭时退回
     * RPC server 的任一活跃通道（Core 重连后的新连接）。§3.5 可达性必须看活跃通道
     * 集合，不能只看旧连接——否则 Core 重连后首个请求是 lease.list/schedule.audit
     * 时桥会误判不可达并让 pending 行按 no_dispatcher 结算。
     */
    const resolveChannel = (): ControlPlanePeerChannel | undefined => {
      const own = this.planes.get(workspaceIdentity)?.coreChannel ?? initialChannel;
      if (!own.closed) return own;
      return this.options.activeHostChannel?.();
    };

    const channelOf = (): ControlPlanePeerChannel => {
      const channel = resolveChannel();
      if (!channel || channel.closed) {
        throw new RpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.hostUnreachable,
          `Core host channel closed（workspace=${workspaceIdentity}）`,
          true,
        );
      }
      return channel;
    };

    const hostCommandWithDeadline = async (
      rawParams: unknown,
      deadlineAt: number | undefined,
    ): Promise<CommandAck> => {
      const envelope = commandEnvelopeSchema.parse(rawParams);
      const sessionId = envelope.sessionId;
      if (sessionId === null) {
        throw new RpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
          "host.command 需要 sessionId（createSession 不是触发投递面）",
          false,
        );
      }
      const params = hostCommandParamsSchema.parse({
        workspaceIdentity,
        commandId: envelope.commandId,
        ...(envelope.triggerId ? { triggerId: envelope.triggerId } : {}),
        ...(envelope.taint !== undefined ? { taint: envelope.taint } : {}),
        lane: laneFromEnvelope(envelope),
        sessionId,
        envelope,
      });
      const result = await channelOf().request(
        "host.command",
        params,
        CONTROL_PLANE_RPC_TIMEOUTS_MS["host.command"],
        deadlineAt,
      );
      return commandAckSchema.parse(result);
    };

    const worker: TriggerWorkerPort = {
      async findWorkerByThreadKey(input) {
        const raw = await channelOf().request(
          "host.worker.find",
          { workspaceIdentity, threadKey: input.threadKey },
          CONTROL_PLANE_RPC_TIMEOUTS_MS["host.worker.find"],
          currentDeadlineAt(),
        );
        const parsed = hostResumableWorkerSchema.parse(raw);
        return parsed ?? undefined;
      },
      async resume(input) {
        const raw = await channelOf().request(
          "host.worker.resume",
          { workspaceIdentity, sessionId: input.sessionId, triggerId: input.triggerId },
          CONTROL_PLANE_RPC_TIMEOUTS_MS["host.worker.resume"],
          currentDeadlineAt(),
        );
        const parsed = hostWorkerResumeResultSchema.parse(raw);
        // §3.3 wire params 不含唤醒文本：resume 只打开会话。若就此返回成功，
        // dispatchHumanExplicit 会把「resumed」当成已投递，而用户正文从未进入 agent
        // （B-A3 主路径的伪回执）。因此必须再经唯一 admission 投递唤醒输入；幂等键 =
        // triggerId+sessionId（与 owned 直通同一键），重投由 CommandInbox 吸收。
        const envelope = commandEnvelopeSchema.parse({
          commandId: triggerDeliveryCommandId(input.triggerId, parsed.sessionId),
          clientId: CONTROL_PLANE_TRIGGER_CLIENT_ID,
          sessionId: parsed.sessionId,
          type: "sendText",
          payload: { text: input.text },
          issuedAt: nowFn(),
          triggerId: input.triggerId,
          taint: true,
        });
        const ack = await hostCommandWithDeadline(envelope, currentDeadlineAt());
        if (ack.status !== "accepted" && ack.status !== "duplicate") {
          // 投递被拒不是「已送达」：原样抛错，事件保持未决并由 provider 重投。
          throw new RpcError(
            CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
            `host.worker.resume 唤醒投递被拒: ${ack.reasonCode ?? ack.status}（triggerId=${input.triggerId}）`,
            true,
          );
        }
        return parsed;
      },
      async createTask(input) {
        const raw = await channelOf().request(
          "host.worker.createTask",
          {
            workspaceIdentity,
            threadKey: input.threadKey,
            triggerId: input.triggerId,
            payload: input.text,
            ...(input.context ? { context: input.context } : {}),
          },
          CONTROL_PLANE_RPC_TIMEOUTS_MS["host.worker.createTask"],
          currentDeadlineAt(),
        );
        return hostWorkerCreateTaskResultSchema.parse(raw);
      },
    };

    const autoReplyGuard: AutoReplyGuardPort = {
      async admit(envelope: TriggerEnvelope): Promise<boolean> {
        if (envelope.source !== AUTO_REPLY_GUARD_IM_SOURCE) {
          // 非守卫适用面原样放行（私聊/卡片/elicitation/非 IM 来源，§3.3 合同）。
          return true;
        }
        const botId = readPayloadString(envelope.payload, "botId");
        if (!botId) {
          throw new RpcError(
            CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
            "IM 信封缺少 botId，无法向 Core 互答守卫定位 bot",
            false,
          );
        }
        const threadKey =
          envelope.threadKeyHint ??
          `bot:${botId}+${readPayloadString(envelope.payload, "chatId") ?? envelope.actor.id ?? ""}`;
        const actorId = envelope.actor.id ?? botId;
        // 把出口已规范化的发送者/寻址事实随 wire 传给 Core：Core 用它们复用
        // admitAutoReplyTurn 的占额判定，不按 actorId 猜「是否机器人」。
        const chatType = readPayloadString(envelope.payload, "chatType");
        const senderType = readPayloadString(envelope.payload, "senderType");
        const commandText = readPayloadString(envelope.payload, "commandText");
        const raw = await channelOf().request(
          "host.autoReplyGuard",
          {
            workspaceIdentity,
            botId,
            threadKey,
            actorId,
            ...(chatType === "private" || chatType === "group" ? { chatType } : {}),
            ...(senderType === "user" || senderType === "app" ? { senderType } : {}),
            mentionedBot: envelope.payload.mentionedBot === true,
            groupCardAction: envelope.payload.groupCardAction === true,
            elicitation: envelope.payload.elicitation === true,
            ...(envelope.providerMessageId
              ? { providerMessageId: envelope.providerMessageId }
              : {}),
            ...(commandText ? { commandText } : {}),
          },
          CONTROL_PLANE_RPC_TIMEOUTS_MS["host.autoReplyGuard"],
          currentDeadlineAt(),
        );
        return hostAutoReplyGuardResultSchema.parse(raw).admitted;
      },
    };

    // 派发桥可达性：任一未关闭的 Core 通道即可达；断开期间 pending 行留给宽限 sweep。
    // 不能复用 channelOf（它在关闭时抛错，会把可达性探测本身变成异常）。
    const hostReachable = (): boolean => {
      const channel = resolveChannel();
      return channel !== undefined && !channel.closed;
    };

    return {
      handleCommand: (rawParams: unknown) =>
        hostCommandWithDeadline(rawParams, currentDeadlineAt()),
      // 后台派发桥 push 不属于任何 RPC 父请求：显式不传 deadlineAt，只用方法自身预算。
      // 继承入站请求的 deadline 会在请求结束后永久过期（旧实现的实际故障）。
      dispatchHandleCommand: (rawParams: unknown) =>
        hostCommandWithDeadline(rawParams, undefined),
      isHostReachable: hostReachable,
      autoReplyGuard,
      worker,
      backfillSeeds,
      superAgentDatabasePath: getSuperAgentDatabasePath(this.options.dataBaseDir),
      ...(tasksIndexReady ? { tasksIndexDatabasePath: this.tasksIndexDatabasePath } : {}),
    };
  }
}

const CONTROL_PLANE_ERROR_WORKSPACE_FAILED = CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed;
