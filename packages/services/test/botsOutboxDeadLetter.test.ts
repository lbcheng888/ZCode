import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeStreamEvent } from "@zcode/shared";
import * as f from "./botsService.fixtures.js";
import { BOTS_OUTBOX_DEAD_LETTER_FILE } from "../src/bots/config.js";
import { getBotConversationKey } from "../src/bots/groupSessions.js";
import { BotsOutboxDeadLetterRepo } from "../src/bots/outboxDeadLetter.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";

/**
 * M7③ bot 出站死信与重试权威：
 * - 终态出站失败恰好写一行死信（同一稳定 id 只 upsert，不追加）；
 * - 重试成功清行；尝试上限（5）翻 dropped 且不再重试；
 * - 成功路径删行后绝不二次发送。
 */

const feishuTarget = {
  provider: "feishu" as const,
  botId: "feishu-1",
  providerUserId: "ou_user",
  chatType: "private" as const,
};

/** 首次失败按统一退避写 nextRetryAt（1 分钟起）；立即重试的用例先把行推进到到期。 */
async function makeDeadLetterRowDue(
  store: ReturnType<typeof f.createMemoryOutboxDeadLetterStore>,
  id: string,
): Promise<void> {
  const row = store.snapshot().entries.find((entry) => entry.id === id);
  if (!row) throw new Error(`dead letter row missing: ${id}`);
  await store.update(id, { ...row, nextRetryAt: Date.now() - 1 });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bots outbox dead letters", () => {
  it("writes exactly one dead-letter row per failed automation watch, even when repeated", async () => {
    const deadLetterRepo = f.createMemoryOutboxDeadLetterStore();
    const legacyTaskService = { ...f.createLegacyTaskService(), onDynamicTaskEvent: vi.fn() };
    const service = f.createBotsService({
      legacyTaskService,
      repo: f.createMemoryRepo({ ...f.feishuConfig, bots: [] }) as never,
      outboxDeadLetterRepo: deadLetterRepo,
    });

    const params = {
      target: feishuTarget,
      taskId: "task-automation-dl",
      runId: "run-dl-1",
      workspacePath: "/tmp/workspace",
    };
    await service.watchAutomationRun(params);
    await service.watchAutomationRun(params);

    const rows = (await service.listOutboxDeadLetters!()) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      botId: "feishu-1",
      provider: "feishu",
      reason: "bot_missing",
      attempts: 2,
      status: "pending",
    });
    expect(rows[0]?.automation).toMatchObject({ runId: "run-dl-1", taskId: "task-automation-dl" });
    service.disposeAll();
  });

  it("retries a reference dead letter after the bot is restored and clears the row", async () => {
    const deadLetterRepo = f.createMemoryOutboxDeadLetterStore();
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      // 订阅工厂必须返回 disposable，否则 watchTaskStream 在订阅建立时抛 TypeError，
      // 重试会按系统错误记账（failed）而不是恢复投递路径（restored）。
      onDynamicTaskEvent: vi.fn(() => () => ({ dispose() {} })),
    };
    const repo = f.createMemoryRepo({ ...f.feishuConfig, bots: [] });
    const service = f.createBotsService({
      legacyTaskService,
      repo: repo as never,
      outboxDeadLetterRepo: deadLetterRepo,
    });

    await service.watchAutomationRun({
      target: feishuTarget,
      taskId: "task-automation-restore",
      runId: "run-restore-1",
      workspacePath: "/tmp/workspace",
    });
    expect(deadLetterRepo.snapshot().entries).toHaveLength(1);
    await makeDeadLetterRowDue(deadLetterRepo, deadLetterRepo.snapshot().entries[0]!.id);

    // Bot 恢复：重试重放 automation watch，预检通过后清行（投递路径恢复）。
    await repo.writeConfig(f.feishuConfig);
    const summary = await service.retryBotOutboxDeadLetters!();

    expect(summary).toMatchObject({ considered: 1, restored: 1, failed: 0, dropped: 0 });
    expect(deadLetterRepo.snapshot().entries).toHaveLength(0);
    expect(legacyTaskService.onDynamicTaskEvent).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });

  it("flips a reference dead letter to dropped once attempts reach the cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const deadLetterRepo = f.createMemoryOutboxDeadLetterStore();
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(() => () => ({ dispose() {} })),
    };
    const service = f.createBotsService({
      legacyTaskService,
      repo: f.createMemoryRepo({ ...f.feishuConfig, bots: [] }) as never,
      outboxDeadLetterRepo: deadLetterRepo,
    });

    const params = {
      target: feishuTarget,
      taskId: "task-automation-cap",
      runId: "run-cap-1",
      workspacePath: "/tmp/workspace",
    };
    // 首次失败 attempts=1；随后按退避推进时间做 4 次重试，累计 attempts=5 → dropped。
    await service.watchAutomationRun(params);
    let advancedMs = 0;
    for (let i = 0; i < 4; i += 1) {
      const pending = deadLetterRepo.snapshot().entries.find((e) => e.status === "pending");
      expect(pending).toBeDefined();
      advancedMs = (pending?.nextRetryAt ?? 0) - Date.now();
      expect(advancedMs).toBeGreaterThan(0);
      vi.setSystemTime(new Date(Date.now() + advancedMs));
      await service.retryBotOutboxDeadLetters!();
    }

    const rows = deadLetterRepo.snapshot().entries;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "dropped", attempts: 5 });

    // dropped 行不再进入任何重试扫描。
    vi.setSystemTime(new Date(Date.now() + 3_600_000));
    const after = await service.retryBotOutboxDeadLetters!();
    expect(after.considered).toBe(0);
    expect(deadLetterRepo.snapshot().entries[0]).toMatchObject({ status: "dropped", attempts: 5 });
    service.disposeAll();
  });

  it("records a send_failed dead letter with the truncated payload and replays it exactly once", async () => {
    let sendFailures = 1;
    let sendSuccesses = 0;
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlText = url instanceof Request ? url.url : String(url);
      if (urlText.includes("/ilink/bot/sendmessage")) {
        if (sendFailures > 0) {
          sendFailures -= 1;
          return new Response("boom", { status: 500 });
        }
        sendSuccesses += 1;
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const deadLetterRepo = f.createMemoryOutboxDeadLetterStore();
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: f.createMemoryRepo(f.weixinConfig) as never,
      outboxDeadLetterRepo: deadLetterRepo,
      // 不启动 weixin getupdates 轮询：瞬时空响应的 fetch 桩会让长轮询紧循环占满
      // 微任务队列、饿死定时器并打爆 vitest worker 堆（本用例只测出站，不需要入站轮询）。
      runStartupBackgroundTasks: false,
    });

    await service.watchAutomationRun({
      target: {
        provider: "weixin",
        botId: "weixin-1",
        providerUserId: "wx_chat_1",
        chatType: "private",
      },
      taskId: "task-automation-send-dl",
      runId: "run-send-dl-1",
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
    });
    await streamListeners[0]?.({
      type: "agent_message_chunk",
      taskId: "task-automation-send-dl",
      traceId: "run-send-dl-1",
      content: "日报已生成。",
    });
    await streamListeners[0]?.({
      type: "task_complete",
      taskId: "task-automation-send-dl",
      traceId: "run-send-dl-1",
      stopReason: "end_turn",
    });

    // 终态发送失败：恰好一行 send_failed 死信，载荷为截断后的出站文本。
    const rows = deadLetterRepo.snapshot().entries;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      botId: "weixin-1",
      provider: "weixin",
      reason: "send_failed",
      status: "pending",
      attempts: 1,
      payloadText: expect.stringContaining("日报已生成"),
    });
    expect(rows[0]?.payloadTruncated ?? false).toBe(false);
    expect(sendSuccesses).toBe(0);
    await makeDeadLetterRowDue(deadLetterRepo, rows[0]!.id);

    // 重试成功清行；再次重试没有任何行可发，成功路径绝不二次发送。
    const retryOnce = await service.retryBotOutboxDeadLetters!();
    expect(retryOnce).toMatchObject({ considered: 1, sent: 1, failed: 0, dropped: 0 });
    expect(sendSuccesses).toBe(1);
    expect(deadLetterRepo.snapshot().entries).toHaveLength(0);

    const retryTwice = await service.retryBotOutboxDeadLetters!();
    expect(retryTwice.considered).toBe(0);
    expect(sendSuccesses).toBe(1);
    service.disposeAll();
  });

  it("keeps a send_failed row pending across a failed retry until the cap drops it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const deadLetterRepo = f.createMemoryOutboxDeadLetterStore();
    const legacyTaskService = { ...f.createLegacyTaskService(), onDynamicTaskEvent: vi.fn() };
    // bot 不存在：预检死信在每次重试时按同一稳定 id 递增 attempts。
    const service = f.createBotsService({
      legacyTaskService,
      repo: f.createMemoryRepo({ ...f.feishuConfig, bots: [] }) as never,
      outboxDeadLetterRepo: deadLetterRepo,
    });

    const params = {
      target: feishuTarget,
      taskId: "task-automation-pending",
      runId: "run-pending-1",
      workspacePath: "/tmp/workspace",
    };
    await service.watchAutomationRun(params);
    for (let i = 0; i < 4; i += 1) {
      const pending = deadLetterRepo.snapshot().entries.find((e) => e.status === "pending");
      vi.setSystemTime(new Date(pending?.nextRetryAt ?? Date.now()));
      await service.retryBotOutboxDeadLetters!();
    }
    expect(deadLetterRepo.snapshot().entries[0]).toMatchObject({ status: "dropped", attempts: 5 });
    service.disposeAll();
  });

  it("never dead-letters successful automation sends (no row, retry stays empty)", async () => {
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const deadLetterRepo = f.createMemoryOutboxDeadLetterStore();
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: f.createMemoryRepo(f.weixinConfig) as never,
      outboxDeadLetterRepo: deadLetterRepo,
      // 不启动 weixin getupdates 轮询：瞬时空响应的 fetch 桩会让长轮询紧循环占满
      // 微任务队列、饿死定时器并打爆 vitest worker 堆（本用例只测出站，不需要入站轮询）。
      runStartupBackgroundTasks: false,
    });

    await service.watchAutomationRun({
      target: {
        provider: "weixin",
        botId: "weixin-1",
        providerUserId: "wx_chat_1",
        chatType: "private",
      },
      taskId: "task-automation-ok",
      runId: "run-ok-1",
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
    });
    await streamListeners[0]?.({
      type: "agent_message_chunk",
      taskId: "task-automation-ok",
      traceId: "run-ok-1",
      content: "一切正常。",
    });
    await streamListeners[0]?.({
      type: "task_complete",
      taskId: "task-automation-ok",
      traceId: "run-ok-1",
      stopReason: "end_turn",
    });

    expect(deadLetterRepo.snapshot().entries).toHaveLength(0);
    const retry = await service.retryBotOutboxDeadLetters!();
    expect(retry.considered).toBe(0);
    service.disposeAll();
  });

  it("refuses to replay a group send_failed dead letter once group authorization changed", async () => {
    // 重放不得绕过群授权门：授权换发（等价撤销）后，payload 重放必须拒绝投递并按失败退避。
    const sendRequests: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = url instanceof Request ? url.url : String(url);
      if (urlText.includes("tenant_access_token"))
        return Response.json({ code: 0, tenant_access_token: "gt", expire: 3600 });
      if (init?.method === "POST" || urlText.includes("im/v1/messages")) {
        sendRequests.push(urlText);
        return Response.json({ code: 0, data: { message_id: "om_replay" } });
      }
      return Response.json({ code: 0, data: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    const deadLetterRepo = f.createMemoryOutboxDeadLetterStore();
    // 原始失败快照携带授权 auth-A。
    await deadLetterRepo.upsert({
      id: "automation-send:feishu-1:group-revoked",
      botId: "feishu-1",
      provider: "feishu",
      chatType: "group",
      providerUserId: "oc_group",
      reason: "send_failed",
      groupAuthorizationId: "auth-A",
      payloadText: "日报已生成。",
    });
    await makeDeadLetterRowDue(deadLetterRepo, "automation-send:feishu-1:group-revoked");
    const groupStateKey = getBotConversationKey({
      botId: "feishu-1",
      chatType: "group",
      chatId: "oc_group",
    });
    const repo = f.createMemoryRepo(f.feishuConfig, {
      version: 3,
      bots: {
        [groupStateKey]: {
          botId: "feishu-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
          mode: "task",
          activeTaskId: null,
          updatedAt: Date.now(),
          group: {
            chatId: "oc_group",
            name: "group",
            ownerId: "ou_user",
            enabled: true,
            taskIds: [],
            // 授权已换发为 auth-B：与死信快照不一致，重放必须被拒。
            authorizationId: "auth-B",
          },
        },
      },
    } as never);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
      outboxDeadLetterRepo: deadLetterRepo,
      runStartupBackgroundTasks: false,
    });

    const summary = await service.retryBotOutboxDeadLetters!();

    expect(summary).toMatchObject({ considered: 1, sent: 0, failed: 1, dropped: 0 });
    expect(sendRequests).toHaveLength(0);
    expect(deadLetterRepo.snapshot().entries[0]).toMatchObject({
      status: "pending",
      attempts: 2,
      lastError: "group authorization changed for replay",
    });
    service.disposeAll();
  });

  it("replays a group send_failed dead letter while group authorization still matches", async () => {
    let messageCreates = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = url instanceof Request ? url.url : String(url);
      if (urlText.includes("tenant_access_token"))
        return Response.json({ code: 0, tenant_access_token: "gt", expire: 3600 });
      if (init?.method === "POST" || urlText.includes("im/v1/messages")) {
        messageCreates += 1;
        return Response.json({ code: 0, data: { message_id: "om_replay" } });
      }
      return Response.json({ code: 0, data: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    const deadLetterRepo = f.createMemoryOutboxDeadLetterStore();
    await deadLetterRepo.upsert({
      id: "automation-send:feishu-1:group-authorized",
      botId: "feishu-1",
      provider: "feishu",
      chatType: "group",
      providerUserId: "oc_group",
      reason: "send_failed",
      groupAuthorizationId: "auth-A",
      payloadText: "日报已生成。",
    });
    await makeDeadLetterRowDue(deadLetterRepo, "automation-send:feishu-1:group-authorized");
    const groupStateKey = getBotConversationKey({
      botId: "feishu-1",
      chatType: "group",
      chatId: "oc_group",
    });
    const repo = f.createMemoryRepo(f.feishuConfig, {
      version: 3,
      bots: {
        [groupStateKey]: {
          botId: "feishu-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
          mode: "task",
          activeTaskId: null,
          updatedAt: Date.now(),
          group: {
            chatId: "oc_group",
            name: "group",
            ownerId: "ou_user",
            enabled: true,
            taskIds: [],
            authorizationId: "auth-A",
          },
        },
      },
    } as never);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
      outboxDeadLetterRepo: deadLetterRepo,
      runStartupBackgroundTasks: false,
    });

    const summary = await service.retryBotOutboxDeadLetters!();

    expect(summary).toMatchObject({ considered: 1, sent: 1, failed: 0, dropped: 0 });
    expect(messageCreates).toBe(1);
    expect(deadLetterRepo.snapshot().entries).toHaveLength(0);
    service.disposeAll();
  });
});

