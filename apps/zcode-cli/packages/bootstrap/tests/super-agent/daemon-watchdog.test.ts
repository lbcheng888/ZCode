import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { SqliteBackgroundRunStore } from "../../src/super-agent/storage/background-run-store.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/super-agent/watchdog/index.js";
import {
  DAEMON_TASK_NOTIFICATION_BLOCKED,
  createDaemonWatchdog,
} from "../../src/super-agent/daemon/watchdog.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function seedChengStall(database: DatabaseSync, id = "cheng-daemon-stale"): void {
  const store = new SqliteBackgroundRunStore(database);
  const registry = new BackgroundRunRegistry(500, store);
  registry.register(
    {
      id,
      kind: "cheng-job",
      owner: "cheng-host",
      stallClockRef: `cheng-job:${id}`,
    },
    1_000,
  );
}

function seedWorkflowStall(database: DatabaseSync, id = "workflow-daemon-stale"): void {
  const store = new SqliteBackgroundRunStore(database);
  const registry = new BackgroundRunRegistry(500, store);
  registry.register(
    {
      id,
      kind: "workflow",
      owner: "dynamic-workflow",
      ownerSession: "session-a",
      workspaceKey: "ws:a",
      stallClockRef: `dwf-run:${id}`,
    },
    1_000,
  );
}

function seedAutomationRun(database: DatabaseSync, id = "auto-1:manual:run-1"): void {
  const store = new SqliteBackgroundRunStore(database);
  const registry = new BackgroundRunRegistry(500, store);
  registry.register(
    {
      id,
      kind: "automation",
      owner: "automation",
      workspaceKey: "ws:a",
    },
    1_000,
  );
}

