import { describe, expect, it, vi } from "vitest";
import type { SessionGoal } from "@zcode/contracts";

import { createWatchdogGoalControl } from "../src/app/watchdog-goal-control.js";

function target(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    sessionID: "session-1" as never,
    targetID: "goal-1",
    objective: "keep working",
    summaryTitle: null,
    status: "active",
    revision: 1,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 1, updated: 1 },
    ...overrides,
  };
}

function control(targetValue: SessionGoal | null, pausedValue?: SessionGoal | null) {
  const pauseTarget = vi.fn(async () =>
    pausedValue === undefined
      ? target({ ...(targetValue ?? undefined), status: "paused" })
      : pausedValue,
  );
  const stopActiveForegroundExecution = vi.fn();
  const recordTargetChanged = vi.fn(async () => undefined);
  const instance = createWatchdogGoalControl({
    readTarget: async () => targetValue,
    pauseTarget,
    stopActiveForegroundExecution,
    recordTargetChanged,
  });
  return { instance, pauseTarget, stopActiveForegroundExecution, recordTargetChanged };
}

describe("watchdog goal control", () => {
  it("maps the current target into async goal state", async () => {
    const { instance } = control(target());
    await expect(instance.goalState.readAsync?.()).resolves.toEqual({
      goalId: "goal-1",
      status: "active",
      openQuestionCount: 0,
    });
    expect(instance.goalState.read()).toMatchObject({ goalId: "goal-1" });
  });

  it("pauses the current active target, stops foreground work, and records the change", async () => {
    const { instance, pauseTarget, stopActiveForegroundExecution, recordTargetChanged } =
      control(target());

    await expect(instance.pauseGoal("goal-1")).resolves.toBe(true);
    expect(pauseTarget).toHaveBeenCalledWith({
      status: "paused",
      reason: "watchdog-escalation",
    });
    expect(stopActiveForegroundExecution).toHaveBeenCalledTimes(1);
    expect(recordTargetChanged).toHaveBeenCalledWith({
      previousTarget: expect.objectContaining({ targetID: "goal-1", status: "active" }),
      target: expect.objectContaining({ targetID: "goal-1", status: "paused" }),
    });
  });

  it("is idempotent for an already paused goal and rejects non-active/mismatched goals", async () => {
    const paused = control(target({ status: "paused" }));
    await expect(paused.instance.pauseGoal("goal-1")).resolves.toBe(true);
    expect(paused.pauseTarget).not.toHaveBeenCalled();

    const complete = control(target({ status: "complete" }));
    await expect(complete.instance.pauseGoal("goal-1")).resolves.toBe(false);
    expect(complete.pauseTarget).not.toHaveBeenCalled();

    const other = control(target({ targetID: "goal-2" }));
    await expect(other.instance.pauseGoal("goal-1")).resolves.toBe(false);
    expect(other.pauseTarget).not.toHaveBeenCalled();
  });

  it("does not report success when the store did not pause the requested target", async () => {
    const missing = control(target(), null);
    await expect(missing.instance.pauseGoal("goal-1")).resolves.toBe(false);
    expect(missing.stopActiveForegroundExecution).not.toHaveBeenCalled();
    expect(missing.recordTargetChanged).not.toHaveBeenCalled();

    const replaced = control(target(), target({ targetID: "goal-2", status: "paused" }));
    await expect(replaced.instance.pauseGoal("goal-1")).resolves.toBe(false);
    expect(replaced.recordTargetChanged).not.toHaveBeenCalled();
  });
});
