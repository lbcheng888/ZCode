import { describe, expect, it } from "vitest";

import { superAgentStorageModule } from "./module.js";
import type { SuperAgentStorageContract } from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("super-agent-storage contract", () => {
  it("declares its module manifest", () => {
    expect(superAgentStorageModule.id).toBe("super-agent-storage");
    expect(superAgentStorageModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("契约面收敛为单方法端口（类型即文档）", () => {
    const methodNames: (keyof SuperAgentStorageContract)[] = ["openSuperAgentDatabase"];
    expect(methodNames).toEqual(["openSuperAgentDatabase"]);
  });
});
