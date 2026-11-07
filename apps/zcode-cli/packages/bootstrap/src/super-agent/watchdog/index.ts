/**
 * super-agent-watchdog 公共入口（architecture-policy publicEntrypoints 之一）。
 * 调用方只从这里 import；目录内其余文件对外不可见。
 */
export {
  BackgroundRunOwnershipError,
  REPAIR_ACTIONS,
  type BackgroundRunKind,
  type BackgroundRunListFilter,
  type BackgroundRunOwner,
  type BackgroundRunRegistration,
  type BackgroundRunRow,
  type BackgroundRunTerminalState,
  type BackgroundRunTouchPatch,
  type CommandResult,
  type GoalHintSource,
  type GoalStateSnapshot,
  type GoalStateSource,
  type NoProgressAdjudicator,
  type RepairAction,
  type SuperAgentWatchdogConfig,
  type SuperAgentWatchdogContract,
  type SuperAgentWatchdogId,
  type TickReport,
  type TriggerBacklogSnapshot,
  type TriggerBacklogSource,
  type WatchdogEscalationRecord,
  type WatchdogProbeResult,
  type WatchdogRepairCommandSurface,
  type WatchdogRepairRecord,
  type WatchdogStatus,
} from "./contract.js";
export {
  createBackgroundRunProjectionPort,
  createWorkflowOnlyBackgroundRunProjection,
  type BackgroundRunProjectionPort,
} from "./composition.js";
export { BackgroundRunRegistry } from "./registry.js";
export {
  createChengStallRepairCommands,
  createStallRepairCommands,
  type AutomationPausePort,
  type ChengJobCancelPort,
  type ChengStallRepairCommandsDeps,
  type StallRepairCommandsDeps,
  type WorkflowRunCancelPort,
} from "./cheng-stall-commands.js";
export { validateRepairAction, isRepairAction, executeRepair } from "./repair.js";
export {
  runProbes,
  isWorkflowStallCandidate,
  type ProbeReadContext,
} from "./probes.js";
export {
  runProgressCheck,
  extractKeywords,
  type ProgressCheckContext,
  type ProgressCheckOutcome,
  type ProgressCheckState,
} from "./progress-check.js";
export {
  createSuperAgentWatchdog,
  SuperAgentWatchdog,
  DEFAULT_WATCHDOG_CONFIG,
  type WatchdogDeps,
} from "./watchdog.js";
