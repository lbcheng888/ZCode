import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  capabilityTicketBindingsMatch,
  capabilityTicketSchema,
  capabilityTicketScopeAllows,
  capabilityTicketScopeWithinRole,
  capabilityTicketScopeSchema,
  capabilityTicketRedeemRequestSchema,
  classifyAttachmentTool,
  issueCapabilityTicketRequestSchema,
  normalizeCapabilityTicketScope,
  resolveCapabilityTicketTtlMs,
  CAPABILITY_TICKET_MAX_TTL_MS,
  type AttachmentRole,
  type CapabilityTicket,
  type CapabilityTicketFailureCode,
  type CapabilityTicketMode,
  type CapabilityTicketRedeemRequest,
  type CapabilityTicketRedeemResult,
  type CapabilityTicketScope,
  type IssueCapabilityTicketRequest,
} from "@zcode/shared";

/**
 * P6 能力票据 broker（spec §2.3/§2.5，本批宿主内存权威）。
 *
 * 落点偏差（如实登记）：spec 要求 broker 固定落受管 headless 控制面子进程（bootstrap 组合根）
 * 或独立 edge 进程；本 lane 的可写分区只有 desktop/host，因此这里实现**宿主进程内**内存
 * broker，供 Desktop host 的 attachment 生命周期使用。daemon 仍不签发凭据。edge/远端兑换的
 * 结构在本仓不可达（没有 broker 进程面/控制协议），未接线。SQLite `capability_tickets`
 * 持久表与重启后未终态行审计也未实现；生产组合根默认关闭票据（feature flag + fail-closed）。
 *
 * 语义：
 * - secret 只从 `issue` 返回一次，永不进 status/日志/协议/模型上下文。
 * - 每次兑换原子校验：存在性 → 过期 → 吊销/epoch → 绑定 → secret → nonce/seq 重放 → scope。
 * - 吊销即时：`revoke` / `revokeByAttachment` / `revokeByDevice` 推进 broker 全局单调 epoch，
 *   同时把每张被吊销票据自身的 `revocationEpoch` 更新到该值。兑换请求**必须**携带票据自身的
 *   签发快照，与该票据自己的 epoch 不等直接 `ticket.revoked`（fail-closed，不做本地缓存兜底，
 *   也没有“省略 epoch 就跳过校验”的旁路）。
 *
 *   关键取舍：epoch 校验按**票据自身**判定，不按 broker 全局值。同一 window host 里多个
 *   attachment 共享一个 broker；若拿全局 epoch 比较，任一 attachment detach/port close 都会
 *   +1，其他未吊销 attachment 手里的签发快照永远追不上，票据会在 TTL 内被误判 revoked，
 *   且客户端收不到新 epoch（只有重新 attach/setRole 才重投递）。被吊销票据由 state=revoked
 *   先行拒绝；这里比对 ticket 自身快照，既保证“必须原样带回 epoch”，又不跨 attachment 误伤。
 * - `sweepExpired` 标记过期并清理超过保留窗口的终态记录；registry 在 attach 时机会式调用，
 *   避免 records Map 无界增长（不引入轮询定时器）。
 * - broker 重启 = 新实例 = 全部旧票据 `ticket.unknown`（C7 由内存权威天然满足）。
 */

export type CapabilityTicketIssueErrorCode =
  | "ticket.invalid_binding"
  | "ticket.invalid_scope"
  | "ticket.scope_denied"
  | "ticket.ttl_exceeded";

export class CapabilityTicketIssueError extends Error {
  readonly code: CapabilityTicketIssueErrorCode;

  constructor(code: CapabilityTicketIssueErrorCode, message: string) {
    super(message);
    this.name = "CapabilityTicketIssueError";
    this.code = code;
  }
}

export interface IssuedCapabilityTicket {
  ticket: CapabilityTicket;
  /** 仅在签发返回中出现一次；调用方必须走受控通道，不得落库/日志/模型上下文。 */
  ticketSecret: string;
}

