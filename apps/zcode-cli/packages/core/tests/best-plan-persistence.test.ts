// persistSyntheticToolPart（super-agent 注入卡片的 transcript 事实化）：
// runtime.executeTools 只发事件不落 tool part，冷恢复 hydration 只读 message 的
// tool part（bootstrap transcript-hydration.ts synthesizeToolPart），这里验证合成
// assistant message + completed tool part 的字段满足该读取所需，同 callID 幂等，
// 且 parent user message 缺失时原样抛错、不静默挂空。
import { describe, expect, it } from "vitest";
import type {
  MessageInfo,
  MessagePart,
  MessageWithParts,
  ToolPart,
  TraceContext,
} from "@zcode/contracts";
import {
  createMessageId,
  createPartId,
  createSessionId,
  createTraceId,
  createTurnId,
} from "@zcode/contracts";
import {
  persistAssistantMessage,
  persistMessage,
  persistPart,
  persistSyntheticToolPart,
} from "../src/runtime/methods/message-persistence.js";

function createHarness() {
  const sessionID = createSessionId("best-plan-persistence");
  const savedMessages: MessageInfo[] = [];
  const savedParts: MessagePart[] = [];
  // 预置的 store 行：模拟重启后已持久化的 transcript。
  const storeRows: MessageWithParts[] = [];
  const fakeRuntime = {
    latestConversationMessageId: undefined as string | undefined,
    latestAssistantMessageId: undefined as string | undefined,
    latestAssistantTurnId: undefined as string | undefined,
    sessionId: sessionID,
    sessionStore: {
      async saveMessage(input: MessageInfo) {
        savedMessages.push(input);
      },
      async savePart(input: MessagePart) {
        savedParts.push(input);
      },
      async messages(): Promise<MessageWithParts[]> {
        return [
          ...storeRows,
          ...savedMessages.map((info) => ({
            info,
            parts: savedParts.filter((part) => part.messageID === info.id),
          })),
        ];
      },
    },
    rootTraceContext: { traceId: createTraceId(), sessionId: sessionID },
    workingDirectory: "/tmp/w",
    workspaceRoot: "/tmp/w",
    config: { systemPrompt: "sys" },
    getSessionModelSelection: () => undefined,
    getPlanEnabled: () => false,
    // 挂真实持久化函数：测试走 message → store 的同一条链路。
    persistMessage,
    persistPart,
    persistAssistantMessage,
    logger: undefined,
  };
  return { sessionID, savedMessages, savedParts, storeRows, fakeRuntime };
}

function trace(turnId?: ReturnType<typeof createTurnId>): TraceContext {
  return { traceId: createTraceId(), turnId };
}

