/**
 * 蜂群轮 journal 的读写面。
 *
 * 事件只追加、不原地修改：从最近一条 round_started 起回放，按 taskId 取每个
 * worker 的最后一次 task_result，即可重建最近断点。写侧负责把轮开始/分解结果/
 * 逐 worker 终态/轮完成落盘；写入失败不撤销产出，只进入本轮告警清单。
 */

import type {
  SessionEvent,
  SwarmJournalTaskResult,
  SwarmRoundJournalPayload,
  TraceContext,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";

import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { swarmTaskCompletedText, truncateSwarmWorkerOutput } from "./swarm-evidence.js";
import { errorMessage } from "./swarm-results.js";
import type {
  SwarmRoundCheckpoint,
  SwarmRoundJournalState,
  SwarmTaskResult,
} from "./swarm-types.js";

/** journal 是崩溃恢复账本，聚合产出的上限比进入回合提示的那一份更宽。 */
export const SWARM_JOURNAL_OUTPUT_MAX_CHARS = 10_000;

interface MutableSwarmRoundCheckpoint {
  roundId: string;
  objective: string;
  taskIds: string[];
  taskDescriptions: string[];
  results: SwarmJournalTaskResult[];
  completed: boolean;
  completedTaskIds: string[];
  failedTaskIds: string[];
  output?: string;
}

/**
 * 从 session 事件流读出最近一轮蜂群断点：
 * - 只认 `swarm_round_journal`；
 * - 遇到新的 round_started 就切到新轮（最近断点）；
 * - task_result 按 taskId 覆盖（同一任务失败后补写终态时取最新）；
 * - 指定 roundId 时只回放该轮。
 */
export function readSwarmRoundCheckpoint(
  events: readonly SessionEvent[],
  options: { roundId?: string } = {},
): SwarmRoundCheckpoint | null {
  let current: MutableSwarmRoundCheckpoint | null = null;
  for (const event of events) {
    if (event.type !== SessionEventType.SwarmRoundJournal) continue;
    const payload = event.payload as SwarmRoundJournalPayload | null;
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.roundId !== "string" ||
      !payload.roundId
    ) {
      continue;
    }
    if (options.roundId !== undefined && payload.roundId !== options.roundId) continue;

    if (payload.phase === "round_started") {
      current = {
        roundId: payload.roundId,
        objective: typeof payload.objective === "string" ? payload.objective : "",
        taskIds: [],
        taskDescriptions: [],
        results: [],
        completed: false,
        completedTaskIds: [],
        failedTaskIds: [],
      };
      continue;
    }
    if (!current || current.roundId !== payload.roundId) {
      current = {
        roundId: payload.roundId,
        objective: "",
        taskIds: [],
        taskDescriptions: [],
        results: [],
        completed: false,
        completedTaskIds: [],
        failedTaskIds: [],
      };
    }

    switch (payload.phase) {
      case "decomposed":
        current.taskIds = payload.taskIds === undefined ? [] : [...payload.taskIds];
        current.taskDescriptions =
          payload.taskDescriptions === undefined ? [] : [...payload.taskDescriptions];
        break;
      case "task_result": {
        const result = payload.result;
        if (!result || typeof result.taskId !== "string" || !result.taskId) break;
        const existing = current.results.findIndex((item) => item.taskId === result.taskId);
        if (existing === -1) current.results.push(result);
        else current.results[existing] = result;
        break;
      }
      case "round_completed":
        current.completed = true;
        current.completedTaskIds =
          payload.completedTaskIds === undefined ? [] : [...payload.completedTaskIds];
        current.failedTaskIds =
          payload.failedTaskIds === undefined ? [] : [...payload.failedTaskIds];
        if (typeof payload.output === "string") current.output = payload.output;
        break;
    }
  }
  if (!current) return null;
  return {
    roundId: current.roundId,
    objective: current.objective,
    taskIds: current.taskIds,
    taskDescriptions: current.taskDescriptions,
    results: current.results,
    completed: current.completed,
    completedTaskIds: current.completedTaskIds,
    failedTaskIds: current.failedTaskIds,
    ...(current.output === undefined ? {} : { output: current.output }),
  };
}

/** 从 runtime 的持久化事件 store 读最近蜂群断点；崩溃恢复的入口。 */
export async function readLatestSwarmRoundCheckpoint(
  runtime: AgentRuntimeInternal,
  options: { roundId?: string } = {},
): Promise<SwarmRoundCheckpoint | null> {
  const events = await runtime.eventStore.getEvents(runtime.sessionId);
  return readSwarmRoundCheckpoint(events, options);
}

export function createSwarmRoundJournalState(): SwarmRoundJournalState {
  return { roundStartedWritten: false, roundCompletedWritten: false, journalWarnings: [] };
}

