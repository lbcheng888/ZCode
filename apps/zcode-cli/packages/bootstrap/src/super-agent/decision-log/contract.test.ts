import { describe, expect, it } from "vitest";

import { superAgentDecisionLogModule } from "./module.js";
import { DECISION_LOG_RETENTION_DAYS } from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("super-agent-decision-log contract", () => {
  it("declares its module manifest", () => {
    expect(superAgentDecisionLogModule.id).toBe("super-agent-decision-log");
    expect(superAgentDecisionLogModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("TTL 是 90 天滚动窗口（M9 / spec §1.7）", () => {
    expect(DECISION_LOG_RETENTION_DAYS).toBe(90);
  });
});
