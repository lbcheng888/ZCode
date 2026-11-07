import { randomUUID } from "node:crypto";

import {
  CONTROL_PLANE_RPC_TIMEOUTS_MS,
  hostWatchdogCommandResultSchema,
  type HostWatchdogCommandParams,
} from "@zcode/shared/super-agent-control-plane-protocol";
import type { DaemonTaskNotificationPort } from "./watchdog.js";

/**
 * Core host 请求端口：结构 = DaemonPlaneManager.requestHost（组合根用惰性 manager
 * 包装，工厂不持有 manager 生命周期）。method 收窄到 watchdog 命令面唯一的入口。
 */
export type CoreWatchdogRequestHost = (
  workspaceIdentity: string,
  method: "host.watchdogCommand",
  params: HostWatchdogCommandParams,
  timeoutMs: number,
) => Promise<unknown>;

/**
 * daemon → Core → owner session 的生产 task-notification 端口（S3）：经
 * `host.watchdogCommand action=notify-user` 转 V4 notifyUser，由 owner session 的
 * runtime task-notification 队列投递。缺 ownerSession/workspaceKey 时返回 false——
 * 无法定位 owner 即无法投递，不静默落到诊断信道。
 */
export function createCoreTaskNotificationPort(
  requestHost: CoreWatchdogRequestHost,
): DaemonTaskNotificationPort {
  return {
    enqueue: async ({ message, ownerSession, workspaceKey }) => {
      if (!ownerSession || !workspaceKey) {
        return false;
      }
      const result = hostWatchdogCommandResultSchema.parse(
        await requestHost(
          workspaceKey,
          "host.watchdogCommand",
          {
            action: "notify-user",
            workspaceIdentity: workspaceKey,
            sessionId: ownerSession,
            message,
            commandId: `daemon-notify:${randomUUID()}`,
          },
          CONTROL_PLANE_RPC_TIMEOUTS_MS["host.watchdogCommand"],
        ),
      );
      return result.ok;
    },
  };
}
