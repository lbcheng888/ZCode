/**
 * Swarm 目标编排：模型把目标分解为 2-5 个可并行子任务，每个子任务交给真实子代理执行。
 * 断点续跑只剩 1 个未完成任务时允许只产出 1 个。
 *
 * 语义（确定性、无降级）：
 * - 分解：一次辅助模型调用，JSON schema 约束返回 tasks[].description；解析前先处理
 *   finishReason=length 截断与 ```json 围栏，解析后严格校验任务数（初始轮 2-5，
 *   断点续跑 1-5），任何结构不符都抛错，不修补、不截断、不补造任务。
 * - 执行：每个子任务经 SubagentPort.run 进入生产子代理链路（subagent/runner.ts 的
 *   child AgentRuntime，带完整工具集），返回真实执行结果与工具调用计数；全部经
 *   Promise.all 并发发出，子任务状态在传入对象上原位迁移 pending → running →
 *   done/failed/cancelled。裸模型文本不再是执行证据。
 * - 隔离：每个 worker 在独立 git worktree 中执行（GitWorktreeSwarmWorkspaceFactory
 *   用 `git worktree add --detach` 创建），不并发写同一 workingDirectory；完成后经
 *   合并闸门回写：先 `git merge-tree --write-tree` 预检冲突，干净才 merge，冲突的
 *   那个 worker 记为 failed，其余照常完成。
 * - 后台化：SubagentPort.run 返回 async_launched 时由 worker 立即 waitForTask 收集
 *   终态；回合取消时 stopTask 停掉后台子代理，绝不把“还在后台写”的子任务当成本轮
 *   结果丢失。
 * - 失败：单个 worker 失败不抹掉整批——聚合器返回部分成功产出与失败清单，只有
 *   全部未完成才抛错（全部 cancelled 抛 SwarmRoundCancelledError，调用方按取消
 *   收口；其余按失败 pause 目标）。空文本产出不算完成。
 * - journal：轮开始/分解结果/每个 worker 终态/轮完成写入 session event
 *   `swarm_round_journal`；崩溃后 readLatestSwarmRoundCheckpoint 按最近 roundId
 *   重建断点，已完成 worker 的结果可直接复用。
 * - 取消：分解请求与全部子任务共用 scope.signal；Stop 后 1+N 个在途请求立即取消。
 * - 轮收口：round_started 之后无论成功、失败、取消、异常都恰好写一次 round_completed；
 *   每份 workspace.merge() 之前都过 mergeGate（通过后还要复核基准树干净）。中途拒绝时
 *   已回写的前序结果保留（它们过闸时已通过 CAS），剩余 completed 改 cancelled、工作树
 *   清理，并按取消抛 SwarmRoundSupersededError。
 * - 预算：分解是编排层唯一的直接模型调用，调用后写 usage fact 纳入 token/时间预算；
 *   子任务的模型调用由各自 child runtime 记入自己会话的 usage，本层从终态结果与
 *   失败错误对象读取 usage/totalTokens 汇总，不估算、不重复记账。
 */

import type { ModelResult, TraceContext } from "@zcode/contracts";
import {
  AgentType,
  createChildTraceContext,
  createToolCallId,
} from "@zcode/contracts";

import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import {
  SWARM_MIN_TASKS,
  createSwarmDecompositionResponseSchema,
  createSwarmDecompositionSystemPrompt,
  parseDecompositionResponse,
} from "./swarm-decomposition.js";
import {
  swarmTaskCompletedText,
  truncateSwarmWorkerOutput,
  truncateTo,
} from "./swarm-evidence.js";
import {
  SWARM_JOURNAL_OUTPUT_MAX_CHARS,
  SwarmJournalWriter,
  createSwarmRoundJournalState,
  formatSwarmResumeContext,
  readLatestSwarmRoundCheckpoint,
  toJournalTaskResult,
} from "./swarm-journal.js";
import {
  cancelCompletedResult,
  createFailedResult,
  errorMessage,
  validateSwarmTasks,
} from "./swarm-results.js";
import type {
  PreparedSwarmTask,
  SwarmExecutionScope,
  SwarmMergeGateVerdict,
  SwarmOrchestratorDeps,
  SwarmRoundCheckpoint,
  SwarmRoundEvidence,
  SwarmRoundJournalState,
  SwarmRoundOptions,
  SwarmRoundUsage,
  SwarmRunOptions,
  SwarmTask,
  SwarmTaskResult,
  SwarmWorkspaceFactory,
} from "./swarm-types.js";
import {
  SwarmRoundSupersededError,
  createSwarmRoundId,
} from "./swarm-types.js";
import {
  GitWorktreeSwarmWorkspaceFactory,
  assertSwarmBaseClean,
  assertSwarmGitPreconditions,
  recoverOrphanedSwarmWorktrees,
} from "./swarm-worktree.js";
import { SwarmAggregator } from "./swarm-aggregator.js";
import {
  CoreErrorType,
  createCoreError,
  getModelUsageTotalTokens,
  traceContextToLogContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeModel } from "../methods/runtime-model.js";
