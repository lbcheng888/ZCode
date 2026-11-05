/**
 * super-agent-daemon 对外契约：daemon 侧 control-plane 子进程的宿主装配面
 * （milestone-b-spec §1–§3）。调用方（bootstrap headless entry）只需要这些；
 * 实现细节（socket 帧、peer 认证、plane 生命周期）不外泄。
 */

export {
  CONTROL_PLANE_TRUSTED_PIDS_ENV,
  type PeerIdentity,
  type PeerIdentityResolver,
  type PeerGuardDecision,
  type ControlPlanePeerGuard,
  parseTrustedPids,
  createControlPlanePeerGuard,
} from "./peerIdentity.js";

export {
  ControlPlaneRpcCallError,
  type ControlPlaneRpcRequestHandler,
  type ControlPlanePeerChannel,
  type ControlPlaneRpcServer,
  CONTROL_PLANE_ENDPOINT_PROBE_TIMEOUT_MS,
  type CreateControlPlaneRpcServerOptions,
  createControlPlaneRpcServer,
} from "./rpcServer.js";

export {
  TASKS_INDEX_RELATIVE_PATH,
  resolveTasksIndexDatabasePath,
  type DaemonPlaneManagerOptions,
  DaemonPlaneManager,
} from "./planeManager.js";

export {
  ADJUDICATION_MAX_OUTPUT_TOKENS,
  AdjudicationSessionUnavailableError,
  type AdjudicationSessionAssembly,
  type CreateAdjudicationSessionAssembly,
  type HeadlessAdjudicationModelSource,
  createUnavailableAdjudicationSession,
  createHeadlessAdjudicationSession,
  createLazyAdjudicationSession,
  createEnvironmentAdjudicationSessionAssembly,
  resolveHeadlessProviderRuntimeEnv,
} from "./adjudicationSession.js";
