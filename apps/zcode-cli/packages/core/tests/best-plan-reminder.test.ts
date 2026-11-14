// queueTurnSystemReminder：回合级隐藏 system reminder 队列。
// 锁四条边界：入队后 drain 注入且投影成 <system-reminder>、一次性消费、
// turn 不匹配不注入且遗留条目被丢弃、非法 source / 空 body 在入队时响亮拒绝。
import { describe, expect, it, vi } from "vitest";
import { createRootTraceContext, type TraceContext, type TurnId } from "@zcode/contracts";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RegularTurnLoopState } from "../src/runtime/methods/turn-loop-state.js";
import {
  drainQueuedTurnSystemReminders,
  queueTurnSystemReminder,
} from "../src/runtime/methods/turn-system-reminder/index.js";

const SESSION_ID = "session-1";

function fakeRuntime(): AgentRuntimeInternal {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AgentRuntimeInternal;
}

function emptyState(turnId: string, traceContext: TraceContext): RegularTurnLoopState {
  return {
    turnId: turnId as TurnId,
    turnTraceContext: traceContext,
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
  } as unknown as RegularTurnLoopState;
}

function traceForTurn(turnId: string): TraceContext {
  return createRootTraceContext({
    sessionId: SESSION_ID as never,
    turnId: turnId as never,
  });
}

describe("queueTurnSystemReminder", () => {
  it("queue 后 drain 注入附件，投影成 <system-reminder> 进下一次模型请求", () => {
    const runtime = fakeRuntime();
    const state = emptyState("turn-1", traceForTurn("turn-1"));
    const body = "独立方案 super-agent 已提交本回合最佳方案。先用一段话向用户陈述推荐方案。";

    queueTurnSystemReminder.call(runtime, {
      turnId: "turn-1" as TurnId,
      source: "best_plan_super_agent",
      body,
    });
    drainQueuedTurnSystemReminders(runtime, state);

    const entries = state.turnRequestState.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "attachment",
      content: body,
      metadata: { source: "best_plan_super_agent" },
    });

    // 投影走真实请求路径同一函数（prepareRuntimeProviderRequest → buildProviderRequestMessages）。
    const { messages } = buildProviderRequestMessages({ entries });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain("<system-reminder>");
    expect(messages[0]!.content).toContain(body);
    expect((messages[0]!.content as string).match(/<system-reminder>/g)).toHaveLength(1);
  });

  it("仅消费一次：第二次 drain 不再追加", () => {
    const runtime = fakeRuntime();
    const state = emptyState("turn-1", traceForTurn("turn-1"));
    queueTurnSystemReminder.call(runtime, {
      turnId: "turn-1" as TurnId,
      source: "best_plan_super_agent",
      body: "方案正文",
    });

    drainQueuedTurnSystemReminders(runtime, state);
    expect(state.turnRequestState.entries).toHaveLength(1);

    drainQueuedTurnSystemReminders(runtime, state);
    expect(state.turnRequestState.entries).toHaveLength(1);
  });

  it("turn 不匹配不注入，遗留条目按丢弃语义清除", () => {
    const runtime = fakeRuntime();
    queueTurnSystemReminder.call(runtime, {
      turnId: "turn-a" as TurnId,
      source: "best_plan_super_agent",
      body: "上一回合遗留的方案",
    });

    // 下一回合 drain：turnId 不匹配，不注入。
    const nextTurn = emptyState("turn-b", traceForTurn("turn-b"));
    drainQueuedTurnSystemReminders(runtime, nextTurn);
    expect(nextTurn.turnRequestState.entries).toHaveLength(0);

    // 遗留条目已丢弃：再对原回合 drain 也不会注入。
    const originalTurn = emptyState("turn-a", traceForTurn("turn-a"));
    drainQueuedTurnSystemReminders(runtime, originalTurn);
    expect(originalTurn.turnRequestState.entries).toHaveLength(0);
  });

  it("多个排队条目按入队顺序一起注入同一请求", () => {
    const runtime = fakeRuntime();
    const state = emptyState("turn-1", traceForTurn("turn-1"));
    queueTurnSystemReminder.call(runtime, {
      turnId: "turn-1" as TurnId,
      source: "best_plan_super_agent",
      body: "第一条",
    });
    queueTurnSystemReminder.call(runtime, {
      turnId: "turn-1" as TurnId,
      source: "best_plan_super_agent",
      body: "第二条",
    });

    drainQueuedTurnSystemReminders(runtime, state);
    expect(state.turnRequestState.entries.map((entry) => entry.content)).toEqual([
      "第一条",
      "第二条",
    ]);
  });

  it("未知 source 与非 per-request 源在入队时响亮拒绝，不炸投影", () => {
    const runtime = fakeRuntime();
    expect(() =>
      queueTurnSystemReminder.call(runtime, {
        turnId: "turn-1" as TurnId,
        source: "not_a_registered_source",
        body: "正文",
      }),
    ).toThrow(/per-request system-reminder 源/);
    // todo_reminder 是持久生命周期源：本队列只做 turn-local 注入，不接受。
    expect(() =>
      queueTurnSystemReminder.call(runtime, {
        turnId: "turn-1" as TurnId,
        source: "todo_reminder",
        body: "正文",
      }),
    ).toThrow(/per-request system-reminder 源/);
  });

  it("空 body 在入队时拒绝", () => {
    const runtime = fakeRuntime();
    expect(() =>
      queueTurnSystemReminder.call(runtime, {
        turnId: "turn-1" as TurnId,
        source: "best_plan_super_agent",
        body: "   ",
      }),
    ).toThrow(/body 不能为空/);
  });

  it("drain 后发布注入计数 debug 事件", () => {
    const runtime = fakeRuntime();
    const state = emptyState("turn-1", traceForTurn("turn-1"));
    queueTurnSystemReminder.call(runtime, {
      turnId: "turn-1" as TurnId,
      source: "best_plan_super_agent",
      body: "正文",
    });

    drainQueuedTurnSystemReminders(runtime, state);

    const debugCalls = (runtime.logger!.debug as ReturnType<typeof vi.fn>).mock.calls;
    const drainLog = debugCalls.find(
      (call) => (call[1] as { event?: string } | undefined)?.event === "turn.system_reminder.drained",
    );
    expect(drainLog).toBeDefined();
    expect(drainLog![1]).toMatchObject({ injected: 1, discarded: 0 });
  });
});
