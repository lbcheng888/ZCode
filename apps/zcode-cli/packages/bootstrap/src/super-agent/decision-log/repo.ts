import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  DECISION_LOG_RETENTION_DAYS,
  type DecisionLogEntryInput,
  type SuperAgentDecisionLogContract,
} from "./contract.js";

const RETENTION_MS = DECISION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const INSERT_SQL = `
  insert into decision_log (
    id, workspace_identity, trigger_id, origin, disposition,
    batch_id, model_tier, reason, evidence, card_payload, cheng_plan_id, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * decision_log 仓储：唯一写者模块（M12②）。表写入只允许出现在本文件；
 * 句柄由组合根经 super-agent-storage open 后注入（结构类型 = node:sqlite DatabaseSync）。
 */
export function createDecisionLog(db: DatabaseSync): SuperAgentDecisionLogContract {
  return {
    record(entry: DecisionLogEntryInput): void {
      db.prepare(INSERT_SQL).run(
        randomUUID(),
        entry.workspaceIdentity,
        entry.triggerId ?? null,
        entry.origin,
        entry.disposition,
        entry.batchId ?? null,
        entry.modelTier ?? null,
        entry.reason ?? null,
        entry.evidence === undefined ? null : JSON.stringify(entry.evidence),
        entry.card === undefined ? null : JSON.stringify(entry.card),
        entry.chengPlanId ?? null,
        entry.createdAt ?? Date.now(),
      );
    },
    sweepRetention(now: number): number {
      const cutoff = now - RETENTION_MS;
      const result = db.prepare("delete from decision_log where created_at < ?").run(cutoff);
      return Number(result.changes);
    },
  };
}
