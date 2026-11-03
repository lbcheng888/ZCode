// M6 五字段方案卡出口门：would-accept 卡缺 scheme 时不外发（flag 开），并保留
// decision_log 审计行；flag 关保持 P2 字节兼容（旧卡照常呈现）。
import { afterEach, describe, expect, it } from "vitest";

import {
  createSuperAgentControlPlane,
  type SuperAgentControlPlane,
} from "../../src/app/super-agent-control-plane.js";

const WS = "ws-m6";
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

const planes: SuperAgentControlPlane[] = [];

afterEach(() => {
  for (const plane of planes.splice(0)) {
    try {
      plane.stop();
    } catch {
      // 已关不掩盖用例失败。
    }
  }
});

const VALID_SCHEME = {
  currentEvidence: "runner.ts:2178 只滤精确名",
  candidateOptions: [
    { option: "双闸过滤", cost: "需同步维护两张表" },
    { option: "只滤 mcp 前缀", cost: "漏 WebFetch 别名" },
  ],
  recommendation: "双闸（表 + 前缀）",
  impact: "core/subagent/runner.ts",
  verification: "vitest run spec-restricted-profile",
};

async function makePlane(mandateGate: boolean) {
  const errors: Array<{ error: unknown; context: string }> = [];
  const plane = await createSuperAgentControlPlane({
    workspaceIdentity: WS,
    ownerId: "owner-m6",
    onError: (error, context) => errors.push({ error, context }),
    sessionFace: { sessionId: "session-m6", isIdle: () => false },
    hostPorts: {
      handleCommand: async () => {
        throw new Error("M6 单测不触达 CommandInbox");
      },
      autoReplyGuard: { admit: async () => true },
      superAgentDatabasePath: ":memory:",
    },
    adjudicationSession: {
      run: async () => {
        throw new Error("M6 单测不触达裁决模型会话");
      },
      destroySession: () => undefined,
    },
    mandateGate,
    now: () => NOW,
  });
  planes.push(plane);
  return { plane, errors };
}

function seedCardRow(
  plane: SuperAgentControlPlane,
  id: string,
  cardPayload: string | null,
): void {
  const db = plane.database;
  db.prepare(
    `insert into trigger_events (
      id, workspace_identity, source, thread_key, actor_kind, actor_id, payload,
      payload_digest, taint, provider, provider_message_id, fast_path,
      adjudication_status, final_disposition, settled_at, created_at, updated_at
    ) values (?, ?, 'im', ?, 'human', 'u1', '{"text":"hi"}', 'digest', 1, 'feishu', ?, 'unowned_candidate',
      'record_only', null, null, ?, ?)`,
  ).run(id, WS, `${WS}|bot:b1+u1`, `pm-${id}`, NOW, NOW);
  db.prepare(
    `insert into decision_log (
      id, workspace_identity, trigger_id, origin, disposition, batch_id, model_tier,
      reason, evidence, card_payload, created_at
    ) values (?, ?, ?, 'adjudication', 'would_accept', 'batch-m6', 'adjudicator', '值得处理', null, ?, ?)`,
  ).run(`card-${id}`, WS, id, cardPayload, NOW);
}

describe("M6 would-accept 方案卡出口门", () => {
  it("flag 开：缺 card_payload 的卡不外发（告警计数），合法五字段卡携带 scheme", async () => {
    const { plane, errors } = await makePlane(true);
    seedCardRow(plane, "t-old", null);
    seedCardRow(plane, "t-new", JSON.stringify(VALID_SCHEME));

    const cards = plane.listPendingWouldAccept();

    expect(cards).toHaveLength(1);
    expect(cards[0]!.cardId).toBe("card-t-new");
    expect(cards[0]!.scheme).toEqual(VALID_SCHEME);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.context).toBe("super_agent.would_accept.scheme_gate");
  });

  it("flag 开：card_payload 结构不完整同样拦下", async () => {
    const { plane, errors } = await makePlane(true);
    seedCardRow(
      plane,
      "t-bad",
      JSON.stringify({ ...VALID_SCHEME, candidateOptions: [{ option: "唯一", cost: "无对比" }] }),
    );

    expect(plane.listPendingWouldAccept()).toHaveLength(0);
    expect(errors[0]!.context).toBe("super_agent.would_accept.scheme_gate");
  });

  it("裁决产出五字段 scheme → applyVerdicts 落 card_payload → 收件箱携带方案呈现", async () => {
    const errors: Array<{ error: unknown; context: string }> = [];
    const verdictIds: string[] = [];
    const plane = await createSuperAgentControlPlane({
      workspaceIdentity: WS,
      ownerId: "owner-m6-e2e",
      onError: (error, context) => errors.push({ error, context }),
      sessionFace: { sessionId: "session-m6-e2e", isIdle: () => true },
      hostPorts: {
        handleCommand: async () => {
          throw new Error("本用例不触达 CommandInbox");
        },
        autoReplyGuard: { admit: async () => true },
        superAgentDatabasePath: ":memory:",
      },
      adjudicationSession: {
        run: async () => ({
          outputText: JSON.stringify({
            decisions: verdictIds.map((id) => ({
              triggerId: id,
              disposition: "accept",
              reason: "可处理",
              evidence: ["payload 摘要"],
              scheme: VALID_SCHEME,
            })),
          }),
        }),
        destroySession: () => undefined,
      },
      mandateGate: true,
      now: () => NOW,
    });
    planes.push(plane);
    await plane.start();

    const result = await plane.triggerSink.ingest({
      workspaceIdentity: WS,
      source: "im",
      provider: "feishu",
      providerMessageId: "pm-m6-1",
      threadKeyHint: "bot:b1+u1",
      actor: { kind: "bot", id: "b1" },
      payload: { text: "nightly failed", chatType: "private", botId: "b1" },
      taint: true,
    });
    if (!result.handled) throw new Error("候选未入链");
    verdictIds.push(result.triggerId);

    const outcome = await plane.contracts.adjudication.runBatch(WS);
    expect(outcome.status).toBe("applied");
    expect(errors).toEqual([]);

    const cards = plane.listPendingWouldAccept();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.scheme).toEqual(VALID_SCHEME);
  });

  it("flag 关：旧行照常呈现（P2 字节兼容），无出口告警", async () => {
    const { plane, errors } = await makePlane(false);
    seedCardRow(plane, "t-old", null);

    const cards = plane.listPendingWouldAccept();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.scheme).toBeUndefined();
    expect(errors).toEqual([]);
  });
});
