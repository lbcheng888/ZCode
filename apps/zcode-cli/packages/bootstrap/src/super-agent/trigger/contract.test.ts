import { describe, expect, it } from "vitest";

import { superAgentTriggerModule } from "./module.js";
import type { SuperAgentTriggerContract } from "./contract.js";
import { createTriggerSubsystem } from "./impl.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("super-agent-trigger contract", () => {
  it("declares its module manifest", () => {
    expect(superAgentTriggerModule.id).toBe("super-agent-trigger");
    expect(superAgentTriggerModule.requires).toEqual(["shared"]);
    expect(superAgentTriggerModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("契约面 = 订阅 / 路由 / 分派 / verdict / leader 五族，一个意图一个方法", () => {
    // 期望表 = spec §2.1 + §3.3 声明序；新增/删除方法必须先改契约注释再改此表。
    const expected: (keyof SuperAgentTriggerContract)[] = [
      "upsertSubscription",
      "revokeSubscription",
      "sweepExpiredLeases",
      "renewActiveLeases",
      "routeOwned",
      "dispatchHumanExplicit",
      "applyVerdicts",
      "tryClaimLeadership",
      "heartbeatLeadership",
    ];
    const subsystem = createTriggerSubsystem({
      db: null as never,
      delivery: { deliver: async () => ({ status: "admitted" as const }) },
      worker: {
        findWorkerByThreadKey: () => undefined,
        resume: async () => ({ sessionId: "s" }),
        createTask: async () => ({ sessionId: "s" }),
      },
      decisionLog: { record: () => undefined },
    });
    // 从实现实例枚举键名与期望表比对（同义反复的字面量自比较无法失败）：
    // 实现面多方法/少方法在这里运行时暴露；类型面由返回类型注解
    // `: SuperAgentTriggerContract` 在编译期把关。
    expect(Object.keys(subsystem).sort()).toEqual([...expected].sort());
    for (const name of expected) {
      expect(typeof subsystem[name]).toBe("function");
    }
  });
});
