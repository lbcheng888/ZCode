import type { DatabaseSync } from "node:sqlite";

import { SqliteBackgroundRunStore } from "../storage/background-run-store.js";
import {
  createStallRepairCommands,
  createSuperAgentWatchdog,
  type AutomationPausePort,
  type SuperAgentWatchdogConfig,
  type SuperAgentWatchdogContract,
  type WatchdogRepairCommandSurface,
  type WorkflowRunCancelPort,
} from "../watchdog/index.js";
import { BackgroundRunRegistry } from "../watchdog/registry.js";

/**
 * daemon 侧 watchdog（S3）：从共享 `super-agent.sqlite` 恢复生产 registry 行。
 * 只 hydrate 本进程真实有命令面的 kind：workflow（Core RPC → cancelBackgroundWork）、
 * automation（Core RPC → automationService.pause）。
 *
 * cheng-job 不在 daemon 的 kind 集里：daemon 的 cheng host 是本进程新建的 stdio host，
 * 看不到前台 app 的 job.json，跨进程 cancel 恒 jobNotFound，放进来只会反复误 cancel/
 * 误升级。没有 workspace-scoped 共享 job journal 之前，daemon 不承担跨进程 cheng cancel，
 * 由拥有该 job 的会话 app watchdog 处理。
 *
 * 用户通知只有 `taskNotification` 端口在场时才可能成功；daemon 自身无会话 runtime 时
 * 返回稳定能力阻塞 `DAEMON_TASK_NOTIFICATION_BLOCKED`，`notify` 降级为纯诊断告警，
 * 绝不把 onError 记成 notify-user 成功。
 */
export const DAEMON_TASK_NOTIFICATION_BLOCKED = "daemon_task_notification_unavailable";

/** 真实用户 task-notification 投递端口；true 才表示已入 owner session runtime 队列。 */
export interface DaemonTaskNotificationPort {
  enqueue(input: {
    message: string;
    ownerSession?: string;
    workspaceKey?: string;
  }): Promise<boolean>;
}

export type DaemonNotificationChannel = "task-notification" | "blocked";

export interface DaemonWatchdogOptions {
  database: DatabaseSync;
  /** workflow cancel 端口（生产经 Core RPC）；缺席时 workflow 行不 hydrate。 */
  workflowCancel?: WorkflowRunCancelPort;
  /** automation pause 端口（生产经 Core RPC）；缺席时 automation 行不 hydrate。 */
  automationPause?: AutomationPausePort;
  /**
   * 真实用户 task-notification 通道。daemon 当前装配不提供会话 runtime；缺席即显式
   * 能力阻塞，不能拿诊断日志冒充用户通知。
   */
  taskNotification?: DaemonTaskNotificationPort;
  /** daemon 诊断告警（日志/onError）；即使在场也只记录，不计 notify-user 成功。 */
  notify?: (message: string) => void | Promise<void>;
  now?: () => number;
  /** 测试/宿主覆盖；缺省 DEFAULT_WATCHDOG_CONFIG。 */
  config?: Partial<SuperAgentWatchdogConfig>;
}

export interface DaemonWatchdogAssembly {
  readonly registry: BackgroundRunRegistry;
  readonly watchdog: SuperAgentWatchdogContract;
  /** 已装配的 repair 命令面（测试/观测可直调；生产仍由 watchdog 驱动）。 */
  readonly commands: WatchdogRepairCommandSurface;
  /** 当前真实通知能力；blocked = 用户通知不会通过 daemon 送达。 */
  readonly notificationChannel: DaemonNotificationChannel;
  readonly notificationBlockerReason?: string;
  start(): void;
  stop(): Promise<void>;
}

export function createDaemonWatchdog(options: DaemonWatchdogOptions): DaemonWatchdogAssembly {
  const store = new SqliteBackgroundRunStore(options.database);
  const registry = new BackgroundRunRegistry(500, store);
  // 只恢复有命令面的 kind；异 kind 行（尤其 cheng-job）留给拥有该 job 的会话 app watchdog。
  const handledKinds = new Set<string>();
  if (options.workflowCancel !== undefined) handledKinds.add("workflow");
  if (options.automationPause !== undefined) handledKinds.add("automation");
  registry.hydrate(store.loadAll().filter((row) => handledKinds.has(row.kind)));
  const notificationChannel: DaemonNotificationChannel =
    options.taskNotification === undefined ? "blocked" : "task-notification";
  const notificationBlockerReason =
    notificationChannel === "blocked" ? DAEMON_TASK_NOTIFICATION_BLOCKED : undefined;
  const commands = createStallRepairCommands({
    registry,
    ...(options.workflowCancel === undefined ? {} : { workflowRun: options.workflowCancel }),
    ...(options.automationPause === undefined ? {} : { automation: options.automationPause }),
    notify: async (
      message: string,
      context?: {
        ownerSession?: string;
        workspaceKey?: string;
      },
    ) => {
      if (options.taskNotification !== undefined) {
        const accepted = await options.taskNotification.enqueue({
          message,
          ownerSession: context?.ownerSession,
          workspaceKey: context?.workspaceKey,
        });
        return accepted ? true : { ok: false, error: "task-notification 未确认入队" };
      }
      await options.notify?.(message);
      return {
        ok: false,
        error: `${DAEMON_TASK_NOTIFICATION_BLOCKED}: daemon 无 owner session task-notification 端口；用户通知须由会话 app watchdog 投递`,
      };
    },
  });
  const watchdog = createSuperAgentWatchdog({
    registry,
    commands,
    // registry 启动时只 hydrate 一次；共享库里别的进程/plane 之后新增或更新的
    // workflow/automation 行必须每 tick 增量合并，否则 daemon 的行会冻结在启动快照。
    refreshRuns: () => registry.refreshFromPersistence((row) => handledKinds.has(row.kind)),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  let started = false;
  return {
    registry,
    watchdog,
    commands,
    notificationChannel,
    ...(notificationBlockerReason === undefined ? {} : { notificationBlockerReason }),
    start() {
      if (started) return;
      started = true;
      watchdog.start();
    },
    async stop() {
      if (!started) return;
      started = false;
      await watchdog.stop();
    },
  };
}
