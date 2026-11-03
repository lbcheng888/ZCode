// super-agent-watchdog（M8 registry 投影 + M10 看门狗）实施测试。
// 锚：docs/architecture/super-agent-watchdog-spec.md §8 测试表——探针命中矩阵、
// 熔断升级、行所有权、repair 枚举校验、LLM 无进展裁决休眠。
import { describe, expect, it, vi } from "vitest";

import {
  BackgroundRunOwnershipError,
  BackgroundRunRegistry,
  DEFAULT_WATCHDOG_CONFIG,
  createBackgroundRunProjectionPort,
  createSuperAgentWatchdog,
  validateRepairAction,
  type SuperAgentWatchdogConfig,
  type SuperAgentWatchdogContract,
  type WatchdogRepairCommandSurface,
} from "../src/super-agent/watchdog/index.js";
import { superAgentWatchdogModule } from "../src/super-agent/watchdog/module.js";
// 跨包常量关系测试锚（spec §9 实施偏差 3）：心跳周期必须与探针 staleness 上限对表。
// 相对路径取 core 源码（先例：super-agent-spec-lane.test.ts），避免依赖 dist 新鲜度。
import {
  BACKGROUND_TASK_POLL_INTERVAL_MS,
  HEARTBEAT_TOUCH_PERIOD_MS,
} from "../../core/src/tool/executor/background-tasks.js";

function mockCommands(overrides?: Partial<WatchdogRepairCommandSurface>) {
  return {
    cancelStalledRun: vi.fn(async () => ({ ok: true })),
    pauseWorkspaceAutomation: vi.fn(async () => ({ ok: true })),
    notifyUser: vi.fn(async () => ({ ok: true })),
    pauseGoal: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } satisfies WatchdogRepairCommandSurface;
}

function watchdogFixture(options?: {
  config?: Partial<SuperAgentWatchdogConfig>;
  commands?: WatchdogRepairCommandSurface;
  goalState?: () => { goalId: string; status: "active" | "budget_limited"; openQuestionCount: number } | undefined;
  triggerBacklog?: () => { oldestAgeMs: number; pendingCount: number } | undefined;
  goalHint?: () => string | undefined;
  adjudicator?: {
    adjudicate: (input: {
      objectiveHint: string;
      recentActivity: string;
      zeroProgressStreak: number;
    }) => Promise<{ proposal: string; targetId?: string }>;
  };
}) {
  const registry = new BackgroundRunRegistry(100);
  const commands = options?.commands ?? mockCommands();
  const now = { value: 1_000_000 };
  const watchdog = createSuperAgentWatchdog({
    registry,
    commands,
    now: () => now.value,
    ...(options?.goalState ? { goalState: { read: options.goalState } } : {}),
    ...(options?.triggerBacklog ? { triggerBacklog: { read: options.triggerBacklog } } : {}),
    ...(options?.goalHint ? { goalHint: { read: options.goalHint } } : {}),
    ...(options?.adjudicator ? { adjudicator: options.adjudicator } : {}),
    config: { repairCooldownMs: 0, ...options?.config },
  });
  return { registry, commands, watchdog, now };
}

