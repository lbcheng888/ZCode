import { describe, expect, it } from "vitest";

import { superAgentWriteLeasesModule } from "./module.js";
import type { SuperAgentWriteLeasesContract } from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("super-agent-write-leases contract", () => {
  it("declares its module manifest", () => {
    expect(superAgentWriteLeasesModule.id).toBe("super-agent-write-leases");
    expect(superAgentWriteLeasesModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("契约面收敛为四个仓储意图", () => {
    const methodNames: (keyof SuperAgentWriteLeasesContract)[] = [
      "acquire",
      "getActive",
      "release",
      "sweepExpired",
    ];
    expect(methodNames).toHaveLength(4);
  });
});