describe("daemon watchdog on the production registry", () => {
  it("does not hydrate cheng-job rows (no cross-process cheng cancel)", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedChengStall(db);
    const assembly = createDaemonWatchdog({
      database: db,
      now: () => 1_000,
      config: { repairCooldownMs: 0 },
    });

    const report = await assembly.watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    // daemon 的 stdio cheng host 看不到前台 app 的 job.json，跨进程 cancel 恒
    // jobNotFound；该行归拥有它的会话 app watchdog，daemon 不捞、不误 cancel。
    expect(assembly.registry.get("cheng-daemon-stale")).toBeUndefined();
    expect(report.repairs).toEqual([]);
  });

  it("blocks user notification explicitly when no task-notification runtime is wired", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedWorkflowStall(db);
    const notify = vi.fn(() => undefined);
    const assembly = createDaemonWatchdog({
      database: db,
      // cancel 未确认 ⇒ repair 失败，用来触发升级 notify 而不依赖 cheng 行。
      workflowCancel: { cancel: async () => false },
      notify,
      now: () => 1_000,
      config: {
        escalationCooldownMs: 0,
        escalationFailureThreshold: 1,
        repairCooldownMs: 0,
      },
    });

    expect(assembly.notificationChannel).toBe("blocked");
    expect(assembly.notificationBlockerReason).toBe(DAEMON_TASK_NOTIFICATION_BLOCKED);
    const report = await assembly.watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("连续 1 次 repair 失败"));
    // onError 只是诊断信道，不能算作用户已收到通知。
    expect(report.escalations).toEqual([
      expect.objectContaining({ goalPaused: false, notified: false }),
    ]);
    expect(assembly.registry.get("workflow-daemon-stale")?.state).toBe("running");
  });

  it("upgrades notify-user to the real task-notification channel when wired", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedWorkflowStall(db);
    const enqueue = vi.fn(async () => true);
    const diagnosticNotify = vi.fn(() => undefined);
    const assembly = createDaemonWatchdog({
      database: db,
      workflowCancel: { cancel: async () => false },
      taskNotification: { enqueue },
      notify: diagnosticNotify,
      now: () => 1_000,
      config: {
        escalationCooldownMs: 0,
        escalationFailureThreshold: 1,
        repairCooldownMs: 0,
      },
    });

    expect(assembly.notificationChannel).toBe("task-notification");
    expect(assembly.notificationBlockerReason).toBeUndefined();
    const report = await assembly.watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    expect(enqueue).toHaveBeenCalledWith({
      message: expect.stringContaining("连续 1 次 repair 失败"),
      // 路由事实随升级通知带给端口：真实端口缺 ownerSession/workspaceKey 不出站。
      ownerSession: "session-a",
      workspaceKey: "ws:a",
    });
    expect(diagnosticNotify).not.toHaveBeenCalled();
    expect(report.escalations).toEqual([
      expect.objectContaining({ goalPaused: false, notified: true }),
    ]);
  });

  it("does not fake user notification when the task-notification port rejects", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedWorkflowStall(db);
    const enqueue = vi.fn(async () => false);
    const assembly = createDaemonWatchdog({
      database: db,
      workflowCancel: { cancel: async () => false },
      taskNotification: { enqueue },
      now: () => 1_000,
      config: {
        escalationCooldownMs: 0,
        escalationFailureThreshold: 1,
        repairCooldownMs: 0,
      },
    });

    const report = await assembly.watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(report.escalations).toEqual([
      expect.objectContaining({ goalPaused: false, notified: false }),
    ]);
  });

  it("hydrates workflow rows and cancels through the Core command port", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedWorkflowStall(db);
    const cancel = vi.fn(async () => true);
    const assembly = createDaemonWatchdog({
      database: db,
      workflowCancel: { cancel },
      now: () => 1_000,
      config: { repairCooldownMs: 0 },
    });

    const report = await assembly.watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    expect(cancel).toHaveBeenCalledWith(
      "workflow-daemon-stale",
      expect.objectContaining({ workspaceKey: "ws:a", ownerSession: "session-a" }),
    );
    expect(report.repairs).toEqual([
      expect.objectContaining({
        probe: "workflow-run-stalled",
        targetId: "workflow-daemon-stale",
        action: "cancel-stalled",
        ok: true,
      }),
    ]);
  });

  it("refreshes workflow rows added after startup hydrate on the next tick", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const cancel = vi.fn(async () => true);
    const assembly = createDaemonWatchdog({
      database: db,
      workflowCancel: { cancel },
      now: () => 1_000,
      config: { repairCooldownMs: 0 },
    });

    // registry 启动 hydrate 时还看不到这行；模拟别的进程稍后写入共享库。
    expect(assembly.registry.get("workflow-late")).toBeUndefined();
    seedWorkflowStall(db, "workflow-late");

    const report = await assembly.watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    expect(assembly.registry.get("workflow-late")).toMatchObject({
      kind: "workflow",
      ownerSession: "session-a",
    });
    expect(cancel).toHaveBeenCalledWith(
      "workflow-late",
      expect.objectContaining({ workspaceKey: "ws:a", ownerSession: "session-a" }),
    );
    expect(report.repairs).toEqual([
      expect.objectContaining({
        probe: "workflow-run-stalled",
        targetId: "workflow-late",
        action: "cancel-stalled",
        ok: true,
      }),
    ]);
  });

  it("refreshes workflow rows updated externally after startup hydrate", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedWorkflowStall(db, "workflow-updated");
    const cancel = vi.fn(async () => true);
    const assembly = createDaemonWatchdog({
      database: db,
      workflowCancel: { cancel },
      now: () => 1_000,
      config: { repairCooldownMs: 0 },
    });
    // 启动快照：hydrate 的行没有 stalledSince。
    expect(assembly.registry.get("workflow-updated")?.stalledSince).toBeUndefined();

    const externalStore = new SqliteBackgroundRunStore(db);
    const external = new BackgroundRunRegistry(500, externalStore);
    external.register(
      {
        id: "workflow-updated",
        kind: "workflow",
        owner: "dynamic-workflow",
        ownerSession: "session-a",
        workspaceKey: "ws:a",
        stallClockRef: "dwf-run:workflow-updated",
        stalledSince: 3_000,
      },
      3_000,
    );

    await assembly.watchdog.tick(3_000);

    // 更新更晚的外部行必须被合并，否则 daemon 仍停在启动快照。
    expect(assembly.registry.get("workflow-updated")).toMatchObject({
      stalledSince: 3_000,
      updatedAt: 3_000,
    });
  });

  it("hydrates automation rows and pauses through the Core command port", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedAutomationRun(db);
    const pause = vi.fn(async () => true);
    const assembly = createDaemonWatchdog({
      database: db,
      automationPause: { pause },
      now: () => 1_000,
    });

    await expect(
      assembly.commands.pauseWorkspaceAutomation("ws:a", "auto-1:manual:run-1"),
    ).resolves.toEqual({ ok: true });
    expect(pause).toHaveBeenCalledWith({ id: "auto-1" }, { workspaceKey: "ws:a" });
    expect(assembly.registry.get("auto-1:manual:run-1")?.state).toBe("running");
  });

  it("does not fake automation pause success when the Core command port rejects", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    seedAutomationRun(db);
    const assembly = createDaemonWatchdog({
      database: db,
      automationPause: { pause: async () => false },
      now: () => 1_000,
    });

    await expect(
      assembly.commands.pauseWorkspaceAutomation("ws:a", "auto-1:manual:run-1"),
    ).resolves.toEqual({
      ok: false,
      error: "automation pause 未生效（非 active/不存在）：auto-1",
    });
  });

  it("does not hydrate workflow rows without a cancel port", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const store = new SqliteBackgroundRunStore(db);
    const seed = new BackgroundRunRegistry(500, store);
    seed.register(
      {
        id: "workflow-row",
        kind: "workflow",
        owner: "dynamic-workflow",
        stallClockRef: "dwf-run:workflow-row",
      },
      1_000,
    );
    const assembly = createDaemonWatchdog({
      database: db,
      now: () => 1_000,
      config: { repairCooldownMs: 0 },
    });

    await assembly.watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    expect(assembly.registry.get("workflow-row")).toBeUndefined();
  });
});