describe("探针命中矩阵（spec §2/§8）", () => {
  it("stalled workflow run ⇒ cancel-stalled（经命令面，不直写状态）", async () => {
    const { registry, commands, watchdog, now } = watchdogFixture();
    registry.register(
      {
        id: "run-stalled-1",
        kind: "workflow",
        owner: "dynamic-workflow",
        stallClockRef: "dwf-run:run-stalled-1",
        stalledSince: now.value - 60_000,
      },
      now.value,
    );

    const report = await watchdog.tick();

    expect(commands.cancelStalledRun).toHaveBeenCalledWith("run-stalled-1");
    expect(report.repairs).toEqual([
      expect.objectContaining({
        probe: "workflow-run-stalled",
        targetId: "run-stalled-1",
        action: "cancel-stalled",
        ok: true,
      }),
    ]);
    // 行权威不翻转：watchdog 不改 registry 行状态（终态由 owner 回写）。
    expect(registry.get("run-stalled-1")?.state).toBe("running");
  });

  it("cancel-stalled 拒绝无 stall 钟的 run（资格复核）", async () => {
    const { registry, commands, watchdog, now } = watchdogFixture();
    // 无 stallClockRef 的 workflow 行：即使 20min 钟按 staleness 命中也不进入 cancel 资格。
    registry.register(
      { id: "run-no-clock", kind: "workflow", owner: "dynamic-workflow" },
      now.value - 21 * 60_000,
    );

    await watchdog.tick();

    expect(commands.cancelStalledRun).not.toHaveBeenCalled();
  });

  it("registry-stall：声明心跳的 running 行超时 ⇒ notify-user", async () => {
    const { registry, commands, watchdog, now } = watchdogFixture();
    registry.register(
      { id: "bash-1", kind: "background_task", owner: "runtime-background-task", heartbeat: true },
      now.value - 120_000, // > stalenessCapMs 60s
    );

    const report = await watchdog.tick();

    expect(commands.notifyUser).toHaveBeenCalledWith(expect.stringContaining("registry-stall"));
    expect(report.repairs).toEqual([
      expect.objectContaining({ probe: "registry-stall", action: "notify-user", ok: true }),
    ]);
  });

  it("registry-stall：running 行未声明心跳 ⇒ skipped（数据源缺席，不误报）", async () => {
    const { registry, commands, watchdog, now } = watchdogFixture();
    // 事件驱动 owner 的健康长命行（automation 执行期等）：无周期回写承诺，不进判据。
    registry.register(
      { id: "auto-run-1", kind: "automation", owner: "automation", workspaceKey: "ws:a" },
      now.value - 30 * 60_000,
    );

    const report = await watchdog.tick();

    expect(report.probes.find((p) => p.probe === "registry-stall")).toEqual({
      probe: "registry-stall",
      status: "skipped",
      detail: "running 行均未声明 owner 心跳（数据源缺席）",
    });
    expect(commands.notifyUser).not.toHaveBeenCalled();
    expect(report.repairs).toHaveLength(0);
  });

  it("goal budget_limited 带未决问题 ⇒ notify-user", async () => {
    const { commands, watchdog } = watchdogFixture({
      goalState: () => ({ goalId: "goal-1", status: "budget_limited", openQuestionCount: 2 }),
    });

    const report = await watchdog.tick();

    expect(commands.notifyUser).toHaveBeenCalledWith(expect.stringContaining("goal-budget-limited"));
    expect(report.probes.find((p) => p.probe === "goal-budget-limited-open-questions")?.status).toBe(
      "hit",
    );
  });

  it("trigger 积压龄超阈值 ⇒ notify-user；端口缺席 ⇒ skipped", async () => {
    const { commands: commandsWithSource, watchdog: watchdogWithSource } = watchdogFixture({
      triggerBacklog: () => ({ oldestAgeMs: 15 * 60_000, pendingCount: 9 }),
    });
    const report = await watchdogWithSource.tick();
    expect(commandsWithSource.notifyUser).toHaveBeenCalledWith(
      expect.stringContaining("trigger-backlog-age"),
    );
    expect(report.probes.find((p) => p.probe === "trigger-backlog-age")?.status).toBe("hit");

    const { watchdog } = watchdogFixture();
    const bare = await watchdog.tick();
    expect(bare.probes.find((p) => p.probe === "trigger-backlog-age")).toEqual({
      probe: "trigger-backlog-age",
      status: "skipped",
      detail: "triggerBacklog 端口未挂载",
    });
  });

  it("未落地数据源探针恒 skipped（dispatch/daemon/permission/restart）", async () => {
    const { watchdog } = watchdogFixture();
    const report = await watchdog.tick();
    for (const probe of [
      "dispatch-pending-overage",
      "daemon-heartbeat",
      "permission-pending-overage",
      "restart-storm",
    ]) {
      expect(report.probes.find((p) => p.probe === probe)?.status).toBe("skipped");
    }
  });
});

