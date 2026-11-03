import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createDecisionLog } from "../../src/super-agent/decision-log/repo.js";
import { applyVerdicts } from "../../src/super-agent/trigger/verdict-interpret.js";
import type { TriggerDecisionLogEntryInput } from "../../src/super-agent/trigger/contract.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

function seedTriggerEvent(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `insert into trigger_events (
        id, workspace_identity, source, thread_key, actor_kind, actor_id, payload,
        payload_digest, taint, provider, provider_message_id, fast_path,
        adjudication_status, final_disposition, settled_at, created_at, updated_at
      ) values (?, 'ws-a', 'im', 'bot:bot-1:u1:t1', 'human', 'u1', '{"text":"hi"}',
        'digest', 1, 'feishu', ?, 'unowned_candidate', 'pending', null, null, ?, ?)`,
    )
    .run(id, `pm-${id}`, NOW, NOW);
}

function makeDecisionLog(sink: TriggerDecisionLogEntryInput[]): {
  record(entry: TriggerDecisionLogEntryInput): void;
} {
  return {
    record(entry) {
      sink.push(entry);
    },
  };
}

describe("super-agent-trigger applyVerdicts（§2.1，P2 全收敛 would-accept）", () => {
  it("无 Mandate：accept/record-only 落 would_accept 卡片 + record_only；reject 落 rejected", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-accept");
    seedTriggerEvent(db, "t-record");
    seedTriggerEvent(db, "t-reject");

    const sink: TriggerDecisionLogEntryInput[] = [];
    applyVerdicts(
      { db, decisionLog: makeDecisionLog(sink), now: () => NOW },
      "batch-1",
      [
        { triggerId: "t-accept", disposition: "accept", reason: "可处理", evidence: ["e1"] },
        { triggerId: "t-record", disposition: "record-only" },
        { triggerId: "t-reject", disposition: "reject", reason: "越权" },
      ],
    );

    const statuses = db
      .prepare(
        "select id, adjudication_status from trigger_events where id in ('t-accept','t-record','t-reject') order by id",
      )
      .all() as Array<{ id: string; adjudication_status: string }>;
    expect(statuses).toEqual([
      { id: "t-accept", adjudication_status: "record_only" },
      { id: "t-record", adjudication_status: "record_only" },
      { id: "t-reject", adjudication_status: "rejected" },
    ]);

    expect(sink).toHaveLength(3);
    expect(sink.map((entry) => entry.disposition)).toEqual([
      "would_accept",
      "would_accept",
      "reject",
    ]);
    expect(sink.every((entry) => entry.origin === "adjudication")).toBe(true);
    expect(sink.every((entry) => entry.batchId === "batch-1")).toBe(true);
    expect(sink[0]!.evidence).toEqual(["e1"]);
    expect(sink[2]!.reason).toBe("越权");
    // P2 无 mandateId：全部 candidate 只落 would-accept，不建订阅不触发执行（A4）。
    const subs = db
      .prepare("select count(*) as n from trigger_subscriptions")
      .get() as { n: number };
    expect(Number(subs.n)).toBe(0);
  });

  it("FK 不命中整批拒绝：零写入（fail-closed，不部分执行）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-valid");

    const sink: TriggerDecisionLogEntryInput[] = [];
    expect(() =>
      applyVerdicts(
        { db, decisionLog: makeDecisionLog(sink), now: () => NOW },
        "batch-2",
        [
          { triggerId: "t-valid", disposition: "accept" },
          { triggerId: "t-missing", disposition: "accept" },
        ],
      ),
    ).toThrow(/整批拒绝执行/);

    expect(sink).toHaveLength(0);
    const status = db
      .prepare("select adjudication_status from trigger_events where id = 't-valid'")
      .get() as { adjudication_status: string };
    expect(status.adjudication_status).toBe("pending");
  });

  it("写入段中途失败 → 整体 ROLLBACK（零部分执行，同批重放不产生重复行）", async () => {
    // 回归锚（reviewer minor）：FK 全量校验只保证「校验失败零写入」；校验通过后
    // 第 k 条 decisionLog.record 抛错时，前 k-1 条必须随事务一起回滚，否则整批
    // 半执行、且 decision_log（append-only）已落行会让重放产生重复行。
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-first");
    seedTriggerEvent(db, "t-second");

    const realDecisionLog = createDecisionLog(db);
    let records = 0;
    const failingDecisionLog = {
      record(entry: TriggerDecisionLogEntryInput): void {
        records += 1;
        if (records === 2) {
          throw new Error("decision_log 写入冲突");
        }
        realDecisionLog.record(entry);
      },
    };

    expect(() =>
      applyVerdicts(
        { db, decisionLog: failingDecisionLog, now: () => NOW },
        "batch-rollback",
        [
          { triggerId: "t-first", disposition: "accept" },
          { triggerId: "t-second", disposition: "reject" },
        ],
      ),
    ).toThrow(/decision_log 写入冲突/);

    const statuses = db
      .prepare(
        "select id, adjudication_status from trigger_events where id in ('t-first','t-second') order by id",
      )
      .all() as Array<{ id: string; adjudication_status: string }>;
    expect(statuses).toEqual([
      { id: "t-first", adjudication_status: "pending" },
      { id: "t-second", adjudication_status: "pending" },
    ]);
    const rows = db.prepare("select count(*) as n from decision_log").get() as { n: number };
    expect(Number(rows.n)).toBe(0);
  });
});
