// ============================================================
// Swarm Worker - 单个子任务的执行边界
// ============================================================
// swarm 编排把一批子任务分给多个 worker；每个 worker 只执行一个子任务。执行本身
// 走既有的 agent/task 基础设施 SubagentPort（runtime/methods/subagent.ts 的生产
// 实现在 subagent/runner.ts），本层只负责：
//   1. 把 SwarmTask 映射成 SubagentRunRequest；
//   2. 把 AgentOutput / 抛出的错误归一成 swarm 侧可收集的终态结果；
//   3. async_launched 时用 waitForTask 收集后台子代理的真实终态；回合取消时
//      stopTask 停掉后台执行，绝不让子代理继续在后台写而蜂群层丢失结果；
//   4. 取消由调用方 signal 权威判定（预取消不 spawn，执行中取消记 cancelled）。
// 不做 fallback：执行错误原样进入 failed 结果（cause 保留原始错误对象），不吞异常。
// SwarmTask / SwarmTaskResult 统一在 swarm-types.ts 定义，这里只引用。

import type {
  AgentBackgroundedOutput,
  AgentCompletedOutput,
  AgentOutput,
  Model,
  SubagentFailedUsage,
  SubagentPort,
  SubagentRunOptions,
  SubagentRunRequest,
  SubagentTaskSnapshot,
} from "@zcode/contracts";
import { extractSubagentFailedUsage } from "../../subagent/runner.js";
import type {
  SwarmTask,
  SwarmTaskCancelledResult,
  SwarmTaskCompletedResult,
  SwarmTaskFailedResult,
  SwarmTaskResult,
} from "./swarm-types.js";

/** 执行单个子任务：真实跑子代理并返回归一化终态结果。 */
export class SwarmWorker {
  constructor(private readonly subagentPort: SubagentPort) {}

  /**
   * 执行单个子任务。signal 是取消的权威方：预取消不 spawn，执行中 abort 记 cancelled。
   * 信号由编排层按回合作用域传入，任务对象本身不携带取消状态。
   * model/modelOverride 来自调用方 Agent Loop：原样透传给 SubagentPort.run，让 child
   * 继承父会话的模型事实（AgentSwarm 前台并发即走这条）。
   */
  async execute(
    task: SwarmTask,
    options?: {
      signal?: AbortSignal;
      model?: Model;
      modelOverride?: SubagentRunOptions["modelOverride"];
    },
  ): Promise<SwarmTaskResult> {
    if (!task.taskId) {
      throw new Error("Swarm task requires a non-empty taskId");
    }
    if (!task.prompt) {
      throw new Error(`Swarm task ${task.taskId} requires a non-empty prompt`);
    }

    const { signal, model, modelOverride } = options ?? {};
    const startedAt = Date.now();
    if (signal?.aborted) {
      return createCancelledResult(task, startedAt, signal.reason);
    }

    // 三个字段都不在场时不传 options，保持既有调用方的 SubagentPort.run 签名字节不变。
    const runOptions: SubagentRunOptions | undefined =
      signal === undefined && model === undefined && modelOverride === undefined
        ? undefined
        : {
            ...(signal === undefined ? {} : { signal }),
            ...(model === undefined ? {} : { model }),
            ...(modelOverride === undefined ? {} : { modelOverride }),
          };

    let output: AgentOutput;
    try {
      output = await this.subagentPort.run(toSubagentRunRequest(task), runOptions);
    } catch (error) {
      // signal 是取消的权威方：abort 导致的拒绝一律记 cancelled，其余原样记 failed。
      // 失败前已发生的模型调用只存在于错误对象（含 cause 链）的 usage 上；原样提取，
      // 不臆造 token。
      if (signal?.aborted) {
        return createCancelledResult(task, startedAt, signal.reason, extractSubagentFailedUsage(error));
      }
      return {
        status: "failed",
        taskId: task.taskId,
        agentType: task.agentType,
        description: task.description,
        error: error instanceof Error ? error.message : String(error),
        cause: error,
        totalDurationMs: Date.now() - startedAt,
        ...extractSubagentFailedUsage(error),
      };
    }

    if (output.status === "async_launched") {
      return await this.collectBackgroundedTask(task, output, startedAt, signal);
    }
    return toCompletedResult(task, output);
  }