describe("熔断升级（spec §4/§8）", () => {
  it("连续 N 次 repair 失败 ⇒ pause goal + 升级 notify；冷却窗内不重复升级", async () => {
    const { commands, watchdog, now } = watchdogFixture({
      config: { escalationFailureThreshold: 3, escalationCooldownMs: 600_000 },
      commands: mockCommands({
        cancelStalledRun: vi.fn(async () => ({ ok: false, error: "stream down" })),
      }),
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
    });
    watchdog.registerRun({
      id: "run-1",
      kind: "workflow",
      owner: "dynamic-workflow",
      stallClockRef: "dwf-run:run-1",
      stalledSince: now.value,
    });

    const first = await watchdog.tick();
    expect(first.escalations).toHaveLength(0);
    const second = await watchdog.tick();
    expect(second.escalations).toHaveLength(0);
    const third = await watchdog.tick();
    expect(third.escalations).toEqual([
      expect.objectContaining({ consecutiveFailures: 3, goalPaused: true, notified: true }),
    ]);
    expect(commands.pauseGoal).toHaveBeenCalledTimes(1);
    expect(commands.notifyUser).toHaveBeenCalledWith(expect.stringContaining("看门狗升级"));

    // 冷却窗内不再升级；升级成功已清零连续失败，此后需要新一轮 N 次失败。
    now.value += 1_000;
    const fourth = await watchdog.tick();
    expect(fourth.escalations).toHaveLength(0);
    expect(commands.pauseGoal).toHaveBeenCalledTimes(1);

    // 冷却窗过后、新一轮失败凑满 N ⇒ 再次升级。
    now.value += 600_000;
    await watchdog.tick(); // 失败 ×2
    const sixth = await watchdog.tick(); // 失败 ×3 → 升级
    expect(sixth.escalations).toEqual([
      expect.objectContaining({ consecutiveFailures: 3, goalPaused: true, notified: true }),
    ]);
    expect(commands.pauseGoal).toHaveBeenCalledTimes(2);
  });

  it("同轮 notify 成功不清零 cancel 失败计数（熔断只计状态变更类）", async () => {
    const { registry, commands, watchdog, now } = watchdogFixture({
      config: { escalationFailureThreshold: 2, escalationCooldownMs: 600_000 },
      commands: mockCommands({
        cancelStalledRun: vi.fn(async () => ({ ok: false, error: "stream down" })),
        notifyUser: vi.fn(async () => ({ ok: true })),
      }),
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
    });
    registry.register(
      {
        id: "run-1",
        kind: "workflow",
        owner: "dynamic-workflow",
        stallClockRef: "dwf-run:run-1",
        stalledSince: now.value,
      },
      now.value,
    );
    // 声明心跳且已超时的行：每轮 registry-stall 都会成功 notify。
    registry.register(
      { id: "alive-1", kind: "automation", owner: "automation", heartbeat: true },
      now.value - 120_000,
    );

    const first = await watchdog.tick();
    expect(first.repairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ probe: "registry-stall", action: "notify-user", ok: true }),
        expect.objectContaining({ probe: "workflow-run-stalled", action: "cancel-stalled", ok: false }),
      ]),
    );
    expect(first.escalations).toHaveLength(0);
    expect(watchdog.status().consecutiveRepairFailures).toBe(1);

    const second = await watchdog.tick();
    expect(second.escalations).toEqual([
      expect.objectContaining({ consecutiveFailures: 2, goalPaused: true }),
    ]);
    expect(commands.pauseGoal).toHaveBeenCalledTimes(1);
  });

  it("notify-user 失败不计入熔断（观察信道故障不触发升级）", async () => {
    const { registry, watchdog, now } = watchdogFixture({
      config: { escalationFailureThreshold: 1 },
      commands: mockCommands({
        notifyUser: vi.fn(async () => ({ ok: false, error: "notify channel down" })),
      }),
    });
    registry.register(
      { id: "alive-1", kind: "automation", owner: "automation", heartbeat: true },
      now.value - 120_000,
    );

    const report = await watchdog.tick();

    expect(report.repairs).toEqual([
      expect.objectContaining({ probe: "registry-stall", action: "notify-user", ok: false }),
    ]);
    expect(report.escalations).toHaveLength(0);
    expect(watchdog.status().consecutiveRepairFailures).toBe(0);
  });

  it("成功 repair 清零连续失败计数（不误升级）", async () => {
    const { commands, watchdog, now } = watchdogFixture({
      config: { escalationFailureThreshold: 2 },
      commands: mockCommands({
        cancelStalledRun: vi
          .fn<(id: string) => Promise<{ ok: boolean; error?: string }>>()
          .mockResolvedValueOnce({ ok: false, error: "boom" })
          .mockResolvedValue({ ok: true }),
      }),
    });
    watchdog.registerRun({
      id: "run-1",
      kind: "workflow",
      owner: "dynamic-workflow",
      stallClockRef: "dwf-run:run-1",
      stalledSince: now.value,
    });

    await watchdog.tick(); // 失败 ×1
    const recovered = await watchdog.tick(); // 成功 → 清零
    expect(recovered.escalations).toHaveLength(0);
    expect(watchdog.status().consecutiveRepairFailures).toBe(0);
    const third = await watchdog.tick(); // 再失败 ×1，不足 N
    expect(third.escalations).toHaveLength(0);
    expect(commands.pauseGoal).not.toHaveBeenCalled();
  });
});

