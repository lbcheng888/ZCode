/**
 * swarm-runtime 公共入口：本模块有两个互不替代的入口。
 *
 * - goal swarm（swarm-orchestrator / target-continuation）：target 生命周期按轮推进的
 *   隔离执行。每个 worker 一棵 git worktree，revision 合并闸门后才回写基准树，journal
 *   记录回合。编排器、worker、聚合器与 worktree 实现的内部模块不对外暴露；外部需要的
 *   类型、错误与证据格式化都由 swarm-orchestrator 的既有 re-export 面提供。
 * - AgentSwarm（agent-swarm.ts）：模型可见的 AgentSwarm 工具执行面。所有 worker 共享
 *   调用方 workspace，不建 worktree、不做 merge，只适合相互独立、同形的任务；它复用
 *   SwarmWorker 的执行与取消收口，但绝不进入 goal swarm 的隔离/合并路径。
 *
 * tool/handlers/agent.ts 从这一个入口按需导入 runAgentSwarm（不深导入 agent-swarm.js）；
 * 按需加载是为了切断工具注册期的初始化环，见 handlers/agent.ts 的注释。
 */
export * from "./swarm-orchestrator.js";
export { SwarmWorker } from "./swarm-worker.js";
export { runAgentSwarm } from "./agent-swarm.js";
export { SwarmAggregator } from "./swarm-aggregator.js";
export {
  runSwarmGoalContinuation,
  type SwarmGoalContinuationInput,
  type SwarmGoalContinuationResult,
} from "./target-continuation.js";
