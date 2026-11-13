import { describe, expect, it } from "vitest";
import { buildBestPlanSection, createContextBuilder } from "../src/context/index.js";

const envInfo = {
  cwd: "/workspace",
  platform: "linux",
  shell: "bash",
  osVersion: "Linux 6.6.0",
  nodeVersion: "v24.14.0",
} as const;

const IDENTITY_OPENING =
  "You are an agent working with the user toward their goals, using your own judgment along the way.";

// 六个字段与 ProposeBestPlan 的 schema 同字面。
const PROTOCOL_FIELDS = [
  "summary",
  "currentEvidence",
  "candidateOptions",
  "recommendation",
  "impact",
  "verification",
] as const;

function systemText(config: Parameters<typeof createContextBuilder>[0]): string {
  return createContextBuilder(config)
    .build()
    .systemMessages.map((message) => String(message.content))
    .join("\n");
}

describe("context builder — best plan protocol", () => {
  it("injects the protocol into the stable system body after the identity when the tool is available", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      guidanceToolNames: ["Read", "Edit", "ProposeBestPlan"],
    }).build();

    const section = result.sections.find((candidate) => candidate.source === "best_plan");
    expect(section).toMatchObject({
      name: "Best Plan Protocol",
      source: "best_plan",
      injectionTarget: "system",
      cacheHint: "stable",
    });
    expect(section?.tokens).toBeGreaterThan(0);

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    expect(stableBody).toContain("# Best plan");
    expect(stableBody).toContain("第一次写/改/执行类工具调用或实质回答之前");
    expect(stableBody).toContain("同一轮只调用一次");
    expect(stableBody.indexOf(IDENTITY_OPENING)).toBeGreaterThanOrEqual(0);
    expect(stableBody.indexOf("# Best plan")).toBeGreaterThan(stableBody.indexOf(IDENTITY_OPENING));
    // 协议是稳定段，不混进动态 system block。
    expect(String(result.systemMessages[2]?.content ?? "")).not.toContain("# Best plan");
  });

  it("leaves no trace when the tool is absent from the tool table", () => {
    const withoutToolName = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      guidanceToolNames: ["Read", "Edit"],
    }).build();
    const withoutToolTable = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
    }).build();

    for (const result of [withoutToolName, withoutToolTable]) {
      expect(result.sections.some((section) => section.source === "best_plan")).toBe(false);
      expect(
        result.systemMessages.map((message) => String(message.content)).join("\n"),
      ).not.toContain("# Best plan");
    }
  });

  it("does not inject the protocol for a workflow actor", () => {
    const text = systemText({
      workingDirectory: "/workspace",
      envInfo,
      guidanceToolNames: ["ProposeBestPlan", "submit_result", "escalate"],
      workflowActor: { name: "reviewer" },
    });

    expect(text).not.toContain("# Best plan");
    expect(text).not.toContain("ProposeBestPlan");
  });

  it("does not inject the protocol under a custom system prompt", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      customSystemPrompt: "You are concise for this task.",
      guidanceToolNames: ["ProposeBestPlan"],
    }).build();

    expect(result.sections.some((section) => section.source === "best_plan")).toBe(false);
    expect(result.systemMessages[1]?.content).toBe("\nYou are concise for this task.");
  });

  it("states the six fields, the ordering rule, and the execution contract", () => {
    const content = buildBestPlanSection().content;

    expect(content).toContain("# Best plan");
    expect(content).toContain("`ProposeBestPlan`");
    for (const field of PROTOCOL_FIELDS) {
      expect(content).toContain(`\`${field}\``);
    }
    expect(content).toContain("至少两个真实候选");
    expect(content).toContain("代价");
    expect(content).toContain("不等待用户批准");
    expect(content).toContain("正文之前");
    expect(content).toContain("子代理不适用");
    expect(content).toContain("不要为子代理产卡");
  });
});