  /**
   * 后台化子代理的终态收集：
   * - 正常路径 waitForTask 等到终态，把 snapshot.output 归一成 completed；
   * - 回合 abort 时 waitForTask 会拒绝，此时 stopTask 让后台执行真正停下，再记 cancelled；
   * - 端口没有 waitForTask 时不能用 backgrounded 结果把执行面丢给调用方——优先
   *   stopTask 收口成 cancelled；两个方法都缺席则 failed（明确要求端口补齐）。
   */
  private async collectBackgroundedTask(
    task: SwarmTask,
    output: AgentBackgroundedOutput,
    startedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<SwarmTaskResult> {
    const waitForTask = this.subagentPort.waitForTask?.bind(this.subagentPort);

    if (waitForTask === undefined) {
      if (this.subagentPort.stopTask !== undefined) {
        try {
          // 运行时因回合 abort 停止后台子代理，不是用户显式操作；不带 initiator。
          await this.subagentPort.stopTask(output.backgroundTaskId);
        } catch (error) {
          return createFailedResult(
            task,
            `SubagentPort.stopTask failed for backgrounded task ${task.taskId}: ${errorMessage(error)}`,
            error,
            startedAt,
            extractSubagentFailedUsage(error),
          );
        }
        return createCancelledResult(
          task,
          startedAt,
          new Error(
            "SubagentPort.waitForTask is unavailable; the backgrounded worker was stopped instead of losing its result",
          ),
        );
      }
      return createFailedResult(
        task,
        "SubagentPort.waitForTask or stopTask is required to collect a backgrounded swarm worker",
        undefined,
        startedAt,
      );
    }

    let snapshot: SubagentTaskSnapshot | undefined;
    try {
      snapshot = await waitForTask(
        output.backgroundTaskId,
        signal === undefined ? undefined : { signal },
      );
    } catch (error) {
      if (signal?.aborted) {
        const stopError = await this.stopBackgroundedTask(output.backgroundTaskId);
        if (stopError !== undefined) {
          return createFailedResult(
            task,
            `Swarm round aborted but SubagentPort.stopTask failed for ${task.taskId}: ${errorMessage(stopError)}`,
            stopError,
            startedAt,
            extractSubagentFailedUsage(stopError),
          );
        }
        return createCancelledResult(
          task,
          startedAt,
          signal.reason ?? error,
          extractSubagentFailedUsage(error),
        );
      }
      return createFailedResult(
        task,
        `SubagentPort.waitForTask failed for backgrounded task ${task.taskId}: ${errorMessage(error)}`,
        error,
        startedAt,
        extractSubagentFailedUsage(error),
      );
    }

    if (snapshot === undefined) {
      return createFailedResult(
        task,
        `Backgrounded swarm worker ${task.taskId} was lost: waitForTask returned no snapshot`,
        undefined,
        startedAt,
      );
    }

    switch (snapshot.status) {
      case "completed": {
        const completed = snapshot.output;
        if (!completed || completed.status !== "completed") {
          return createFailedResult(
            task,
            `Backgrounded swarm worker ${task.taskId} completed without a deliverable`,
            undefined,
            startedAt,
          );
        }
        return toCompletedResult(task, completed, Date.now() - startedAt);
      }
      case "failed":
      case "lost":
        return createFailedResult(
          task,
          snapshot.error ?? `Backgrounded swarm worker ${task.taskId} ended with status ${snapshot.status}`,
          snapshot.error === undefined ? undefined : new Error(snapshot.error),
          startedAt,
          // 失败前已发生的用量由 runner 写进 snapshot.usage；只取模型明细与汇总 token，
          // 不把整个 usage 快照当成 ModelUsage 交给预算记账。
          {
            ...(snapshot.usage?.modelUsage === undefined
              ? {}
              : { usage: snapshot.usage.modelUsage }),
            ...(snapshot.usage?.totalTokens === undefined
              ? {}
              : { totalTokens: snapshot.usage.totalTokens }),
          },
        );
      case "cancelled":
      case "killed":
      case "stopped":
        return createCancelledResult(
          task,
          startedAt,
          snapshot.error ?? `backgrounded worker ended with status ${snapshot.status}`,
          {
            ...(snapshot.usage?.modelUsage === undefined
              ? {}
              : { usage: snapshot.usage.modelUsage }),
            ...(snapshot.usage?.totalTokens === undefined
              ? {}
              : { totalTokens: snapshot.usage.totalTokens }),
          },
        );
      case "running":
        return createFailedResult(
          task,
          `SubagentPort.waitForTask returned non-terminal status running for ${task.taskId}`,
          undefined,
          startedAt,
        );
    }
  }

  /** abort 收口：停掉后台子代理；成功返回 undefined，失败把原始错误交给调用方。 */
  private async stopBackgroundedTask(taskId: string): Promise<unknown | undefined> {
    const stopTask = this.subagentPort.stopTask?.bind(this.subagentPort);
    if (stopTask === undefined) {
      return new Error(
        "SubagentPort.stopTask is unavailable; the backgrounded worker could not be stopped after abort",
      );
    }
    try {
      // abort 收口不是用户显式 Stop，不传 initiator。
      await stopTask(taskId);
      return undefined;
    } catch (error) {
      return error;
    }
  }
}

function toSubagentRunRequest(task: SwarmTask): SubagentRunRequest {
  return {
    sessionId: task.sessionId,
    ...(task.turnId === undefined ? {} : { turnId: task.turnId }),
    parentToolCallId: task.parentToolCallId,
    agentType: task.agentType,
    description: task.description,
    prompt: task.prompt,
    ...(task.callerCanReadOutputFile === undefined
      ? {}
      : { callerCanReadOutputFile: task.callerCanReadOutputFile }),
    workingDirectory: task.workingDirectory,
    workspaceRoot: task.workspaceRoot,
    // 隔离工作树是整棵树的边界：worker 的文件工具与显式 cwd 只能落在这里，回写只走 merge。
    // 边界只由编排层显式写入；缺席即共享调用方 workspace（AgentSwarm 走这条），
    // 不得回退 workspaceRoot——那会把普通会话误变成路径狱。
    ...(task.workspaceBoundary === undefined ? {} : { workspaceBoundary: task.workspaceBoundary }),
    trace: task.trace,
  };
}

function toCompletedResult(
  task: SwarmTask,
  output: AgentCompletedOutput,
  totalDurationMs: number = output.totalDurationMs,
): SwarmTaskCompletedResult {
  return {
    status: "completed",
    taskId: task.taskId,
    agentId: output.agentId,
    agentType: output.agentType,
    description: output.description,
    content: output.content,
    totalToolUseCount: output.totalToolUseCount,
    totalDurationMs,
    ...(output.totalTokens === undefined ? {} : { totalTokens: output.totalTokens }),
    ...(output.usage === undefined ? {} : { usage: output.usage }),
  };
}

function createFailedResult(
  task: SwarmTask,
  error: string,
  cause: unknown,
  startedAt: number,
  failedUsage: SubagentFailedUsage = {},
): SwarmTaskFailedResult {
  return {
    status: "failed",
    taskId: task.taskId,
    agentType: task.agentType,
    description: task.description,
    error,
    ...(cause === undefined ? {} : { cause }),
    totalDurationMs: Date.now() - startedAt,
    ...failedUsage,
  };
}

function createCancelledResult(
  task: SwarmTask,
  startedAt: number,
  reason: unknown,
  failedUsage: SubagentFailedUsage = {},
): SwarmTaskCancelledResult {
  return {
    status: "cancelled",
    taskId: task.taskId,
    agentType: task.agentType,
    description: task.description,
    ...(reason === undefined
      ? {}
      : { reason: reason instanceof Error ? reason.message : String(reason) }),
    totalDurationMs: Date.now() - startedAt,
    ...failedUsage,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