describe("bots outbox dead letter file repo", () => {
  let tempDataBaseDir: string;

  beforeEach(async () => {
    tempDataBaseDir = await mkdtemp(join(tmpdir(), "zcode-outbox-dead-letter-"));
    setDataBaseDir(tempDataBaseDir);
  });

  afterEach(async () => {
    setDataBaseDir(null);
    await rm(tempDataBaseDir, { recursive: true, force: true });
  });

  it("upserts, reads and removes rows on disk and survives reopening the file", async () => {
    const repo = new BotsOutboxDeadLetterRepo();
    expect(await repo.read()).toEqual({ version: 1, entries: [] });

    const row = await repo.upsert({
      id: "automation-watch:feishu-1:file-repo",
      botId: "feishu-1",
      provider: "feishu",
      chatType: "private",
      providerUserId: "ou_user",
      reason: "bot_missing",
    });
    expect(row).toMatchObject({ attempts: 1, status: "pending" });

    // 重新打开文件版仓库：磁盘内容是权威，重读后行仍在。
    const reopened = new BotsOutboxDeadLetterRepo();
    const rows = (await reopened.read()).entries;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: row.id, reason: "bot_missing" });

    await reopened.remove(row.id);
    expect((await repo.read()).entries).toHaveLength(0);
  });

  it("recreates an empty version-1 file when the on-disk file is corrupted", async () => {
    const filePath = join(getAppConfigDir(), BOTS_OUTBOX_DEAD_LETTER_FILE);
    await mkdir(getAppConfigDir(), { recursive: true });
    await writeFile(filePath, "{ this is not json", "utf8");

    const repo = new BotsOutboxDeadLetterRepo();
    expect(await repo.read()).toEqual({ version: 1, entries: [] });

    // 重建后写入不再被损坏文件阻塞。
    await repo.upsert({
      id: "automation-watch:feishu-1:recreated",
      botId: "feishu-1",
      provider: "feishu",
      chatType: "private",
      providerUserId: "ou_user",
      reason: "bot_missing",
    });
    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as { version: number };
    expect(onDisk.version).toBe(1);
  });

  it("refuses to reinterpret a future-version file", async () => {
    const filePath = join(getAppConfigDir(), BOTS_OUTBOX_DEAD_LETTER_FILE);
    await mkdir(getAppConfigDir(), { recursive: true });
    await writeFile(filePath, JSON.stringify({ version: 2, entries: [] }), "utf8");

    const repo = new BotsOutboxDeadLetterRepo();
    await expect(repo.read()).rejects.toThrow(/Unsupported bot outbox dead letter file version/);
  });
});
