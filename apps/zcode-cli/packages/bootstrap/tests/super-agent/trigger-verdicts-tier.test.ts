import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { applyVerdicts } from "../../src/super-agent/trigger/verdict-interpret.js";
import type {
  TriggerDecisionLogEntryInput,
  TriggerMandatePort,
  TriggerSchemeCard,
  TriggerSpecRunInput,
} from "../../src/super-agent/trigger/contract.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

const VALID_SCHEME: TriggerSchemeCard = {
  currentEvidence: "runner.ts:2178 双闸只过滤精确名",
  candidateOptions: [
    { option: "出口校验", cost: "需要内容生产配合" },
    { option: "只做内容生产", cost: "缺字段仍会外发" },
  ],
  recommendation: "成对落地（生产 + 出口门）",
  impact: "decision_log 加列，旧行 NULL 兼容",
  verification: "vitest run tests/super-agent",
};

function seedTriggerEvent(
  database: DatabaseSync,
  id: string,
  threadKey = "ws-a|bot:bot-1+u1:t1",
): void {
  database
    .prepare(
      `insert into trigger_events (
        id, workspace_identity, source, thread_key, actor_kind, actor_id, payload,
        payload_digest, taint, provider, provider_message_id, fast_path,
        adjudication_status, final_disposition, settled_at, created_at, updated_at
      ) values (?, 'ws-a', 'im', ?, 'human', 'u1', '{"text":"hi"}',
        'digest', 1, 'feishu', ?, 'unowned_candidate', 'pending', null, null, ?, ?)`,
    )
    .run(id, threadKey, `pm-${id}`, NOW, NOW);
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

function mandateReturning(
  tier: "record_only" | "speculative" | "auto",
  calls: string[] = [],
): TriggerMandatePort {
  return {
    resolveFor(triggerClass, options) {
      calls.push(`${triggerClass}@${options?.workspaceIdentity ?? ""}`);
      return { tier, source: tier === "record_only" ? "implicit" : "explicit", mandateId: "m-1" };
    },
  };
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("applyVerdicts M4 档位分派 + M6 方案门", () => {
  it("未注入 mandate（flag 关）：accept 仍全收敛 would_accept，零执行", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-1");
    const sink: TriggerDecisionLogEntryInput[] = [];
    const dispatched: TriggerSpecRunInput[] = [];

    applyVerdicts(
      {
        db,
        decisionLog: makeDecisionLog(sink),
        now: () => NOW,
        specRun: { start: async (input) => void dispatched.push(input) },
      },
      "batch-1",
      [{ triggerId: "t-1", disposition: "accept", reason: "值得处理" }],
    );
    await flushAsync();

    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ disposition: "would_accept", origin: "adjudication" });
    expect(dispatched).toHaveLength(0);
    const status = db
      .prepare("select adjudication_status from trigger_events where id = 't-1'")
      .get() as { adjudication_status: string };
    expect(status.adjudication_status).toBe("record_only");
  });

  it("mandate=record_only：accept → would_accept 卡片（携带方案卡内容）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-1");
    const sink: TriggerDecisionLogEntryInput[] = [];
    const calls: string[] = [];

    applyVerdicts(
      {
        db,
        decisionLog: makeDecisionLog(sink),
        now: () => NOW,
        mandate: mandateReturning("record_only", calls),
      },
      "batch-1",
      [{ triggerId: "t-1", disposition: "accept", scheme: VALID_SCHEME }],
    );

    expect(calls).toEqual(["bot:bot-1@ws-a"]);
    expect(sink[0]).toMatchObject({
      disposition: "would_accept",
      card: VALID_SCHEME,
    });
  });

  it("mandate=speculative：commit 后异步 specRun 启动，事务内落 accepted", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-1");
    const sink: TriggerDecisionLogEntryInput[] = [];
    const dispatched: TriggerSpecRunInput[] = [];

    applyVerdicts(
      {
        db,
        decisionLog: makeDecisionLog(sink),
        now: () => NOW,
        mandate: mandateReturning("speculative"),
        proposalGate: true,
        specRun: {
          start: async (input) => {
            dispatched.push(input);
          },
        },
      },
      "batch-1",
      [
        {
          triggerId: "t-1",
          disposition: "accept",
          reason: "CI 失败可复现",
          evidence: ["log:1"],
          scheme: VALID_SCHEME,
        },
      ],
    );

    // 两阶段：applyVerdicts 同步返回时 dispatch 尚未执行（commit 后才启动）。
    expect(dispatched).toHaveLength(0);
    await flushAsync();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      triggerId: "t-1",
      workspaceIdentity: "ws-a",
      threadKey: "ws-a|bot:bot-1+u1:t1",
      source: "im",
      tier: "speculative",
      reason: "CI 失败可复现",
      evidence: ["log:1"],
      card: VALID_SCHEME,
    });

    const status = db
      .prepare("select adjudication_status from trigger_events where id = 't-1'")
      .get() as { adjudication_status: string };
    expect(status.adjudication_status).toBe("accepted");
    expect(sink[0]).toMatchObject({ disposition: "accept" });
  });

  it("mandate=auto 同理分派", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-1");
    const dispatched: TriggerSpecRunInput[] = [];
    applyVerdicts(
      {
        db,
        decisionLog: makeDecisionLog([]),
        now: () => NOW,
        mandate: mandateReturning("auto"),
        proposalGate: true,
        specRun: { start: async (input) => void dispatched.push(input) },
      },
      "batch-1",
      [{ triggerId: "t-1", disposition: "accept", scheme: VALID_SCHEME }],
    );
    await flushAsync();
    expect(dispatched[0]?.tier).toBe("auto");
  });

  it("档位要求执行但未注入 specRun → 事务前抛错、零写入", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-1");
    const sink: TriggerDecisionLogEntryInput[] = [];

    await expect(
      applyVerdicts(
        {
          db,
          decisionLog: makeDecisionLog(sink),
          now: () => NOW,
          mandate: mandateReturning("auto"),
          proposalGate: true,
        },
        "batch-1",
        [{ triggerId: "t-1", disposition: "accept", scheme: VALID_SCHEME }],
      ),
    ).rejects.toThrow(/未注入 specRun 端口/);

    expect(sink).toHaveLength(0);
    const status = db
      .prepare("select adjudication_status from trigger_events where id = 't-1'")
      .get() as { adjudication_status: string };
    expect(status.adjudication_status).toBe("pending");
  });

  it("M6：proposalGate 开且 accept 缺 scheme → 降级 record_only + 计数行，不外发", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-1");
    const sink: TriggerDecisionLogEntryInput[] = [];

    applyVerdicts(
      {
        db,
        decisionLog: makeDecisionLog(sink),
        now: () => NOW,
        mandate: mandateReturning("auto"),
        proposalGate: true,
        specRun: { start: async () => undefined },
      },
      "batch-1",
      [{ triggerId: "t-1", disposition: "accept", reason: "一句话摘要" }],
    );

    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({
      disposition: "record_only",
      reason: "scheme_card_incomplete:missing",
    });
    const status = db
      .prepare("select adjudication_status from trigger_events where id = 't-1'")
      .get() as { adjudication_status: string };
    expect(status.adjudication_status).toBe("record_only");
  });

  it("M6：候选方案不足 2 条 → 拦下并给出字段计数", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-1");
    const sink: TriggerDecisionLogEntryInput[] = [];
    const incomplete = {
      ...VALID_SCHEME,
      candidateOptions: [{ option: "唯一方案", cost: "无对比" }],
    };

    applyVerdicts(
      {
        db,
        decisionLog: makeDecisionLog(sink),
        now: () => NOW,
        proposalGate: true,
        mandate: mandateReturning("record_only"),
      },
      "batch-1",
      [{ triggerId: "t-1", disposition: "accept", scheme: incomplete }],
    );

    expect(sink[0]).toMatchObject({ disposition: "record_only" });
    expect(String(sink[0]!.reason)).toContain("scheme_card_incomplete:candidateOptions");
  });

  it("specRun 异步失败经 onError 告警（不吞）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-1");
    const errors: string[] = [];
    applyVerdicts(
      {
        db,
        decisionLog: makeDecisionLog([]),
        now: () => NOW,
        mandate: mandateReturning("auto"),
        proposalGate: true,
        specRun: {
          start: async () => {
            throw new Error("subagent 启动失败");
          },
        },
        onError: (error, context) => {
          errors.push(`${context}:${error instanceof Error ? error.message : String(error)}`);
        },
      },
      "batch-1",
      [{ triggerId: "t-1", disposition: "accept", scheme: VALID_SCHEME }],
    );
    await flushAsync();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("subagent 启动失败");
  });

  it("真实 red ChengGate：不启动 spec run，decision_log 留 record_only 计数，状态收敛", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-gate-red");
    db.prepare("update trigger_events set payload = ? where id = ?").run(
      JSON.stringify({ text: "hi", chengJobId: "job-red" }),
      "t-gate-red",
    );
    const sink: TriggerDecisionLogEntryInput[] = [];
    const starts: TriggerSpecRunInput[] = [];
    await applyVerdicts(
      {
        db,
        decisionLog: makeDecisionLog(sink),
        now: () => NOW,
        mandate: mandateReturning("speculative"),
        proposalGate: true,
        specRun: {
          start: async (input) => {
            starts.push(input);
          },
        },
        resolveSpecRunGate: async (jobId) => {
          expect(jobId).toBe("job-red");
          // 真实 evaluateChengGate 的红结果形状；由 host verify 产出。
          return { ok: false, level: "BLOCKED", reasons: ["settle_not_solved"] };
        },
      },
      "batch-gate-red",
      [{ triggerId: "t-gate-red", disposition: "accept", scheme: VALID_SCHEME }],
    );
    await flushAsync();

    expect(starts).toEqual([]);
    // 出站门在事务前/落库前生效：连 accept 卡行都不写，只留 record_only 审计。
    expect(sink.map((entry) => entry.disposition)).toEqual(["record_only"]);
    expect(sink[0]?.reason).toBe("cheng_gate_blocked:settle_not_solved");
    const status = db
      .prepare("select adjudication_status from trigger_events where id = 't-gate-red'")
      .get() as { adjudication_status: string };
    expect(status.adjudication_status).toBe("record_only");
  });

  it("真实 green ChengGate 随 specRun 输入传递", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedTriggerEvent(db, "t-gate-green");
    db.prepare("update trigger_events set payload = ? where id = ?").run(
      JSON.stringify({ text: "hi", chengJobId: "job-green" }),
      "t-gate-green",
    );
    const starts: TriggerSpecRunInput[] = [];
    await applyVerdicts(
      {
        db,
        decisionLog: makeDecisionLog([]),
        now: () => NOW,
        mandate: mandateReturning("speculative"),
        proposalGate: true,
        specRun: {
          start: async (input) => {
            starts.push(input);
          },
        },
        resolveSpecRunGate: async () => ({
          ok: true,
          level: "DIAGNOSTIC_NOT_ACCEPTANCE",
          reasons: [],
        }),
      },
      "batch-gate-green",
      [{ triggerId: "t-gate-green", disposition: "accept", scheme: VALID_SCHEME }],
    );
    await flushAsync();

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      chengJobId: "job-green",
      chengGate: { ok: true, level: "DIAGNOSTIC_NOT_ACCEPTANCE" },
    });
  });
});
