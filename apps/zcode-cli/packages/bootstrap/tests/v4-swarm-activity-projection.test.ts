import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  conversationDeltaSchema,
  statePatchSchema,
  type ConversationDelta,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

const SESSION_ID = "swarm-activity-session";

function swarmEvent(sequenceNumber: number, payload: unknown, sessionId = SESSION_ID): SessionEvent {
  return {
    id: `swarm-event-${sequenceNumber}`,
    sessionId,
    turnId: "turn-goal",
    type: SessionEventType.SwarmRoundJournal,
    traceId: "trace",
    timestamp: new Date(1_700_000_000_000 + sequenceNumber),
    sequenceNumber,
    payload,
  } as SessionEvent;
}

function harness(sessionId = SESSION_ID) {
  const projection = new ProductProjection(sessionId, "epoch");
  let seq = 0;
  const apply = (payload: unknown): ConversationDelta[] =>
    projection.applyEvent(swarmEvent(++seq, payload, sessionId));
  return { projection, apply };
}

/** 一条 state.updated 的 patch 在 wire 侧要经 statePatchSchema.parse；新增键被封闭键集剥掉即读端断链。 */
function assertWirePatchCarriesSwarm(deltas: readonly ConversationDelta[]): void {
  const swarmDeltas = deltas.filter(
    (delta) => delta.op === "state.updated" && delta.patch.swarmActivity !== undefined,
  );
  expect(swarmDeltas.length).toBeGreaterThan(0);
  for (const delta of swarmDeltas) {
    if (delta.op !== "state.updated" || delta.patch.swarmActivity === undefined) continue;
    expect(statePatchSchema.parse(delta.patch).swarmActivity).toEqual(delta.patch.swarmActivity);
    // 帧解码走 conversationDeltaSchema（discriminatedUnion）；整条 delta 必须能原样往返。
    expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
  }
}

function roundEvents(roundId: string): SessionEvent[] {
  return [
    swarmEvent(1, { phase: "round_started", roundId, objective: "整轮目标" }),
    swarmEvent(2, {
      phase: "decomposed",
      roundId,
      taskIds: ["swarm-task-1", "swarm-task-2"],
      taskDescriptions: ["任务1", "任务2"],
    }),
    swarmEvent(3, {
      phase: "task_result",
      roundId,
      result: { taskId: "swarm-task-1", status: "done", output: "产出1" },
    }),
    swarmEvent(4, {
      phase: "task_result",
      roundId,
      result: { taskId: "swarm-task-2", status: "failed", error: "child boom" },
    }),
    swarmEvent(5, {
      phase: "round_completed",
      roundId,
      completedTaskIds: ["swarm-task-1"],
      failedTaskIds: ["swarm-task-2"],
      output: "产出1",
    }),
  ];
}

