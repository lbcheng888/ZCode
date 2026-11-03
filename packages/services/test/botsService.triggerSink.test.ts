import { describe, expect, it, vi } from "vitest";
import * as f from "./botsService.fixtures.js";
import {
  buildBotTriggerThreadKeyHint,
  noopTriggerSink,
  type TriggerSink,
  type TriggerSinkEnvelope,
} from "../src/bots/triggerSink.js";

/**
 * Phase 2 出口（spec §5.2 / 工作流 ws6）：
 * - 缺省（features.eventRouter=false，未注入 sink）：legacy 直路逐字节不变；
 * - 注入 no-op 直通（kill-switch 裁决回退）：同样 legacy 行为，信封被铸造且 taint=true；
 * - 注入真实 sink 返回 handled=true：跳过 legacy，避免双跑；
 * - sink 抛错：快速去重占位必须释放，错误原样上浮（provider 可重试）。
 */

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};

function createService(sink?: TriggerSink) {
  const repo = f.createMemoryRepo(f.baseConfig);
  const legacyTaskService = f.createLegacyTaskService();
  const service = f.createBotsService({
    credentialService: f.createCredentialService({ "secret-1": "secret" }),
    legacyTaskService,
    repo: repo as never,
    ...(sink ? { triggerSink: sink } : {}),
  });
  return { service, legacyTaskService, repo };
}

async function bind(service: ReturnType<typeof f.createBotsService>) {
  const code = await service.createBindCode({ botId: "webhook-1" });
  await service.handleInboundMessage({
    botId: "webhook-1",
    text: `/bind ${code.code}`,
    actor,
  });
}

function helloPayload(messageId: string) {
  return {
    botId: "webhook-1",
    webhookSecret: "secret",
    messageId,
    text: "hello",
    userId: "user-1",
  };
}

describe("botsService TriggerSink 出口（spec §5.2）", () => {
  it("缺省未注入 sink：legacy 直路不变（createTask 一次、重投仍被快速守卫去重）", async () => {
    const { service, legacyTaskService } = createService();
    await bind(service);

    const first = await service.handleProviderCallbackResponse("webhook", helloPayload("msg-1"));
    const replay = await service.handleProviderCallbackResponse("webhook", helloPayload("msg-1"));

    expect(first.ok).toBe(true);
    expect(first.replies).toEqual([]);
    expect(replay.replies).toEqual([]);
    expect(legacyTaskService.createTask).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });

  it("注入 no-op 直通（kill-switch 缺省）：legacy 行为一致，信封被铸造且 taint=true", async () => {
    const seen: TriggerSinkEnvelope[] = [];
    const sink: TriggerSink = {
      async ingest(envelope) {
        seen.push(envelope);
        return noopTriggerSink.ingest(envelope);
      },
    };
    const { service, legacyTaskService } = createService(sink);
    await bind(service);

    const response = await service.handleProviderCallbackResponse("webhook", helloPayload("msg-2"));

    expect(response.ok).toBe(true);
    expect(legacyTaskService.createTask).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      taint: true,
      source: "webhook",
      provider: "webhook",
      providerMessageId: "msg-2",
      actor: { kind: "human", id: "user-1" },
      threadKeyHint: "bot:webhook-1+user-1",
      payload: expect.objectContaining({
        botId: "webhook-1",
        chatType: "private",
        text: "hello",
        senderType: "user",
      }),
    });
    // 凭据零字节：webhookSecret 不得进信封。
    expect(JSON.stringify(seen[0]!.payload)).not.toContain("secret");
    service.disposeAll();
  });

  it("sink 返回 handled=true：跳过 legacy 直路（不 createTask、无 replies）", async () => {
    const sink: TriggerSink = {
      async ingest() {
        return { handled: true, triggerId: "trigger-1", route: "human_explicit" };
      },
    };
    const { service, legacyTaskService } = createService(sink);
    await bind(service);

    const response = await service.handleProviderCallbackResponse("webhook", helloPayload("msg-3"));

    expect(response).toMatchObject({ ok: true });
    expect(response.replies).toEqual([]);
    expect(legacyTaskService.createTask).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("sink 抛错：错误原样上浮且释放快速去重占位（重投可再次进入 sink）", async () => {
    const ingest = vi
      .fn<TriggerSink["ingest"]>()
      .mockRejectedValueOnce(new Error("intake db down"))
      .mockResolvedValueOnce({ handled: false });
    const sink: TriggerSink = { ingest };
    const { service, legacyTaskService } = createService(sink);
    await bind(service);

    await expect(
      service.handleProviderCallbackResponse("webhook", helloPayload("msg-4")),
    ).rejects.toThrow("intake db down");

    const retry = await service.handleProviderCallbackResponse("webhook", helloPayload("msg-4"));
    expect(retry.ok).toBe(true);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(legacyTaskService.createTask).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });
});

describe("buildBotTriggerThreadKeyHint 域键格式（与 intake/回填三方一致）", () => {
  it("私聊用 providerUserId，群聊用 chatId，话题追加 threadId", () => {
    expect(buildBotTriggerThreadKeyHint({ botId: "b1", providerUserId: "u1" })).toBe("bot:b1+u1");
    expect(
      buildBotTriggerThreadKeyHint({
        botId: "b1",
        providerUserId: "sender-1",
        chatId: "chat-9",
      }),
    ).toBe("bot:b1+chat-9");
    expect(
      buildBotTriggerThreadKeyHint({
        botId: "b1",
        providerUserId: "sender-1",
        chatId: "chat-9",
        threadId: "t-1",
      }),
    ).toBe("bot:b1+chat-9/t-1");
  });
});