describe("registry 行级所有权（spec §1.2/§8）", () => {
  it("第二写者（异 owner）settle/touch 被拒绝，行状态不变", () => {
    const registry = new BackgroundRunRegistry(10);
    registry.register(
      { id: "r1", kind: "workflow", owner: "dynamic-workflow", stallClockRef: "dwf-run:r1" },
      1_000,
    );

    expect(() => registry.settle("r1", "automation", "completed", 2_000)).toThrow(
      BackgroundRunOwnershipError,
    );
    expect(() => registry.touch("r1", "offpeak", { stalledSince: 2_000 }, 2_000)).toThrow(
      BackgroundRunOwnershipError,
    );
    expect(registry.get("r1")?.state).toBe("running");
    expect(registry.get("r1")?.stalledSince).toBeUndefined();

    // 行缺席 = no-op（投影不阻断业务路径），且不凭空建行。
    expect(() => registry.settle("ghost", "automation", "completed", 2_000)).not.toThrow();
    expect(registry.get("ghost")).toBeUndefined();

    // 同 owner 正常回写。
    registry.settle("r1", "dynamic-workflow", "completed", 3_000, {
      narrowResultRef: "artifact://r1",
    });
    expect(registry.get("r1")?.state).toBe("completed");
    expect(registry.get("r1")?.narrowResultRef).toBe("artifact://r1");
  });

  it("同 owner 重臂（终态行上 register）复位为新生命周期", () => {
    const registry = new BackgroundRunRegistry(10);
    registry.register({ id: "r1", kind: "workflow", owner: "dynamic-workflow" }, 1_000);
    registry.settle("r1", "dynamic-workflow", "cancelled", 2_000);
    registry.register(
      { id: "r1", kind: "workflow", owner: "dynamic-workflow", stallClockRef: "dwf-run:r1" },
      3_000,
    );
    const row = registry.get("r1");
    expect(row?.state).toBe("running");
    expect(row?.terminalAt).toBeUndefined();
    expect(row?.stallClockRef).toBe("dwf-run:r1");
  });

  it("投影端口按所有权规则写 registry（组合根接缝）", () => {
    const registry = new BackgroundRunRegistry(10);
    const port = createBackgroundRunProjectionPort(registry, () => 1_000);
    port.register({ id: "offpeak-1", kind: "offpeak", owner: "offpeak", workspaceKey: "ws:a" });
    port.touch("offpeak-1", "offpeak", {});
    expect(registry.get("offpeak-1")?.updatedAt).toBe(1_000);
    expect(() => port.settle("offpeak-1", "automation", "dropped")).toThrow(
      BackgroundRunOwnershipError,
    );
  });
});

