import { describe, expect, it, vi } from "vitest";
import type { ModelToolCall } from "@zcode/contracts";

import { createToolAdjudicationSession } from "../../src/app/super-agent-control-plane.js";

const JOB_ID = "a".repeat(64);

describe("adjudication tool session", () => {
  it("loads allowlisted read-only tools, executes calls, feeds results back, and never exposes generate", async () => {
    const contracts = [{ name: "ChengInspect" }, { name: "ChengPlan" }];
    const executed: ModelToolCall[] = [];
    const generateInputs: Array<{
      messages: readonly unknown[];
      tools: readonly { name: string }[];
    }> = [];
    let calls = 0;
    const close = vi.fn(async () => {});
    const session = createToolAdjudicationSession({
      createRuntime: () => ({
        toolContracts: contracts as never,
        async generateText({ messages, tools }) {
          generateInputs.push({ messages, tools });
          calls += 1;
          if (calls === 1) {
            return {
              text: "",
              selection: {} as never,
              finishReason: "tool_calls",
              usage: { inputTokens: 10, outputTokens: 2 },
              toolCalls: [
                {
                  id: "call-plan",
                  name: "ChengPlan",
                  input: { jobId: JOB_ID, task: "p02_min2" },
                },
              ],
            };
          }
          return {
            text: '{"decisions":[]}',
            selection: {} as never,
            finishReason: "stop",
            usage: { inputTokens: 20, outputTokens: 5 },
          };
        },
        async executeToolCall(call) {
          executed.push(call);
          return { content: '{"status":"ok","plan":{"kind":"cheng_plan"}}', isError: false };
        },
        close,
      }),
      abortSignal: new AbortController().signal,
    });

    const result = await session.run({
      workspaceIdentity: "ws-a",
      sessionKey: "ws-a",
      prompt: "adjudicate",
      candidateCount: 1,
      toolAllowlist: ["Recall", "GoalRead", "ChengInspect", "ChengPlan"],
      toolDisallowlist: ["ChengGenerate", "ChengVerify", "ChengExplain"],
      modelTier: "adjudicator",
      scheduling: "background-low-priority",
    });

    expect(result.outputText).toBe('{"decisions":[]}');
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 7 });
    expect(result.chengPlanReceipts).toEqual([
      { planId: `cheng-plan://${JOB_ID}`, jobId: JOB_ID, task: "p02_min2" },
    ]);
    expect(executed).toEqual([
      expect.objectContaining({ name: "ChengPlan", input: { jobId: JOB_ID, task: "p02_min2" } }),
    ]);
    // 模型只看到白名单里的只读工具面；generate/verify 从未作为 contract 暴露。
    expect(generateInputs[0]?.tools.map((tool) => tool.name)).toEqual([
      "ChengInspect",
      "ChengPlan",
    ]);
    expect(generateInputs[1]?.tools.map((tool) => tool.name)).toEqual([
      "ChengInspect",
      "ChengPlan",
    ]);
    expect(generateInputs[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", toolName: "ChengPlan", isError: false }),
      ]),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refuses a tool call outside the allowlist instead of executing it", async () => {
    const executed: ModelToolCall[] = [];
    const toolMessages: unknown[] = [];
    let calls = 0;
    const session = createToolAdjudicationSession({
      createRuntime: () => ({
        toolContracts: [{ name: "ChengInspect" }] as never,
        async generateText({ messages }) {
          calls += 1;
          if (calls === 1) {
            return {
              text: "",
              selection: {} as never,
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-generated",
                  name: "ChengGenerate",
                  input: {},
                },
              ],
            };
          }
          toolMessages.push(...messages);
          return { text: "done", selection: {} as never, finishReason: "stop" };
        },
        async executeToolCall(call) {
          executed.push(call);
          return { content: "should not run", isError: false };
        },
      }),
      abortSignal: new AbortController().signal,
    });

    const result = await session.run({
      workspaceIdentity: "ws-a",
      sessionKey: "ws-a",
      prompt: "adjudicate",
      candidateCount: 1,
      toolAllowlist: ["ChengInspect"],
      toolDisallowlist: ["ChengGenerate", "ChengVerify"],
      modelTier: "adjudicator",
      scheduling: "background-low-priority",
    });

    expect(result.outputText).toBe("done");
    expect(executed).toEqual([]);
    expect(toolMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolName: "ChengGenerate",
          isError: true,
          content: expect.stringContaining("tool not allowed"),
        }),
      ]),
    );
  });
});
