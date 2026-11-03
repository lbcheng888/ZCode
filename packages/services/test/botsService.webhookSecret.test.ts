import { describe, expect, it } from "vitest";
import type { BotsConfigFile } from "@zcode/shared";
import * as f from "./botsService.fixtures.js";

/**
 * Phase 0 安全债回归：webhook 配置了 webhookSecretRef 后必须 fail-closed。
 * 旧实现（expectedSecret && expectedSecret !== inboundSecret）在凭据加载为空时
 * 跳过整条校验（fail-open），本文件锁定修复后的四种准入语义。
 */

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};

async function bind(service: ReturnType<typeof f.createBotsService>) {
  const code = await service.createBindCode({ botId: "webhook-1" });
  await service.handleInboundMessage({
    botId: "webhook-1",
    text: `/bind ${code.code}`,
    actor,
  });
}

function webhookConfig(overrides: Partial<BotsConfigFile["bots"][number]> = {}): BotsConfigFile {
  return {
    version: 3,
    bots: [{ ...f.baseConfig.bots[0]!, ...overrides }],
  };
}

describe("botsService webhook secret fail-closed admission", () => {
  it("rejects with 401 when the secret ref is set but the loaded value is empty", async () => {
    const service = f.createBotsService({
      credentialService: f.createCredentialService({}),
      repo: f.createMemoryRepo(webhookConfig()) as never,
    });
    await bind(service);

    const response = await service.handleProviderCallbackResponse("webhook", {
      botId: "webhook-1",
      webhookSecret: "anything",
      messageId: "message-empty-ref",
      text: "hello",
      userId: "user-1",
    });

    expect(response).toMatchObject({
      ok: false,
      status: 401,
      replies: [],
      responseBody: { error: expect.stringContaining("secret") },
    });
    service.disposeAll();
  });

  it("rejects with 401 when the inbound secret mismatches the loaded value", async () => {
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "expected" }),
      repo: f.createMemoryRepo(webhookConfig()) as never,
    });
    await bind(service);

    const response = await service.handleProviderCallbackResponse("webhook", {
      botId: "webhook-1",
      webhookSecret: "forged",
      messageId: "message-mismatch",
      text: "hello",
      userId: "user-1",
    });

    expect(response).toMatchObject({
      ok: false,
      status: 401,
      replies: [],
      responseBody: { error: expect.stringContaining("secret") },
    });
    service.disposeAll();
  });

  it("admits the callback when the inbound secret matches the loaded value", async () => {
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: f.createMemoryRepo(webhookConfig()) as never,
    });
    await bind(service);

    const response = await service.handleProviderCallbackResponse("webhook", {
      botId: "webhook-1",
      webhookSecret: "secret",
      messageId: "message-match",
      text: "hello",
      userId: "user-1",
    });

    expect(response.status === undefined || response.status < 400).toBe(true);
    expect(response.replies.some((reply) => /secret/i.test(reply.text))).toBe(false);
    expect(legacyTaskService.createTask).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });

  it("keeps current admission for a webhook bot without a secret ref", async () => {
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      // 即使凭据库里有值，bot 未配置 webhookSecretRef 时也不做 secret 门禁。
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: f.createMemoryRepo(webhookConfig({ webhookSecretRef: undefined })) as never,
    });
    await bind(service);

    const response = await service.handleProviderCallbackResponse("webhook", {
      botId: "webhook-1",
      messageId: "message-no-ref",
      text: "hello",
      userId: "user-1",
    });

    expect(response.status === undefined || response.status < 400).toBe(true);
    expect(legacyTaskService.createTask).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });

  it("still rejects a mismatched Feishu callback token unchanged (control case)", async () => {
    const service = f.createBotsService({
      credentialService: f.createCredentialService({}),
      repo: f.createMemoryRepo({
        ...f.feishuConfig,
        bots: [{ ...f.feishuConfig.bots[0]!, webhookSecretRef: "feishu-secret-ref" }],
      }) as never,
    });

    const response = await service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-1",
      token: "forged",
      header: { event_type: "im.message.receive_v1" },
      event: {},
    });

    expect(response).toMatchObject({
      ok: false,
      status: 401,
      replies: [],
      responseBody: { error: expect.stringContaining("secret") },
    });
    service.disposeAll();
  });
});