describe("repair 枚举校验（spec §3/§8）", () => {
  it("未知动作拒绝执行，合法枚举通过", () => {
    expect(validateRepairAction("cancel-stalled")).toBe("cancel-stalled");
    expect(validateRepairAction("pause-automation")).toBe("pause-automation");
    expect(validateRepairAction("notify-user")).toBe("notify-user");
    expect(validateRepairAction("edit-prompt")).toBeNull();
    expect(validateRepairAction("self-modify")).toBeNull();
    expect(validateRepairAction({ action: "notify-user" })).toBeNull();
  });
});

describe("progress-vs-objective 与 LLM 无进展裁决（spec §5/§8）", () => {
  it("flag OFF：连续 K 轮零进展也不调用裁决器（dormant）", async () => {
    const adjudicator = {
      adjudicate: vi.fn(async () => ({ proposal: "notify-user" })),
    };
    const { watchdog } = watchdogFixture({
      config: { zeroProgressRounds: 3, llmNoProgressAdjudication: false },
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
      goalHint: () => "重构鉴权网关并补齐集成测试",
      adjudicator,
    });

    for (let i = 0; i < 5; i += 1) {
      const report = await watchdog.tick();
      expect(report.zeroProgressStreak).toBe(i + 1);
      expect(report.adjudicationFired).toBe(false);
    }
    expect(adjudicator.adjudicate).not.toHaveBeenCalled();
    expect(watchdog.status().zeroProgressStreak).toBe(5);
  });

  it("flag ON：K 轮后裁决一次，合法提案经命令面执行", async () => {
    const adjudicator = {
      adjudicate: vi.fn(async () => ({ proposal: "notify-user" })),
    };
    const { commands, watchdog } = watchdogFixture({
      config: { zeroProgressRounds: 2, llmNoProgressAdjudication: true },
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
      goalHint: () => "部署灰度开关并验证回滚路径",
      adjudicator,
    });

    await watchdog.tick(); // streak 1
    const second = await watchdog.tick(); // streak 2 → 裁决
    expect(adjudicator.adjudicate).toHaveBeenCalledTimes(1);
    expect(adjudicator.adjudicate).toHaveBeenCalledWith(
      expect.objectContaining({ zeroProgressStreak: 2 }),
    );
    expect(second.repairs).toEqual([
      expect.objectContaining({ probe: "progress-vs-objective", action: "notify-user", ok: true }),
    ]);
    // 每 streak 峰只裁决一次。
    await watchdog.tick();
    expect(adjudicator.adjudicate).toHaveBeenCalledTimes(1);
  });

  it("flag ON：未知提案被拒绝执行且不计入熔断", async () => {
    const adjudicator = {
      adjudicate: vi.fn(async () => ({ proposal: "edit-system-prompt" })),
    };
    const { commands, watchdog } = watchdogFixture({
      config: { zeroProgressRounds: 1, llmNoProgressAdjudication: true },
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
      goalHint: () => "整理发布说明并归档旧构建",
      adjudicator,
    });

    const report = await watchdog.tick();

    expect(adjudicator.adjudicate).toHaveBeenCalledTimes(1);
    expect(report.repairs).toHaveLength(0);
    expect(commands.cancelStalledRun).not.toHaveBeenCalled();
    expect(commands.notifyUser).not.toHaveBeenCalled();
    expect(watchdog.status().invalidProposalCount).toBe(1);
    expect(watchdog.status().consecutiveRepairFailures).toBe(0);
    expect(watchdog.status().adjudicationFiredForStreak).toBe(true);
  });

  it("近况关键词命中 ⇒ 进度条清零，不进入零进展", async () => {
    const adjudicator = {
      adjudicate: vi.fn(async () => ({ proposal: "notify-user" })),
    };
    const { registry, watchdog, now } = watchdogFixture({
      config: { zeroProgressRounds: 1, llmNoProgressAdjudication: true },
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
      goalHint: () => "修复 auth 网关 的重放漏洞",
      adjudicator,
    });
    registry.register(
      {
        id: "run-1",
        kind: "workflow",
        owner: "dynamic-workflow",
        narrowResultRef: "auth-gateway replay-fix patch ready",
      },
      now.value,
    );

    const report = await watchdog.tick();

    expect(report.zeroProgressStreak).toBe(0);
    expect(adjudicator.adjudicate).not.toHaveBeenCalled();
  });

  it("goalHint 端口缺席 ⇒ 跳过比较：streak 不自增、裁决器零调用、报告带原因", async () => {
    const adjudicator = {
      adjudicate: vi.fn(async () => ({ proposal: "notify-user" })),
    };
    const { watchdog } = watchdogFixture({
      config: { zeroProgressRounds: 1, llmNoProgressAdjudication: true },
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
      adjudicator,
    });

    for (let i = 0; i < 3; i += 1) {
      const report = await watchdog.tick();
      expect(report.zeroProgressStreak).toBe(0);
      expect(report.progressSkippedReason).toBe("goalHint 端口缺席或未返回提示");
      expect(report.adjudicationFired).toBe(false);
    }
    expect(adjudicator.adjudicate).not.toHaveBeenCalled();
  });

  it("goalHint read() 返回 undefined 或空关键词 ⇒ 同样跳过比较", async () => {
    for (const goalHint of [() => undefined, () => "   "]) {
      const adjudicator = {
        adjudicate: vi.fn(async () => ({ proposal: "notify-user" })),
      };
      const { watchdog } = watchdogFixture({
        config: { zeroProgressRounds: 1, llmNoProgressAdjudication: true },
        goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
        goalHint,
        adjudicator,
      });

      const report = await watchdog.tick();

      expect(report.zeroProgressStreak).toBe(0);
      expect(report.progressSkippedReason).toBeTruthy();
      expect(adjudicator.adjudicate).not.toHaveBeenCalled();
    }
  });

  it("streak 在 goalHint 缺席期间保持，恢复后继续计数", async () => {
    let hint: string | undefined = "推进 v2 协议迁移并补齐回归";
    const adjudicator = {
      adjudicate: vi.fn(async () => ({ proposal: "notify-user" })),
    };
    const { watchdog } = watchdogFixture({
      config: { zeroProgressRounds: 2, llmNoProgressAdjudication: true },
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
      goalHint: () => hint,
      adjudicator,
    });

    const first = await watchdog.tick(); // hint 在场，零命中 → streak 1
    expect(first.zeroProgressStreak).toBe(1);

    hint = undefined;
    const skipped = await watchdog.tick(); // 缺席：保持 1，不自增
    expect(skipped.zeroProgressStreak).toBe(1);
    expect(skipped.progressSkippedReason).toBe("goalHint 端口缺席或未返回提示");

    hint = "推进 v2 协议迁移并补齐回归";
    const third = await watchdog.tick(); // 恢复 → streak 2 → 裁决
    expect(third.zeroProgressStreak).toBe(2);
    expect(adjudicator.adjudicate).toHaveBeenCalledTimes(1);
  });

  it("裁决 cancel-stalled 带真实 stalled 行 targetId ⇒ 按行执行", async () => {
    const adjudicator = {
      adjudicate: vi.fn(async () => ({ proposal: "cancel-stalled", targetId: "run-1" })),
    };
    const { registry, commands, watchdog, now } = watchdogFixture({
      config: { zeroProgressRounds: 1, llmNoProgressAdjudication: true },
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
      goalHint: () => "推进 v2 协议迁移并补齐回归",
      adjudicator,
    });
    registry.register(
      {
        id: "run-1",
        kind: "workflow",
        owner: "dynamic-workflow",
        stallClockRef: "dwf-run:run-1",
        stalledSince: now.value,
      },
      now.value,
    );

    const report = await watchdog.tick();

    expect(commands.cancelStalledRun).toHaveBeenCalledWith("run-1");
    // 探针与裁决都指向同一真实行（探针先发，裁决按目标通道再发）。
    expect(report.repairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ probe: "workflow-run-stalled", action: "cancel-stalled", ok: true }),
        expect.objectContaining({
          probe: "progress-vs-objective",
          action: "cancel-stalled",
          targetId: "run-1",
          ok: true,
        }),
      ]),
    );
    // 执行用真实行，熔断计数走状态变更类通道（成功 → 清零）。
    expect(watchdog.status().consecutiveRepairFailures).toBe(0);
  });

  it("裁决 cancel-stalled 目标不可解析 / 指向健康行 ⇒ invalidProposal（不执行不计熔断）", async () => {
    for (const targetId of ["ghost-run", "run-healthy"]) {
      const adjudicator = {
        adjudicate: vi.fn(async () => ({ proposal: "cancel-stalled", targetId })),
      };
      const { registry, commands, watchdog, now } = watchdogFixture({
        config: { zeroProgressRounds: 1, llmNoProgressAdjudication: true },
        goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
        goalHint: () => "推进 v2 协议迁移并补齐回归",
        adjudicator,
      });
      // run-healthy：workflow 行恒带 stallClockRef，但未 stalled 且未满 20min —— 不合格。
      registry.register(
        { id: "run-healthy", kind: "workflow", owner: "dynamic-workflow", stallClockRef: "dwf-run:run-healthy" },
        now.value,
      );

      const report = await watchdog.tick();

      expect(report.repairs).toHaveLength(0);
      expect(commands.cancelStalledRun).not.toHaveBeenCalled();
      expect(watchdog.status().invalidProposalCount).toBe(1);
      expect(watchdog.status().consecutiveRepairFailures).toBe(0);
    }
  });

  it("裁决 pause-automation 经行 workspaceKey 定位", async () => {
    const adjudicator = {
      adjudicate: vi.fn(async () => ({ proposal: "pause-automation", targetId: "auto-1" })),
    };
    const { registry, commands, watchdog, now } = watchdogFixture({
      config: { zeroProgressRounds: 1, llmNoProgressAdjudication: true },
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
      goalHint: () => "推进 v2 协议迁移并补齐回归",
      adjudicator,
    });
    registry.register(
      { id: "auto-1", kind: "automation", owner: "automation", workspaceKey: "ws:9" },
      now.value,
    );

    const report = await watchdog.tick();

    expect(commands.pauseWorkspaceAutomation).toHaveBeenCalledWith("ws:9");
    expect(report.repairs).toEqual([
      expect.objectContaining({
        probe: "progress-vs-objective",
        action: "pause-automation",
        targetId: "auto-1",
        ok: true,
      }),
    ]);
    expect(watchdog.status().invalidProposalCount).toBe(0);
    expect(watchdog.status().consecutiveRepairFailures).toBe(0);
  });

  it("裁决 pause-automation 缺 targetId ⇒ invalidProposal（不执行不计熔断）", async () => {
    const adjudicator = {
      adjudicate: vi.fn(async () => ({ proposal: "pause-automation" })),
    };
    const { registry, commands, watchdog, now } = watchdogFixture({
      config: { zeroProgressRounds: 1, llmNoProgressAdjudication: true },
      goalState: () => ({ goalId: "goal-1", status: "active", openQuestionCount: 0 }),
      goalHint: () => "推进 v2 协议迁移并补齐回归",
      adjudicator,
    });
    registry.register(
      { id: "auto-1", kind: "automation", owner: "automation", workspaceKey: "ws:9" },
      now.value,
    );

    const report = await watchdog.tick();

    expect(report.repairs).toHaveLength(0);
    expect(commands.pauseWorkspaceAutomation).not.toHaveBeenCalled();
    expect(watchdog.status().invalidProposalCount).toBe(1);
    expect(watchdog.status().consecutiveRepairFailures).toBe(0);
  });
});

