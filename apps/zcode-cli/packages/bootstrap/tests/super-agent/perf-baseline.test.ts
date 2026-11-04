/**
 * super-agent 控制面性能基线（计时基准，非功能测试）：
 * 1. 裁决攒批：N=8 候选 runBatch 全链路（prompt 构建 → verdict 校验 → mandate →
 *    事务交付落行）延迟；
 * 2. DB 写吞吐：真实 temp-file SQLite 上 1000 条 trigger_events + 1000 条
 *    decision_log 落行耗时（走 intake / decision-log 生产写入点，零 mock）；
 * 3. EventRouter.routeOwned owned 直通：订阅线程零 LLM 路由延迟（断言 < 1ms）。
 *
 * LLM 会话为脚本化应答——本文件测的是控制面自身开销，不是模型时延；
 * DB 层全部真实（openSuperAgentDatabase + temp file），每项测量重复 10 次报
 * mean / P50 / P95（最近秩百分位）与原始样本。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createDecisionLog } from "../../src/super-agent/decision-log/index.js";
import { createTriggerEventsRepo } from "../../src/super-agent/intake/trigger-events.js";
import { createMandateContract } from "../../src/super-agent/mandate/index.js";
import { applyVerdicts } from "../../src/super-agent/trigger/verdict-interpret.js";
import { createTriggerSubscriptions } from "../../src/super-agent/trigger/subscriptions.js";
import { routeOwned } from "../../src/super-agent/trigger/event-router.js";
import {
  createAdjudicationDriver,
  type AdjudicationModelSessionPort,
  type SuperAgentAdjudicationContract,
} from "../../src/super-agent/adjudication/index.js";

/** 每项测量的重复次数（P50/P95 样本量）。 */
const MEASUREMENT_RUNS = 10;
/** 裁决攒批候选数 N（spec 唤醒阈值 = 8）。 */
const ADJUDICATION_CANDIDATE_COUNT = 8;
/** 单次吞吐测量的每表落行数。 */
const DB_INSERTS_PER_RUN = 1000;
/** routeOwned 断言上限：owned 直通零 LLM，须在 1ms 内（spec 期望）。 */
const ROUTE_OWNED_P95_BUDGET_MS = 1;

const WORKSPACE = "ws-perf";
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const ROUTE_THREAD_KEY = `${WORKSPACE}|bot:bot-1+u1`;

let db: DatabaseSync | undefined;
let tempDir: string | undefined;
const drivers: SuperAgentAdjudicationContract[] = [];

afterEach(() => {
  for (const driver of drivers) driver.stop();
  drivers.length = 0;
  db?.close();
  db = undefined;
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function openTempDatabase(): Promise<DatabaseSync> {
  tempDir = mkdtempSync(join(tmpdir(), "super-agent-perf-"));
  db = await openSuperAgentDatabase({ databasePath: join(tempDir, "super-agent.sqlite") });
  return db;
}

interface TimingStats {
  mean: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  samples: number[];
}

/** 最近秩百分位（nearest-rank）：排序后取 ceil(p·n) 位样本，n=10 时 P50=第5、P95=第10。 */
function percentile(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

function timingStats(samples: number[]): TimingStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    mean: sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    samples,
  };
}

/** 原始数字直出（计时基准的产出物，断言之外必须可见）。 */
function report(label: string, stats: TimingStats): void {
  const fmt = (value: number) => value.toFixed(3);
  console.log(
    `[perf-baseline] ${label} n=${stats.samples.length} ` +
      `mean=${fmt(stats.mean)}ms p50=${fmt(stats.p50)}ms p95=${fmt(stats.p95)}ms ` +
      `min=${fmt(stats.min)}ms max=${fmt(stats.max)}ms ` +
      `samples=[${stats.samples.map(fmt).join(", ")}]`,
  );
}

function seedCandidate(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `insert into trigger_events (
        id, workspace_identity, source, thread_key, actor_kind, actor_id, payload,
        payload_digest, taint, provider, provider_message_id, fast_path,
        adjudication_status, final_disposition, settled_at, created_at, updated_at
      ) values (?, ?, 'im', ?, 'human', 'u1', ?, 'digest', 1, 'feishu', ?,
        'unowned_candidate', 'pending', null, null, ?, ?)`,
    )
    .run(id, WORKSPACE, ROUTE_THREAD_KEY, '{"text":"perf"}', `pm-${id}`, NOW, NOW);
}

function verdictsJson(triggerIds: readonly string[]): string {
  return JSON.stringify({
    decisions: triggerIds.map((triggerId) => ({
      triggerId,
      disposition: "record-only",
    })),
  });
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare(`select count(*) as n from ${table}`).get() as { n: number };
  return Number(row.n);
}

