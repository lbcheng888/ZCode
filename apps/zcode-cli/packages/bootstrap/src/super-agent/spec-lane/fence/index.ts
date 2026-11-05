/**
 * P6 OS 级 egress 围栏内部入口。
 * 对外只经 ../index.ts 暴露；目录内其余文件不跨模块 import。
 */
export {
  FenceStartupError,
  SPEC_FENCE_PLATFORM_MATRIX,
  fencePlatformMatrixEntry,
  type FenceCapability,
  type FenceEgressScope,
  type FenceErrorCode,
  type FenceMechanism,
  type FencePlatformMatrixEntry,
  type FenceRunStatus,
  type PrepareFenceRequest,
  type SpecFenceContract,
  type SpecFenceHandle,
} from "./contract.js";
export {
  DEFAULT_POSIX_SHELL_PATH,
  DEFAULT_SANDBOX_EXEC_PATH,
  DEFAULT_UNSHARE_PATH,
  buildDarwinFenceProfile,
  buildFenceCommandPlan,
  buildFencedExecutionCommand,
  buildLinuxFenceRuleset,
  isLoopbackBrokerHost,
  quotePosixShellArg,
  type BuildFenceCommandPlanInput,
  type DarwinFenceCommandPlan,
  type FenceArtifactPaths,
  type FenceBrokerEndpoint,
  type FenceCommandPlan,
  type LinuxFenceCommandPlan,
  type UnsupportedFenceCommandPlan,
} from "./command-plan.js";
export { createSpecFence, type CreateSpecFenceOptions } from "./executor.js";
export { createFencedExecutionPort } from "./execution-wrap.js";