describe("契约面（与模块内 contract.test 同断言；CLI vitest include 不收集 src/**，在此保底执行）", () => {
  it("模块清单与 policy 一致（requires 空、提供 super-agent-watchdog）", () => {
    expect(superAgentWatchdogModule.id).toBe("super-agent-watchdog");
    expect(superAgentWatchdogModule.requires).toEqual([]);
    expect(superAgentWatchdogModule.provides).toContain("super-agent-watchdog");
  });

  it("LLM 无进展裁决缺省 OFF", () => {
    expect(DEFAULT_WATCHDOG_CONFIG.llmNoProgressAdjudication).toBe(false);
  });

  it("实现暴露契约的八个方法", () => {
    const contract: SuperAgentWatchdogContract = createSuperAgentWatchdog({
      registry: new BackgroundRunRegistry(10),
      commands: mockCommands(),
    });
    for (const method of [
      "registerRun",
      "settleRun",
      "touchRun",
      "listRuns",
      "start",
      "stop",
      "tick",
      "status",
    ] as const) {
      expect(typeof contract[method]).toBe("function");
    }
  });
});

describe("生命周期（spec §6）", () => {
  it("start/stop 幂等；stop 等待在途 tick", async () => {
    const { watchdog } = watchdogFixture({ config: { tickIntervalMs: 60_000 } });
    expect(watchdog.status().running).toBe(false);
    watchdog.start();
    watchdog.start();
    expect(watchdog.status().running).toBe(true);
    await watchdog.stop();
    expect(watchdog.status().running).toBe(false);
    await watchdog.stop(); // 未启动再 stop = no-op
  });
});

