import { describe, expect, it, vi } from "vitest";

import {
  BackgroundRunRegistry,
  createChengStallRepairCommands,
  createStallRepairCommands,
  createSuperAgentWatchdog,
  createWorkflowOnlyBackgroundRunProjection,
  DEFAULT_WATCHDOG_CONFIG,
} from "../../src/super-agent/watchdog/index.js";

function chengRow(registry: BackgroundRunRegistry, id = "cheng-stale-1"): void {
  registry.register(
    {
      id,
      kind: "cheng-job",
      owner: "cheng-host",
      stallClockRef: `cheng-job:${id}`,
      heartbeat: true,
    },
    1_000,
  );
}

function automationRow(
  registry: BackgroundRunRegistry,
  id = "auto-1:manual:run-1",
  workspaceKey = "ws:a",
): void {
  registry.register(
    {
      id,
      kind: "automation",
      owner: "automation",
      workspaceKey,
    },
    1_000,
  );
}

function workflowRow(registry: BackgroundRunRegistry, id = "workflow-stale-1"): void {
  registry.register(
    {
      id,
      kind: "workflow",
      owner: "dynamic-workflow",
      stallClockRef: `dwf-run:${id}`,
    },
    1_000,
  );
}

describe("S3 production cheng cancel-stalled command surface", () => {
  it("cancels a stalled cheng-job through the real host command and reports success", async () => {
    const registry = new BackgroundRunRegistry(100);
    chengRow(registry);
    const cancel = vi.fn(async () => "cancelled" as const);
    const commands = createChengStallRepairCommands({ registry, host: { cancel } });

    await expect(commands.cancelStalledRun("cheng-stale-1")).resolves.toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledWith("cheng-stale-1");
  });

  it("does not fake success when host only reports queued/running", async () => {
    const registry = new BackgroundRunRegistry(100);
    chengRow(registry);
    const commands = createChengStallRepairCommands({
      registry,
      host: { cancel: async () => "running" },
    });
    await expect(commands.cancelStalledRun("cheng-stale-1")).resolves.toEqual({
      ok: false,
      error: "host cancel 未确认终态：running",
    });
  });

  it("rejects missing/non-cheng rows and surfaces host errors", async () => {
    const registry = new BackgroundRunRegistry(100);
    const cancel = vi.fn(async () => "cancelled" as const);
    const commands = createChengStallRepairCommands({ registry, host: { cancel } });

    await expect(commands.cancelStalledRun("missing")).resolves.toMatchObject({ ok: false });
    registry.register(
      {
        id: "workflow-1",
        kind: "workflow",
        owner: "dynamic-workflow",
        stallClockRef: "dwf-run:workflow-1",
      },
      1_000,
    );
    await expect(commands.cancelStalledRun("workflow-1")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("只支持 cheng-job"),
    });
    expect(cancel).not.toHaveBeenCalled();

    chengRow(registry, "cheng-error");
    const failing = createChengStallRepairCommands({
      registry,
      host: {
        cancel: async () => {
          throw new Error("host down");
        },
      },
    });
    await expect(failing.cancelStalledRun("cheng-error")).resolves.toEqual({
      ok: false,
      error: "host cancel 失败：host down",
    });
  });

  it("probe hit → production command surface cancels the cheng job", async () => {
    const registry = new BackgroundRunRegistry(100);
    chengRow(registry);
    const cancel = vi.fn(async () => "cancelled" as const);
    const commands = createChengStallRepairCommands({ registry, host: { cancel } });
    const watchdog = createSuperAgentWatchdog({
      registry,
      commands,
      now: () => 1_000,
      config: { repairCooldownMs: 0 },
    });

    const now = 1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs;
    const report = await watchdog.tick(now);

    expect(cancel).toHaveBeenCalledWith("cheng-stale-1");
    expect(report.repairs).toEqual([
      expect.objectContaining({
        probe: "workflow-run-stalled",
        targetId: "cheng-stale-1",
        action: "cancel-stalled",
        ok: true,
      }),
    ]);
    // watchdog 不改行状态；终态仍由 cheng-host owner 回写。
    expect(registry.get("cheng-stale-1")?.state).toBe("running");
  });

  it("cancels a stalled workflow through the production workflow cancel port", async () => {
    const registry = new BackgroundRunRegistry(100);
    workflowRow(registry);
    const workflowCancel = vi.fn(async () => true);
    const commands = createStallRepairCommands({
      registry,
      workflowRun: { cancel: workflowCancel },
    });

    await expect(commands.cancelStalledRun("workflow-stale-1")).resolves.toEqual({ ok: true });
    expect(workflowCancel).toHaveBeenCalledWith("workflow-stale-1", {});
    // run owner 回写终态；命令面不写 registry。
    expect(registry.get("workflow-stale-1")?.state).toBe("running");
  });

  it("does not fake workflow cancellation when the run is already terminal or missing", async () => {
    const registry = new BackgroundRunRegistry(100);
    workflowRow(registry);
    const commands = createStallRepairCommands({
      registry,
      workflowRun: { cancel: async () => false },
    });
    await expect(commands.cancelStalledRun("workflow-stale-1")).resolves.toEqual({
      ok: false,
      error: "workflow cancel 未确认在途 run：workflow-stale-1",
    });
  });

  it("reports unsupported capability for workflow rows without a cancel port", async () => {
    const registry = new BackgroundRunRegistry(100);
    workflowRow(registry);
    const commands = createStallRepairCommands({ registry });
    await expect(commands.cancelStalledRun("workflow-stale-1")).resolves.toEqual({
      ok: false,
      error: "cancel-stalled 未接入 workflow cancel 端口：workflow-stale-1",
    });
  });

  it("production workflow projection registers workflow rows (not background_task) and feeds the watchdog", async () => {
    const registry = new BackgroundRunRegistry(100);
    const projection = createWorkflowOnlyBackgroundRunProjection(registry, () => 1_000, {
      ownerSession: "session-a",
      workspaceKey: "ws:a",
    });
    projection.register({
      id: "workflow-projected",
      kind: "workflow",
      owner: "dynamic-workflow",
      stallClockRef: "dwf-run:workflow-projected",
    });
    projection.register({
      id: "task-ignored",
      kind: "background_task",
      owner: "runtime-background-task",
      heartbeat: true,
    });
    expect(registry.get("workflow-projected")).toMatchObject({
      kind: "workflow",
      state: "running",
      ownerSession: "session-a",
      workspaceKey: "ws:a",
    });
    expect(registry.get("task-ignored")).toBeUndefined();

    const workflowCancel = vi.fn(async () => true);
    const watchdog = createSuperAgentWatchdog({
      registry,
      commands: createStallRepairCommands({
        registry,
        workflowRun: { cancel: workflowCancel },
      }),
      now: () => 1_000,
      config: { repairCooldownMs: 0 },
    });
    const report = await watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    expect(workflowCancel).toHaveBeenCalledWith(
      "workflow-projected",
      expect.objectContaining({ workspaceKey: "ws:a", ownerSession: "session-a" }),
    );
    expect(report.repairs[0]).toMatchObject({
      probe: "workflow-run-stalled",
      targetId: "workflow-projected",
      action: "cancel-stalled",
      ok: true,
    });
  });

  it("notify-user sends through the injected notification port and leaves registry rows untouched", async () => {
    const registry = new BackgroundRunRegistry(100);
    workflowRow(registry);
    const notify = vi.fn(async () => true);
    const commands = createStallRepairCommands({ registry, notify });

    await expect(commands.notifyUser("watchdog notice")).resolves.toEqual({ ok: true });
    expect(notify).toHaveBeenCalledWith("watchdog notice", undefined);
    expect(registry.get("workflow-stale-1")?.state).toBe("running");
  });

  it("does not fake notify success when the port is missing, rejects, or throws", async () => {
    const registry = new BackgroundRunRegistry(100);
    await expect(createStallRepairCommands({ registry }).notifyUser("notice")).resolves.toEqual({
      ok: false,
      error: "notify-user 未接入通知端口",
    });
    await expect(
      createStallRepairCommands({ registry, notify: () => false }).notifyUser("notice"),
    ).resolves.toEqual({ ok: false, error: "notify-user 未确认入队" });
    await expect(
      createStallRepairCommands({
        registry,
        notify: () => {
          throw new Error("queue closed");
        },
      }).notifyUser("notice"),
    ).resolves.toEqual({ ok: false, error: "notify-user 失败：queue closed" });
  });

  it("pause-automation resolves automationId from the runId and pauses through the production port", async () => {
    const registry = new BackgroundRunRegistry(100);
    automationRow(registry);
    const pause = vi.fn(async () => true);
    const commands = createStallRepairCommands({
      registry,
      automation: { pause },
    });

    await expect(commands.pauseWorkspaceAutomation("ws:a", "auto-1:manual:run-1")).resolves.toEqual(
      { ok: true },
    );
    expect(pause).toHaveBeenCalledWith({ id: "auto-1" }, { workspaceKey: "ws:a" });
    // owner 回写 paused；命令面不写 registry。
    expect(registry.get("auto-1:manual:run-1")?.state).toBe("running");
  });

  it("pause-automation fails closed on missing port, invalid runId, wrong workspace, or non-automation row", async () => {
    const registry = new BackgroundRunRegistry(100);
    const missingPort = createStallRepairCommands({ registry });
    automationRow(registry, "auto-2:manual:run-2", "ws:other");
    automationRow(registry, "auto-bad", "ws:a");
    workflowRow(registry);
    const pause = vi.fn(async () => true);
    const commands = createStallRepairCommands({ registry, automation: { pause } });

    await expect(
      missingPort.pauseWorkspaceAutomation("ws:a", "auto-2:manual:run-2"),
    ).resolves.toEqual({ ok: false, error: "pause-automation 未接入 automation 端口" });
    await expect(commands.pauseWorkspaceAutomation("ws:a", "auto-2:manual:run-2")).resolves.toEqual(
      {
        ok: false,
        error: "pause-automation workspaceKey 不匹配：ws:a != ws:other",
      },
    );
    await expect(commands.pauseWorkspaceAutomation("ws:a", "auto-bad")).resolves.toEqual({
      ok: false,
      error: "pause-automation 无法解析 automation runId：auto-bad",
    });
    await expect(commands.pauseWorkspaceAutomation("ws:a", "workflow-stale-1")).resolves.toEqual({
      ok: false,
      error: "pause-automation 不支持行类型 workflow: workflow-stale-1",
    });
    expect(pause).not.toHaveBeenCalled();
  });

  it("pause-automation does not fake success when the automation is not active", async () => {
    const registry = new BackgroundRunRegistry(100);
    automationRow(registry);
    const commands = createStallRepairCommands({
      registry,
      automation: { pause: async () => false },
    });
    await expect(commands.pauseWorkspaceAutomation("ws:a", "auto-1:manual:run-1")).resolves.toEqual(
      {
        ok: false,
        error: "automation pause 未生效（非 active/不存在）：auto-1",
      },
    );
  });

  it("pause-goal sends through the injected goal command and leaves registry untouched", async () => {
    const registry = new BackgroundRunRegistry(100);
    const pauseGoal = vi.fn(async () => true);
    const commands = createStallRepairCommands({ registry, pauseGoal });

    await expect(commands.pauseGoal("goal-1")).resolves.toEqual({ ok: true });
    expect(pauseGoal).toHaveBeenCalledWith("goal-1");
    expect(registry.list()).toEqual([]);
  });

  it("pause-goal fails closed on missing port, not-effective, or command errors", async () => {
    const registry = new BackgroundRunRegistry(100);
    await expect(createStallRepairCommands({ registry }).pauseGoal("goal-1")).resolves.toEqual({
      ok: false,
      error: "pause-goal 未接入目标暂停端口",
    });
    await expect(
      createStallRepairCommands({ registry, pauseGoal: () => false }).pauseGoal("goal-1"),
    ).resolves.toEqual({ ok: false, error: "pause-goal 未生效：goal-1" });
    await expect(
      createStallRepairCommands({
        registry,
        pauseGoal: () => {
          throw new Error("store closed");
        },
      }).pauseGoal("goal-1"),
    ).resolves.toEqual({ ok: false, error: "pause-goal 失败：store closed" });
  });

  it("escalation resolves goal via async goalState and calls pause-goal", async () => {
    const registry = new BackgroundRunRegistry(100);
    workflowRow(registry);
    const pauseGoal = vi.fn(async () => true);
    const notify = vi.fn(async () => true);
    const commands = createStallRepairCommands({
      registry,
      workflowRun: { cancel: async () => false },
      pauseGoal,
      notify,
    });
    const watchdog = createSuperAgentWatchdog({
      registry,
      commands,
      goalState: {
        read: () => undefined,
        readAsync: async () => ({
          goalId: "goal-1",
          status: "active",
          openQuestionCount: 0,
        }),
      },
      now: () => 1_000,
      config: {
        escalationCooldownMs: 0,
        escalationFailureThreshold: 1,
        repairCooldownMs: 0,
      },
    });

    const report = await watchdog.tick(1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs);

    expect(pauseGoal).toHaveBeenCalledWith("goal-1");
    // 升级 notify 带最近一次 repair 的路由事实（该行无 owner/session ⇒ 两键均缺）。
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已暂停 goal goal-1"), {
      ownerSession: undefined,
      workspaceKey: undefined,
    });
    expect(report.escalations).toEqual([
      expect.objectContaining({
        consecutiveFailures: 1,
        goalPaused: true,
        notified: true,
      }),
    ]);
    expect(registry.get("workflow-stale-1")?.state).toBe("running");
  });

  it("probe hit on trigger backlog → notify-user reaches the notification port", async () => {
    const registry = new BackgroundRunRegistry(100);
    const notify = vi.fn(async () => true);
    const commands = createStallRepairCommands({ registry, notify });
    const watchdog = createSuperAgentWatchdog({
      registry,
      commands,
      triggerBacklog: {
        read: () => ({
          oldestAgeMs: DEFAULT_WATCHDOG_CONFIG.triggerBacklogAgeMs + 1,
          pendingCount: 2,
        }),
      },
      now: () => 1_000,
      config: { repairCooldownMs: 0 },
    });

    const report = await watchdog.tick(1_000);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("最老 candidate"),
      // backlog 目标无 registry 行 ⇒ 路由事实缺位，由端口显式失败而非盲投。
      { ownerSession: undefined, workspaceKey: undefined },
    );
    expect(report.repairs).toEqual([
      expect.objectContaining({
        probe: "trigger-backlog-age",
        action: "notify-user",
        ok: true,
      }),
    ]);
  });

  it("probe hit on workflow row → production command surface cancels the run", async () => {
    const registry = new BackgroundRunRegistry(100);
    workflowRow(registry);
    const workflowCancel = vi.fn(async () => true);
    const commands = createStallRepairCommands({
      registry,
      workflowRun: { cancel: workflowCancel },
    });
    const watchdog = createSuperAgentWatchdog({
      registry,
      commands,
      now: () => 1_000,
      config: { repairCooldownMs: 0 },
    });

    const now = 1_000 + DEFAULT_WATCHDOG_CONFIG.workflowStallMs;
    const report = await watchdog.tick(now);

    expect(workflowCancel).toHaveBeenCalledWith("workflow-stale-1", {});
    expect(report.repairs).toEqual([
      expect.objectContaining({
        probe: "workflow-run-stalled",
        targetId: "workflow-stale-1",
        action: "cancel-stalled",
        ok: true,
      }),
    ]);
    expect(registry.get("workflow-stale-1")?.state).toBe("running");
  });
});
