/**
 * swarm-runtime 公共入口：target 生命周期只从这里使用蜂群编排。
 *
 * 编排器、worker、聚合器与 worktree 实现的内部模块不对外暴露；外部需要的
 * 类型、错误与证据格式化都由 swarm-orchestrator 的既有 re-export 面提供。
 */
export * from "./swarm-orchestrator.js";
export { SwarmWorker } from "./swarm-worker.js";
export { SwarmAggregator } from "./swarm-aggregator.js";
export {
  runSwarmGoalContinuation,
  type SwarmGoalContinuationInput,
  type SwarmGoalContinuationResult,
} from "./target-continuation.js";
