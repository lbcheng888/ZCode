/**
 * daemon watchdog notify-user 整机链（S3）：真实 sqlite 种子行 → 真实 daemon watchdog
 * 升级 → 真实生产 task-notification 端口（createCoreTaskNotificationPort）→ Core 缝
 * → 真实 V4CommandExecutor → owner session runtime task-notification 队列（最外沿
 * 测试替身）。
 *
 * 模块边界（daemon 侧不 import @zcode/server-cli）：Core 缝两侧都以 @zcode/shared 的
 * 真实协议 schema 收发（hostWatchdogCommandParams/commandEnvelope/
 * hostWatchdogCommandResult），任何一侧字段漂移都会 parse 失败。缝内 glue 与真实
 * Core handler `handleHostWatchdogCommand` notify-user 分支逐行等价，其真实覆盖在
 * packages/zcode-server-cli/test/superAgentHostHandlers.test.ts。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import {
  CONTROL_PLANE_RPC_TIMEOUTS_MS,
  hostWatchdogCommandParamsSchema,
  hostWatchdogCommandResultSchema,
} from "@zcode/shared/super-agent-control-plane-protocol";
import { commandEnvelopeSchema } from "@zcode/shared/zcode-protocol-v4";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { SqliteBackgroundRunStore } from "../../src/super-agent/storage/background-run-store.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/super-agent/watchdog/index.js";
import { createDaemonWatchdog } from "../../src/super-agent/daemon/watchdog.js";
import { createCoreTaskNotificationPort } from "../../src/super-agent/daemon/coreWatchdogPorts.js";
import { V4CommandExecutor } from "../../src/zcode-protocol-v4/commands/executor.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../../src/zcode-protocol-v4/commands/types.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

interface QueuedNotification {
  commandId: string;
  text: string;
  traceContext: unknown;
}

function seedWorkflowStall(database: DatabaseSync, options?: { withOwner?: boolean }): void {
  const store = new SqliteBackgroundRunStore(database);
  const registry = new BackgroundRunRegistry(500, store);
  registry.register(
    {
      id: "workflow-daemon-stale",
      kind: "workflow",
      owner: "dynamic-workflow",
      ...(options?.withOwner === false ? {} : { ownerSession: "session-a" }),
      workspaceKey: "ws:a",
      stallClockRef: "dwf-run:workflow-daemon-stale",
    },
    1_000,
  );
}

/**
 * Core 缝：等价于真实 Core handler 的 notify-user 分支，但把
 * `agent.sendConversationCommandV4` 换成同进程真实 V4CommandExecutor + runtime 替身。
 */
function makeCoreSeam() {
  const queue: QueuedNotification[] = [];
  const requestHost = vi.fn(
    async (
      _workspaceKey: string,
      method: "host.watchdogCommand",
      rawParams: unknown,
      timeoutMs: number,
    ) => {
      expect(method).toBe("host.watchdogCommand");
      // 生产超时必须随端口带过来：Core 侧按同一预算执行。
      expect(timeoutMs).toBe(CONTROL_PLANE_RPC_TIMEOUTS_MS["host.watchdogCommand"]);
      const params = hostWatchdogCommandParamsSchema.parse(rawParams);
      if (params.action !== "notify-user") {
        throw new Error(`Core 缝只承运 notify-user，收到 ${params.action}`);
      }
      const envelope = commandEnvelopeSchema.parse({
        commandId: params.commandId,
        clientId: "super-agent-watchdog",
        sessionId: params.sessionId,
        type: "notifyUser",
        payload: { text: params.message },
        issuedAt: Date.now(),
      });
      const record = {
        app: {
          sessionId: params.sessionId,
          runtime: {
            enqueueBackgroundTaskNotification: (input: {
              commandId: string;
              text: string;
              traceContext: unknown;
            }) => {
              queue.push(input);
              return true;
            },
          },
        },
        workspace: { workspacePath: "/w" },
        persistence: "immediate",
        traceContext: { traceId: "trace-integration" },
      } as unknown as V4SessionRecordView;
      const host: V4CommandCoreHost = {
        getRecord: (id: string) => (id === params.sessionId ? record : undefined),
      };
      try {
        await new V4CommandExecutor(host).execute(envelope);
        return hostWatchdogCommandResultSchema.parse({ ok: true });
      } catch (error) {
        return hostWatchdogCommandResultSchema.parse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  return { requestHost, queue };
}

describe("daemon notify-user 整机链（daemon → Core 缝 → V4 executor → runtime 队列）", () => {
  it("升级 notify 经真实生产端口全链入队：commandId 透传为幂等键", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedWorkflowStall(db);
    const { requestHost, queue } = makeCoreSeam();

    const assembly = createDaemonWatchdog({
      database: db,
      // cancel 不确认 ⇒ repair 失败一轮即达升级阈值（真实 Core cancel 链另有整机用例）。
      workflowCancel: { cancel: async () => false },
      taskNotification: createCoreTaskNotificationPort(requestHost),
      now: () => 1_000,
      config: {
        escalationCooldownMs: 0,
        escalationFailureThreshold: 1,
        repairCooldownMs: 0,
      },
    });
    expect(assembly.notificationChannel).toBe("task-notification");

    const report = await assembly.watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    expect(report.escalations).toEqual([
      expect.objectContaining({ goalPaused: false, notified: true }),
    ]);
    expect(requestHost).toHaveBeenCalledOnce();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      commandId: expect.stringMatching(/^daemon-notify:[0-9a-f-]{36}$/),
      traceContext: { traceId: "trace-integration" },
    });
    expect(queue[0]!.text).toContain("连续 1 次 repair 失败");
  });

  it("行缺 ownerSession ⇒ 无法定位 owner，不出站、不虚报 notified", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedWorkflowStall(db, { withOwner: false });
    const { requestHost } = makeCoreSeam();

    const assembly = createDaemonWatchdog({
      database: db,
      workflowCancel: { cancel: async () => false },
      taskNotification: createCoreTaskNotificationPort(requestHost),
      now: () => 1_000,
      config: {
        escalationCooldownMs: 0,
        escalationFailureThreshold: 1,
        repairCooldownMs: 0,
      },
    });

    const report = await assembly.watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    expect(requestHost).not.toHaveBeenCalled();
    expect(report.escalations).toEqual([
      expect.objectContaining({ goalPaused: false, notified: false }),
    ]);
  });
});