describe("SwarmRoundJournal → swarmActivity 投影", () => {
  it("运行中发布读数与可停止控制位，task_result 去重，round_completed 收口控制", () => {
    const { projection, apply } = harness();

    const started = apply({ phase: "round_started", roundId: "round-1", objective: "整轮目标" });
    expect(projection.getSnapshot().swarmActivity).toEqual({
      roundId: "round-1",
      activeUnits: 0,
      completedUnits: 0,
      failedUnits: 0,
      totalUnits: 0,
    });
    expect(projection.getSnapshot().control).toMatchObject({
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
    });
    // 蜂群跑在既有 goal 续跑轮内：journal 只动控制位，不得伪造 turn phase。
    expect(projection.getSnapshot().control.phase).toBe("draft");
    assertWirePatchCarriesSwarm(started);
    // 同一条 journal 重放：读数与控制位都没变，不产 delta。
    expect(apply({ phase: "round_started", roundId: "round-1", objective: "整轮目标" })).toEqual(
      [],
    );

    const decomposed = apply({
      phase: "decomposed",
      roundId: "round-1",
      taskIds: ["swarm-task-1", "swarm-task-2"],
    });
    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      activeUnits: 2,
      completedUnits: 0,
      failedUnits: 0,
      totalUnits: 2,
    });
    assertWirePatchCarriesSwarm(decomposed);

    apply({
      phase: "task_result",
      roundId: "round-1",
      result: { taskId: "swarm-task-1", status: "done", output: "产出1" },
    });
    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      activeUnits: 1,
      completedUnits: 1,
      failedUnits: 0,
    });

    apply({
      phase: "task_result",
      roundId: "round-1",
      result: { taskId: "swarm-task-2", status: "failed", error: "child boom" },
    });
    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      activeUnits: 0,
      completedUnits: 1,
      failedUnits: 1,
    });
    // 同一 worker 的重复终态只计数一次。
    expect(
      apply({
        phase: "task_result",
        roundId: "round-1",
        result: { taskId: "swarm-task-2", status: "failed", error: "child boom" },
      }),
    ).toEqual([]);
    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      activeUnits: 0,
      completedUnits: 1,
      failedUnits: 1,
    });

    const completed = apply({
      phase: "round_completed",
      roundId: "round-1",
      completedTaskIds: ["swarm-task-1"],
      failedTaskIds: ["swarm-task-2"],
      output: "产出1",
    });
    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      activeUnits: 0,
      completedUnits: 1,
      failedUnits: 1,
      totalUnits: 2,
    });
    expect(projection.getSnapshot().swarmActivity?.interrupted).toBeUndefined();
    expect(projection.getSnapshot().control).toMatchObject({
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
    });
    assertWirePatchCarriesSwarm(completed);
    expect(
      apply({
        phase: "round_completed",
        roundId: "round-1",
        completedTaskIds: ["swarm-task-1"],
        failedTaskIds: ["swarm-task-2"],
        output: "产出1",
      }),
    ).toEqual([]);
  });

  it("round_completed 携带 error 时标记 interrupted，新轮从零读数清掉中断标记", () => {
    const { projection, apply } = harness();

    apply({ phase: "round_started", roundId: "round-failed", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-failed",
      taskIds: ["swarm-task-1", "swarm-task-2", "swarm-task-3"],
    });
    apply({
      phase: "task_result",
      roundId: "round-failed",
      result: { taskId: "swarm-task-1", status: "done", output: "产出1" },
    });
    apply({
      phase: "task_result",
      roundId: "round-failed",
      result: { taskId: "swarm-task-2", status: "cancelled" },
    });
    const failed = apply({
      phase: "round_completed",
      roundId: "round-failed",
      completedTaskIds: ["swarm-task-1"],
      failedTaskIds: ["swarm-task-2", "swarm-task-3"],
      error: "Swarm aggregation failed for all 3 tasks",
    });

    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      roundId: "round-failed",
      activeUnits: 0,
      completedUnits: 1,
      failedUnits: 2,
      totalUnits: 3,
      interrupted: true,
    });
    expect(projection.getSnapshot().control).toMatchObject({
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
    });
    assertWirePatchCarriesSwarm(failed);

    apply({ phase: "round_started", roundId: "round-next", objective: "下一轮" });
    expect(projection.getSnapshot().swarmActivity).toEqual({
      roundId: "round-next",
      activeUnits: 0,
      completedUnits: 0,
      failedUnits: 0,
      totalUnits: 0,
    });
    expect(projection.getSnapshot().swarmActivity?.interrupted).toBeUndefined();
  });

  it("原子候选路径（live publisher）保留 task_result 去重账本", () => {
    const { projection, apply } = harness();
    apply({ phase: "round_started", roundId: "round-atomic", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-atomic",
      taskIds: ["swarm-task-1", "swarm-task-2"],
    });

    const first = projection.applyEventAtomically(
      swarmEvent(3, {
        phase: "task_result",
        roundId: "round-atomic",
        result: { taskId: "swarm-task-1", status: "done", output: "产出1" },
      }),
      () => true,
    );
    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      activeUnits: 1,
      completedUnits: 1,
    });
    assertWirePatchCarriesSwarm(first ?? []);

    // cloneProjection/adoptProjection 必须带上账本；否则第二次同 taskId 会被再计一次。
    expect(
      projection.applyEventAtomically(
        swarmEvent(4, {
          phase: "task_result",
          roundId: "round-atomic",
          result: { taskId: "swarm-task-1", status: "done", output: "产出1" },
        }),
        () => true,
      ),
    ).toEqual([]);
    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      activeUnits: 1,
      completedUnits: 1,
    });
  });

  it("SessionResumed 把旧 Runtime 的在途 active 计数按中断收尾", () => {
    const { projection, apply } = harness();

    apply({ phase: "round_started", roundId: "round-resume", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-resume",
      taskIds: ["swarm-task-1", "swarm-task-2"],
    });
    apply({
      phase: "task_result",
      roundId: "round-resume",
      result: { taskId: "swarm-task-1", status: "done", output: "产出1" },
    });
    expect(projection.getSnapshot().swarmActivity?.activeUnits).toBe(1);
    expect(projection.getSnapshot().control.canStop).toBe(true);

    projection.applyEvent({
      ...swarmEvent(4, {}),
      type: SessionEventType.SessionResumed,
      payload: {
        directory: "/workspace",
        interruptedToolCount: 1,
        messageCount: 1,
        partCount: 1,
        recoveredCompactTimelineCount: 0,
        recoveredSteerInputCount: 0,
        resumedTodoCount: 0,
      },
    });

    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      roundId: "round-resume",
      activeUnits: 0,
      interrupted: true,
    });
    expect(projection.getSnapshot().control.canStop).toBe(false);
  });

  it("坏 journal 事件不抛 TypeError，也不改动快照", () => {
    const { projection, apply } = harness();

    expect(apply(null)).toEqual([]);
    expect(apply({})).toEqual([]);
    expect(apply({ roundId: "bad-round", phase: 42 })).toEqual([]);
    expect(apply({ roundId: "bad-round", phase: "unknown-phase" })).toEqual([]);
    expect(apply({ roundId: "", phase: "round_started" })).toEqual([]);
    expect(apply({ roundId: "bad-round", phase: "task_result", result: null })).toEqual([]);
    expect(apply({ roundId: "bad-round", phase: "task_result", result: { taskId: "" } })).toEqual(
      [],
    );
    expect(projection.getSnapshot().swarmActivity).toBeUndefined();
    expect(projection.getSnapshot().control.canStop).toBe(false);
  });

  it("SessionResumed 把 round_started-only 的残留控制位按中断收尾", () => {
    const { projection, apply } = harness();

    apply({ phase: "round_started", roundId: "round-started-only", objective: "整轮目标" });
    expect(projection.getSnapshot().swarmActivity).toEqual({
      roundId: "round-started-only",
      activeUnits: 0,
      completedUnits: 0,
      failedUnits: 0,
      totalUnits: 0,
    });
    expect(projection.getSnapshot().control.canStop).toBe(true);

    // 进程在 decomposed/round_completed 之前死掉：activeUnits 仍是 0，但 canStop
    // 已被 round_started 置 true；resume 必须清掉残留控制位并标 interrupted。
    projection.applyEvent({
      ...swarmEvent(2, {}),
      type: SessionEventType.SessionResumed,
      payload: {
        directory: "/workspace",
        interruptedToolCount: 0,
        messageCount: 0,
        partCount: 0,
        recoveredCompactTimelineCount: 0,
        recoveredSteerInputCount: 0,
        resumedTodoCount: 0,
      },
    });

    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      roundId: "round-started-only",
      activeUnits: 0,
      interrupted: true,
    });
    expect(projection.getSnapshot().control.canStop).toBe(false);
  });

  it("hydration replay 与 live 得到一致计数，收尾 parse 不丢 swarmActivity", () => {
    const events = roundEvents("round-hydrate");
    const live = new ProductProjection(SESSION_ID, "epoch-live");
    for (const event of events) live.applyEvent(event);
    const liveActivity = live.getSnapshot().swarmActivity;
    expect(liveActivity).toMatchObject({
      activeUnits: 0,
      completedUnits: 1,
      failedUnits: 1,
      totalUnits: 2,
    });
    expect(live.getSnapshot().control.canStop).toBe(false);

    const cold = new ProductProjection(SESSION_ID, "epoch-cold");
    cold.beginHydrationReplay();
    const hydrationDeltas: ConversationDelta[] = [];
    for (const event of events) {
      hydrationDeltas.push(...cold.applyHydrationEvent(event));
    }
    cold.completeHydrationReplay();

    expect(cold.getSnapshot().swarmActivity).toEqual(liveActivity);
    expect(cold.getSnapshot().control).toMatchObject({
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
    });
    assertWirePatchCarriesSwarm(hydrationDeltas);
    // 冷恢复收尾用 statePatchSchema.parse(整份快照) 折成 patch：该键必须原样保留。
    expect(statePatchSchema.parse(cold.getSnapshot()).swarmActivity).toEqual(liveActivity);
  });
});