describe("super-agent 控制面性能基线", () => {
  it(`裁决攒批延迟：N=${ADJUDICATION_CANDIDATE_COUNT} 候选 runBatch ×${MEASUREMENT_RUNS}（mock LLM 应答，DB 真实）`, async () => {
    const database = await openTempDatabase();
    const decisionLog = createDecisionLog(database);
    // 脚本化会话：按当前轮候选 id 返回齐覆盖 verdict（时序基准用，非功能替身）。
    let currentBatchIds: string[] = [];
    const session: AdjudicationModelSessionPort = {
      run: async () => ({ outputText: verdictsJson(currentBatchIds) }),
      destroySession: () => {},
    };
    const driver = createAdjudicationDriver({
      db: database,
      session,
      delivery: {
        applyVerdicts: (batchId, decisions) =>
          applyVerdicts({ db: database, decisionLog }, batchId, decisions),
      },
      mandate: createMandateContract(),
      onError: (error, context) => {
        throw error instanceof Error
          ? error
          : new Error(`adjudication onError: ${context}: ${String(error)}`);
      },
    });
    drivers.push(driver);

    const samples: number[] = [];
    for (let run = 0; run < MEASUREMENT_RUNS; run += 1) {
      const ids = Array.from(
        { length: ADJUDICATION_CANDIDATE_COUNT },
        (_, index) => `perf-adj-${run}-${index}`,
      );
      for (const id of ids) seedCandidate(database, id);
      currentBatchIds = ids;

      const startedAt = performance.now();
      const outcome = await driver.runBatch(WORKSPACE);
      samples.push(performance.now() - startedAt);

      // 行为门：每轮必须真跑批且 8 候选全结算（时序基准不豁免正确性）。
      expect(outcome.status).toBe("applied");
      expect(outcome.modelCalled).toBe(true);
      expect(outcome.candidateCount).toBe(ADJUDICATION_CANDIDATE_COUNT);
      expect(
        countRows(
          database,
          "trigger_events where adjudication_status = 'pending' and workspace_identity = 'ws-perf'",
        ),
      ).toBe(0);
    }

    const stats = timingStats(samples);
    report(`adjudication.runBatch N=${ADJUDICATION_CANDIDATE_COUNT}`, stats);
    // 宽松红线：仅拦病理级回归（如意外引入模型等待），不设抖动敏感阈值。
    expect(stats.p95).toBeLessThan(1000);
  });

  it(`DB 写吞吐：${DB_INSERTS_PER_RUN} trigger_events + ${DB_INSERTS_PER_RUN} decision_log 落行 ×${MEASUREMENT_RUNS}（temp file 真库）`, async () => {
    const database = await openTempDatabase();
    const events = createTriggerEventsRepo(database);
    const decisionLog = createDecisionLog(database);

    const samples: number[] = [];
    for (let run = 0; run < MEASUREMENT_RUNS; run += 1) {
      const startedAt = performance.now();
      for (let index = 0; index < DB_INSERTS_PER_RUN; index += 1) {
        // 走 intake 生产写入点（含 payload 摘要 + 每行 prepare），非裸 SQL 捷径。
        events.insert({
          workspaceIdentity: WORKSPACE,
          source: "im",
          threadKey: ROUTE_THREAD_KEY,
          actorKind: "human",
          actorId: "u1",
          payload: JSON.stringify({ text: `perf ${run} ${index}` }),
          provider: "feishu",
          providerMessageId: `perf-db-${run}-${index}`,
          now: NOW,
        });
      }
      for (let index = 0; index < DB_INSERTS_PER_RUN; index += 1) {
        decisionLog.record({
          workspaceIdentity: WORKSPACE,
          origin: "adjudication",
          disposition: "record_only",
          batchId: `perf-db-${run}`,
          modelTier: "adjudicator",
          reason: "perf baseline",
          createdAt: NOW,
        });
      }
      samples.push(performance.now() - startedAt);
    }

    // 行为门：两表行数精确等于累计落行量（零丢行、零重复）。
    expect(
      countRows(database, `trigger_events where workspace_identity = '${WORKSPACE}'`),
    ).toBe(DB_INSERTS_PER_RUN * MEASUREMENT_RUNS);
    expect(countRows(database, `decision_log where workspace_identity = '${WORKSPACE}'`)).toBe(
      DB_INSERTS_PER_RUN * MEASUREMENT_RUNS,
    );

    const stats = timingStats(samples);
    report(
      `db.inserts ${DB_INSERTS_PER_RUN} trigger_events + ${DB_INSERTS_PER_RUN} decision_log`,
      stats,
    );
    // 宽松红线：1000+1000 落行单轮若超 5s 说明吞吐出现病理回归。
    expect(stats.p95).toBeLessThan(5000);
  });

  it(`EventRouter.routeOwned owned 直通延迟：订阅线程 ×${MEASUREMENT_RUNS}（零 LLM，P95 < ${ROUTE_OWNED_P95_BUDGET_MS}ms）`, async () => {
    const database = await openTempDatabase();
    const subscriptions = createTriggerSubscriptions(database);
    database
      .prepare(
        `insert into trigger_events (
          id, workspace_identity, source, thread_key, actor_kind, actor_id, payload,
          payload_digest, taint, provider, provider_message_id, fast_path,
          adjudication_status, final_disposition, settled_at, created_at, updated_at
        ) values ('perf-route-1', ?, 'im', ?, 'human', 'u1', ?, 'digest', 1, 'feishu',
          'pm-perf-route-1', 'owned', null, null, null, ?, ?)`,
      )
      .run(
        WORKSPACE,
        ROUTE_THREAD_KEY,
        JSON.stringify({ text: "PR #42 需要你跟进" }),
        NOW,
        NOW,
      );
    subscriptions.upsert({
      workspaceIdentity: WORKSPACE,
      threadKey: ROUTE_THREAD_KEY,
      sessionId: "session-perf",
      lane: "followup",
      ownerKind: "session",
      now: NOW,
    });

    const deps = {
      db: database,
      subscriptions,
      // 投递为进程内回执（owned 直通零 LLM；真实 host RPC 的网络成本不在本项范围）。
      delivery: { deliver: async () => ({ status: "admitted" as const }) },
      now: () => NOW,
    };

    const samples: number[] = [];
    for (let run = 0; run < MEASUREMENT_RUNS; run += 1) {
      const startedAt = performance.now();
      const outcome = await routeOwned(deps, "perf-route-1");
      samples.push(performance.now() - startedAt);
      expect(outcome.kind).toBe("routed");
    }

    const stats = timingStats(samples);
    report("trigger.routeOwned owned", stats);
    expect(stats.p95).toBeLessThan(ROUTE_OWNED_P95_BUDGET_MS);
  });
});
