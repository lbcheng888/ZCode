import { describe, expect, it } from "vitest";
import {
  toolCallCreateWorkflowDisplaySchema,
  workflowRunSchema,
  type ToolCallCreateWorkflowCausalityGraph,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  liveParticipantView,
  participantsOfPhase,
  withImplicitPhase,
} from "../src/components/workflow-graph/participant-model.js";
import { buildWorkflowTimeline } from "../src/components/workflow-timeline/timeline-model.js";

/**
 * 三相位并行 + may-set 车道拷贝的图回归（2026-11-12 testfield）。
 *
 * 分析器把共享 helper 站点按「站点」认领阶段，may-set 展开又把它拆成每条车道一份拷贝，
 * 于是同一站点的 lane 拷贝会被复制进每个认领阶段（`ask#1~actor#2~phase#1..3`）。静态图
 * 保持这个形状；live 视图只用 actor / node 的 `phaseName` 认领本列真正出现过的那一份，
 * 既不把一条车道广播到三列，也不藏掉真的跨了阶段的 actor。
 */

const PHASES = [
  { id: "phase#1", name: "全链隔离" },
  { id: "phase#2", name: "副作用顺序与版本标记" },
  { id: "phase#3", name: "算子行号动态化" },
] as const;

function parallelGraph(
  steps: {
    id: string;
    phase: string;
    lane: string;
    source?: string;
  }[],
  participants: {
    id: string;
    phase: string;
    lane: string;
    steps: string[];
    member?: { index: number; of: number };
  }[],
  handoffs: { from: string; to: string }[] = [],
): ToolCallCreateWorkflowCausalityGraph {
  // 走真实 display schema：图 fixture 与工具输出边界同一份校验，形状漂移会先在这里失败。
  const display = toolCallCreateWorkflowDisplaySchema.parse({
    kind: "create_workflow",
    ok: true,
    errorCount: 0,
    diagnostics: [],
    causalityGraph: {
      phases: PHASES.map((phase) => ({
        ...phase,
        alongside: PHASES.filter((other) => other.id !== phase.id).map((other) => other.id),
      })),
      phaseEdges: [],
      steps: steps.map((step) => ({
        ...step,
        kind: "ask",
        label: step.id,
        line: 1,
        column: 1,
      })),
      lanes: [...new Set(steps.map((step) => step.lane))].map((lane) => ({ id: lane, name: lane })),
      participants: participants.map((participant) => ({
        ...participant,
        ...(participant.member === undefined ? { many: true } : {}),
      })),
      handoffs,
    },
  });
  if (display.causalityGraph === undefined) throw new Error("fixture 缺少 causalityGraph");
  return display.causalityGraph;
}

function phaseNameOf(id: string): string {
  const phase = PHASES.find((candidate) => candidate.id === id);
  if (phase === undefined) throw new Error(`未知阶段：${id}`);
  return phase.name;
}

function runOf(
  actors: { siteId: string; name: string; phaseName: string; ordinal?: number }[],
  nodes: {
    siteId: string;
    phaseName: string;
    actorSiteId: string;
    ordinal?: number;
    actorOrdinal?: number;
  }[],
): WorkflowRunState {
  return workflowRunSchema.parse({
    runId: "run-parallel",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: nodes.length },
    actors: actors.map((actor) => ({
      ...actor,
      ordinal: actor.ordinal ?? 1,
      status: "running",
    })),
    nodes: nodes.map((node) => ({
      siteId: node.siteId,
      ordinal: node.ordinal ?? 1,
      kind: "ask",
      phase: "settled",
      outcome: "ok",
      actorSiteId: node.actorSiteId,
      actorOrdinal: node.actorOrdinal ?? 1,
      phaseName: node.phaseName,
    })),
    lastEventSequence: 1,
  });
}

