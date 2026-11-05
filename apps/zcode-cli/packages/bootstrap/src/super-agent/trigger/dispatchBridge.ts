/**
 * dispatch_requests 派发桥状态机（spec super-agent-trigger-subsystem-spec §1.6 /
 * §3.2，M7② exactly-once）。
 *
 * 状态机（全部转移 = 单条 UPDATE … WHERE id=? AND status=? CAS，跨进程靠 WAL + CAS
 * 串行化）：
 *
 *   claimDue ──► pending_dispatch ──pushDispatch──► pushed ──onHostAck──► dispatched
 *                      │
 *                      └──sweepSkipped(宽限) CAS──► skipped(no_dispatcher)
 *
 * - settle dispatched 仅在 host ACK（admitted | duplicate）后（§1.6）。
 * - skipped 仅由宽限定时器触发且与 push 状态 CAS 互斥：push 成功后的行不可能再被
 *   跳过；被跳过的行 pushDispatch 返回 already_terminal、零推送（T3⑤）。
 * - 崩溃重投：pushed 停滞行由 resumePendingAfterBoot 重推同 commandId（hash(runId)），
 *   CommandInbox 幂等吸收不双跑（T3②）；pending 停滞行按宿主可达性补推或留给宽限
 *   结算（T3①④）。无 failed 终态：push 异常计入 attempts 后原样上浮，行保持可续推。
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  DispatchAckResult,
  DispatchClaimInput,
  DispatchClaimResult,
  DispatchPolicy,
  DispatchPushPort,
  DispatchPushResult,
  DispatchRequestRecord,
  ResumePendingAfterBootOptions,
  ResumePendingAfterBootResult,
  SuperAgentDispatchBridgeContract,
  SweepSkippedOptions,
} from "./dispatchBridgePort.js";

/**
 * commandId = hash(runId)（§1.6）：同 runId 崩溃重投恒同键，由 CommandInbox 幂等
 * 吸收（M7②）。取 sha256 十六进制——稳定、无方向、跨重启可复算。
 */
export function dispatchCommandIdForRun(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}

/** SQLite 冲突判定：仅 run_id/command_id 的 UNIQUE 冲突走幂等短路，其余错误原样上浮。 */
function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

const COLUMNS = `id, run_id, command_id, workspace_identity, session_id, payload,
  status, skip_reason, dispatch_policy, attempts,
  claimed_at, pushed_at, acked_at, settled_at, created_at, updated_at`;

const INSERT_CLAIM_SQL = `
  insert into dispatch_requests (${COLUMNS})
  values (?, ?, ?, ?, ?, ?, 'pending_dispatch', NULL, ?, 0, ?, NULL, NULL, NULL, ?, ?)
`;

const SELECT_BY_ID_SQL = `select ${COLUMNS} from dispatch_requests where id = ?`;
const SELECT_BY_RUN_ID_SQL = `select ${COLUMNS} from dispatch_requests where run_id = ?`;
const SELECT_BY_COMMAND_ID_SQL = `select ${COLUMNS} from dispatch_requests where command_id = ?`;
const SELECT_BY_STATUS_SQL = `select ${COLUMNS} from dispatch_requests where status = ? order by updated_at`;
const SELECT_BY_STATUS_WORKSPACE_SQL = `select ${COLUMNS} from dispatch_requests where status = ? and workspace_identity = ? order by updated_at`;

/** pending→pushed CAS：attempts+1、记 pushed_at。 */
const CAS_PENDING_TO_PUSHED_SQL = `
  update dispatch_requests
  set status = 'pushed', pushed_at = ?, attempts = attempts + 1, updated_at = ?
  where id = ? and status = 'pending_dispatch'
`;

/** pushed 续推：attempts+1、刷新 pushed_at（行状态不变，attempts 供失败面告警）。 */
const CAS_PUSHED_RETRY_SQL = `
  update dispatch_requests
  set pushed_at = ?, attempts = attempts + 1, updated_at = ?
  where id = ? and status = 'pushed'
`;

/** pushed→dispatched CAS：仅 host ACK 后 settle（§1.6）。 */
const CAS_PUSHED_TO_DISPATCHED_SQL = `
  update dispatch_requests
  set status = 'dispatched', acked_at = ?, settled_at = ?, updated_at = ?
  where command_id = ? and status = 'pushed'
`;

/** 宽限跳过：只结算 in_window 的 pending_dispatch（与 push 的 CAS 互斥面）。 */
const CAS_SWEEP_IN_WINDOW_SQL = `
  update dispatch_requests
  set status = 'skipped', skip_reason = 'no_dispatcher', settled_at = ?, updated_at = ?
  where status = 'pending_dispatch' and dispatch_policy = 'in_window' and updated_at <= ?
`;