import { recordModelUsageFact } from "../methods/usage-observability.js";
import { SwarmWorker } from "./swarm-worker.js";

export * from "./swarm-types.js";
export {
  readLatestSwarmRoundCheckpoint,
  readSwarmRoundCheckpoint,
} from "./swarm-journal.js";
export {
  SWARM_MAX_TASKS,
  SWARM_MIN_TASKS,
  parseDecompositionResponse,
} from "./swarm-decomposition.js";
export { formatSwarmRoundEvidence, swarmTaskCompletedText } from "./swarm-evidence.js";
export {
  GitWorktreeSwarmWorkspaceFactory,
  assertSwarmBaseClean,
  assertSwarmGitPreconditions,
  recoverOrphanedSwarmWorktrees,
  type SwarmGitPreconditions,
  type SwarmOrphanRecovery,
} from "./swarm-worktree.js";
export { SwarmRoundCancelledError } from "./swarm-aggregator.js";

const SWARM_DECOMPOSITION_QUERY_SOURCE = "goal_swarm_decomposition";

export class SwarmOrchestrator {
  private readonly worker: SwarmWorker;
  private readonly agentType: string;
  private readonly workspaceFactory: SwarmWorkspaceFactory;
  private readonly journal: SwarmJournalWriter;

  constructor(private readonly deps: SwarmOrchestratorDeps) {
    this.worker = new SwarmWorker(deps.subagentPort);
    this.agentType = deps.scope.agentType ?? AgentType.GeneralPurpose;
    this.workspaceFactory = deps.workspaceFactory ?? new GitWorktreeSwarmWorkspaceFactory();
    this.journal = new SwarmJournalWriter(deps.runtime, deps.scope.trace);
  }

