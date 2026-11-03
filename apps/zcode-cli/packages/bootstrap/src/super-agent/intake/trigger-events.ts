/**
 * trigger_events 仓储：本模块是 intake 侧该表的写入点（spec §1.2 / §2 模块表）。
 * INSERT 与 fast_path / rejected 收敛的 UPDATE 只允许出现在本文件；
 * final_disposition / adjudication_status 的后续收敛（orphaned / adjudication）
 * 归 super-agent-trigger / super-agent-adjudication（经 trigger-events-access）。
 * 读（幂等短路回查）也收口在此。表结构由 super-agent-storage 迁移创建；本模块不建表。
 */
import { createHash, randomUUID } from "node:crypto";

import type { FastPathDisposition, IntakeDatabaseHandle } from "./contract.js";

/** payload 列内容上限（§1.2）：超限截断 + artifact 引用标记（P2 只落截断标记）。 */
export const TRIGGER_PAYLOAD_MAX_BYTES = 64 * 1024;

const TRUNCATION_MARKER = "…[truncated]";

export interface InsertTriggerEventInput {
  workspaceIdentity: string;
  source: string;
  threadKey: string;
  actorKind: string;
  actorId?: string;
  /** 已截断的 payload JSON 文本（本文件负责截断；调用方传原始 JSON 文本）。 */
  payload: string;
  provider?: string;
  providerMessageId?: string;
  now: number;
}

export interface TriggerEventRow {
  id: string;
  workspaceIdentity: string;
  fastPath: FastPathDisposition | null;
  adjudicationStatus: string | null;
  finalDisposition: string | null;
}

/** 摘要化 payload：UTF-8 字节超限截断（截断点按字符边界回退），digest 覆盖落库文本。 */
export function summarizePayload(rawJson: string): { payload: string; digest: string } {
  let payload = rawJson;
  if (Buffer.byteLength(payload, "utf8") > TRIGGER_PAYLOAD_MAX_BYTES) {
    // 按字符从尾部回退，保证多字节字符不被劈开；截断后仍可能超 64KB 边界内 3 字节，可接受。
    while (Buffer.byteLength(payload, "utf8") > TRIGGER_PAYLOAD_MAX_BYTES - TRUNCATION_MARKER.length) {
      payload = payload.slice(0, Math.max(0, payload.length - 256));
    }
    payload = `${payload}${TRUNCATION_MARKER}`;
  }
  return { payload, digest: createHash("sha256").update(payload).digest("hex") };
}

function toRow(record: Record<string, unknown>): TriggerEventRow {
  const fastPath = record.fast_path === null || record.fast_path === undefined ? null : String(record.fast_path);
  if (fastPath !== null && fastPath !== "owned" && fastPath !== "human_explicit" && fastPath !== "unowned_candidate") {
    // fast_path 列只允许 DDL 约定三态；未知值原样抛出，不静默归类。
    throw new Error(`trigger_events.fast_path 非法值: ${fastPath}`);
  }
  return {
    id: String(record.id),
    workspaceIdentity: String(record.workspace_identity),
    fastPath,
    adjudicationStatus:
      record.adjudication_status === null || record.adjudication_status === undefined
        ? null
        : String(record.adjudication_status),
    finalDisposition:
      record.final_disposition === null || record.final_disposition === undefined
        ? null
        : String(record.final_disposition),
  };
}

const SELECT_BY_PROVIDER_MESSAGE = `
  select id, workspace_identity, fast_path, adjudication_status, final_disposition
  from trigger_events where provider = ? and provider_message_id = ?
  limit 1
`;

const INSERT_SQL = `
  insert into trigger_events (
    id, workspace_identity, source, thread_key, actor_kind, actor_id,
    payload, payload_digest, taint, provider, provider_message_id,
    fast_path, adjudication_status, final_disposition, settled_at, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
`;

const UPDATE_FAST_PATH_SQL = `
  update trigger_events
  set fast_path = ?, adjudication_status = ?, updated_at = ?
  where id = ?
`;

const UPDATE_REJECTED_SQL = `
  update trigger_events
  set final_disposition = 'rejected', settled_at = ?, updated_at = ?
  where id = ?
`;

export interface TriggerEventsRepo {
  /**
   * 插入审计行（fast_path/adjudication_status 先 NULL，Fast Path 收敛后回写）。
   * provider_message_id 冲突（partial unique index）原样抛 SQLite 错误——调用方捕获后
   * 走 findByProviderMessageId 幂等短路（裁定 3：DB unique 是权威）。
   */
  insert(input: InsertTriggerEventInput): string;
  /** 幂等键回查；无行返回 undefined。 */
  findByProviderMessageId(provider: string, providerMessageId: string): TriggerEventRow | undefined;
  /** Fast Path 收敛回写：owned/explicit/candidate 落 fast_path；candidate 另落 adjudication_status=pending。 */
  markFastPath(
    id: string,
    fastPath: FastPathDisposition,
    adjudicationStatus: "pending" | null,
    now: number,
  ): void;
  /** 快路径拒绝终态：final_disposition='rejected' + settled_at（fast_path 保持 NULL）。 */
  markRejected(id: string, now: number): void;
}

export function createTriggerEventsRepo(db: IntakeDatabaseHandle): TriggerEventsRepo {
  return {
    insert(input: InsertTriggerEventInput): string {
      const id = randomUUID();
      const { payload, digest } = summarizePayload(input.payload);
      db.prepare(INSERT_SQL).run(
        id,
        input.workspaceIdentity,
        input.source,
        input.threadKey,
        input.actorKind,
        input.actorId ?? null,
        payload,
        digest,
        input.provider ?? null,
        input.providerMessageId ?? null,
        input.now,
        input.now,
      );
      return id;
    },
    findByProviderMessageId(provider: string, providerMessageId: string): TriggerEventRow | undefined {
      const row = db
        .prepare(SELECT_BY_PROVIDER_MESSAGE)
        .get(provider, providerMessageId) as Record<string, unknown> | undefined;
      return row ? toRow(row) : undefined;
    },
    markFastPath(
      id: string,
      fastPath: FastPathDisposition,
      adjudicationStatus: "pending" | null,
      now: number,
    ): void {
      db.prepare(UPDATE_FAST_PATH_SQL).run(fastPath, adjudicationStatus, now, id);
    },
    markRejected(id: string, now: number): void {
      db.prepare(UPDATE_REJECTED_SQL).run(now, now, id);
    },
  };
}

/** SQLite 冲突判定：UNIQUE(provider, provider_message_id) 冲突以外的错误不得被吞成幂等短路。 */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}
