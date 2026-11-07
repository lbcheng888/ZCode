import { describe, expect, it, vi } from "vitest";
import { replyToChannelHandler } from "../src/tool/handlers/reply-to-channel.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

function fixture() {
  const node = {
    type: "channelMention",
    refId: "m1",
    name: "Ryan Bot",
    targetId: "ou_target",
    idType: "open_id",
    entityType: "unknown",
    channel: "feishu",
  };
  const source = {
    botId: "bot",
    appId: "app",
    provider: "feishu",
    chatId: "oc_group",
    messageId: "om_input",
    senderId: "ou_sender",
    senderName: "Sender",
    authorizationId: "auth",
    contentParts: [node],
  };
  const user = {
    info: {
      id: "user",
      role: "user",
      metadata: { conversationInputIntent: { sourceCommandId: "input", botGroupSource: source } },
    },
    parts: [],
  };
  const assistant = {
    info: { id: "assistant", role: "assistant", parentID: "user" },
    parts: [{ type: "tool", callID: "call" }],
  };
  const messages = [
    user,
    assistant,
    { info: { id: "queued", role: "user", metadata: {} }, parts: [] },
  ];
  const reply = vi.fn(async () => ({
    status: "sent",
    deliveryId: "delivery",
    providerMessageId: "om_sent",
  }));
  const readTarget = vi.fn(async () => null);
  const abort = new AbortController();
  const context = {
    sessionId: "task",
    toolCallId: "call",
    abortSignal: abort.signal,
    sessionStore: { messages: async () => messages, readTarget },
    topicResourcePort: { reply },
  } as unknown as ToolExecutionContext;
  return { context, reply, readTarget, abort, user, assistant };
}
const input = {
  parts: [
    { type: "mention", refId: "m1" },
    { type: "text", text: " 请确认" },
  ],
};
describe("ReplyToChannel", () => {
  it("forwards typed names and preserves clarification without claiming delivery", async () => {
    const f = fixture();
    const clarification = {
      status: "needs_clarification",
      unresolved: [
        {
          name: "Alex",
          reason: "ambiguous",
          candidates: [{ ref: "opaque", name: "Alex", label: "Alex (member)", kind: "user" }],
          truncated: false,
        },
        { name: "Missing", reason: "not_found", candidates: [], truncated: false },
      ],
    };
    f.reply.mockResolvedValue(clarification as never);
    const parts = [
      { type: "mentionName", name: "Alex" },
      { type: "mentionName", name: "Missing" },
    ];
    expect(await replyToChannelHandler({ parts }, f.context)).toEqual(clarification);
    expect(f.reply.mock.calls[0]?.[0]).toMatchObject({ parts });
  });
  it("uses executing assistant parent rather than a newer queued user input", async () => {
    const { context, reply } = fixture();
    expect(await replyToChannelHandler(input, context)).toMatchObject({
      status: "sent",
      providerMessageId: "om_sent",
    });
    expect(reply).toHaveBeenCalledWith(
      {
        taskId: "task",
        inputId: "input",
        toolCallId: "call",
        parts: input.parts,
      },
      expect.objectContaining({ signal: context.abortSignal }),
    );
  });
  it.each(["cancelled", "missingCall", "missingSource"])(
    "rejects %s before sending",
    async (kind) => {
      const f = fixture();
      if (kind === "cancelled") f.abort.abort();
      if (kind === "missingCall") f.assistant.parts = [];
      if (kind === "missingSource") f.user.info.metadata = {} as typeof f.user.info.metadata;
      await expect(replyToChannelHandler(input, f.context)).rejects.toThrow();
      expect(f.reply).not.toHaveBeenCalled();
    },
  );
  it("forwards desktop follow-up without botGroupSource for Host binding resolution", async () => {
    const f = fixture();
    f.user.info.metadata = {
      conversationInputIntent: { sourceCommandId: "desktop-input" },
    } as typeof f.user.info.metadata;
    await expect(replyToChannelHandler(input, f.context)).resolves.toMatchObject({
      status: "sent",
    });
    expect(f.reply).toHaveBeenCalledWith(
      { taskId: "task", inputId: "desktop-input", toolCallId: "call", parts: input.parts },
      expect.anything(),
    );
  });
  it("preserves unknown receipt status without claiming success", async () => {
    const f = fixture();
    f.reply.mockResolvedValue({ status: "unknown", deliveryId: "delivery", providerMessageId: "" });
    expect(await replyToChannelHandler(input, f.context)).toMatchObject({ status: "unknown" });
  });
  it("red bound ChengGate blocks the external channel with zero delivery", async () => {
    const f = fixture();
    f.readTarget.mockResolvedValue({ chengRef: { jobId: "job-red" } } as never);
    f.context.chengReadPort = {
      verify: vi.fn(async () => ({
        gate: { ok: false, level: "BLOCKED", reasons: ["settle_not_solved"] },
      })),
    } as never;

    await expect(replyToChannelHandler(input, f.context)).rejects.toThrow(
      "cheng_gate_blocked:settle_not_solved",
    );
    expect(f.reply).not.toHaveBeenCalled();
  });
  it("green bound ChengGate allows the external channel", async () => {
    const f = fixture();
    const verify = vi.fn(async () => ({
      gate: { ok: true, level: "PRODUCTION", reasons: [] },
    }));
    f.readTarget.mockResolvedValue({ chengRef: { jobId: "job-green" } } as never);
    f.context.chengReadPort = { verify } as never;

    await expect(replyToChannelHandler(input, f.context)).resolves.toMatchObject({
      status: "sent",
    });
    expect(verify).toHaveBeenCalledWith("job-green");
    expect(f.reply).toHaveBeenCalled();
  });
  it("fails closed when a bound Cheng job has no read port", async () => {
    const f = fixture();
    f.readTarget.mockResolvedValue({ chengRef: { jobId: "job-red" } } as never);

    await expect(replyToChannelHandler(input, f.context)).rejects.toThrow(
      /Cheng delivery gate unavailable/,
    );
    expect(f.reply).not.toHaveBeenCalled();
  });
  it("propagates gate resolver failure with zero delivery", async () => {
    const f = fixture();
    f.readTarget.mockResolvedValue({ chengRef: { jobId: "job-red" } } as never);
    f.context.chengReadPort = {
      verify: vi.fn(async () => {
        throw new Error("cheng host unavailable");
      }),
    } as never;

    await expect(replyToChannelHandler(input, f.context)).rejects.toThrow("cheng host unavailable");
    expect(f.reply).not.toHaveBeenCalled();
  });
});
