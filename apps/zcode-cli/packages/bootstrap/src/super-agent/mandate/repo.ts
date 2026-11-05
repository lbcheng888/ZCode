import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  InsertMandateInput,
  MandateRecord,
  MandateResolveOptions,
  MandateStatus,
  MandateTier,
  MandateVerdict,
  SuperAgentMandateContract,
  SuperAgentMandateRepo,
} from "./contract.js";

const SELECT_COLUMNS = `
  id, workspace_identity, trigger_class, tier, scope, policy_version,
  resume_after_restart, expires_at, status, created_at, updated_at
`;

function toRecord(row: Record<string, unknown>): MandateRecord {
  const status = String(row.status);
  if (status !== "active" && status !== "revoked") {
    // 状态列只允许 DDL 约定的两个枚举值；未知值原样抛出，不静默归入 active。
    throw new Error(`mandate.status 非法值: ${status}`);
  }
  const tier = String(row.tier);
  if (tier !== "record_only" && tier !== "speculative" && tier !== "auto") {
    throw new Error(`mandate.tier 非法值: ${tier}`);
  }
  return {
    id: String(row.id),
    workspaceIdentity: String(row.workspace_identity),
    triggerClass: String(row.trigger_class),
    tier: tier as MandateTier,
    scope: row.scope === null || row.scope === undefined ? null : String(row.scope),
    policyVersion: Number(row.policy_version),
    resumeAfterRestart: Number(row.resume_after_restart) !== 0,
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    status: status as MandateStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** mandate 表仓储：表写入只允许出现在本文件；句柄由组合根经 super-agent-storage open 后注入。 */
export function createMandateRepo(db: DatabaseSync): SuperAgentMandateRepo {
  return {
    insert(input: InsertMandateInput): MandateRecord {
      const id = randomUUID();
      const now = input.now ?? Date.now();
      db.prepare(
        `insert into mandate (
          id, workspace_identity, trigger_class, tier, scope, policy_version,
          resume_after_restart, expires_at, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        id,
        input.workspaceIdentity,
        input.triggerClass,
        input.tier,
        input.scope ?? null,
        input.policyVersion,
        input.resumeAfterRestart === true ? 1 : 0,
        input.expiresAt ?? null,
        now,
        now,
      );
      return {
        id,
        workspaceIdentity: input.workspaceIdentity,
        triggerClass: input.triggerClass,
        tier: input.tier,
        scope: input.scope ?? null,
        policyVersion: input.policyVersion,
        resumeAfterRestart: input.resumeAfterRestart === true,
        expiresAt: input.expiresAt ?? null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
    },
    getActive(workspaceIdentity: string, triggerClass: string, now?: number): MandateRecord | undefined {
      const row = db
        .prepare(
          `select ${SELECT_COLUMNS} from mandate
            where workspace_identity = ? and trigger_class = ? and status = 'active'
              and (expires_at is null or expires_at >= ?)
            limit 1`,
        )
        .get(workspaceIdentity, triggerClass, now ?? Date.now()) as
        | Record<string, unknown>
        | undefined;
      return row ? toRecord(row) : undefined;
    },
    revoke(id: string, now?: number): boolean {
      const result = db
        .prepare("update mandate set status = 'revoked', updated_at = ? where id = ? and status = 'active'")
        .run(now ?? Date.now(), id);
      return Number(result.changes) > 0;
    },
    sweepExpired(now: number): number {
      const result = db
        .prepare(
          "update mandate set status = 'revoked', updated_at = ? where status = 'active' and expires_at is not null and expires_at < ?",
        )
        .run(now, now);
      return Number(result.changes);
    },
  };
}

/**
 * resolveFor（M4 三档）：缺省不注入 repo → 恒隐式 record_only（flag 关字节兼容，spec §0）；
 * 注入 repo + workspaceIdentity → 查 (workspace, trigger_class) active 未过期行（getActive
 * 已含 expires_at 过滤），命中返回显式档，未命中回退隐式（查询层 UNION 缺省）。
 */
export function createMandateContract(options?: {
  repo?: SuperAgentMandateRepo;
  workspaceIdentity?: string;
  now?: () => number;
}): SuperAgentMandateContract {
  return {
    resolveFor(triggerClass: string, resolveOptions?: MandateResolveOptions): MandateVerdict {
      const repo = resolveOptions?.repo ?? options?.repo;
      const workspaceIdentity = resolveOptions?.workspaceIdentity ?? options?.workspaceIdentity;
      if (!repo || !workspaceIdentity) {
        return { tier: "record_only", source: "implicit" };
      }
      const now = resolveOptions?.now ?? options?.now?.() ?? Date.now();
      const active = repo.getActive(workspaceIdentity, triggerClass, now);
      if (!active) {
        return { tier: "record_only", source: "implicit" };
      }
      // expiresAt 与 tier/mandateId 出自同一次 getActive 读：调用方不得再查一次补过期时间
      // （两次读之间可能被 revoke，会把已撤销 mandate 当成不设过期）。
      return { tier: active.tier, source: "explicit", mandateId: active.id, expiresAt: active.expiresAt };
    },
  };
}
