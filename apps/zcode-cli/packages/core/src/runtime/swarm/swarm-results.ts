/**
 * 蜂群任务结果的确定性校验与终态构造。
 *
 * 这些 helper 不依赖编排实例：批次校验、失败结果与 completed→cancelled 收口在
 * 轮生命周期、worker 边界与 journal 之间共用同一口径（usage 原样保留，不估算）。
 */

import type { ModelUsage } from "@zcode/contracts";

import type {
  SwarmTask,
  SwarmTaskCancelledResult,
  SwarmTaskCompletedResult,
  SwarmTaskFailedResult,
} from "./swarm-types.js";

/** 批次校验：空批次、空/重复 taskId、空 prompt、缺基准目录都是调用方的确定性错误。 */
export function validateSwarmTasks(tasks: readonly SwarmTask[]): void {
  if (tasks.length === 0) {
    throw new Error("Swarm execution requires at least one task");
  }
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task.taskId) {
      throw new Error("Swarm task requires a non-empty taskId");
    }
    if (seen.has(task.taskId)) {
      throw new Error(`Swarm task id ${task.taskId} is not unique`);
    }
    seen.add(task.taskId);
    if (!task.prompt) {
      throw new Error(`Swarm task ${task.taskId} requires a non-empty prompt`);
    }
    if (!task.workingDirectory) {
      throw new Error(`Swarm task ${task.taskId} requires a non-empty workingDirectory`);
    }
    if (!task.workspaceRoot) {
      throw new Error(`Swarm task ${task.taskId} requires a non-empty workspaceRoot`);
    }
  }
}

export function createFailedResult(
  task: SwarmTask,
  error: string,
  cause: unknown,
  totalDurationMs: number,
  failedUsage: { usage?: ModelUsage; totalTokens?: number } = {},
): SwarmTaskFailedResult {
  return {
    status: "failed",
    taskId: task.taskId,
    agentType: task.agentType,
    description: task.description,
    error,
    cause,
    totalDurationMs,
    ...failedUsage,
  };
}

/** completed → cancelled 收口；已发生的 usage 原样保留，供本轮预算继续记账。 */
export function cancelCompletedResult(
  result: SwarmTaskCompletedResult,
  reason: string,
): SwarmTaskCancelledResult {
  return {
    status: "cancelled",
    taskId: result.taskId,
    agentType: result.agentType,
    description: result.description,
    reason,
    totalDurationMs: result.totalDurationMs,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.totalTokens === undefined ? {} : { totalTokens: result.totalTokens }),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
