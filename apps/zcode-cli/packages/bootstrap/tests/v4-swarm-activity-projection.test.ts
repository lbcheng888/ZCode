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

function subagentEvent(
  sequenceNumber: number,
  type: SessionEventType,
  payload: unknown,
): SessionEvent {
  return {
    ...swarmEvent(sequenceNumber, payload),
    id: `subagent-event-${sequenceNumber}`,
    type,
  } as SessionEvent;
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
      units: [],
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
    // 分解清单直接落成可渲染行；缺描述时用空串而不是伪造 taskId。
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      { taskId: "swarm-task-1", description: "", status: "running" },
      { taskId: "swarm-task-2", description: "", status: "running" },
    ]);
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
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      { taskId: "swarm-task-1", description: "", status: "done" },
      { taskId: "swarm-task-2", description: "", status: "running" },
    ]);

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
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      { taskId: "swarm-task-1", description: "", status: "done" },
      { taskId: "swarm-task-2", description: "", status: "failed", error: "child boom" },
    ]);
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
    // 收口不改写已上报的终态；行上的 error 原样保留。
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      { taskId: "swarm-task-1", description: "", status: "done" },
      { taskId: "swarm-task-2", description: "", status: "failed", error: "child boom" },
    ]);
    expect(
      projection.getSnapshot().swarmActivity?.units?.filter((unit) => unit.status !== "done")
        .length,
    ).toBe(projection.getSnapshot().swarmActivity?.failedUnits);
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
    const failedActivity = projection.getSnapshot().swarmActivity;
    expect(failedActivity?.units).toEqual([
      { taskId: "swarm-task-1", description: "", status: "done" },
      // task_result 的 cancelled 是更细的终态，不被 failedTaskIds 汇总覆盖。
      { taskId: "swarm-task-2", description: "", status: "cancelled" },
      // 汇总点名的未终态行按汇总收口。
      { taskId: "swarm-task-3", description: "", status: "failed" },
    ]);
    // 未完成的终态行（failed + cancelled）与聚合 failedUnits 同源一致。
    expect(
      failedActivity?.units?.filter(
        (unit) => unit.status === "failed" || unit.status === "cancelled",
      ).length,
    ).toBe(failedActivity?.failedUnits);
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
      units: [],
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
    // 新 Runtime 不会接手旧轮在途 worker：running 行按中断收尾，已终态行原样保留。
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      { taskId: "swarm-task-1", description: "", status: "done" },
      { taskId: "swarm-task-2", description: "", status: "cancelled" },
    ]);
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
    // 非数组 / 含非字符串项的分解清单是坏事实：整条忽略，不以半截数组造行。
    expect(apply({ roundId: "bad-round", phase: "decomposed", taskIds: "oops" })).toEqual([]);
    expect(apply({ roundId: "bad-round", phase: "decomposed", taskIds: ["ok", 42] })).toEqual([]);
    expect(projection.getSnapshot().swarmActivity).toBeUndefined();
    expect(projection.getSnapshot().control.canStop).toBe(false);
  });

  it("坏计数帧仍收口控制位：非法清单按空数组处理，running 单元标 cancelled", () => {
    const { projection, apply } = harness();

    apply({ phase: "round_started", roundId: "round-bad-count", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-bad-count",
      taskIds: ["swarm-task-1", "swarm-task-2"],
    });
    expect(projection.getSnapshot().control.canStop).toBe(true);

    const badCounts = apply({
      phase: "round_completed",
      roundId: "round-bad-count",
      completedTaskIds: 42,
      failedTaskIds: { oops: true },
    });

    // 坏帧不能整条丢弃：canStop 必须清掉，否则 UI 永远显示「可停止」。
    expect(projection.getSnapshot().control).toMatchObject({
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
    });
    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      roundId: "round-bad-count",
      activeUnits: 0,
      completedUnits: 0,
      failedUnits: 0,
      totalUnits: 2,
    });
    // 汇总不可用：仍 running 的行没有权威终态，按 cancelled 收口；无 error 不标 interrupted。
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      { taskId: "swarm-task-1", description: "", status: "cancelled" },
      { taskId: "swarm-task-2", description: "", status: "cancelled" },
    ]);
    expect(projection.getSnapshot().swarmActivity?.interrupted).toBeUndefined();
    assertWirePatchCarriesSwarm(badCounts);

    // error 在场时同样按空数组收口，但 interrupted 必须置位并把原始错误带到行上。
    apply({ phase: "round_started", roundId: "round-bad-count-error", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-bad-count-error",
      taskIds: ["swarm-task-3"],
    });
    apply({
      phase: "round_completed",
      roundId: "round-bad-count-error",
      completedTaskIds: ["swarm-task-3", 7],
      failedTaskIds: null,
      error: "decompose failed",
    });
    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      roundId: "round-bad-count-error",
      activeUnits: 0,
      interrupted: true,
    });
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      {
        taskId: "swarm-task-3",
        description: "",
        status: "cancelled",
        error: "decompose failed",
      },
    ]);
    expect(projection.getSnapshot().control.canStop).toBe(false);
  });

  it("坏 decomposed 不清掉已发布的单元行", () => {
    const { projection, apply } = harness();

    apply({ phase: "round_started", roundId: "round-bad-decomposed", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-bad-decomposed",
      taskIds: ["swarm-task-1"],
      taskDescriptions: ["任务1"],
    });
    expect(
      apply({ phase: "decomposed", roundId: "round-bad-decomposed", taskIds: "oops" }),
    ).toEqual([]);
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      { taskId: "swarm-task-1", description: "任务1", status: "running" },
    ]);
  });

  it("缺 decomposed 的恢复片段：task_result 回填终态行且不伪造描述", () => {
    const { projection, apply } = harness();

    apply({
      phase: "task_result",
      roundId: "round-fragment",
      result: { taskId: "swarm-task-9", status: "failed", error: "worker lost" },
    });

    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      roundId: "round-fragment",
      activeUnits: 0,
      completedUnits: 0,
      failedUnits: 1,
      totalUnits: 0,
      units: [
        {
          taskId: "swarm-task-9",
          description: "",
          status: "failed",
          error: "worker lost",
        },
      ],
    });
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
      units: [],
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

  it("units 是 additive-optional：旧计数帧仍可解码，不被补默认值", () => {
    const parsed = statePatchSchema.parse({
      swarmActivity: { activeUnits: 0, completedUnits: 1, totalUnits: 1 },
    });
    expect(parsed.swarmActivity).toEqual({ activeUnits: 0, completedUnits: 1, totalUnits: 1 });
    expect(parsed.swarmActivity?.units).toBeUndefined();
  });

  it("decomposed.taskToolCallIds 把 Subagent* 事件关联到对应 unit 的实时活动", () => {
    const { projection } = harness();
    let seq = 0;
    const apply = (payload: unknown): ConversationDelta[] =>
      projection.applyEvent(swarmEvent(++seq, payload));
    const subagent = (type: SessionEventType, payload: unknown): ConversationDelta[] =>
      projection.applyEvent(subagentEvent(++seq, type, payload));

    apply({ phase: "round_started", roundId: "round-live", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-live",
      taskIds: ["swarm-task-1", "swarm-task-2"],
      taskDescriptions: ["任务1", "任务2"],
      taskToolCallIds: ["swarm_call_1", "swarm_call_2"],
    });

    const spawned = subagent(SessionEventType.SubagentSpawned, {
      agentId: "agent-1",
      agentType: "Explore",
      childSessionId: "child-1",
      description: "任务1",
      parentToolCallId: "swarm_call_1",
      status: "running",
    });
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      {
        taskId: "swarm-task-1",
        description: "任务1",
        status: "running",
        agentId: "agent-1",
        childSessionId: "child-1",
      },
      { taskId: "swarm-task-2", description: "任务2", status: "running" },
    ]);
    // 既有 subagent row 行为不被实时活动更新吞掉。
    expect(
      projection
        .getSnapshot()
        .rows.window.some(
          (row) => row.kind === "subagent" && row.childSessionId === "child-1",
        ),
    ).toBe(true);
    assertWirePatchCarriesSwarm(spawned);

    // 最近消息截断到 200 字符；未命中的 parentToolCallId 不产生新 unit。
    const longMessage = "读".repeat(260);
    const messaged = subagent(SessionEventType.SubagentMessage, {
      agentId: "agent-1",
      childSessionId: "child-1",
      parentToolCallId: "swarm_call_1",
      summaryText: longMessage,
    });
    expect(projection.getSnapshot().swarmActivity?.units?.[0]?.lastMessage).toBe("读".repeat(200));
    expect(projection.getSnapshot().swarmActivity?.units).toHaveLength(2);
    assertWirePatchCarriesSwarm(messaged);

    const stopped = subagent(SessionEventType.SubagentStopped, {
      agentId: "agent-1",
      childSessionId: "child-1",
      parentToolCallId: "swarm_call_1",
      status: "completed",
    });
    expect(projection.getSnapshot().swarmActivity).toMatchObject({
      activeUnits: 2,
      completedUnits: 0,
      failedUnits: 0,
    });
    expect(projection.getSnapshot().swarmActivity?.units?.[0]).toEqual({
      taskId: "swarm-task-1",
      description: "任务1",
      status: "done",
      agentId: "agent-1",
      childSessionId: "child-1",
      lastMessage: "读".repeat(200),
    });
    assertWirePatchCarriesSwarm(stopped);
  });

  it("task_result 收口终态时清掉实时活动，迟到 spawn 不复活终态行", () => {
    const { projection } = harness();
    let seq = 0;
    const apply = (payload: unknown): ConversationDelta[] =>
      projection.applyEvent(swarmEvent(++seq, payload));
    const subagent = (type: SessionEventType, payload: unknown): ConversationDelta[] =>
      projection.applyEvent(subagentEvent(++seq, type, payload));

    apply({ phase: "round_started", roundId: "round-settle", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-settle",
      taskIds: ["swarm-task-1"],
      taskDescriptions: ["任务1"],
      taskToolCallIds: ["swarm_call_1"],
    });
    subagent(SessionEventType.SubagentSpawned, {
      agentId: "agent-1",
      childSessionId: "child-1",
      parentToolCallId: "swarm_call_1",
      status: "running",
    });
    subagent(SessionEventType.SubagentMessage, {
      agentId: "agent-1",
      parentToolCallId: "swarm_call_1",
      summaryText: "最新进展",
    });
    expect(projection.getSnapshot().swarmActivity?.units?.[0]?.lastMessage).toBe("最新进展");

    const settled = apply({
      phase: "task_result",
      roundId: "round-settle",
      result: { taskId: "swarm-task-1", status: "done", output: "产出1" },
    });
    // 身份字段保留供下钻；实时活动随终态一起剥离。
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      {
        taskId: "swarm-task-1",
        description: "任务1",
        status: "done",
        agentId: "agent-1",
        childSessionId: "child-1",
      },
    ]);
    assertWirePatchCarriesSwarm(settled);

    // 迟到 spawn 只命中在途行；终态行保持原样，不补身份也不改回 running。
    const late = subagent(SessionEventType.SubagentSpawned, {
      agentId: "agent-late",
      childSessionId: "child-late",
      parentToolCallId: "swarm_call_1",
      status: "running",
    });
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      {
        taskId: "swarm-task-1",
        description: "任务1",
        status: "done",
        agentId: "agent-1",
        childSessionId: "child-1",
      },
    ]);
    expect(
      late.some(
        (delta) => delta.op === "state.updated" && delta.patch.swarmActivity !== undefined,
      ),
    ).toBe(false);
  });

  it("SessionResumed 收口 running 行时清掉实时活动", () => {
    const { projection } = harness();
    let seq = 0;
    const apply = (payload: unknown): ConversationDelta[] =>
      projection.applyEvent(swarmEvent(++seq, payload));
    const subagent = (type: SessionEventType, payload: unknown): ConversationDelta[] =>
      projection.applyEvent(subagentEvent(++seq, type, payload));

    apply({ phase: "round_started", roundId: "round-resume-activity", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-resume-activity",
      taskIds: ["swarm-task-1", "swarm-task-2"],
      taskDescriptions: ["任务1", "任务2"],
      taskToolCallIds: ["swarm_call_1", "swarm_call_2"],
    });
    subagent(SessionEventType.SubagentSpawned, {
      agentId: "agent-1",
      childSessionId: "child-1",
      parentToolCallId: "swarm_call_1",
      status: "running",
    });
    subagent(SessionEventType.SubagentMessage, {
      agentId: "agent-1",
      parentToolCallId: "swarm_call_1",
      summaryText: "任务1进展",
    });
    subagent(SessionEventType.SubagentSpawned, {
      agentId: "agent-2",
      childSessionId: "child-2",
      parentToolCallId: "swarm_call_2",
      status: "running",
    });
    subagent(SessionEventType.SubagentMessage, {
      agentId: "agent-2",
      parentToolCallId: "swarm_call_2",
      summaryText: "在途消息",
    });
    expect(projection.getSnapshot().swarmActivity?.units?.[1]?.lastMessage).toBe("在途消息");
    apply({
      phase: "task_result",
      roundId: "round-resume-activity",
      result: { taskId: "swarm-task-1", status: "done", output: "产出1" },
    });

    projection.applyEvent({
      ...swarmEvent(++seq, {}),
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

    // 已终态的行保持 done；被收口为 cancelled 的在途行不带活动。
    expect(projection.getSnapshot().swarmActivity?.units).toEqual([
      {
        taskId: "swarm-task-1",
        description: "任务1",
        status: "done",
        agentId: "agent-1",
        childSessionId: "child-1",
      },
      {
        taskId: "swarm-task-2",
        description: "任务2",
        status: "cancelled",
        agentId: "agent-2",
        childSessionId: "child-2",
      },
    ]);
  });

  it("round_completed 保留终态 units 供回看，并清掉残留实时活动", () => {
    const { projection } = harness();
    let seq = 0;
    const apply = (payload: unknown): ConversationDelta[] =>
      projection.applyEvent(swarmEvent(++seq, payload));
    const subagent = (type: SessionEventType, payload: unknown): ConversationDelta[] =>
      projection.applyEvent(subagentEvent(++seq, type, payload));

    apply({ phase: "round_started", roundId: "round-review", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-review",
      taskIds: ["swarm-task-1", "swarm-task-2"],
      taskDescriptions: ["任务1", "任务2"],
      taskToolCallIds: ["swarm_call_1", "swarm_call_2"],
    });
    subagent(SessionEventType.SubagentSpawned, {
      agentId: "agent-1",
      childSessionId: "child-1",
      parentToolCallId: "swarm_call_1",
      status: "running",
    });
    subagent(SessionEventType.SubagentMessage, {
      agentId: "agent-1",
      parentToolCallId: "swarm_call_1",
      summaryText: "停止前的最近消息",
    });
    subagent(SessionEventType.SubagentStopped, {
      agentId: "agent-1",
      childSessionId: "child-1",
      parentToolCallId: "swarm_call_1",
      status: "completed",
    });
    // SubagentStopped 只推进行状态；轮级收口前 lastMessage 仍在，随后由 round_completed 清掉。
    expect(projection.getSnapshot().swarmActivity?.units?.[0]).toMatchObject({
      status: "done",
      lastMessage: "停止前的最近消息",
    });
    apply({
      phase: "task_result",
      roundId: "round-review",
      result: { taskId: "swarm-task-2", status: "failed", error: "child boom" },
    });

    const completed = apply({
      phase: "round_completed",
      roundId: "round-review",
      completedTaskIds: ["swarm-task-1"],
      failedTaskIds: ["swarm-task-2"],
    });
    const activity = projection.getSnapshot().swarmActivity;
    // 回合结束不删键、不删行：终态 units 原样保留供回看。
    expect(activity).toBeDefined();
    expect(activity).toMatchObject({
      roundId: "round-review",
      activeUnits: 0,
      completedUnits: 1,
      failedUnits: 1,
      totalUnits: 2,
    });
    expect(activity?.units).toEqual([
      {
        taskId: "swarm-task-1",
        description: "任务1",
        status: "done",
        agentId: "agent-1",
        childSessionId: "child-1",
      },
      { taskId: "swarm-task-2", description: "任务2", status: "failed", error: "child boom" },
    ]);
    assertWirePatchCarriesSwarm(completed);
  });

  it("lastMessage 截断不留下孤立高位代理（emoji 边界）", () => {
    const { projection } = harness();
    let seq = 0;
    const apply = (payload: unknown): ConversationDelta[] =>
      projection.applyEvent(swarmEvent(++seq, payload));
    const subagent = (type: SessionEventType, payload: unknown): ConversationDelta[] =>
      projection.applyEvent(subagentEvent(++seq, type, payload));

    apply({ phase: "round_started", roundId: "round-emoji", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-emoji",
      taskIds: ["swarm-task-1"],
      taskDescriptions: ["任务1"],
      taskToolCallIds: ["swarm_call_1"],
    });
    subagent(SessionEventType.SubagentSpawned, {
      agentId: "agent-1",
      childSessionId: "child-1",
      parentToolCallId: "swarm_call_1",
      status: "running",
    });
    // 199 个 ASCII + 1 个 emoji（2 个码元）：第 200 个码元正好是 emoji 的高位代理。
    subagent(SessionEventType.SubagentMessage, {
      agentId: "agent-1",
      parentToolCallId: "swarm_call_1",
      summaryText: `${"a".repeat(199)}😀`,
    });

    const lastMessage = projection.getSnapshot().swarmActivity?.units?.[0]?.lastMessage;
    expect(lastMessage).toBe("a".repeat(199));
    expect(lastMessage).toHaveLength(199);
    const tail = lastMessage?.charCodeAt(lastMessage.length - 1) ?? 0;
    expect(tail >= 0xd800 && tail <= 0xdbff).toBe(false);
  });

  it("hydration replay 用同一事件序重建 unit 实时活动，与 live 快照一致", () => {
    const events: SessionEvent[] = [
      swarmEvent(1, { phase: "round_started", roundId: "round-replay", objective: "整轮目标" }),
      swarmEvent(2, {
        phase: "decomposed",
        roundId: "round-replay",
        taskIds: ["swarm-task-1"],
        taskDescriptions: ["任务1"],
        taskToolCallIds: ["swarm_call_1"],
      }),
      subagentEvent(3, SessionEventType.SubagentSpawned, {
        agentId: "agent-replay",
        agentType: "Explore",
        childSessionId: "child-replay",
        description: "任务1",
        parentToolCallId: "swarm_call_1",
        status: "running",
      }),
      subagentEvent(4, SessionEventType.SubagentMessage, {
        agentId: "agent-replay",
        parentToolCallId: "swarm_call_1",
        summaryText: "恢复中的最近消息",
      }),
      subagentEvent(5, SessionEventType.SubagentStopped, {
        agentId: "agent-replay",
        childSessionId: "child-replay",
        parentToolCallId: "swarm_call_1",
        status: "completed",
      }),
    ];

    const live = new ProductProjection(SESSION_ID, "epoch-live");
    for (const event of events) live.applyEvent(event);
    const cold = new ProductProjection(SESSION_ID, "epoch-cold");
    cold.beginHydrationReplay();
    for (const event of events) cold.applyHydrationEvent(event);
    cold.completeHydrationReplay();

    const liveActivity = live.getSnapshot().swarmActivity;
    expect(liveActivity?.units).toEqual([
      {
        taskId: "swarm-task-1",
        description: "任务1",
        status: "done",
        agentId: "agent-replay",
        childSessionId: "child-replay",
        lastMessage: "恢复中的最近消息",
      },
    ]);
    expect(cold.getSnapshot().swarmActivity).toEqual(liveActivity);
    expect(statePatchSchema.parse(cold.getSnapshot()).swarmActivity).toEqual(liveActivity);
  });

  it("旧 journal 无 taskToolCallIds：Subagent* 只维护 subagent row，units 保持原样", () => {
    const { projection } = harness();
    let seq = 0;
    const apply = (payload: unknown): ConversationDelta[] =>
      projection.applyEvent(swarmEvent(++seq, payload));
    const subagent = (type: SessionEventType, payload: unknown): ConversationDelta[] =>
      projection.applyEvent(subagentEvent(++seq, type, payload));

    apply({ phase: "round_started", roundId: "round-legacy", objective: "整轮目标" });
    apply({
      phase: "decomposed",
      roundId: "round-legacy",
      taskIds: ["swarm-task-1"],
      taskDescriptions: ["任务1"],
    });
    const legacyUnits = projection.getSnapshot().swarmActivity?.units;

    subagent(SessionEventType.SubagentSpawned, {
      agentId: "agent-legacy",
      childSessionId: "child-legacy",
      parentToolCallId: "swarm_call_legacy",
      status: "running",
    });
    subagent(SessionEventType.SubagentMessage, {
      parentToolCallId: "swarm_call_legacy",
      summaryText: "旧日志消息",
    });
    subagent(SessionEventType.SubagentStopped, {
      agentId: "agent-legacy",
      parentToolCallId: "swarm_call_legacy",
      status: "completed",
    });

    // 没有关联键就不更新 units，也不凭空创建行；subagent row 仍按旧路径物化。
    expect(projection.getSnapshot().swarmActivity?.units).toEqual(legacyUnits);
    expect(
      projection
        .getSnapshot()
        .rows.window.some(
          (row) => row.kind === "subagent" && row.childSessionId === "child-legacy",
        ),
    ).toBe(true);
  });

  it("坏 taskToolCallIds 不阻断 units 发布，也不建立错误映射", () => {
    const { projection } = harness();
    let seq = 0;
    const apply = (payload: unknown): ConversationDelta[] =>
      projection.applyEvent(swarmEvent(++seq, payload));

    apply({ phase: "round_started", roundId: "round-bad-tool-ids", objective: "整轮目标" });
    // 长度对不齐：仍发布 units，但无法把 tool call id 关联到 taskId。
    apply({
      phase: "decomposed",
      roundId: "round-bad-tool-ids",
      taskIds: ["swarm-task-1", "swarm-task-2"],
      taskDescriptions: ["任务1", "任务2"],
      taskToolCallIds: ["swarm_call_1"],
    });
    expect(projection.getSnapshot().swarmActivity?.units).toHaveLength(2);
    expect(
      projection.getSnapshot().swarmActivity?.units?.some((unit) => unit.agentId !== undefined),
    ).toBe(false);

    projection.applyEvent(
      subagentEvent(++seq, SessionEventType.SubagentSpawned, {
        agentId: "agent-bad",
        childSessionId: "child-bad",
        parentToolCallId: "swarm_call_1",
        status: "running",
      }),
    );
    expect(
      projection.getSnapshot().swarmActivity?.units?.some((unit) => unit.agentId !== undefined),
    ).toBe(false);
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
    // 描述来自同一条 decomposed 事件；终态与 error 来自对应 task_result。
    expect(liveActivity?.units).toEqual([
      { taskId: "swarm-task-1", description: "任务1", status: "done" },
      { taskId: "swarm-task-2", description: "任务2", status: "failed", error: "child boom" },
    ]);
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
