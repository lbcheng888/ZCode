/**
 * daemon scheduler 装配入口（B-SPEC §4.4 B3）。
 *
 * 生产构建只在部署门禁打开（`ControlPlaneOptions` 注入 → Core env 标记）时调用；
 * 门禁关不构造、不轮询，Desktop Main fork 保持现状（legacy）。
 */
import {
  AutomationRepo,
  OffPeakTaskRepo,
  createSuperAgentControlPlaneScheduleAuditor,
} from "@zcode/services/node";

import type { SuperAgentControlPlaneCorePort } from "../superAgentControlPlanePort.js";
import {
  createProductionDaemonScheduler,
  type DaemonScheduler,
  type DaemonSchedulerAutomationRepo,
  type DaemonSchedulerOffPeakRepo,
} from "./daemonScheduler.js";

export type {
  DaemonScheduler,
  DaemonSchedulerAuditPort,
  DaemonSchedulerAutomationRepo,
  DaemonSchedulerDispatchPort,
  DaemonSchedulerDispatchRequestSnapshot,
  DaemonSchedulerDispatchResult,
  DaemonSchedulerHostCommandAck,
  DaemonSchedulerLeasePort,
  DaemonSchedulerManualRun,
  DaemonSchedulerOffPeakRepo,
  DaemonSchedulerOptions,
  DaemonSchedulerRunTerminal,
  DaemonSchedulerTerminalDispatch,
} from "./daemonScheduler.js";
export {
  createDaemonScheduler,
  createProductionDaemonScheduler,
} from "./daemonScheduler.js";
export {
  createPendingDispatchWriter,
  pendingDispatchCommandId,
  type PendingDispatchInput,
  type PendingDispatchInsertResult,
  type PendingDispatchRequestSnapshot,
  type PendingDispatchTerminal,
  type PendingDispatchWriter,
} from "./pendingDispatch.js";

export interface CoreDaemonSchedulerOptions {
  controlPlane: SuperAgentControlPlaneCorePort;
  tasksIndexDatabasePath: string;
  /** child 的 serverRoot：租约 ownerId 门控的输入（§2.5）。 */
  serverRoot: string;
  now?: () => number;
  /** manual claim 心跳间隔（测试可缩短）；缺省 60s。 */
  manualClaimHeartbeatMs?: number;
  /** 测试注入替身；生产缺省构造真实 AutomationRepo。 */
  repo?: DaemonSchedulerAutomationRepo;
  /** 测试注入替身；生产缺省构造真实 OffPeakTaskRepo。 */
  offPeakRepo?: DaemonSchedulerOffPeakRepo;
}

/**
 * Core 生产装配：租约/审计经控制面 RPC，pending 行写本地 tasks-index。
 * `repo` / `offPeakRepo` 句柄由 scheduler.stop() 收口（close 幂等）。
 */
export function createCoreDaemonScheduler(
  options: CoreDaemonSchedulerOptions,
): DaemonScheduler {
  const repo = options.repo ?? new AutomationRepo();
  const offPeakRepo = options.offPeakRepo ?? new OffPeakTaskRepo();
  return createProductionDaemonScheduler({
    repo,
    offPeakRepo,
    leases: { list: () => options.controlPlane.listLeases() },
    auditor: createSuperAgentControlPlaneScheduleAuditor(options.controlPlane.port),
    tasksIndexDatabasePath: options.tasksIndexDatabasePath,
    serverRoot: options.serverRoot,
    ensureWorkspace: (workspaceIdentity, workspacePath) =>
      options.controlPlane.ensureWorkspace(workspaceIdentity, workspacePath),
    ...(options.now ? { now: options.now } : {}),
    ...(options.manualClaimHeartbeatMs !== undefined
      ? { manualClaimHeartbeatMs: options.manualClaimHeartbeatMs }
      : {}),
  });
}