interface TicketRecord {
  ticket: CapabilityTicket;
  secret: string;
  mode: CapabilityTicketMode;
  /** 签发时宿主派生的权威角色；兑换时用于计算 requiresHostConfirmation。 */
  role: AttachmentRole;
  /** 已成功兑换过的 nonce；同一 nonce 再次出现即重放。 */
  seenNonces: Set<string>;
  /** sequential 票据的最后一个 seq；下一次必须严格更大。 */
  lastSeq: number | undefined;
}

/**
 * 终态记录保留窗口：sweepExpired 之后仍保留这么久用于审计/排障，超过即删除，避免宿主
 * 生命周期内 records Map 无界增长。终态票据删除后再兑换自然是 ticket.unknown（仍 deny）。
 */
const CAPABILITY_TICKET_TERMINAL_RETENTION_MS = 10 * 60_000;

export interface CapabilityTicketBrokerOptions {
  now?: () => number;
  createTicketId?: () => string;
  createSecret?: () => string;
  maxTtlMs?: number;
}

export interface CapabilityTicketStatus extends CapabilityTicket {
  /**
   * broker 当前全局 epoch（审计用）。票据自带的 `revocationEpoch` 是该票据自身的快照：
   * 未吊销时二者可能不等（别的 attachment 吊销过），这不代表本票据失效。
   */
  currentRevocationEpoch: number;
}

export interface CapabilityTicketBroker {
  issue(request: IssueCapabilityTicketRequest): IssuedCapabilityTicket;
  redeem(request: CapabilityTicketRedeemRequest): CapabilityTicketRedeemResult;
  revoke(ticketId: string): boolean;
  revokeByAttachment(attachmentId: string): number;
  revokeByDevice(deviceId: string): number;
  sweepExpired(at?: number): number;
  status(ticketId: string): CapabilityTicketStatus | undefined;
  /** 当前全局吊销 epoch（审计/观测用）。兑换必须携带票据自身的签发快照，不是本全局值。 */
  getRevocationEpoch(): number;
}

function defaultCreateTicketId(): string {
  return randomBytes(16).toString("base64url");
}

function defaultCreateSecret(): string {
  return randomBytes(32).toString("base64url");
}

function secretsEqual(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  if (expectedBytes.length !== receivedBytes.length) return false;
  return timingSafeEqual(expectedBytes, receivedBytes);
}

function redeemFailure(code: CapabilityTicketFailureCode): CapabilityTicketRedeemResult {
  return { ok: false, code, message: code };
}

