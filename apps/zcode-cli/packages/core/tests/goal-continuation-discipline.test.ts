// goal 长程续跑纪律（kimi 三件套最小移植）：goal 续跑回合起跑时经 queueTurnSystemReminder
// 注入 goal reminder（source=goal_continuation）。锁四条边界：纪律常量含三条锚点原文、
// full/sparse 两档按目标与预算带切换、goal 续跑回合的真实模型请求带提醒而用户回合不带、
// 关旗时不注入（旧续跑行为保持原样）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  type ModelRequest,
  type ModelResult,
  type SessionGoal,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import { getSystemReminderDescriptor } from "../src/system-reminder/source.js";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  buildGoalContinuationReminder,
  GOAL_CONTINUATION_DISCIPLINE_TEXT,
  goalBudgetBand,
} from "../src/runtime/helpers/goal-layer.js";
import {
  drainQueuedTurnSystemReminders,
  queueTurnSystemReminder,
} from "../src/runtime/methods/turn-system-reminder/index.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const FULL_TIER_MARKER = "goal 长程纪律提醒（full 档）";
const SPARSE_TIER_MARKER = "goal 长程纪律提醒（sparse 档）";

/** 把一次模型请求的全部消息内容摊平成文本，便于做提醒存在/缺席断言。 */
function requestText(request: ModelRequest): string {
  return request.messages
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    )
    .join("\n");
}

function fakeRuntime(): AgentRuntimeInternal {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AgentRuntimeInternal;
}

function emptyState(turnId: string, traceContext: TraceContext) {
  return {
    turnId: turnId as TurnId,
    turnTraceContext: traceContext,
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
  } as unknown as Parameters<typeof drainQueuedTurnSystemReminders>[1];
}

function traceForTurn(turnId: string): TraceContext {
  return createRootTraceContext({
    sessionId: "session-goal-discipline" as never,
    turnId: turnId as never,
  });
}

function disciplineGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    sessionID: "session-goal-discipline" as never,
    targetID: "goal-discipline-1",
    objective: "修复长程 goal 续跑纪律",
    summaryTitle: null,
    status: "active",
    revision: 1,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    turnBudget: 256,
    turnsUsed: 0,
    wallClockBudgetSeconds: null,
    time: { created: 1_000, updated: 1_000 },
    ...overrides,
  } as SessionGoal;
}

describe("goal continuation discipline constant", () => {
  it("纪律全文保留三条锚点：不要调 GoalUpdate / 连续 3 个 / 正常结束回合", () => {
    expect(GOAL_CONTINUATION_DISCIPLINE_TEXT).toContain("不要调 GoalUpdate");
    expect(GOAL_CONTINUATION_DISCIPLINE_TEXT).toContain("连续 3 个");
    expect(GOAL_CONTINUATION_DISCIPLINE_TEXT).toContain("正常结束回合");
    // zcode 契约改写：complete 由 runtime 完成校验判定，blocked 走 GoalBlock 工具。
    expect(GOAL_CONTINUATION_DISCIPLINE_TEXT).toContain("完成校验");
    expect(GOAL_CONTINUATION_DISCIPLINE_TEXT).toContain("GoalBlock");
    expect(GOAL_CONTINUATION_DISCIPLINE_TEXT).toContain("如实说明并结束回合");
  });
});

