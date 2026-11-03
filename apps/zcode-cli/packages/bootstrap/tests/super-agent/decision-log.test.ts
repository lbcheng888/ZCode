import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createDecisionLog } from "../../src/super-agent/decision-log/index.js";
import { DECISION_LOG_RETENTION_DAYS } from "../../src/super-agent/decision-log/contract.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("super-agent-decision-log 仓储", () => {
  it("record 落行可读（含 evidence JSON 数组），sweepRetention 按 90 天滚动窗口清理", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const log = createDecisionLog(db);
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);

    log.record({
      workspaceIdentity: "ws-a",
      triggerId: "trigger-old",
      origin: "adjudication",
      disposition: "would_accept",
      batchId: "batch-1",
      modelTier: "adjudicator",
      reason: "候选无归属",
      evidence: ["threadKey=bot:1", "no-subscriber"],
      createdAt: now - (DECISION_LOG_RETENTION_DAYS + 1) * DAY_MS,
    });
    log.record({
      workspaceIdentity: "ws-a",
      triggerId: "trigger-new",
      origin: "fast_path",
      disposition: "routed",
      createdAt: now - 1 * DAY_MS,
    });

    const before = db.prepare("select count(*) as n from decision_log").get() as { n: number };
    expect(Number(before.n)).toBe(2);

    const removed = log.sweepRetention(now);
    expect(removed).toBe(1);

    const rows = db
      .prepare("select trigger_id, origin, disposition, evidence from decision_log order by created_at")
      .all() as {
      trigger_id: string;
      origin: string;
      disposition: string;
      evidence: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger_id).toBe("trigger-new");
    expect(rows[0]!.origin).toBe("fast_path");
    expect(rows[0]!.disposition).toBe("routed");

    // 幂等：窗口内已无过期行，重复 sweep 返回 0。
    expect(log.sweepRetention(now)).toBe(0);

    // evidence 落 JSON 数组文本，可原样还原。
    const oldEvidence = db
      .prepare("select evidence from decision_log where trigger_id = 'trigger-old'")
      .get() as { evidence: string } | undefined;
    expect(oldEvidence).toBeUndefined();
  });

  it("evidence 与 batch_id 原样往返（M12③ 分档记录字段不丢）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const log = createDecisionLog(db);
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);
    log.record({
      workspaceIdentity: "ws-b",
      origin: "adjudication",
      disposition: "record_only",
      batchId: "batch-9",
      modelTier: "adjudicator",
      evidence: ["e1", "e2"],
      createdAt: now,
    });
    const row = db
      .prepare("select batch_id, model_tier, evidence from decision_log where workspace_identity = 'ws-b'")
      .get() as { batch_id: string; model_tier: string; evidence: string };
    expect(row.batch_id).toBe("batch-9");
    expect(row.model_tier).toBe("adjudicator");
    expect(JSON.parse(row.evidence)).toEqual(["e1", "e2"]);
  });
});