/** 宽限跳过（本 plane 范围）：单 child 多 plane 共用 tasks-index 时按 workspace CAS。 */
const CAS_SWEEP_IN_WINDOW_WORKSPACE_SQL = `
  update dispatch_requests
  set status = 'skipped', skip_reason = 'no_dispatcher', settled_at = ?, updated_at = ?
  where status = 'pending_dispatch' and dispatch_policy = 'in_window'
    and workspace_identity = ? and updated_at <= ?
`;

/** durable-wait 最大陈旧期（T3④）：超龄才结算，跳过原因 stale。 */
const CAS_SWEEP_DURABLE_STALE_SQL = `
  update dispatch_requests
  set status = 'skipped', skip_reason = 'stale', settled_at = ?, updated_at = ?
  where status = 'pending_dispatch' and dispatch_policy = 'durable_wait' and updated_at <= ?
`;

const CAS_SWEEP_DURABLE_STALE_WORKSPACE_SQL = `
  update dispatch_requests
  set status = 'skipped', skip_reason = 'stale', settled_at = ?, updated_at = ?
  where status = 'pending_dispatch' and dispatch_policy = 'durable_wait'
    and workspace_identity = ? and updated_at <= ?
`;

function toRecord(row: Record<string, unknown>): DispatchRequestRecord {
  const status = String(row.status);
  if (
    status !== "pending_dispatch" &&
    status !== "pushed" &&
    status !== "dispatched" &&
    status !== "skipped"
  ) {
    // status 列只允许 DDL 约定四态；未知值原样抛出，不静默归类。
    throw new Error(`dispatch_requests.status 非法值: ${status}`);
  }
  const policy = String(row.dispatch_policy);
  if (policy !== "in_window" && policy !== "durable_wait") {
    throw new Error(`dispatch_requests.dispatch_policy 非法值: ${policy}`);
  }
  return {
    id: String(row.id),
    runId: String(row.run_id),
    commandId: String(row.command_id),
    workspaceIdentity: String(row.workspace_identity),
    sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    payload: row.payload === null || row.payload === undefined ? null : String(row.payload),
    // 运行时校验已收敛到四态，此处收窄给类型面。
    status: status as DispatchRequestRecord["status"],
    skipReason:
      row.skip_reason === null || row.skip_reason === undefined ? null : String(row.skip_reason),
    dispatchPolicy: policy as DispatchRequestRecord["dispatchPolicy"],
    attempts: Number(row.attempts),
    claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
    pushedAt: row.pushed_at === null || row.pushed_at === undefined ? null : Number(row.pushed_at),
    ackedAt: row.acked_at === null || row.acked_at === undefined ? null : Number(row.acked_at),
    settledAt: row.settled_at === null || row.settled_at === undefined ? null : Number(row.settled_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export interface DispatchBridgeDeps {
  /** tasks-index 句柄（dispatch_requests 表由 services 迁移 §1.6 建出）。 */
  db: DatabaseSync;
  /** push 端（host CommandInbox RPC；组合根注入）。 */
  push: DispatchPushPort;
  /** 注入时钟（测试/回放）；缺省 Date.now。 */
  now?: () => number;
}

/**
 * 派发桥组合工厂：一个 tasks-index 句柄 + 一个 push 端口得到 §2.1 五方法。
 * 组合根（控制面宿主，§7-7）负责打开库与注入端口；本工厂不启动循环。
 */
export function createDispatchBridge(deps: DispatchBridgeDeps): SuperAgentDispatchBridgeContract {
  const { db, push } = deps;
  const now = deps.now ?? Date.now;

  const selectById = db.prepare(SELECT_BY_ID_SQL);
  const selectByRunId = db.prepare(SELECT_BY_RUN_ID_SQL);
  const selectByCommandId = db.prepare(SELECT_BY_COMMAND_ID_SQL);
  const selectByStatus = db.prepare(SELECT_BY_STATUS_SQL);
  const selectByStatusWorkspace = db.prepare(SELECT_BY_STATUS_WORKSPACE_SQL);
  const insertClaim = db.prepare(INSERT_CLAIM_SQL);
  const casPendingToPushed = db.prepare(CAS_PENDING_TO_PUSHED_SQL);
  const casPushedRetry = db.prepare(CAS_PUSHED_RETRY_SQL);
  const casPushedToDispatched = db.prepare(CAS_PUSHED_TO_DISPATCHED_SQL);
  const sweepInWindow = db.prepare(CAS_SWEEP_IN_WINDOW_SQL);
  const sweepInWindowWorkspace = db.prepare(CAS_SWEEP_IN_WINDOW_WORKSPACE_SQL);
  const sweepDurableStale = db.prepare(CAS_SWEEP_DURABLE_STALE_SQL);
  const sweepDurableStaleWorkspace = db.prepare(CAS_SWEEP_DURABLE_STALE_WORKSPACE_SQL);

  function readById(id: string): DispatchRequestRecord | undefined {
    const row = selectById.get(id) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : undefined;
  }

  function readByRunId(runId: string): DispatchRequestRecord | undefined {
    const row = selectByRunId.get(runId) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : undefined;
  }

  function readByCommandId(commandId: string): DispatchRequestRecord | undefined {
    const row = selectByCommandId.get(commandId) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : undefined;
  }

  function terminalResult(record: DispatchRequestRecord): DispatchPushResult {
    if (record.status !== "dispatched" && record.status !== "skipped") {
      throw new Error(`terminalResult 收到非终态行: ${record.status}`);
    }
    return {
      kind: "already_terminal",
      requestId: record.id,
      status: record.status,
      skipReason: record.skipReason,
    };
  }

  /**
   * 真正的推送：行必须已处于 pushed（claim→pushed CAS 已完成），带上稳定 commandId
   * 调端口。端口异常原样上浮——行保持 pushed、attempts 已 +1，由崩溃重投规则续推。
   */
  async function pushRecord(record: DispatchRequestRecord): Promise<DispatchPushResult> {
    const receipt = await push.push({
      requestId: record.id,
      commandId: record.commandId,
      runId: record.runId,
      workspaceIdentity: record.workspaceIdentity,
      sessionId: record.sessionId,
      payload: record.payload,
    });
    return { kind: "pushed", requestId: record.id, commandId: record.commandId, receipt };
  }

  /** CAS pending→pushed（或 pushed 续推）；被并发 sweep/ACK 抢先则收敛为 null。 */
  function casToPushed(record: DispatchRequestRecord, timestamp: number): DispatchRequestRecord | null {
    if (record.status === "pending_dispatch") {
      casPendingToPushed.run(timestamp, timestamp, record.id);
    } else {
      casPushedRetry.run(timestamp, timestamp, record.id);
    }
    // 以回读为准：changes=0 且行已被并发转移（sweep 抢先 skipped、或 ACK 已 dispatched）
    // 时返回非 pushed 态，由调用方收敛为 already_terminal；changes=1 时回读取新态。
    const fresh = readById(record.id);
    if (!fresh) throw new Error(`dispatch_requests 行在 CAS 后消失: ${record.id}`);
    return fresh.status === "pushed" ? fresh : null;
  }

  async function pushDispatch(requestId: string): Promise<DispatchPushResult> {
    const record = readById(requestId);
    if (!record) return { kind: "not_found", requestId };
    if (record.status === "dispatched" || record.status === "skipped") {
      // 终态零推送（T3①③：claim 后未推被宽限结算 / ACK 后不再推）。
      return terminalResult(record);
    }
    const timestamp = now();
    const pushed = casToPushed(record, timestamp);
    if (!pushed) {
      const fresh = readById(requestId);
      if (!fresh) return { kind: "not_found", requestId };
      return terminalResult(fresh);
    }
    return pushRecord(pushed);
  }

  async function resumePendingAfterBoot(
    options?: ResumePendingAfterBootOptions,
  ): Promise<ResumePendingAfterBootResult> {
    const result: ResumePendingAfterBootResult = { pushed: [], pending: [], failures: [] };
    const hostAvailable = options?.hostAvailable ?? push.isHostReachable?.() ?? true;
    const workspaceIdentity = options?.workspaceIdentity;
    const rowsOf = (status: "pushed" | "pending_dispatch"): Record<string, unknown>[] =>
      workspaceIdentity === undefined
        ? (selectByStatus.all(status) as Record<string, unknown>[])
        : (selectByStatusWorkspace.all(status, workspaceIdentity) as Record<string, unknown>[]);
    const stalled = [...rowsOf("pushed"), ...rowsOf("pending_dispatch")].map(toRecord);
    if (!hostAvailable) {
      // 宿主不可达：不推任何行（T3①/④——in-window 由随后的 sweep 按宽限结算，
      // durable-wait 留待回连）。重推也必须等回连，避免对着空宿主刷 attempts。
      for (const record of stalled) result.pending.push(record.id);
      return result;
    }
    for (const record of stalled) {
      try {
        // pushDispatch 统一走 pending→pushed / pushed 续推 CAS（attempts 每次 +1），
        // 停滞 pushed 行重推同 commandId（T3②）。
        const outcome = await pushDispatch(record.id);
        if (outcome.kind === "pushed") {
          if (outcome.receipt.status === "rejected") {
            // 确定性拒绝（如 dispatch.sessionRequired/payloadMissing）不是 ACK：行停在
            // pushed。§1.6 无 failed 终态、skipped 只允许宽限触发，这里不能自行造终态；
            // 但**不得静默**——计入 failures 由循环 onError 告警（调停收敛待 spec 裁决）。
            result.failures.push({
              requestId: record.id,
              message: `host rejected admission: ${outcome.receipt.reasonCode ?? "unknown"}`,
            });
            result.pending.push(record.id);
          } else {
            result.pushed.push({ requestId: record.id, commandId: outcome.commandId });
          }
        } else if (outcome.kind === "not_found") {
          // 行在扫描与推送之间被并发删除（TTL 清理）：不重试，不报失败。
          continue;
        } else {
          // already_terminal：已被并发 ACK/跳过收敛，零动作。
        }
      } catch (error) {
        // 推失败不吞：行保持 pushed，错误带出供告警；下轮 resume 续推同 commandId。
        result.failures.push({
          requestId: record.id,
          message: error instanceof Error ? error.message : String(error),
        });
        result.pending.push(record.id);
      }
    }
    return result;
  }

  return {
    claimDue(input: DispatchClaimInput): DispatchClaimResult {
      const timestamp = input.now ?? now();
      const commandId = dispatchCommandIdForRun(input.runId);
      const requestId = randomUUID();
      const policy: DispatchPolicy = input.dispatchPolicy ?? "in_window";
      try {
        insertClaim.run(
          requestId,
          input.runId,
          commandId,
          input.workspaceIdentity,
          input.sessionId ?? null,
          input.payload ?? null,
          policy,
          timestamp,
          timestamp,
          timestamp,
        );
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        // run_id UNIQUE 幂等短路（§1.6）：同 runId 已有行 → 返回既有行，零新增。
        const existing = readByRunId(input.runId);
        if (!existing) throw error;
        return {
          requestId: existing.id,
          runId: existing.runId,
          commandId: existing.commandId,
          status: existing.status,
          created: false,
        };
      }
      return {
        requestId,
        runId: input.runId,
        commandId,
        status: "pending_dispatch",
        created: true,
      };
    },

    pushDispatch,

    onHostAck(commandId: string, outcome: "admitted" | "duplicate"): DispatchAckResult {
      const timestamp = now();
      const result = casPushedToDispatched.run(timestamp, timestamp, timestamp, commandId);
      if (Number(result.changes) === 1) {
        const record = readByCommandId(commandId);
        if (!record) throw new Error(`dispatch_requests 行在 ACK 后消失: ${commandId}`);
        return { kind: "settled", requestId: record.id };
      }
      const record = readByCommandId(commandId);
      // ACK 不命中行 = 调用方把未知 commandId 当回执，编程错误：响亮失败不吞。
      if (!record) {
        throw new Error(`onHostAck: commandId 未命中 dispatch_requests 行: ${commandId}`);
      }
      // 幂等：重复 ACK、或 ACK 时行已被并发转移 → noop（outcome 只认 admitted|duplicate）。
      void outcome;
      return { kind: "noop", requestId: record.id, status: record.status };
    },

    sweepSkipped(sweepNow: number, graceMs: number, options?: SweepSkippedOptions): number {
      const cutoff = sweepNow - graceMs;
      const workspaceIdentity = options?.workspaceIdentity;
      let changed =
        workspaceIdentity === undefined
          ? Number(sweepInWindow.run(sweepNow, sweepNow, cutoff).changes)
          : Number(sweepInWindowWorkspace.run(sweepNow, sweepNow, workspaceIdentity, cutoff).changes);
      if (options?.durableMaxStaleMs !== undefined) {
        const staleCutoff = sweepNow - options.durableMaxStaleMs;
        changed +=
          workspaceIdentity === undefined
            ? Number(sweepDurableStale.run(sweepNow, sweepNow, staleCutoff).changes)
            : Number(
                sweepDurableStaleWorkspace.run(sweepNow, sweepNow, workspaceIdentity, staleCutoff)
                  .changes,
              );
      }
      return changed;
    },

    resumePendingAfterBoot,
  };
}
