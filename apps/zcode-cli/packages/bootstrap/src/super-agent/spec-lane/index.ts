/**
 * super-agent-spec-lane 公共入口（architecture-policy publicEntrypoints 之一）。
 * 调用方只从这里 import；目录内其余文件对外不可见。
 *
 * dispatcher 组合根的典型装配（spec §6 接缝）：
 *   1. lane.prepareSpecRunEgress({ workspaceRoot, allowHosts }) → plan（失败即 run 拒绝启动）；
 *   2. adapters buildSpecRunEnv({ proxyUrl: plan.proxyUrl, sourceEnv }) → 无凭据子进程 env；
 *   3. core buildSpecRestrictedProfile() → 受限 profile；
 *   4. 用 plan.networkPolicy + env 建执行适配器，用 profile 建 subagent run
 *      （生产 = createSpecRunSubagentLaunchPort → AgentRuntime.launchSubagent）；
 *   5. run 终态后 lane.stopSpecRunEgress(workspaceRoot)。
 */
export {
  SpecEgressStartupError,
  type PrepareSpecRunEgressRequest,
  type SpecRunEgressPlan,
  type SpecRunNetworkPolicy,
  type SuperAgentSpecLaneContract,
  type SuperAgentSpecLaneId,
} from "./contract.js";
export {
  normalizeSpecEgressAllowlist,
  startEgressProxy,
  type EgressAllowlistEntry,
  type EgressProxyHandle,
} from "./egress-proxy.js";
export { createSuperAgentSpecLane } from "./spec-lane.js";
export {
  createSpecRunDispatcher,
  type SpecRunDispatchInput,
  type SpecRunDispatcherDeps,
  type SpecRunLaunchPort,
  type SpecRunLaunchRequest,
} from "./dispatcher.js";
export {
  createSpecRunSubagentLaunchPort,
  type SpecRunExecutionPortInput,
  type SpecRunSubagentLaunchPortDeps,
} from "./launch.js";
export { superAgentSpecLaneModule } from "./module.js";

// P6 OS 级 egress 围栏（spec §3）：平台矩阵、命令构建器、能力探测与执行包装。
export {
  FenceStartupError,
  SPEC_FENCE_PLATFORM_MATRIX,
  fencePlatformMatrixEntry,
  createSpecFence,
  createFencedExecutionPort,
  buildFenceCommandPlan,
  buildFencedExecutionCommand,
  buildDarwinFenceProfile,
  buildLinuxFenceRuleset,
  isLoopbackBrokerHost,
  quotePosixShellArg,
  type FenceCapability,
  type FenceEgressScope,
  type FenceErrorCode,
  type FenceMechanism,
  type FencePlatformMatrixEntry,
  type FenceRunStatus,
  type PrepareFenceRequest,
  type SpecFenceContract,
  type SpecFenceHandle,
  type BuildFenceCommandPlanInput,
  type FenceBrokerEndpoint,
  type FenceCommandPlan,
  type LinuxFenceCommandPlan,
  type DarwinFenceCommandPlan,
  type UnsupportedFenceCommandPlan,
  type CreateSpecFenceOptions,
} from "./fence/index.js";