describe("persistSyntheticToolPart", () => {
  it("落 assistant message + completed tool part，字段满足 hydration 合成所需", async () => {
    const { savedMessages, savedParts, fakeRuntime } = createHarness();
    const turnId = createTurnId();
    const parentId = createMessageId();
    const startedAt = 1_000;
    const endedAt = 1_500;

    const result = await persistSyntheticToolPart.call(
      fakeRuntime as never,
      {
        turnId,
        parentUserMessageId: parentId,
        toolCallId: "tool_card_1",
        toolName: "ProposeBestPlan",
        input: { summary: "s", candidateOptions: [] },
        output: { ok: true, planId: "abc" },
        startedAt,
        endedAt,
      },
      trace(turnId),
    );

    expect(savedMessages).toHaveLength(1);
    const message = savedMessages[0];
    expect(message?.role).toBe("assistant");
    if (message?.role !== "assistant") return;
    // assistant 行缺 time.completed 且无 error 时冷路径判 cancelled，必须带 completed。
    expect(message.id).toBe(result.assistantMessageId);
    expect(message.parentID).toBe(parentId);
    expect(message.time.created).toBe(startedAt);
    expect(message.time.completed).toBe(endedAt);
    // anchor.turnId 决定冷恢复轮归属。
    expect(message.anchor).toMatchObject({ turnId });

    expect(savedParts).toHaveLength(1);
    const part = savedParts[0];
    expect(part?.type).toBe("tool");
    if (part?.type !== "tool") return;
    // synthesizeToolPart 读 callID/tool/state.{status,input,output,time} 合成
    // ToolCallScheduled/Started/Result，这些字段缺一不可。
    const toolPart: ToolPart = part;
    expect(toolPart.id).toBe(result.partId);
    expect(toolPart.messageID).toBe(result.assistantMessageId);
    expect(toolPart.callID).toBe("tool_card_1");
    expect(toolPart.tool).toBe("ProposeBestPlan");
    expect(toolPart.state).toEqual({
      status: "completed",
      input: { summary: "s", candidateOptions: [] },
      output: JSON.stringify({ ok: true, planId: "abc" }),
      title: "ProposeBestPlan",
      metadata: { schemaVersion: 1 },
      time: { start: startedAt, end: endedAt },
    });
  });

  it("同 callID 重放幂等：返回既有 id、不重复写，且先于 parent 解析短路", async () => {
    const { sessionID, savedMessages, savedParts, storeRows, fakeRuntime } = createHarness();
    const existingMessageId = createMessageId();
    const existingPartId = createPartId();
    // 预置行挂 assistant message（本 store 没有任何 user message）：若幂等查重
    // 晚于 parent 解析，这次调用会在查不到 parent 时抛错而不是短路。
    storeRows.push({
      info: {
        id: existingMessageId,
        sessionID,
        role: "assistant",
        time: { created: 1, completed: 2 },
        parentID: createMessageId(),
        mode: "build",
        agent: "zcode-agent",
        path: { cwd: "/tmp/w", root: "/tmp/w" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: existingPartId,
          sessionID,
          messageID: existingMessageId,
          type: "tool",
          callID: "tool_card_dup",
          tool: "ProposeBestPlan",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "ProposeBestPlan",
            metadata: { schemaVersion: 1 },
            time: { start: 1, end: 2 },
          },
        },
      ],
    });

    const input = {
      turnId: createTurnId(),
      toolCallId: "tool_card_dup",
      toolName: "ProposeBestPlan",
      input: { summary: "s" },
      output: "ok",
      startedAt: 3,
      endedAt: 4,
    } as const;
    const first = await persistSyntheticToolPart.call(
      fakeRuntime as never,
      input,
      trace(input.turnId),
    );
    const second = await persistSyntheticToolPart.call(
      fakeRuntime as never,
      input,
      trace(input.turnId),
    );

    expect(first).toEqual({ assistantMessageId: existingMessageId, partId: existingPartId });
    expect(second).toEqual(first);
    expect(savedMessages).toHaveLength(0);
    expect(savedParts).toHaveLength(0);
  });

  it("缺 parentUserMessageId 且查不到当前 turn 的 user message 时抛错", async () => {
    const { fakeRuntime } = createHarness();
    const turnId = createTurnId();
    await expect(
      persistSyntheticToolPart.call(
        fakeRuntime as never,
        {
          turnId,
          toolCallId: "tool_orphan",
          toolName: "ProposeBestPlan",
          input: {},
          output: "",
          startedAt: 1,
          endedAt: 2,
        },
        trace(turnId),
      ),
    ).rejects.toThrow(/parent user message/);
  });

  it("缺 parentUserMessageId 时回退到 anchor.turnId 匹配的最新 user message", async () => {
    const { sessionID, savedMessages, storeRows, fakeRuntime } = createHarness();
    const turnId = createTurnId();
    const olderUserId = createMessageId();
    const latestUserId = createMessageId();
    for (const [id, created] of [
      [olderUserId, 5],
      [latestUserId, 9],
    ] as const) {
      storeRows.push({
        info: {
          id,
          sessionID,
          role: "user",
          time: { created },
          agent: "zcode-agent",
          anchor: { turnId },
        },
        parts: [],
      });
    }

    await persistSyntheticToolPart.call(
      fakeRuntime as never,
      {
        turnId,
        toolCallId: "tool_card_2",
        toolName: "ProposeBestPlan",
        input: {},
        output: "",
        startedAt: 10,
        endedAt: 11,
      },
      trace(turnId),
    );

    expect(savedMessages[0]).toMatchObject({ role: "assistant", parentID: latestUserId });
  });
});
