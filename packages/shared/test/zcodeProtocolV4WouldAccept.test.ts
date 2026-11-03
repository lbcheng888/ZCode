// would-accept 收件箱投影黄金测试（spec §5.5 / design §6）：
// additive-optional 偏斜纪律——旧客户端解析新快照存活，缺席键是 unknown 而不是空列表。
import { describe, expect, it } from "vitest";
import {
  applyConversationDeltas,
  conversationSnapshotSchema,
  conversationDeltaSchema,
  type ConversationDelta,
  type ConversationSnapshot,
} from "../src/zcode-protocol-v4/index.js";

const CARD = {
  cardId: "card-1",
  source: "im",
  summary: "用户在群里问发布状态",
  suggestedTier: "auto",
  createdAt: 1_796_000_000_000,
} as const;

/** 归一化形态的完整快照夹具（与 zcodeProtocolV4Coalesce 同口径）。 */
function makeSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "s-1",
    logEpoch: "epoch-1",
    seq: 0,
    revision: 0,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1000 }],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "guard.manualCompact" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "guard.sendQueuedNowStopsBeforeDrain" },
      pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
      resumeGoal: { allowed: false, reasonCode: "guard.stopPausesActiveGoalTarget" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title: "", titleSource: "default" },
    config: {
      provider: "glm",
      model: "glm-5",
      thought: "medium",
      thoughtLevels: ["medium", "high", "max"],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: { usedTokens: 100, maxTokens: 200000, autoCompactThresholdTokens: null },
      cumulative: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

function stateUpdated(patch: Record<string, unknown>): ConversationDelta {
  return conversationDeltaSchema.parse({ op: "state.updated", patch });
}

describe("pendingWouldAccept 快照投影", () => {
  it("旧快照（无该键）解析存活且保持 undefined——缺席是 unknown，不是空列表", () => {
    const parsed = conversationSnapshotSchema.parse(makeSnapshot());
    expect(parsed.pendingWouldAccept).toBeUndefined();
  });

  it("新快照携带卡片列表解析通过，字段原样", () => {
    const parsed = conversationSnapshotSchema.parse({
      ...makeSnapshot(),
      pendingWouldAccept: [CARD],
    });
    expect(parsed.pendingWouldAccept).toEqual([CARD]);
  });

  it("显式空数组解析为已发布且零卡片的空态", () => {
    const parsed = conversationSnapshotSchema.parse({ ...makeSnapshot(), pendingWouldAccept: [] });
    expect(parsed.pendingWouldAccept).toEqual([]);
  });

  it("卡片内部的未知键被剥掉而不是拒收整份快照（老客户端前向兼容）", () => {
    const parsed = conversationSnapshotSchema.parse({
      ...makeSnapshot(),
      pendingWouldAccept: [{ ...CARD, futureField: "x" }],
    });
    expect(parsed.pendingWouldAccept).toEqual([CARD]);
  });

  it("来源枚举接受类型预留的 git/file，拒绝词表外的值", () => {
    for (const source of ["git", "file", "webhook", "schedule", "ci"]) {
      expect(
        conversationSnapshotSchema.safeParse({
          ...makeSnapshot(),
          pendingWouldAccept: [{ ...CARD, source }],
        }).success,
      ).toBe(true);
    }
    expect(
      conversationSnapshotSchema.safeParse({
        ...makeSnapshot(),
        pendingWouldAccept: [{ ...CARD, source: "email" }],
      }).success,
    ).toBe(false);
  });

  it("建议档位与 mandate.tier 同词汇，词表外拒绝", () => {
    for (const suggestedTier of ["record_only", "speculative", "auto"]) {
      expect(
        conversationSnapshotSchema.safeParse({
          ...makeSnapshot(),
          pendingWouldAccept: [{ ...CARD, suggestedTier }],
        }).success,
      ).toBe(true);
    }
    expect(
      conversationSnapshotSchema.safeParse({
        ...makeSnapshot(),
        pendingWouldAccept: [{ ...CARD, suggestedTier: "unsafe" }],
      }).success,
    ).toBe(false);
  });
});

describe("spec §5.4 P2 additive 槽位（mandateState / backgroundRuns / watchdogAlerts）", () => {
  it("旧快照缺席三键时解析存活且不物化键——缺席是 unknown，不是空值", () => {
    const parsed = conversationSnapshotSchema.parse(makeSnapshot());
    expect(parsed).not.toHaveProperty("mandateState");
    expect(parsed).not.toHaveProperty("backgroundRuns");
    expect(parsed).not.toHaveProperty("watchdogAlerts");
  });

  it("P2 不填值但键名已冻结：携带占位值解析通过、原样透传", () => {
    const parsed = conversationSnapshotSchema.parse({
      ...makeSnapshot(),
      mandateState: { tier: "record_only" },
      backgroundRuns: [],
      watchdogAlerts: [{ alertId: "w-1" }],
    });
    expect(parsed.mandateState).toEqual({ tier: "record_only" });
    expect(parsed.backgroundRuns).toEqual([]);
    expect(parsed.watchdogAlerts).toEqual([{ alertId: "w-1" }]);
  });

  it("statePatch 键集合同步冻结：新 patch 接受三键，旧 patch 缺席照常", () => {
    const withSlots = stateUpdated({
      mandateState: null,
      backgroundRuns: [],
      watchdogAlerts: [],
    }).patch;
    expect(withSlots).toHaveProperty("backgroundRuns");
    // 与 pendingWouldAccept 同纪律：StatePatch 是封闭键集，只冻快照不冻增量等于没冻。
    const legacy = stateUpdated({ queue: { items: [], autoDrain: true } }).patch;
    expect(legacy).not.toHaveProperty("mandateState");
    expect(legacy).not.toHaveProperty("watchdogAlerts");
  });
});

describe("pendingWouldAccept state.updated 增量", () => {
  it("patch 携带该键时整键替换", () => {
    const base = conversationSnapshotSchema.parse({
      ...makeSnapshot(),
      pendingWouldAccept: [CARD],
    });
    const next = applyConversationDeltas(base, [
      stateUpdated({ pendingWouldAccept: [{ ...CARD, cardId: "card-2" }] }),
    ]);
    expect(next.pendingWouldAccept).toEqual([{ ...CARD, cardId: "card-2" }]);
  });

  it("patch 缺席该键时保持原值（键级整体替换，缺席不碰）", () => {
    const base = conversationSnapshotSchema.parse({
      ...makeSnapshot(),
      pendingWouldAccept: [CARD],
    });
    const next = applyConversationDeltas(base, [stateUpdated({ meta: { title: "t", titleSource: "custom" } })]);
    expect(next.pendingWouldAccept).toEqual([CARD]);
  });

  it("statePatch schema 接受该键、也接受不带该键的旧 patch", () => {
    expect(stateUpdated({ pendingWouldAccept: [] }).patch).toHaveProperty("pendingWouldAccept");
    expect(stateUpdated({ queue: { items: [], autoDrain: true } }).patch).not.toHaveProperty(
      "pendingWouldAccept",
    );
  });
});
