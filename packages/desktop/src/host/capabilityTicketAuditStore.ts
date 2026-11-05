// P6 能力票据审计库（spec §2.3 规则 6）。
//
// 权威仍是宿主内存 broker：本库只记录公开事实（ticketId/binding/scope/state/epoch），
// **没有 secret 列**，也不能用来复活票据——broker 重启时把上一进程未终态行标记 expired，
// 进程内 records 仍为空（旧票据一律 ticket.unknown）。
//
// 与 workspace 域库分开：broker 是宿主级执行授权权威，不是 workspace 数据；独立
// SQLite 文件避免与 daemon/plane 的域库单写者冲突（偏差登记见 P6 spec §2.3）。
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CapabilityTicket } from "@zcode/shared";
import type { CapabilityTicketAuditPort } from "./capabilityTicketBroker.js";

export interface CapabilityTicketAuditStore extends CapabilityTicketAuditPort {
  close(): void;
}

export function createCapabilityTicketAuditStore(options: {
  databasePath: string;
}): CapabilityTicketAuditStore {
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const db = new DatabaseSync(options.databasePath);
  // 审计库只在本机宿主进程内使用；文件权限收紧到 0600（WAL/SHM 由 SQLite 创建）。
  try {
    chmodSync(options.databasePath, 0o600);
  } catch {
    // 文件系统不支持 chmod（例如某些网络盘）时不能让宿主起不来；库内没有 secret。
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS capability_tickets (
      ticket_id TEXT PRIMARY KEY,
      workspace_identity TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      device_id TEXT,
      surface_kind TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      revoke_epoch INTEGER NOT NULL,
      redeemed_at INTEGER,
      revoked_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);

  const upsert = db.prepare(`
    INSERT INTO capability_tickets (
      ticket_id, workspace_identity, attachment_id, device_id, surface_kind,
      subject_kind, subject_id, scope_json, issued_at, expires_at, state,
      revoke_epoch, redeemed_at, revoked_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticket_id) DO UPDATE SET
      state = excluded.state,
      revoke_epoch = excluded.revoke_epoch,
      redeemed_at = excluded.redeemed_at,
      revoked_at = excluded.revoked_at,
      updated_at = excluded.updated_at
  `);
  const invalidate = db.prepare(`
    UPDATE capability_tickets
       SET state = 'expired', revoked_at = ?, updated_at = ?
     WHERE state IN ('issued', 'active')
  `);

  return {
    record(ticket) {
      upsert.run(
        ticket.ticketId,
        ticket.binding.workspaceIdentity,
        ticket.binding.attachmentId,
        ticket.binding.deviceId ?? null,
        ticket.binding.surfaceKind,
        ticket.binding.subject.kind,
        ticket.binding.subject.id,
        JSON.stringify(ticket.scope),
        ticket.issuedAt,
        ticket.expiresAt,
        ticket.state,
        ticket.revocationEpoch,
        ticket.redeemedAt ?? null,
        ticket.revokedAt ?? null,
        Date.now(),
      );
    },
    invalidateNonTerminal(at) {
      const result = invalidate.run(at, at);
      return Number(result.changes);
    },
    close() {
      db.close();
    },
  };
}