export function createCapabilityTicketBroker(
  options: CapabilityTicketBrokerOptions = {},
): CapabilityTicketBroker {
  const now = options.now ?? Date.now;
  const createTicketId = options.createTicketId ?? defaultCreateTicketId;
  const createSecret = options.createSecret ?? defaultCreateSecret;
  const maxTtlMs = options.maxTtlMs ?? CAPABILITY_TICKET_MAX_TTL_MS;
  const records = new Map<string, TicketRecord>();
  let revocationEpoch = 0;

  function issue(request: IssueCapabilityTicketRequest): IssuedCapabilityTicket {
    const parsed = issueCapabilityTicketRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new CapabilityTicketIssueError(
        "ticket.invalid_binding",
        `Invalid capability ticket issue request: ${parsed.error.message}`,
      );
    }
    const { binding, role, mode, ttlMs } = parsed.data;
    // tools-only scope 在签发时归一为 toolClasses：票据自身固定工具族约束，兑换时不能靠
    // 调用方传入的 permissionGroup 重算分类绕过（见 capabilityTicketScopeAllows）。
    const requestedScope: CapabilityTicketScope = normalizeCapabilityTicketScope(
      capabilityTicketScopeSchema.parse(parsed.data.scope),
    );
    if (!capabilityTicketScopeWithinRole(role, requestedScope)) {
      throw new CapabilityTicketIssueError(
        "ticket.scope_denied",
        `Role ${role} cannot request scope ${JSON.stringify(requestedScope)}`,
      );
    }
    const resolvedMode: CapabilityTicketMode = mode ?? "single_use";
    const resolvedTtlMs = resolveCapabilityTicketTtlMs(resolvedMode, ttlMs);
    if (resolvedTtlMs > maxTtlMs) {
      throw new CapabilityTicketIssueError(
        "ticket.ttl_exceeded",
        `Capability ticket ttl ${resolvedTtlMs}ms exceeds hard cap ${maxTtlMs}ms`,
      );
    }

    let ticketId = createTicketId();
    // 随机 128-bit 下碰撞概率可忽略；有界重试把注入的退化生成器变成显式崩溃而不是死循环。
    let collisionAttempts = 0;
    while (records.has(ticketId)) {
      collisionAttempts += 1;
      if (collisionAttempts > 8) {
        throw new Error("capability ticket id collision persisted after 8 attempts");
      }
      ticketId = createTicketId();
    }
    const issuedAt = now();
    const ticket = capabilityTicketSchema.parse({
      ticketId,
      binding,
      scope: requestedScope,
      issuedAt,
      expiresAt: issuedAt + resolvedTtlMs,
      revocationEpoch,
      state: "issued",
    }) satisfies CapabilityTicket;
    const ticketSecret = createSecret();
    records.set(ticketId, {
      ticket,
      secret: ticketSecret,
      mode: resolvedMode,
      role,
      seenNonces: new Set<string>(),
      lastSeq: undefined,
    });
    return { ticket, ticketSecret };
  }

  function markRevoked(ticket: CapabilityTicket, at: number): void {
    if (ticket.state === "revoked") return;
    ticket.state = "revoked";
    ticket.revokedAt = at;
    revocationEpoch += 1;
    ticket.revocationEpoch = revocationEpoch;
  }

  function markExpired(ticket: CapabilityTicket): void {
    if (ticket.state === "revoked" || ticket.state === "expired") return;
    ticket.state = "expired";
  }

  function revoke(ticketId: string): boolean {
    const record = records.get(ticketId);
    if (!record || record.ticket.state === "revoked") return false;
    markRevoked(record.ticket, now());
    return true;
  }

  /**
   * 批量吊销。命中 0 张时不推进 epoch：吊销不存在的票据不算一次吊销；若在这里无条件 +1，
   * 任何 no-op 调用（例如本地 attachment 的 detach）都会把所有其他在途票据打成 revoked，
   * 变成拒绝服务面。spec §2.3 规则 4 的“吊销即 +1”按实际生效的吊销执行。
   */
  function revokeByAttachment(attachmentId: string): number {
    const at = now();
    let count = 0;
    for (const record of records.values()) {
      if (record.ticket.binding.attachmentId !== attachmentId) continue;
      if (record.ticket.state === "revoked") continue;
      markRevoked(record.ticket, at);
      count += 1;
    }
    return count;
  }

  function revokeByDevice(deviceId: string): number {
    const at = now();
    let count = 0;
    for (const record of records.values()) {
      if (record.ticket.binding.deviceId !== deviceId) continue;
      if (record.ticket.state === "revoked") continue;
      markRevoked(record.ticket, at);
      count += 1;
    }
    return count;
  }

  function terminalTimestamp(record: TicketRecord): number {
    if (record.ticket.state === "revoked") {
      return record.ticket.revokedAt ?? record.ticket.expiresAt;
    }
    if (record.ticket.state === "consumed" && record.ticket.redeemedAt !== undefined) {
      return record.ticket.redeemedAt;
    }
    return record.ticket.expiresAt;
  }

  /**
   * 标记过期并清理超过保留窗口的终态记录（spec §2.3 规则 6 的 sweep）。
   * 返回值是本次**新标记**的过期数；清理终态记录不计入。
   */
  function sweepExpired(at: number = now()): number {
    let count = 0;
    for (const [ticketId, record] of records) {
      if (record.ticket.state === "issued" || record.ticket.state === "active") {
        if (at >= record.ticket.expiresAt) {
          markExpired(record.ticket);
          count += 1;
        }
        continue;
      }
      if (at >= terminalTimestamp(record) + CAPABILITY_TICKET_TERMINAL_RETENTION_MS) {
        records.delete(ticketId);
      }
    }
    return count;
  }

  function status(ticketId: string): CapabilityTicketStatus | undefined {
    const record = records.get(ticketId);
    if (!record) return undefined;
    const ticket = record.ticket;
    return {
      ...ticket,
      binding: { ...ticket.binding },
      scope: { ...ticket.scope },
      currentRevocationEpoch: revocationEpoch,
    };
  }

  function getRevocationEpoch(): number {
    return revocationEpoch;
  }

  function redeem(request: CapabilityTicketRedeemRequest): CapabilityTicketRedeemResult {
    const parsed = capabilityTicketRedeemRequestSchema.safeParse(request);
    if (!parsed.success) {
      // 结构非法不是「票据不存在」的授权失败，但对外仍是 fail-closed deny。
      return redeemFailure("ticket.binding_mismatch");
    }
    const input = parsed.data;
    const record = records.get(input.ticketId);
    if (!record) return redeemFailure("ticket.unknown");

    const at = now();
    if (at >= record.ticket.expiresAt) {
      markExpired(record.ticket);
      return redeemFailure("ticket.expired");
    }
    if (record.ticket.state === "revoked") return redeemFailure("ticket.revoked");
    // 吊销 epoch 传播：schema 已强制携带；与**该票据自身**的快照不等即拒绝（fail-closed）。
    // 不能用 broker 全局 epoch：多个 attachment 共享 broker 时，别的 attachment 吊销会推进
    // 全局值，让未受影响 attachment 的签发快照永远追不上，票据在 TTL 内被误判 revoked。
    if (input.revocationEpoch !== record.ticket.revocationEpoch) {
      return redeemFailure("ticket.revoked");
    }
    if (record.ticket.state === "expired") return redeemFailure("ticket.expired");
    if (record.ticket.state === "consumed") return redeemFailure("ticket.replayed");
    if (!capabilityTicketBindingsMatch(record.ticket.binding, input.binding)) {
      return redeemFailure("ticket.binding_mismatch");
    }
    if (!secretsEqual(record.secret, input.ticketSecret)) {
      // 不区分「票据不存在」与「secret 错误」，避免探测 oracle。
      return redeemFailure("ticket.unknown");
    }
    if (record.seenNonces.has(input.nonce)) return redeemFailure("ticket.replayed");
    if (record.mode === "sequential") {
      if (input.seq === undefined) return redeemFailure("ticket.replayed");
      if (record.lastSeq !== undefined && input.seq <= record.lastSeq) {
        return redeemFailure("ticket.replayed");
      }
    }
    if (!capabilityTicketScopeAllows(record.ticket.scope, input.action)) {
      return redeemFailure("ticket.scope_denied");
    }

    record.seenNonces.add(input.nonce);
    if (record.mode === "single_use") {
      record.ticket.state = "consumed";
      record.ticket.redeemedAt = at;
    } else {
      record.ticket.state = "active";
      record.ticket.redeemedAt = at;
      record.lastSeq = input.seq;
    }
    // 写操作在非 host 角色下是 ask：兑换成功只代表票据有效，不代表宿主已确认（spec §1.3）。
    // 当前签发侧已禁止非 host 申请 workspace_write，这里仍把结论写进句柄，执行端不得省略。
    const requiresHostConfirmation =
      record.role !== "host" &&
      classifyAttachmentTool(input.action.toolName, input.action.permissionGroup) ===
        "workspace_write";
    return {
      ok: true,
      ticketId: record.ticket.ticketId,
      injection: {
        ticketId: record.ticket.ticketId,
        binding: { ...record.ticket.binding },
        scope: { ...record.ticket.scope },
        expiresAt: record.ticket.expiresAt,
        revocationEpoch: record.ticket.revocationEpoch,
        requiresHostConfirmation,
      },
    };
  }

  return {
    issue,
    redeem,
    revoke,
    revokeByAttachment,
    revokeByDevice,
    sweepExpired,
    status,
    getRevocationEpoch,
  };
}