describe("workflow parallel phase roster", () => {
  it("三相位各两个真实参与者：每列两枚药丸，总计六枚", () => {
    const steps = [
      { id: "ask#1", phase: "phase#1", lane: "actor#1" },
      { id: "ask#2", phase: "phase#1", lane: "actor#2" },
      { id: "ask#3", phase: "phase#2", lane: "actor#3" },
      { id: "ask#4", phase: "phase#2", lane: "actor#4" },
      { id: "ask#5", phase: "phase#3", lane: "actor#5" },
      { id: "ask#6", phase: "phase#3", lane: "actor#6" },
    ];
    const participants = steps.map((step) => ({
      id: `${step.phase}:${step.lane}`,
      phase: step.phase,
      lane: step.lane,
      steps: [step.id],
    }));
    const graph = parallelGraph(steps, participants);
    const run = runOf(
      [
        { siteId: "actor#1", name: "隔离实施", phaseName: "全链隔离" },
        { siteId: "actor#2", name: "隔离评审", phaseName: "全链隔离" },
        { siteId: "actor#3", name: "副作用实施", phaseName: "副作用顺序与版本标记" },
        { siteId: "actor#4", name: "副作用评审", phaseName: "副作用顺序与版本标记" },
        { siteId: "actor#5", name: "算子实施", phaseName: "算子行号动态化" },
        { siteId: "actor#6", name: "算子评审", phaseName: "算子行号动态化" },
      ],
      steps.map((step) => ({
        siteId: step.id,
        phaseName: phaseNameOf(step.phase),
        actorSiteId: step.lane,
      })),
    );

    const live = liveParticipantView(withImplicitPhase(graph), run);
    const expectedLanes = [
      ["actor#1", "actor#2"],
      ["actor#3", "actor#4"],
      ["actor#5", "actor#6"],
    ];
    for (const [index, phase] of PHASES.entries()) {
      expect(
        participantsOfPhase(live.graph, phase.id)
          .map((participant) => participant.lane)
          .sort(),
      ).toEqual(expectedLanes[index]);
    }
    expect(PHASES.map((phase) => participantsOfPhase(live.graph, phase.id).length)).toEqual([2, 2, 2]);

    const model = buildWorkflowTimeline(graph, run);
    expect(model.stations.map((station) => station.pills.length)).toEqual([2, 2, 2]);
    expect(model.stations.flatMap((station) => station.pills)).toHaveLength(6);
  });

  it("静态复制图在 live run 下只留本阶段的那一份", () => {
    // 与真实载荷同形：同一站点 ask#1 被三个阶段认领，may-set 展开成同一条车道的三份拷贝。
    const graph = parallelGraph(
      PHASES.map((phase) => ({
        id: `ask#1~phase#${phase.id.slice(-1)}`,
        source: "ask#1",
        phase: phase.id,
        lane: "actor#1",
      })),
      PHASES.map((phase) => ({
        id: `${phase.id}:actor#1`,
        phase: phase.id,
        lane: "actor#1",
        steps: [`ask#1~phase#${phase.id.slice(-1)}`],
      })),
      [{ from: "phase#1:actor#1", to: "phase#3:actor#1" }],
    );
    const run = runOf(
      [{ siteId: "actor#1", name: "隔离实施", phaseName: "全链隔离" }],
      [{ siteId: "ask#1", phaseName: "全链隔离", actorSiteId: "actor#1" }],
    );

    // 无 run 的静态预览保持原样：三份拷贝都在（分析器层的复制不在 UI 里猜）。
    const staticPreview = liveParticipantView(graph, undefined);
    expect(staticPreview.graph).toBe(graph);
    expect(PHASES.map((phase) => participantsOfPhase(graph, phase.id).length)).toEqual([1, 1, 1]);

    const live = liveParticipantView(withImplicitPhase(graph), run);
    expect(PHASES.map((phase) => participantsOfPhase(live.graph, phase.id).length)).toEqual([1, 0, 0]);
    expect(live.graph.participants.map((p) => p.id)).toEqual(["phase#1:actor#1@1"]);
    // 被收窄掉的拷贝不再有卡，指向它的交接边也不能留下。
    expect(live.graph.handoffs).toEqual([]);
  });

  it("没有阶段戳的旧 run 保持原样：三份静态拷贝都还在", () => {
    const graph = parallelGraph(
      PHASES.map((phase) => ({
        id: `ask#1~phase#${phase.id.slice(-1)}`,
        source: "ask#1",
        phase: phase.id,
        lane: "actor#1",
      })),
      PHASES.map((phase) => ({
        id: `${phase.id}:actor#1`,
        phase: phase.id,
        lane: "actor#1",
        steps: [`ask#1~phase#${phase.id.slice(-1)}`],
      })),
    );
    // 旧 CLI 不发 phaseName：没有可用的划分坐标，宁可重复也不藏（与 phasesOf 的兜底同一语义）。
    const run = workflowRunSchema.parse({
      runId: "run-legacy",
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 1 },
      actors: [{ siteId: "actor#1", ordinal: 1, name: "隔离实施", status: "running" }],
      nodes: [
        {
          siteId: "ask#1",
          ordinal: 1,
          kind: "ask",
          phase: "settled",
          outcome: "ok",
          actorSiteId: "actor#1",
          actorOrdinal: 1,
        },
      ],
      lastEventSequence: 1,
    });

    const live = liveParticipantView(withImplicitPhase(graph), run);
    expect(PHASES.map((phase) => participantsOfPhase(live.graph, phase.id).length)).toEqual([1, 1, 1]);
  });

  it("成员卡只认自己那个序号的实例，不跟着整条车道走", () => {
    const graph = parallelGraph(
      PHASES.map((phase) => ({
        id: `ask#1~phase#${phase.id.slice(-1)}`,
        source: "ask#1",
        phase: phase.id,
        lane: "actor#1",
      })),
      PHASES.flatMap((phase) =>
        [0, 1].map((index) => ({
          id: `${phase.id}:actor#1[${index}]`,
          phase: phase.id,
          lane: "actor#1",
          steps: [`ask#1~phase#${phase.id.slice(-1)}`],
          member: { index, of: 2 },
        })),
      ),
    );
    const run = runOf(
      [
        { siteId: "actor#1", name: "成员一", phaseName: "全链隔离", ordinal: 1 },
        { siteId: "actor#1", name: "成员二", phaseName: "副作用顺序与版本标记", ordinal: 2 },
      ],
      [
        { siteId: "ask#1", phaseName: "全链隔离", actorSiteId: "actor#1", actorOrdinal: 1 },
        {
          siteId: "ask#1",
          phaseName: "副作用顺序与版本标记",
          actorSiteId: "actor#1",
          actorOrdinal: 2,
        },
      ],
    );

    const live = liveParticipantView(withImplicitPhase(graph), run);
    expect(participantsOfPhase(live.graph, "phase#1").map((p) => p.id)).toEqual([
      "phase#1:actor#1[0]",
    ]);
    expect(participantsOfPhase(live.graph, "phase#2").map((p) => p.id)).toEqual([
      "phase#2:actor#1[1]",
    ]);
    expect(participantsOfPhase(live.graph, "phase#3")).toEqual([]);
  });

  it("真的跨了阶段的 actor 在它出现过的每一列都保留", () => {
    const graph = parallelGraph(
      PHASES.map((phase) => ({
        id: `ask#1~phase#${phase.id.slice(-1)}`,
        source: "ask#1",
        phase: phase.id,
        lane: "actor#1",
      })),
      PHASES.map((phase) => ({
        id: `${phase.id}:actor#1`,
        phase: phase.id,
        lane: "actor#1",
        steps: [`ask#1~phase#${phase.id.slice(-1)}`],
      })),
    );
    const run = runOf(
      [{ siteId: "actor#1", name: "隔离实施", phaseName: "全链隔离" }],
      [
        { siteId: "ask#1", phaseName: "全链隔离", actorSiteId: "actor#1", ordinal: 1 },
        { siteId: "ask#1", phaseName: "算子行号动态化", actorSiteId: "actor#1", ordinal: 2 },
      ],
    );

    const live = liveParticipantView(withImplicitPhase(graph), run);
    expect(PHASES.map((phase) => participantsOfPhase(live.graph, phase.id).length)).toEqual([1, 0, 1]);
  });
});
