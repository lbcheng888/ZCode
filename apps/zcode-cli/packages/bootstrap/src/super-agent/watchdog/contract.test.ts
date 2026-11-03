import { describe, expect, it } from "vitest";

import {
  BackgroundRunOwnershipError,
  REPAIR_ACTIONS,
  type SuperAgentWatchdogContract,
} from "./contract.js";
import { createBackgroundRunProjectionPort } from "./composition.js";
import { validateRepairAction } from "./repair.js";
import { BackgroundRunRegistry } from "./registry.js";
import { DEFAULT_WATCHDOG_CONFIG, createSuperAgentWatchdog } from "./watchdog.js";
import { superAgentWatchdogModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("super-agent-watchdog contract", () => {
  it("declares its module manifest", () => {
    expect(superAgentWatchdogModule.id).toBe("super-agent-watchdog");
    expect(superAgentWatchdogModule.requires).toEqual([]);
    expect(superAgentWatchdogModule.provides).toContain("super-agent-watchdog");
  });

  it("exposes the eight contract methods on the implementation", () => {
    const watchdog = createSuperAgentWatchdog({
      registry: new BackgroundRunRegistry(10),
      commands: {
        cancelStalledRun: async () => ({ ok: true }),
        pauseWorkspaceAutomation: async () => ({ ok: true }),
        notifyUser: async () => ({ ok: true }),
        pauseGoal: async () => ({ ok: true }),
      },
    });
    const contract: SuperAgentWatchdogContract = watchdog;
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

  it("rejects unknown repair actions and accepts the typed enum", () => {
    expect(validateRepairAction("cancel-stalled")).toBe("cancel-stalled");
    expect(validateRepairAction("pause-automation")).toBe("pause-automation");
    expect(validateRepairAction("notify-user")).toBe("notify-user");
    expect(validateRepairAction("edit-prompt")).toBeNull();
    expect(validateRepairAction("")).toBeNull();
    expect(validateRepairAction(42)).toBeNull();
    expect([...REPAIR_ACTIONS]).toEqual(["cancel-stalled", "pause-automation", "notify-user"]);
  });

  it("enforces row ownership through the projection port", () => {
    const registry = new BackgroundRunRegistry(10);
    const port = createBackgroundRunProjectionPort(registry, () => 1_000);
    port.register({ id: "r1", kind: "workflow", owner: "dynamic-workflow" });
    expect(() =>
      port.settle("r1", "automation", "completed"),
    ).toThrow(BackgroundRunOwnershipError);
    expect(() =>
      port.touch("r1", "offpeak", { stalledSince: 1 }),
    ).toThrow(BackgroundRunOwnershipError);
    expect(registry.get("r1")?.state).toBe("running");
    // 同 owner 终态回写成功。
    port.settle("r1", "dynamic-workflow", "completed");
    expect(registry.get("r1")?.state).toBe("completed");
  });

  it("keeps LLM adjudication off by default", () => {
    expect(DEFAULT_WATCHDOG_CONFIG.llmNoProgressAdjudication).toBe(false);
  });
});
