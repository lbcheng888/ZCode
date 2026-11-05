import { hostname } from "node:os";
import {
  createServerHostServices,
  disposeServiceResourcesAndWait,
  materializeZCodeBuiltinProviderConfig,
  getAppConfigDir,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  createTopicResourcePeers,
  createServiceLogger,
} from "@zcode/services/node";
import { IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import { ZCODE_VERSION } from "@zcode/shared";
import { getTasksIndexDatabasePath } from "@zcode/services/storage-startup";
import { CONTROL_PLANE_CORE_ENABLED_ENV } from "../contracts.js";
import {
  createControlPlaneClient,
  isControlPlanePeerModeEnabled,
  type ControlPlaneClient,
} from "../supervisor/controlPlaneClient.js";
import { createCoreHttpServer } from "./http.js";
import { createIngressToken } from "./ingressToken.js";
import { installParentDisconnectHandler } from "./parentDisconnect.js";
import { resolveCoreServerId } from "./serverIdentity.js";
import {
  createSuperAgentControlPlaneCorePort,
  SuperAgentControlPlaneGenerationGate,
  type SuperAgentControlPlaneCorePort,
} from "./superAgentControlPlanePort.js";
import {
  createSuperAgentControlPlaneInboundHandler,
  type SuperAgentHostDispatchSettlement,
  type SuperAgentHostServiceAccess,
} from "./superAgentHostHandlers.js";
import { createCoreDaemonScheduler, type DaemonScheduler } from "./scheduler/index.js";
import { createTaskActivityTracker } from "./taskActivityTracker.js";
import { resolveServerLayout } from "../runtime/paths.js";

const log = createServiceLogger("server-core");

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export async function runServerCore(generation: number): Promise<void> {
  let shutdown: ((reason: string) => Promise<void>) | undefined;
  let parentDisconnected = false;
  let disposeParentDisconnectHandler = (): void => undefined;
  disposeParentDisconnectHandler = installParentDisconnectHandler(() => {
    if (shutdown) void shutdown("parent-disconnected");
    else parentDisconnected = true;
  });
  const layout = resolveServerLayout(process.env.ZCODE_SERVER_ROOT?.trim());
  // §2.3/§4.2 启动期单一投影：只有 CLI launcher 在部署门禁打开时才写该 env。
  // 门禁关 = 不构造客户端/端口，createServerHostServices 收到的 options 与现状逐字段相同。
  const controlPlaneEnabled = process.env[CONTROL_PLANE_CORE_ENABLED_ENV] === "1";
  let controlPlaneClient: ControlPlaneClient | undefined;
  let controlPlaneCorePort: SuperAgentControlPlaneCorePort | undefined;
  /**
   * child→Core 回调的服务投影（host.command/worker）：client 早于
   * `createServerHostServices` 构造，处理器按调用时取服务，不在装配期捕获。
   */
  let hostServices: SuperAgentHostServiceAccess | undefined;
  /**
   * 派发结算面：scheduler 在 services 就绪后构造，inbound handler 早于它注册，
   * 因此按调用时取；未装配时 host.command 只转发回执（不伪造台账结算）。
   */
  let dispatchSettlement: SuperAgentHostDispatchSettlement | undefined;
  /** worker 终态订阅（键 = sessionId + inputId）；run 终态/关停时释放。 */
  const terminalSubscriptions = new Map<string, { dispose(): void }>();
  let daemonScheduler: DaemonScheduler | undefined;
  if (controlPlaneEnabled) {
    const gate = new SuperAgentControlPlaneGenerationGate();
    // Supervisor 是唯一代际事实来源；消息可能早于 services 初始化到达，所以监听器先注册。
    process.on("message", (raw: unknown) => {
      if (
        typeof raw === "object" &&
        raw !== null &&
        "type" in raw &&
        (raw as { type?: unknown }).type === "control-plane-state"
      ) {
        gate.update(raw);
      }
    });
    const client = createControlPlaneClient({
      serverRoot: layout.serverRoot,
      // §3.8：peer 门模式下 child 在连接建立时已完成内核身份校验，Core 不能再发
      // auth 首帧（否则会被当作非法业务帧、触发协议错误断开）。开关与 child 共用 env。
      peerMode: isControlPlanePeerModeEnabled(),
      onInboundRequest: createSuperAgentControlPlaneInboundHandler({
        getServices: () => hostServices,
        getDispatchSettlement: () => dispatchSettlement,
      }),
    });
    controlPlaneClient = client;
    controlPlaneCorePort = createSuperAgentControlPlaneCorePort({
      client,
      gate,
      // createServerHostServices 在返回前完成 tasks-index 迁移；首次 ingest 必然在其之后。
      tasksIndexReady: true,
      tasksIndexDatabasePath: getTasksIndexDatabasePath(),
    });
  }
  const topicResourcePeers = createTopicResourcePeers();
  const explicitZCodeBuiltinProviderConfigFilePath =
    process.env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  // Built-in Config 物化到所属 Environment 配置根（~/.zcode/v2）而不是 release 自带的 runtime 目录：
  // release 目录是不可变的，同一 releaseId 重装时 assertExistingReleaseMatches 会重算整棵树的
  // 内容哈希，多出的物化文件会让校验失败。
  const zcodeBuiltinProviderConfigFilePath = explicitZCodeBuiltinProviderConfigFilePath
    ? explicitZCodeBuiltinProviderConfigFilePath
    : typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ === "string"
      ? await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot: getAppConfigDir(),
          content: __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__,
        })
      : undefined;
  if (!zcodeBuiltinProviderConfigFilePath) {
    throw new Error(
      `当前构建未嵌入 ZCode Built-in Provider Config，且未设置 ${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV}`,
    );
  }
  const sourceServerId = (await resolveCoreServerId()) ?? hostname() ?? "zcode-server";
  const {
    services,
    workspaceIdentityMapper,
    migrationFailedPathCount,
    capabilityTicketAdmissionPeers,
  } = await createServerHostServices({
    sourceServerId,
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: true,
    topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
    ...(controlPlaneCorePort
      ? { superAgentControlPlaneRpcPort: controlPlaneCorePort.port }
      : {}),
  });
  // child→Core 回调服务面就绪：此后 host.command/worker.find/resume 方可转发到 agent。
  if (controlPlaneEnabled) hostServices = services;
  /**
   * B3 原子切换（B-SPEC §4.4.3）：部署门禁打开即构造并启动 daemon scheduler。
   * pending 行写面与 child 派发桥 push/sweep 在同一批运行；host.command 回执在此回灌
   * run 台账（ACK=dispatched，rejected=失败退避），worker 终态按 inputAccepted.inputId
   * 精确回写 outcome。启动失败（tasks-index 未迁移等）原样上浮 → Core 启动级失败，
   * 不进入「门禁开但 scheduler 不在跑」的半状态（那会让 child 租约挡住 Desktop 回退）。
   *
   * 已知边界（诚实登记，不伪接线）：daemon 内 off-peak 仍只 claim + 审计 + 顺延
   * （spec §7-5 裁决 off-peak 不进桥；执行面仍归 host）。
   */
  if (controlPlaneEnabled && controlPlaneCorePort) {
    const scheduler = createCoreDaemonScheduler({
      controlPlane: controlPlaneCorePort,
      tasksIndexDatabasePath: getTasksIndexDatabasePath(),
      serverRoot: layout.serverRoot,
    });
    daemonScheduler = scheduler;
    await scheduler.start();
    dispatchSettlement = {
      isDeliverable: (commandId) => scheduler.isHostCommandDeliverable(commandId),
      settle: async (commandId, ack, sessionId) => {
        const settled = await scheduler.settleHostCommand({
          commandId,
          status: ack.status,
          sessionId,
          ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
        });
        // 非桥命令（owned/human-explicit 直通命令的 commandId 不在 dispatch_requests）。
        if (!settled) return;
        if (ack.status !== "accepted" && ack.status !== "duplicate") return;
        const inputId =
          ack.result && ack.result.type === "inputAccepted" ? ack.result.inputId : undefined;
        if (!inputId) {
          // inputAccepted.inputId 是把 worker 终态精确归属到本 run 的唯一键。缺它是
          // runtime/协议缺口，不得用该会话的任意终态冒充本 run 收口。
          log.error("dispatch ACK missing inputAccepted.inputId; terminal not tracked", {
            commandId,
            runId: settled.runId,
            sessionId,
          });
          return;
        }
        const key = `${sessionId}\u0000${inputId}`;
        if (terminalSubscriptions.has(key)) return;
        const taskService = services.getOptional(IZCodeTaskService);
        if (!taskService) {
          log.error("IZCodeTaskService unavailable; terminal outcome cannot be observed", {
            commandId,
            runId: settled.runId,
            sessionId,
          });
          return;
        }
        let subscription: { dispose(): void } | undefined;
        subscription = taskService.onDynamicTaskTerminalOutcome(sessionId)((terminal) => {
          // 同一 task 可能同时承载用户输入；只认本次派发的 inputId。
          if (terminal.inputId !== inputId) return;
          terminalSubscriptions.delete(key);
          subscription?.dispose();
          void scheduler
            .settleRunTerminal({
              runId: settled.runId,
              outcome: terminal.outcome,
              ...(terminal.error ? { error: terminal.error } : {}),
            })
            .catch((error: unknown) => {
              log.warn("worker terminal settlement failed", {
                runId: settled.runId,
                sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        });
        terminalSubscriptions.set(key, subscription);
      },
    };
  }
  const taskActivityTracker = createTaskActivityTracker(services.getOptional(IZCodeAgentService));
  const ingressToken = await createIngressToken(layout);
  const http = await createCoreHttpServer(services, {
    serverId: sourceServerId,
    ingressToken,
    migrationFailedPathCount,
    workspaceIdentityMapper,
    topicResourcePeers,
    ...(capabilityTicketAdmissionPeers ? { capabilityTicketAdmissionPeers } : {}),
  });
  const send = (message: unknown): Promise<void> => {
    if (typeof process.send !== "function" || process.connected === false) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        process.send?.(message, () => resolve());
      } catch {
        // 父进程断连后的最后一条生命周期消息不应阻塞资源释放。
        resolve();
      }
    });
  };
  // ready.version 的语义是 Core 版本；不能误发 Node runtime 版本常量
  // （22.16.0），否则消费方读取会拿到错误值。
  await send({
    type: "ready",
    host: http.host,
    port: http.port,
    version: ZCODE_VERSION,
    ...(process.env.ZCODE_SERVER_RELEASE_ID?.trim()
      ? { releaseId: process.env.ZCODE_SERVER_RELEASE_ID.trim() }
      : {}),
    generation,
  });
  let shutdownStarted = false;
  let lastRunningTaskCount = taskActivityTracker.readRunningTaskCount();
  const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(
    (runningTaskCount) => {
      lastRunningTaskCount = runningTaskCount;
      void send({
        type: "task-activity",
        runningTasks: taskActivityTracker.readRunningTasks(),
        runningTaskCount,
      });
    },
  );
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = Promise.resolve(taskActivityTracker.readRunningTaskCount())
      .then((runningTaskCount) => {
        if (runningTaskCount !== lastRunningTaskCount) {
          lastRunningTaskCount = runningTaskCount;
          void send({
            type: "task-activity",
            runningTasks: taskActivityTracker.readRunningTasks(),
            runningTaskCount,
          });
        }
        void send({
          type: "heartbeat",
          runningTasks: taskActivityTracker.readRunningTasks(),
          at: Date.now(),
          runningTaskCount,
        });
      })
      .catch(() => {
        void send({
          type: "heartbeat",
          runningTasks: taskActivityTracker.readRunningTasks(),
          at: Date.now(),
          runningTaskCount: lastRunningTaskCount,
        });
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, 10_000);
  shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    disposeParentDisconnectHandler();
    clearInterval(heartbeat);
    activitySubscription.dispose();
    taskActivityTracker.dispose();
    // 先摘派发结算面/worker 终态订阅（依赖 task service），再停 scheduler（关
    // tasks-index 句柄），避免关库后仍有 host.command 回执写入。
    dispatchSettlement = undefined;
    for (const subscription of terminalSubscriptions.values()) subscription.dispose();
    terminalSubscriptions.clear();
    await daemonScheduler?.stop().catch(() => undefined);
    await http.close().catch(() => undefined);
    await disposeServiceResourcesAndWait(services).catch(() => undefined);
    // services 已停止后再关 RPC，避免 sink 在收口过程中拿到半关闭连接以外的行为。
    await controlPlaneClient?.close().catch(() => undefined);
    await send({ type: "shutdown-ack" });
    await send({ type: "exit", reason });
    try {
      process.disconnect?.();
    } catch {
      // 父进程已断连时 disconnect 可能报告 IPC_CHANNEL_CLOSED；不影响资源已释放后的退出。
    }
    // 仅设置 exitCode 无法关闭 Agent/SQLite 等仍持有的事件循环；Supervisor 的有界停止
    // 会因此等待到超时。资源释放完成后显式退出，确保 stop/restart/uninstall 真正收口。
    process.exit(0);
  };
  if (parentDisconnected) void shutdown("parent-disconnected");
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "command" in message &&
      message.command === "shutdown"
    ) {
      void shutdown("requested");
    }
  });
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
