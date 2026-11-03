// prompt-admission 触发来源枚举与 wire schema 同源合同（spec §2.2 / 设计 §7 Upgrade）。
import { describe, expect, it } from "vitest";
import {
  promptTriggerSourceSchema,
  parseCommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import {
  promptTriggerSourceOf,
  type PromptTriggerSource,
} from "../src/runtime/methods/prompt-admission.js";

describe("prompt-admission 触发来源枚举（与 shared wire schema 同步）", () => {
  it("枚举值集 = wire schema 值集（两侧同一定义，无第二份字面量）", () => {
    const fromSchema = promptTriggerSourceSchema.options;
    const fromAdmission: PromptTriggerSource[] = ["user", "trigger"];
    expect([...fromSchema].sort()).toEqual([...fromAdmission].sort());
  });

  it("信封带 triggerId → trigger；缺省/空 → user", () => {
    expect(promptTriggerSourceOf({ triggerId: "trigger-1" })).toBe("trigger");
    expect(promptTriggerSourceOf({ triggerId: "  " })).toBe("user");
    expect(promptTriggerSourceOf({ triggerId: null })).toBe("user");
    expect(promptTriggerSourceOf({})).toBe("user");
  });

  it("wire 信封 triggerId 经 parse 后与 promptTriggerSourceOf 推导一致（合同端到端）", () => {
    const parsed = parseCommandEnvelope({
      commandId: "trig-1:session-a",
      clientId: "trigger-router",
      sessionId: "session-a",
      type: "sendText",
      payload: { text: "hi" },
      issuedAt: 1,
      triggerId: "trigger-1",
      taint: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(promptTriggerSourceOf(parsed.envelope)).toBe("trigger");

    const legacy = parseCommandEnvelope({
      commandId: "cmd-legacy",
      clientId: "desktop",
      sessionId: "session-a",
      type: "sendText",
      payload: { text: "hi" },
      issuedAt: 1,
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(promptTriggerSourceOf(legacy.envelope)).toBe("user");
  });
});
