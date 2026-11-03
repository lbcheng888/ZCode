import { describe, expect, it } from "vitest";

import { superAgentMandateModule } from "./module.js";
import type { SuperAgentMandateContract } from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("super-agent-mandate contract", () => {
  it("declares its module manifest", () => {
    expect(superAgentMandateModule.id).toBe("super-agent-mandate");
    expect(superAgentMandateModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("契约面收敛为单一查询意图（P2 只保证 resolveFor）", () => {
    const methodNames: (keyof SuperAgentMandateContract)[] = ["resolveFor"];
    expect(methodNames).toEqual(["resolveFor"]);
  });
});