/** 把最近中断轮的 roundId 与已完成 taskId/描述拼进分解提示，并明确要求不重复。 */
export function formatSwarmResumeContext(checkpoint: SwarmRoundCheckpoint): string {
  // 中断轮没有 round_completed，已完成任务只在 task_result(status=done) 里；
  // completedTaskIds 仅在正常收口时才有值，这里合并两个来源。
  const completedIds = new Set(checkpoint.completedTaskIds);
  for (const result of checkpoint.results) {
    if (result.status === "done") completedIds.add(result.taskId);
  }
  const orderedTaskIds = [
    ...checkpoint.taskIds.filter((taskId) => completedIds.has(taskId)),
    ...[...completedIds].filter((taskId) => !checkpoint.taskIds.includes(taskId)),
  ];
  const completedLines = orderedTaskIds.map((taskId) => {
    const index = checkpoint.taskIds.indexOf(taskId);
    const description = index === -1 ? undefined : checkpoint.taskDescriptions[index];
    return description === undefined ? `- ${taskId}` : `- ${taskId}: ${description}`;
  });
  return [
    `A previous swarm round (${checkpoint.roundId}) for this objective was interrupted before it completed.`,
    completedLines.length === 0
      ? "No subtask had completed before the interruption."
      : [
          "These subtasks already completed; do not schedule them again or duplicate their work:",
          ...completedLines,
        ].join("\n"),
    "Decompose only the remaining work of the objective.",
  ].join("\n");
}

export function toJournalTaskResult(result: SwarmTaskResult): SwarmJournalTaskResult {
  switch (result.status) {
    case "completed": {
      const output = truncateSwarmWorkerOutput(swarmTaskCompletedText(result));
      return output
        ? { taskId: result.taskId, status: "done", output }
        : { taskId: result.taskId, status: "failed", error: "produced no text output" };
    }
    case "failed":
      return { taskId: result.taskId, status: "failed", error: result.error };
    case "cancelled":
      return {
        taskId: result.taskId,
        status: "cancelled",
        ...(result.reason === undefined ? {} : { error: result.reason }),
      };
  }
}

/**
 * 一轮 journal 的写入面：所有方法都不回滚已确定的执行结果，落盘失败只记录告警。
 * round_completed 用轮级 trace；task_result 由调用方带 worker 的 child trace。
 */
export class SwarmJournalWriter {
  constructor(
    private readonly runtime: AgentRuntimeInternal,
    private readonly trace: TraceContext,
  ) {}

  async append(payload: SwarmRoundJournalPayload, traceContext: TraceContext): Promise<void> {
    const event = this.runtime.createEvent(
      SessionEventType.SwarmRoundJournal,
      payload,
      traceContext,
    );
    await this.runtime.appendEvent(event, traceContext);
  }

  /**
   * 写本轮唯一的 round_completed。本轮局部标志先置位再落盘：即使写入失败也只
   * 记 warning（产出不撤销），catch 路径不会重试造成重复事件。
   */
  async writeRoundCompleted(
    completed: {
      roundId: string;
      completedTaskIds: readonly string[];
      failedTaskIds: readonly string[];
      output?: string;
      error?: string;
    },
    journalState: SwarmRoundJournalState,
  ): Promise<void> {
    if (journalState.roundCompletedWritten) return;
    journalState.roundCompletedWritten = true;
    try {
      await this.append(
        {
          phase: "round_completed",
          roundId: completed.roundId,
          completedTaskIds: completed.completedTaskIds,
          failedTaskIds: completed.failedTaskIds,
          ...(completed.output === undefined ? {} : { output: completed.output }),
          ...(completed.error === undefined ? {} : { error: completed.error }),
        },
        this.trace,
      );
    } catch (error) {
      this.recordWarning(
        `Swarm journal round_completed append failed for round ${completed.roundId}: ${errorMessage(error)}`,
        "round_completed",
        journalState,
        completed.roundId,
        error,
      );
    }
  }

  async appendSafe(
    payload: SwarmRoundJournalPayload,
    traceContext: TraceContext,
    journalState: SwarmRoundJournalState,
  ): Promise<void> {
    try {
      await this.append(payload, traceContext);
    } catch (error) {
      const taskSuffix = payload.result === undefined ? "" : ` for task ${payload.result.taskId}`;
      this.recordWarning(
        `Swarm journal ${payload.phase} append failed${taskSuffix}: ${errorMessage(error)}`,
        payload.phase,
        journalState,
        payload.roundId,
        error,
      );
    }
  }

  /** journal 失败只进入本轮告警清单 + 日志；绝不据此反转已确定的执行结果。 */
  private recordWarning(
    warning: string,
    phase: SwarmRoundJournalPayload["phase"],
    journalState: SwarmRoundJournalState,
    roundId: string,
    error: unknown,
  ): void {
    journalState.journalWarnings.push(warning);
    this.runtime.logger?.warn("Swarm journal append failed", {
      ...traceContextToLogContext(this.trace),
      event: "target.swarm.journal_append_failed",
      module: "core.runtime",
      status: "failed",
      roundId,
      phase,
      errorMessage: errorMessage(error),
    });
  }
}
