import { describe, expect, it } from "vitest";

import { superAgentIntakeModule } from "./module.js";
import { TRIGGER_PAYLOAD_MAX_BYTES } from "./trigger-events.js";
import { mintBotThreadDomainKey, mintThreadKey } from "./fast-path.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("super-agent-intake contract", () => {
  it("declares its module manifest", () => {
    expect(superAgentIntakeModule.id).toBe("super-agent-intake");
    expect(superAgentIntakeModule.requires).toEqual([]);
    expect(superAgentIntakeModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("payload 上限 64KB（spec §1.2）", () => {
    expect(TRIGGER_PAYLOAD_MAX_BYTES).toBe(64 * 1024);
  });

  it("信道域键格式与出口/回填三方一致：bot:<botId>+<peer>[/<threadId>]", () => {
    expect(mintBotThreadDomainKey({ botId: "b1", peerId: "u1" })).toBe("bot:b1+u1");
    expect(mintBotThreadDomainKey({ botId: "b1", peerId: "chat-9", threadId: "t1" })).toBe(
      "bot:b1+chat-9/t1",
    );
    expect(mintThreadKey("ws-a", "bot:b1+u1")).toBe("ws-a|bot:b1+u1");
  });
});