// owner 心跳接线（spec §9 实施偏差 1/3）：core 侧周期 touch 与本探针 staleness 上限必须对表。
describe("owner 心跳周期与 registry-stall 判据（spec §9）", () => {
  it("心跳周期 + 轮询粒度严格小于 stalenessCapMs（等号即竞态）", () => {
    expect(HEARTBEAT_TOUCH_PERIOD_MS).toBeLessThan(DEFAULT_WATCHDOG_CONFIG.stalenessCapMs);
    expect(HEARTBEAT_TOUCH_PERIOD_MS + BACKGROUND_TASK_POLL_INTERVAL_MS).toBeLessThan(
      DEFAULT_WATCHDOG_CONFIG.stalenessCapMs,
    );
  });

  it("registry-stall：周期到期前不命中；到期后最坏采样点仍不命中；无回写超上限才命中", async () => {
    const { registry, commands, watchdog, now } = watchdogFixture();
    registry.register(
      { id: "bash-hb", kind: "background_task", owner: "runtime-background-task", heartbeat: true },
      now.value,
    );

    // 到期前（周期 - 1ms）：健康行不命中。
    now.value += HEARTBEAT_TOUCH_PERIOD_MS - 1;
    let report = await watchdog.tick();
    expect(report.probes.find((p) => p.probe === "registry-stall")).toEqual({
      probe: "registry-stall",
      status: "ok",
    });

    // 到期后最坏采样龄 = 周期 + 轮询粒度（下一触尚未落地）：仍不命中——
    // 这正是「周期必须严格小于 stalenessCapMs 并留粒度余量」钉住的窗口。
    now.value += 1 + BACKGROUND_TASK_POLL_INTERVAL_MS;
    report = await watchdog.tick();
    expect(report.probes.find((p) => p.probe === "registry-stall")).toEqual({
      probe: "registry-stall",
      status: "ok",
    });
    expect(commands.notifyUser).not.toHaveBeenCalled();

    // 对照：停止回写超过 stalenessCapMs 才 hit（周期接错时此对照不改变前两格的结论）。
    now.value += DEFAULT_WATCHDOG_CONFIG.stalenessCapMs;
    report = await watchdog.tick();
    expect(report.probes.find((p) => p.probe === "registry-stall")).toEqual(
      expect.objectContaining({ probe: "registry-stall", status: "hit" }),
    );
    expect(commands.notifyUser).toHaveBeenCalledWith(expect.stringContaining("registry-stall"));
  });
});