describe("goal continuation reminder tiers", () => {
  it("首次注入为 full 档：目标 + 预算带 + 纪律全文", () => {
    const runtime = fakeRuntime();
    const reminder = buildGoalContinuationReminder(runtime, disciplineGoal());
    expect(reminder.tier).toBe("full");
    expect(reminder.body).toContain(FULL_TIER_MARKER);
    expect(reminder.body).toContain("<untrusted_objective>");
    expect(reminder.body).toContain("修复长程 goal 续跑纪律");
    expect(reminder.body).toContain("预算带：within");
    expect(reminder.body).toContain("不要调 GoalUpdate");
  });

  it("字段完全一致时降为 sparse 档：只保留目标一句话 + 预算带", () => {
    const runtime = fakeRuntime();
    buildGoalContinuationReminder(runtime, disciplineGoal());
    const sparse = buildGoalContinuationReminder(runtime, disciplineGoal());
    expect(sparse.tier).toBe("sparse");
    expect(sparse.body).toContain(SPARSE_TIER_MARKER);
    expect(sparse.body).toContain("修复长程 goal 续跑纪律");
    expect(sparse.body).toContain("预算带：within");
    // 纪律全文不重复进入 sparse 档。
    expect(sparse.body).not.toContain("不要调 GoalUpdate");
  });

  it("预算带变化（within→nearing）回到 full 档", () => {
    const runtime = fakeRuntime();
    buildGoalContinuationReminder(runtime, disciplineGoal());
    buildGoalContinuationReminder(runtime, disciplineGoal());
    const nearing = buildGoalContinuationReminder(
      runtime,
      disciplineGoal({ turnsUsed: 200 }),
    );
    expect(nearing.band).toBe("nearing");
    expect(nearing.tier).toBe("full");
    expect(nearing.body).toContain("预算带：nearing");
    expect(nearing.body).toContain("不要调 GoalUpdate");
  });

  it("目标替换（targetID/revision/objective 任一变化）回到 full 档", () => {
    const runtime = fakeRuntime();
    buildGoalContinuationReminder(runtime, disciplineGoal());
    buildGoalContinuationReminder(runtime, disciplineGoal());
    const replaced = buildGoalContinuationReminder(
      runtime,
      disciplineGoal({ targetID: "goal-discipline-2", revision: 2 }),
    );
    expect(replaced.tier).toBe("full");
    const edited = buildGoalContinuationReminder(
      runtime,
      disciplineGoal({ revision: 3, objective: "换一个目标" }),
    );
    expect(edited.tier).toBe("full");
    expect(edited.body).toContain("换一个目标");
  });
});

describe("goal budget band", () => {
  it("无预算、未过 75% 为 within；达到 75% 即 nearing", () => {
    expect(goalBudgetBand(disciplineGoal({ turnBudget: null }))).toBe("within");
    expect(goalBudgetBand(disciplineGoal({ turnBudget: 256, turnsUsed: 10 }))).toBe("within");
    expect(goalBudgetBand(disciplineGoal({ turnBudget: 100, turnsUsed: 75 }))).toBe("nearing");
    expect(goalBudgetBand(disciplineGoal({ turnBudget: 100, turnsUsed: 80 }))).toBe("nearing");
  });
});

describe("goal_continuation reminder source", () => {
  it("source 已注册为 per-request 生命周期，入队不抛错且 drain 注入", () => {
    expect(getSystemReminderDescriptor("goal_continuation")).toMatchObject({
      channel: "current_turn",
      lifecycle: "per_current_turn",
      providerVisibility: "provider_visible",
    });
    const runtime = fakeRuntime();
    expect(() =>
      queueTurnSystemReminder.call(runtime, {
        turnId: "turn-goal-1" as TurnId,
        source: "goal_continuation",
        body: GOAL_CONTINUATION_DISCIPLINE_TEXT,
      }),
    ).not.toThrow();
    const state = emptyState("turn-goal-1", traceForTurn("turn-goal-1"));
    drainQueuedTurnSystemReminders(runtime, state);
    expect(state.turnRequestState.entries).toMatchObject([
      {
        kind: "attachment",
        content: GOAL_CONTINUATION_DISCIPLINE_TEXT,
        metadata: { source: "goal_continuation" },
      },
    ]);
  });
});

