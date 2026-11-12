/**
 * 出生阶段坐标的两个打戳函数（docs/dynamic-workflow/presentation.md 追记 2026-09-09）。
 *
 * 拆分原因：engine.ts 顶到 oxlint max-lines 上限（400 行）。选中这两个而不是别的，是因为它们
 * 高度同族——同一张 `instancePhases` 表（实例 `siteId@ordinal` → 它**出生时**的阶段，名字 + 来源）的仅有
 * 两个读者，一个给事件打戳、一个给 `ProviderStop` 明细补阶段，且都是纯函数：表由调用方（引擎）
 * 拥有并在铸造点写入，这里只读。公开面仍只有 engine.ts 在用。
 *
 * 表里的值不只记名字，还记这个名字**从哪来**（{@link BirthPhase.from}）。ask 节点的戳只认编译期
 * 表：表在场而站点不在表里，编译期的意思恰恰是这个站点被几个阶段各执行一次（几条并行 lane 共用
 * 一个评审 helper 就是它），铸造那一刻的当前标记是**别的车道**最后跑过的那个，戳上去就是把节点
 * 挂到错误的阶段上。这种时候缺省——一个没有归属的节点比一个挂错车道的节点诚实，读面（presentation.md
 * 「Narrowing by phase」）有它的无名阶段桶。
 */

import type { InstanceRef, RunEvent } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
 * 出生阶段：名字，以及这个名字的来源。
 *
 * - `table`：编译期表（`EngineConfig.sitePhases`）命中——确认图里这个站点只属于一个阶段。
 * - `marker`：本 run 没有编译期表（snippet、老编译产物、直接投喂的 lowered 体），只能取铸造
 *   那一刻的当前标记。它没有第二个坐标，对每一种实例都算数。
 * - `unlisted`：表在场而站点不在表里。编译期在场却拒绝表态，说明这个站点跨阶段（或整段落在
 *   标记之前）：当前标记不归它。
 */
export interface BirthPhase {
  readonly name: string;
  readonly from: "table" | "marker" | "unlisted";
}

/** 实例键（`siteId@ordinal`）→ 它的出生阶段。引擎的 `instancePhases` 的只读视图。 */
export type InstancePhases = ReadonlyMap<string, BirthPhase>;

/**
 * 一个实例的出生阶段名：没在铸造点记过即 undefined；`strict` 时 `unlisted` 也不给名字。
 * `strict` 只给 ask 节点——见文件头。
 */
function birthPhaseOf(
  instance: InstanceRef,
  instancePhases: InstancePhases,
  strict: boolean,
): string | undefined {
  const phase = instancePhases.get(refToString(instance));
  if (phase === undefined) return undefined;
  if (strict && phase.from === "unlisted") return undefined;
  return phase.name;
}

/**
 * 给**出生事件**补上出生阶段：actor 的 `actor-created` 按 actor 查表，节点的 `node-queued`
 * 按 instance 查表，命中缓存的 `node-settled { cached: true }` 同样按 instance——命中的节点
 * 没有 queued，那条 settle 就是它的出生事件。其余事件**原样返回**：调度器的其余发射点零改动，
 * reducer 沿用 `actorSiteId` 的先例向前携带。
 *
 * ask 的 `node-dispatched` 是唯一的例外，它重复自己的出生事实（types.ts 的同名事件），于是
 * 两个阶段名在这里一并补上：`phaseName` 按 instance、`actorPhaseName` 按它的 actor，两次都查
 * 同一张出生表，所以与该实例的 `node-queued`、该 actor 的 `actor-created` 逐字相同。带 `actor`
 * 才补——world-read 的派发不带子代理，保持裸的。
 *
 * 它不是「发出这条事件时的当前阶段」：node-queued 可能被 hold 规则推迟到下一个标记之后才发出，
 * 而出生时刻在上一个阶段；派发更是可能卡在并发上界后面，等到脚本已走过好几个标记。
 *
 * ask 的事件走 {@link birthPhaseOf} 的 strict 分支：编译期表拒绝表态的站点（`unlisted`）不戳，
 * 其余实例（actor / world 节点 / 留白）照旧拿 `marker` 那条坐标。
 */
export function stampBirthPhase(event: RunEvent, instancePhases: InstancePhases): RunEvent {
  if (event.type === "actor-created") {
    const phaseName = birthPhaseOf(event.actor, instancePhases, false);
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-queued") {
    const phaseName = birthPhaseOf(event.instance, instancePhases, event.kind === "ask");
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-dispatched" && event.actor !== undefined) {
    // 带 actor 的派发只可能是 ask（world 的派发是裸的），两个阶段名各自查表：实例按 strict，
    // actor 照旧。
    const phaseName = birthPhaseOf(event.instance, instancePhases, true);
    const actorPhaseName = birthPhaseOf(event.actor, instancePhases, false);
    if (phaseName === undefined && actorPhaseName === undefined) return event;
    return {
      ...event,
      ...(phaseName === undefined ? {} : { phaseName }),
      ...(actorPhaseName === undefined ? {} : { actorPhaseName }),
    };
  }
  if (event.type === "node-settled" && event.cached === true) {
    // 缓存结算只在 ask 上重发出生事实（`kind` 因此在场）；world 的缓存结算没有子代理，也没有
    // kind，走宽松的那条。
    const phaseName = birthPhaseOf(event.instance, instancePhases, event.kind === "ask");
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  // 留白的到达也是一次出生（docs/execution-engine.md「Holes」）：序号与节点同族铸造，出生
  // 阶段同一张表——没有行，事件是它唯一的坐标。
  if (event.type === "hole-reached") {
    const phaseName = birthPhaseOf(event.instance, instancePhases, false);
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  return event;
}

/**
 * 给 `ProviderStop` 补上触发停止的子代理的**出生阶段**（docs/execution-engine.md
 * 「通知文案」的 `phase=`）：driver 只知道 actor ref，阶段只有引擎知道（与事件流上 `phaseName`
 * 的同一张表）。没有 providerStop、没有 subagent、已带阶段、或该 ref 出生在任何 `phase()`
 * 标记之前 → 原样返回。
 */
export function enrichProviderStopPhase(
  error: WorkflowError,
  instancePhases: InstancePhases,
): WorkflowError {
  const details = error.providerStop;
  if (details === undefined || details.subagent === undefined || details.phase !== undefined) {
    return error;
  }
  const phase = instancePhases.get(details.subagent)?.name;
  if (phase === undefined) return error;
  return new WorkflowError(error.code, error.message, {
    providerStop: { ...details, phase },
    cause: (error as { cause?: unknown }).cause,
  });
}