  /**
   * 从 runtime 组装一轮 goal 蜂群：模型、真实子代理执行面与回合作用域。
   * 没有 SubagentPort 时绝不回落到裸模型自述，直接响亮失败。
   */
  static forGoalRound(
    runtime: AgentRuntimeInternal,
    scope: SwarmExecutionScope,
  ): SwarmOrchestrator {
    if (!runtime.subagentPort) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "Goal swarm execution requires SubagentPort (full-toolset subagent loop)",
        { recoverable: false },
      );
    }
    return new SwarmOrchestrator({
      model: createRuntimeModel(runtime, { selection: runtime.getSessionModelSelection() }),
      runtime,
      subagentPort: runtime.subagentPort,
      scope,
    });
  }

  /**
   * 目标分解：一次辅助模型调用，按 JSON schema 取回 tasks[].description。
   * 请求携带 scope.signal，Stop 后立即取消；无论成败都写 usage fact。
   * 分解前写 round_started、成功后写 decomposed journal；截断（finishReason=length）
   * 的响应整份拒绝，绝不拿半份任务清单开工。
   */
  async decomposeGoal(
    objective: string,
    decomposeOptions: SwarmRoundOptions = {},
  ): Promise<SwarmTask[]> {
    const trimmed = objective.trim();
    if (!trimmed) throw new Error("Swarm decomposition requires a non-empty objective");
    const roundId = decomposeOptions.roundId ?? createSwarmRoundId();
    if (!roundId.trim()) throw new Error("Swarm round id must be a non-empty string");
    const nextAction = decomposeOptions.nextAction?.trim();
    // 断点续跑可能只剩 1 个未完成任务：此时 schema/系统提示/解析下限都必须降为 1。
    // 初始轮仍要求 ≥ 2，避免把单任务目标伪装成并行蜂群。
    const minTasks = decomposeOptions.resumeCheckpoint === undefined ? SWARM_MIN_TASKS : 1;

    await this.journal.append(
      { phase: "round_started", roundId, objective: trimmed },
      this.deps.scope.trace,
    );
    if (decomposeOptions.journalState) {
      decomposeOptions.journalState.roundStartedWritten = true;
    }

    const startedAt = Date.now();
    const traceContext = createChildTraceContext(this.deps.scope.trace, {
      sessionId: this.deps.runtime.sessionId,
      attributes: { querySource: SWARM_DECOMPOSITION_QUERY_SOURCE },
    });
    const { signal } = this.deps.scope;

    let response: ModelResult;
    try {
      response = await this.deps.model.generateText({
        messages: [
          { role: "system", content: createSwarmDecompositionSystemPrompt(minTasks) },
          { role: "user", content: trimmed },
          ...(nextAction
            ? [
                {
                  role: "user" as const,
                  content: `The completion verifier's next action for this round; prioritize it when decomposing: ${nextAction}`,
                },
              ]
            : []),
          ...(decomposeOptions.resumeCheckpoint
            ? [
                {
                  role: "user" as const,
                  content: formatSwarmResumeContext(decomposeOptions.resumeCheckpoint),
                },
              ]
            : []),
        ],
        // 分解与 memory selector 同属辅助调用：最低推理档 + 受限输出预算。
        options: auxiliaryModelOptions(this.deps.model),
        responseJsonSchema: createSwarmDecompositionResponseSchema(minTasks),
        ...(signal === undefined ? {} : { abortSignal: signal }),
      });
    } catch (error) {
      await this.recordUsage({ error, startedAt, status: "error", traceContext });
      throw error;
    }
    await this.recordUsage({ result: response, startedAt, status: "completed", traceContext });
    // H2：分解也是目标的真实模型开销；在解析前记账，坏 JSON 也不丢这次调用。
    if (decomposeOptions.usage) {
      decomposeOptions.usage.tokensUsed += Math.max(0, getModelUsageTotalTokens(response.usage));
    }

    const descriptions = parseDecompositionResponse(response.text, response.finishReason, minTasks);
    const tasks = descriptions.map((description, index) =>
      this.createTask(description, index, roundId),
    );
    await this.journal.append(
      {
        phase: "decomposed",
        roundId,
        taskIds: tasks.map((task) => task.taskId),
        taskDescriptions: descriptions,
      },
      this.deps.scope.trace,
    );
    return tasks;
  }

  /**
   * 并行执行：每个子任务先获得独立工作树，再由 SwarmWorker 拉起真实子代理，
   * Promise.all 聚合结果（保持输入顺序）。单个任务失败/建树失败只影响自己，
   * 其余任务照常完成；全部结果返回后按输入顺序走合并闸门。
   */
  async runSwarm(
    tasks: readonly SwarmTask[],
    runOptions: SwarmRunOptions = {},
  ): Promise<SwarmTaskResult[]> {
    validateSwarmTasks(tasks);
    const roundId = runOptions.roundId ?? createSwarmRoundId();
    const prepared = await this.prepareTaskWorkspaces(tasks, roundId);
    const results = await Promise.all(
      prepared.map((entry) => this.executePreparedTask(entry)),
    );
    await this.finalizeTaskResults(prepared, results, roundId, runOptions);
    return results;
  }

  /**
   * 跑完一整轮目标蜂群：分解 → 并行执行 → 逐份截断 → 聚合。
   * 聚合器只在全部子任务未交付时抛错；部分成功会带着失败清单返回证据，
   * 一次 worker/provider 失败不会让长程 goal 停摆。用户 Stop 则在返回前
   * 按取消语义抛出，避免已停止的目标再跑一次真实回合。
   */
  async runGoalRound(
    objective: string,
    options: SwarmRoundOptions = {},
  ): Promise<SwarmRoundEvidence> {
    const startedAt = Date.now();
    try {
      return await this.runGoalRoundInner(objective, options);
    } finally {
      // H2：成功/失败/取消都要把本轮墙钟开销交给 target 预算，不能被异常吞掉。
      if (options.usage) {
        options.usage.elapsedMs += Math.max(0, Date.now() - startedAt);
      }
    }
  }

  private async runGoalRoundInner(
    objective: string,
    options: SwarmRoundOptions,
  ): Promise<SwarmRoundEvidence> {
    const roundId = options.roundId ?? createSwarmRoundId();
    const journalState = createSwarmRoundJournalState();
    let results: SwarmTaskResult[] | undefined;
    try {
      // 启动期 fail-closed：没有仓库 / 无提交 / 脏基准树都不允许分出一轮蜂群。
      const repoRoot = await assertSwarmGitPreconditions({
        baseWorkingDirectory: this.deps.runtime.workingDirectory,
        baseWorkspaceRoot: this.deps.runtime.workspaceRoot,
      });
      await this.recoverOrphanedWorktrees(repoRoot);
      const resumeCheckpoint = await this.readResumeCheckpoint(objective);
      const tasks = await this.decomposeGoal(objective, {
        ...options,
        roundId,
        journalState,
        ...(resumeCheckpoint === undefined ? {} : { resumeCheckpoint }),
      });
      results = await this.runSwarm(tasks, {
        roundId,
        ...(options.mergeGate === undefined ? {} : { mergeGate: options.mergeGate }),
        ...(options.usage === undefined ? {} : { usage: options.usage }),
        journalState,
      });

      // H2：本轮全部终态（completed / failed / cancelled）的真实 token 都进入同一
      // 记账槽；失败/取消任务从错误对象提取到的 usage 同样计入，不能只记 completed。
      if (options.usage) {
        for (const result of results) {
          options.usage.tokensUsed += Math.max(
            0,
            result.totalTokens ?? getModelUsageTotalTokens(result.usage),
          );
        }
      }

      const signal = this.deps.scope.signal;
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Swarm round aborted");
      }

      const aggregation = await new SwarmAggregator().aggregate(
        results.map((result) =>
          result.status === "completed"
            ? {
                ...result,
                // 每份正文进入聚合并前按上下文预算截断；非 completed 结果原样交给聚合器裁决。
                content: [
                  {
                    type: "text" as const,
                    text: truncateSwarmWorkerOutput(swarmTaskCompletedText(result)),
                  },
                ],
              }
            : result,
        ),
      );
      const failedTaskIds = aggregation.failures.map((failure) => failure.taskId);
      await this.journal.writeRoundCompleted(
        {
          roundId,
          completedTaskIds: aggregation.completedTaskIds,
          failedTaskIds,
          output: truncateTo(aggregation.output, SWARM_JOURNAL_OUTPUT_MAX_CHARS),
        },
        journalState,
      );
      const evidence: SwarmRoundEvidence = {
        output: aggregation.output,
        taskDescriptions: tasks.map((task) => task.description),
        completedTaskIds: aggregation.completedTaskIds,
        failures: aggregation.failures,
        ...(journalState.journalWarnings.length === 0
          ? {}
          : { journalWarnings: [...journalState.journalWarnings] }),
      };
      this.deps.runtime.logger?.info("Goal swarm round completed", {
        ...traceContextToLogContext(this.deps.scope.trace),
        event: "target.swarm.round_completed",
        module: "core.runtime",
        status: "completed",
        roundId,
        taskCount: tasks.length,
        completedTaskCount: aggregation.completedTaskIds.length,
        failedTaskCount: failedTaskIds.length,
      });
      return evidence;
    } catch (error) {
      // round_started 之后无论成功、失败、取消、异常都恰好写一次 round_completed；
      // 闸门拒绝路径已在 finalize 写过，由本轮局部标志阻止重复。
      if (journalState.roundStartedWritten) {
        const failedTaskIds =
          results === undefined
            ? []
            : results
                .filter((result) => result.status !== "completed")
                .map((result) => result.taskId);
        await this.journal.writeRoundCompleted(
          {
            roundId,
            completedTaskIds: [],
            failedTaskIds,
            error: errorMessage(error),
          },
          journalState,
        );
      }
      throw error;
    }
  }

  /** 串行建树：git worktree add 会写 .git/worktrees 元数据，并发建树只会互相抢锁。 */
  private async prepareTaskWorkspaces(
    tasks: readonly SwarmTask[],
    roundId: string,
  ): Promise<PreparedSwarmTask[]> {
    const signal = this.deps.scope.signal;
    const prepared: PreparedSwarmTask[] = [];
    for (const task of tasks) {
      // 已取消的回合不建树、不落盘：worker 会直接返回 cancelled。
      if (signal?.aborted) {
        prepared.push({ task });
        continue;
      }
      const startedAt = Date.now();
      try {
        const workspace = await this.workspaceFactory.create({
          roundId,
          taskId: task.taskId,
          baseWorkingDirectory: task.workingDirectory,
          baseWorkspaceRoot: task.workspaceRoot,
        });
        prepared.push({ task, workspace });
      } catch (error) {
        prepared.push({ task, workspaceError: { error, durationMs: Date.now() - startedAt } });
      }
    }
    return prepared;
  }

  private async executePreparedTask(entry: PreparedSwarmTask): Promise<SwarmTaskResult> {
    const { task, workspace, workspaceError } = entry;
    if (workspaceError) {
      const result = createFailedResult(
        task,
        `Swarm workspace isolation failed for task ${task.taskId}: ${errorMessage(workspaceError.error)}`,
        workspaceError.error,
        workspaceError.durationMs,
      );
      task.status = "failed";
      return result;
    }

    task.status = "running";
    // worker 只看到隔离目录；基准 task 的 workingDirectory 保持调用方原值。
    const isolatedTask: SwarmTask = workspace
      ? {
          ...task,
          workingDirectory: workspace.workingDirectory,
          workspaceRoot: workspace.workspaceRoot,
        }
      : task;
    const signal = this.deps.scope.signal;
    const startedAt = Date.now();
    let result: SwarmTaskResult;
    try {
      const rawResult = await this.worker.execute(
        isolatedTask,
        signal === undefined ? undefined : { signal },
      );
      result = rawResult;
      if (rawResult.status === "completed" && !swarmTaskCompletedText(rawResult)) {
        // 空文本是子代理没有交付物的直接证据；不能记成功，否则完成 verifier 会把
        // “跑完了但什么都没说”当成执行证据。
        const cause = new Error(`Swarm task ${task.taskId} produced no text output`);
        result = createFailedResult(task, cause.message, cause, rawResult.totalDurationMs, {
          ...(rawResult.usage === undefined ? {} : { usage: rawResult.usage }),
          ...(rawResult.totalTokens === undefined ? {} : { totalTokens: rawResult.totalTokens }),
        });
      }
    } catch (error) {
      // worker 边界外的意外抛错（例如端口返回畸形 AgentOutput）也只败自己这一路，
      // 不让 Promise.all 把整批结果一起 reject 掉（M6）。
      result = createFailedResult(
        task,
        `Swarm worker failed for task ${task.taskId}: ${errorMessage(error)}`,
        error,
        Date.now() - startedAt,
      );
    }
    task.status = result.status === "completed" ? "done" : result.status;
    return result;
  }

  /**
   * 合并闸门与 journal 都按输入顺序串行执行：并发 merge 会互相冲突，
   * journal 顺序也必须与任务顺序一致才能让恢复面稳定重放。
   */
  private async finalizeTaskResults(
    prepared: readonly PreparedSwarmTask[],
    results: SwarmTaskResult[],
    roundId: string,
    runOptions: SwarmRunOptions,
  ): Promise<void> {
    const journalState = runOptions.journalState ?? createSwarmRoundJournalState();
    const signal = this.deps.scope.signal;

    // 第一遍只做取消收口：Stop 之后跑完的 completed 结果未获准回写，工作树会被清掉。
    for (let index = 0; index < prepared.length; index += 1) {
      const task = prepared[index]!.task;
      const result = results[index]!;
      if (result.status === "completed" && signal?.aborted) {
        results[index] = cancelCompletedResult(
          result,
          "swarm round aborted before workspace merge",
        );
        task.status = "cancelled";
      }
    }

    for (let index = 0; index < prepared.length; index += 1) {
      const entry = prepared[index]!;
      const task = entry.task;
      let result = results[index]!;

      if (entry.workspace && result.status === "completed") {
        // 串行 merge 期间目标仍可能再次变化：每一份回写之前都重跑闸门与基准树
        // 清洁复核。已合并的前序结果不回滚——它们过闸时已通过 CAS。
        if (runOptions.mergeGate !== undefined) {
          const rejection = await this.evaluateMergeGate(prepared, runOptions.mergeGate);
          if (rejection !== undefined) {
            await this.rejectRemainingResults(
              prepared,
              results,
              index,
              roundId,
              rejection,
              journalState,
              runOptions.usage,
            );
            throw new SwarmRoundSupersededError(
              `Swarm round ${roundId} superseded before workspace merge: ${rejection.reason}`,
              rejection.cause,
            );
          }
        }
        try {
          await entry.workspace.merge();
        } catch (error) {
          // 冲突/回写失败发生在 worker 成功之后；保留已完成调用的 usage 供预算记账。
          result = createFailedResult(
            task,
            `Swarm workspace merge failed for task ${task.taskId}: ${errorMessage(error)}`,
            error,
            result.totalDurationMs,
            {
              ...(result.usage === undefined ? {} : { usage: result.usage }),
              ...(result.totalTokens === undefined ? {} : { totalTokens: result.totalTokens }),
            },
          );
          task.status = "failed";
        }
      }

      const cleanupError = await this.disposePreparedWorkspace(entry, roundId);
      if (cleanupError !== undefined && result.status === "completed") {
        result = { ...result, workspaceCleanupError: cleanupError };
      }

      // journal 落盘失败不撤销已 merge 的产出：结果保持真实终态，只记 warning。
      await this.journal.appendSafe(
        { phase: "task_result", roundId, result: toJournalTaskResult(result) },
        task.trace,
        journalState,
      );
      results[index] = result;
    }
  }

  /** 闸门裁决 + 通过后的基准树清洁复核；返回 undefined 表示允许 merge。 */
  private async evaluateMergeGate(
    prepared: readonly PreparedSwarmTask[],
    mergeGate: () => Promise<SwarmMergeGateVerdict>,
  ): Promise<{ reason: string; cause?: unknown } | undefined> {
    try {
      const verdict = await mergeGate();
      if (!verdict.allowed) return { reason: verdict.reason };
    } catch (error) {
      // 闸门自身抛错时 fail-closed：本轮同样零回写，原始错误挂在 cause 上。
      return { reason: `merge gate failed: ${errorMessage(error)}`, cause: error };
    }
    const baseDirectory = prepared[0]?.task.workingDirectory;
    if (baseDirectory === undefined) {
      return { reason: "merge gate passed but no base working directory is available" };
    }
    try {
      await assertSwarmBaseClean(baseDirectory);
      return undefined;
    } catch (error) {
      return { reason: `base worktree clean check failed: ${errorMessage(error)}`, cause: error };
    }
  }

  /**
   * 中途闸门拒绝收口：从 index 起的未合并结果改 cancelled、未合并工作树 dispose、
   * 逐条 journal、写 round_completed。index 之前的 completed 已回写并清理过，原样保留。
   */
  private async rejectRemainingResults(
    prepared: readonly PreparedSwarmTask[],
    results: SwarmTaskResult[],
    fromIndex: number,
    roundId: string,
    rejection: { reason: string; cause?: unknown },
    journalState: SwarmRoundJournalState,
    usage?: SwarmRoundUsage,
  ): Promise<void> {
    const cancelReason = `Swarm round superseded before workspace merge: ${rejection.reason}`;
    const mergedCompletedTaskIds = results
      .slice(0, fromIndex)
      .filter((result) => result.status === "completed")
      .map((result) => result.taskId);
    for (let index = fromIndex; index < prepared.length; index += 1) {
      const task = prepared[index]!.task;
      const result = results[index]!;
      if (result.status === "completed") {
        results[index] = cancelCompletedResult(result, cancelReason);
        task.status = "cancelled";
      }
    }
    // 零回写不代表零开销：本轮全部终态 worker 的真实 token 仍计入预算。
    if (usage !== undefined) {
      for (const result of results) {
        usage.tokensUsed += Math.max(
          0,
          result.totalTokens ?? getModelUsageTotalTokens(result.usage),
        );
      }
    }
    for (let index = fromIndex; index < prepared.length; index += 1) {
      await this.disposePreparedWorkspace(prepared[index]!, roundId);
    }
    for (let index = fromIndex; index < prepared.length; index += 1) {
      await this.journal.appendSafe(
        {
          phase: "task_result",
          roundId,
          result: toJournalTaskResult(results[index]!),
        },
        prepared[index]!.task.trace,
        journalState,
      );
    }
    await this.journal.writeRoundCompleted(
      {
        roundId,
        completedTaskIds: mergedCompletedTaskIds,
        failedTaskIds: [],
        error: rejection.reason,
      },
      journalState,
    );
  }

  /** 清理单个工作树；失败只记日志并返回错误文本，不覆盖结果状态。 */
  private async disposePreparedWorkspace(
    entry: PreparedSwarmTask,
    roundId: string,
  ): Promise<string | undefined> {
    if (!entry.workspace) return undefined;
    try {
      await entry.workspace.dispose();
      return undefined;
    } catch (error) {
      const cleanupError = `Swarm workspace cleanup failed for task ${entry.task.taskId}: ${errorMessage(error)}`;
      this.deps.runtime.logger?.warn("Swarm workspace cleanup failed", {
        ...traceContextToLogContext(entry.task.trace),
        event: "target.swarm.workspace_cleanup_failed",
        module: "core.runtime",
        status: "failed",
        taskId: entry.task.taskId,
        roundId,
        errorMessage: errorMessage(error),
      });
      return cleanupError;
    }
  }

  /** 本轮断点读取：最近一轮未完成且 objective 一致时，作为中断上下文传给分解提示。 */
  private async readResumeCheckpoint(
    objective: string,
  ): Promise<SwarmRoundCheckpoint | undefined> {
    const checkpoint = await readLatestSwarmRoundCheckpoint(this.deps.runtime);
    if (!checkpoint || checkpoint.completed) return undefined;
    if (checkpoint.objective !== objective.trim()) return undefined;
    return checkpoint;
  }

  /** 启动期清理上一进程遗留的 /tmp/zcode-swarm-*；清理失败只记日志，不阻塞本轮。 */
  private async recoverOrphanedWorktrees(repoRoot: string): Promise<void> {
    const recovery = await recoverOrphanedSwarmWorktrees(repoRoot);
    if (recovery.error !== undefined) {
      // 临时目录整体不可读（缺失/无权限）：恢复面故障只记 warn，round 照常继续。
      this.deps.runtime.logger?.warn("Failed to read swarm temp directory for orphan recovery", {
        ...traceContextToLogContext(this.deps.scope.trace),
        event: "target.swarm.orphaned_worktree_recovery_failed",
        module: "core.runtime",
        status: "failed",
        errorMessage: recovery.error,
      });
    }
    if (recovery.removed.length > 0) {
      this.deps.runtime.logger?.info("Recovered orphaned swarm worktrees", {
        ...traceContextToLogContext(this.deps.scope.trace),
        event: "target.swarm.orphaned_worktrees_recovered",
        module: "core.runtime",
        status: "completed",
        count: recovery.removed.length,
        paths: recovery.removed,
      });
    }
    for (const failure of recovery.failures) {
      this.deps.runtime.logger?.warn("Failed to recover orphaned swarm worktree", {
        ...traceContextToLogContext(this.deps.scope.trace),
        event: "target.swarm.orphaned_worktree_recovery_failed",
        module: "core.runtime",
        status: "failed",
        path: failure.path,
        errorMessage: failure.error,
      });
    }
  }

  private createTask(description: string, index: number, roundId: string): SwarmTask {
    const taskId = `swarm-task-${index + 1}`;
    const { scope, runtime } = this.deps;
    return {
      taskId,
      agentType: this.agentType,
      description,
      // 分解提示已要求每条子任务自包含，description 就是交给子代理的完整任务。
      prompt: description,
      status: "pending",
      sessionId: runtime.sessionId,
      ...(scope.trace.turnId === undefined ? {} : { turnId: scope.trace.turnId }),
      // roundId 进入 tool call id：同一会话的多轮蜂群即使 taskId 相同也不会碰撞。
      parentToolCallId: createToolCallId(`swarm_${roundId}_${taskId}`),
      workingDirectory: runtime.workingDirectory,
      workspaceRoot: runtime.workspaceRoot,
      trace: createChildTraceContext(scope.trace, {
        sessionId: runtime.sessionId,
        attributes: { swarmTaskId: taskId, swarmRoundId: roundId },
      }),
    };
  }

  private async recordUsage(input: {
    error?: unknown;
    result?: ModelResult;
    startedAt: number;
    status: "completed" | "error";
    traceContext: TraceContext;
  }): Promise<void> {
    await recordModelUsageFact(this.deps.runtime, {
      events: [],
      model: this.deps.model,
      networkEventStartIndex: 0,
      querySource: SWARM_DECOMPOSITION_QUERY_SOURCE,
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.result === undefined ? {} : { result: input.result }),
      startedAt: input.startedAt,
      status: input.status,
      toolCallCount: input.result?.toolCalls?.length ?? 0,
      traceContext: input.traceContext,
    });
  }
}