describe("goal continuation turn injection", () => {
  it(
    "goal 续跑回合起跑注入 full 档，同一目标的下一回合降为 sparse 档；用户回合不注入",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-goal-discipline-"));
      const sqliteStore = await createSqliteSessionStore({
        dbPath: join(root, "session.sqlite"),
      });
      const sessionID = createSessionId("goal-discipline-turns");
      const requests: ModelRequest[] = [];
      const runtime = createTestAgentRuntime(
        sessionID,
        {
          goalLayerEnabled: true,
          modelStreaming: "off",
          titleGeneration: { enabled: false },
          workspacePath: root,
        },
        {
          sessionStore: sqliteStore,
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            generateText: async (request): Promise<ModelResult> => {
              requests.push(request);
              return { text: "continued", finishReason: "stop", usage: {} };
            },
          }),
        },
      );
      const internal = runtime as unknown as AgentRuntimeInternal;

      try {
        await runtime.ensureSessionPersistedForExternalActivity("/goal 修复长程续跑纪律");
        await sqliteStore.setTarget({
          sessionID,
          objective: "修复长程 goal 续跑纪律",
        });

        // 第一条 goal 续跑回合：full 档纪律全文随首个模型请求进入上下文。
        await runtime.continueActiveTargetIfIdle({ inputId: "goal-discipline-round-1" });
        expect(requests.length).toBe(1);
        const firstTurnText = requestText(requests[0]!);
        expect(firstTurnText).toContain(FULL_TIER_MARKER);
        expect(firstTurnText).toContain("不要调 GoalUpdate");
        expect(firstTurnText).toContain("连续 3 个");
        expect(firstTurnText).toContain("正常结束回合");
        expect(firstTurnText).toContain("修复长程 goal 续跑纪律");

        // 字段与上次注入完全一致：第二条 goal 续跑回合只带 sparse 档；
        // reminder 不进持久历史，turn-local 注入不会让纪律全文在请求间累积。
        await runtime.continueActiveTargetIfIdle({ inputId: "goal-discipline-round-2" });
        expect(requests.length).toBe(2);
        const secondTurnText = requestText(requests[1]!);
        expect(secondTurnText).toContain(SPARSE_TIER_MARKER);
        expect(secondTurnText).toContain("预算带：within");
        expect(secondTurnText).not.toContain(FULL_TIER_MARKER);
        expect(secondTurnText).not.toContain("不要调 GoalUpdate");

        // 非 goal 回合（用户消息）不注入 goal reminder。
        const userPrompt = await runtime.admitPrompt("普通用户问题");
        await userPrompt.completion;
        expect(requests.length).toBe(3);
        const userTurnText = requestText(requests[2]!);
        expect(userTurnText).not.toContain(FULL_TIER_MARKER);
        expect(userTurnText).not.toContain(SPARSE_TIER_MARKER);

        expect((await sqliteStore.readTarget({ sessionID }))?.status).toBe("active");
      } finally {
        internal.goalRoundDriverArmed = false;
        await runtime.closeBrowserSession();
        sqliteStore.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "关旗（goalLayerEnabled 缺席）时续跑回合不注入 goal reminder",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-goal-discipline-off-"));
      const sqliteStore = await createSqliteSessionStore({
        dbPath: join(root, "session.sqlite"),
      });
      const sessionID = createSessionId("goal-discipline-flag-off");
      const requests: ModelRequest[] = [];
      const runtime = createTestAgentRuntime(
        sessionID,
        {
          modelStreaming: "off",
          titleGeneration: { enabled: false },
          workspacePath: root,
        },
        {
          sessionStore: sqliteStore,
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            generateText: async (request): Promise<ModelResult> => {
              requests.push(request);
              return { text: "continued", finishReason: "stop", usage: {} };
            },
          }),
        },
      );
      const internal = runtime as unknown as AgentRuntimeInternal;

      try {
        await runtime.ensureSessionPersistedForExternalActivity("/goal 修复长程续跑纪律");
        await sqliteStore.setTarget({
          sessionID,
          objective: "修复长程 goal 续跑纪律",
        });

        await runtime.continueActiveTargetIfIdle({ inputId: "goal-discipline-flag-off" });
        expect(requests.length).toBe(1);
        const turnText = requestText(requests[0]!);
        expect(turnText).not.toContain(FULL_TIER_MARKER);
        expect(turnText).not.toContain(SPARSE_TIER_MARKER);
        expect(turnText).not.toContain("不要调 GoalUpdate");
      } finally {
        internal.goalRoundDriverArmed = false;
        await runtime.closeBrowserSession();
        sqliteStore.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
