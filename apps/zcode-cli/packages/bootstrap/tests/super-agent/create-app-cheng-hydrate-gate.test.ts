import { describe, expect, it, vi } from "vitest";
import type { GoalChengRef, SessionGoal } from "@zcode/contracts";

import {
  isChengRowOwnedBySession,
  isWorkflowRowOwnedBySession,
  resolveTargetCompletionChengGate,
} from "../../src/app/create-app.js";

const JOB_ID = "a".repeat(64);

function chengRef(): GoalChengRef {
  return {
    jobId: JOB_ID,
    task: "p02_min2",
    planId: `cheng-plan://${JOB_ID}`,
  };
}

function target(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    sessionID: "session-a" as never,
    targetID: "target-a",
    objective: "Ship Cheng",
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

describe("cheng-job hydrate owner filter", () => {
  it("only accepts cheng-job rows owned by the current session", () => {
    expect(
      isChengRowOwnedBySession(
        { kind: "cheng-job", ownerSession: "session-a" },
        "session-a",
      ),
    ).toBe(true);
    // 别的会话/进程的 cheng job：本进程没有 cancel 命令面，不得捞进来。
    expect(
      isChengRowOwnedBySession(
        { kind: "cheng-job", ownerSession: "session-b" },
        "session-a",
      ),
    ).toBe(false);
    expect(isChengRowOwnedBySession({ kind: "cheng-job" }, "session-a")).toBe(false);
    // automation 行不经过该选择器，保持既有语义。
    expect(
      isChengRowOwnedBySession(
        { kind: "automation", ownerSession: "session-a" },
        "session-a",
      ),
    ).toBe(false);
  });
});

describe("workflow-run hydrate owner filter", () => {
  it("only accepts workflow rows owned by the current session", () => {
    expect(
      isWorkflowRowOwnedBySession(
        { kind: "workflow", ownerSession: "session-a" },
        "session-a",
      ),
    ).toBe(true);
    expect(
      isWorkflowRowOwnedBySession(
        { kind: "workflow", ownerSession: "session-b" },
        "session-a",
      ),
    ).toBe(false);
    expect(isWorkflowRowOwnedBySession({ kind: "workflow" }, "session-a")).toBe(false);
    expect(
      isWorkflowRowOwnedBySession(
        { kind: "cheng-job", ownerSession: "session-a" },
        "session-a",
      ),
    ).toBe(false);
  });
});

describe("target completion Cheng gate resolution", () => {
  it("returns undefined without a chengRef, even when a host resolver exists", async () => {
    const resolve = vi.fn(async () => ({
      ok: true,
      level: "PRODUCTION" as const,
      reasons: [],
    }));

    await expect(resolveTargetCompletionChengGate(target(), resolve)).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("fails closed with BLOCKED when the goal has a chengRef but no host resolver", async () => {
    await expect(
      resolveTargetCompletionChengGate(target({ chengRef: chengRef() }), undefined),
    ).resolves.toEqual({
      ok: false,
      level: "BLOCKED",
      reasons: ["cheng_host_unavailable"],
    });
  });

  it("delegates to the host resolver when both chengRef and resolver are present", async () => {
    const verdict = { ok: true, level: "PRODUCTION" as const, reasons: [] };
    const resolve = vi.fn(async () => verdict);
    const goal = target({ chengRef: chengRef() });

    await expect(resolveTargetCompletionChengGate(goal, resolve)).resolves.toBe(verdict);
    expect(resolve).toHaveBeenCalledWith(goal);
  });
});
