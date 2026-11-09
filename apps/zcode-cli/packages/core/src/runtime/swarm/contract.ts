/**
 * swarm-runtime 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 唯一的调用方是 target 生命周期（methods/target.ts → swarm/target-continuation.ts）。编排器负责分解、并行执行、
 * 合并闸门与预算记账；target 侧只在每轮开始前给出目标与取消域，在轮结束后做 revision 复核。
 */
import type { SwarmRoundEvidence, SwarmRoundOptions } from "./swarm-types.js";

export interface SwarmRuntimeContract {
  /**
   * 跑一轮目标蜂群。
   * 前置：目标非空；subagent 端口在场；基准仓库干净且可建 worktree（由编排器 preflight 保证）。
   * 后置：写入本轮 journal（round_started/decomposed/task_result/round_completed）；
   * 每个 worker 的 worktree 已合并或已丢弃；所有模型开销累加进 options.usage。
   * 失败时抛原始错误（含 cause 链）；目标被改写时抛 SwarmRoundSupersededError（不 merge 旧产出）。
   * 幂等性：一轮一个 roundId，不重放；崩溃恢复由 journal 断点与 orphan worktree 清理承担。
   */
  runGoalRound(objective: string, options?: SwarmRoundOptions): Promise<SwarmRoundEvidence>;
}
