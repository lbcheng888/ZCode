/**
 * B-SPEC §3.3 Core 侧窄方法单测：
 * - `createBotTaskFromTrigger`：同 triggerId 两次只建一个会话（Core 持久化绑定）；
 * - `evaluateBotAutoReplyGuard`：admitAutoReplyTurn 判定/占额矩阵（发送者身份来自 wire 事实）。
 */
import { describe, expect, it, vi } from "vitest";
import type { BotsStateFile } from "@zcode/shared";
import {
  createBotsService,
  createLegacyTaskService,
  createMemoryRepo,
  createMemoryTriggerTaskBindingStore,
  telegramConfig,
} from "./botsService.fixtures.js";

const WORKSPACE_IDENTITY = "remote:server:test-owner:/tmp/workspace";

/** 已存在的私聊上下文（trigger 入站时 mint 已读取它；createTask 不得凭空建会话）。 */
function privateState(): BotsStateFile {
  return {
    version: 3,
    bots: {
      "telegram-1": {
        botId: "telegram-1",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: WORKSPACE_IDENTITY,
        mode: "draft",
        activeTaskId: null,
        updatedAt: 1,
      },
    },
  };
}

function groupState(overrides: {
  chatId?: string;
  threadId?: string;
  enabled?: boolean;
  ownerId?: string;
  topicActive?: boolean;
  consecutive?: number;
}): BotsStateFile {
  const chatId = overrides.chatId ?? "chat-1";
  const group = {
    chatId,
    threadId: overrides.threadId,
    name: "Group",
    ownerId: overrides.ownerId ?? "user-1",
    enabled: overrides.enabled ?? true,
    taskIds: [] as string[],
    currentOptions: {},
    autoReplyGuard: { consecutive: overrides.consecutive ?? 0, messageIds: [] as string[] },
    topicActive: overrides.topicActive,
  };
  const key = JSON.stringify(
    overrides.threadId ? ["telegram-1", chatId, overrides.threadId] : ["telegram-1", chatId],
  );
  return {
    version: 3,
    bots: {
      [key]: {
        botId: "telegram-1",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: WORKSPACE_IDENTITY,
        mode: "draft",
        activeTaskId: null,
        updatedAt: 1,
        group: group as never,
      },
    },
  };
}

describe("createBotTaskFromTrigger", () => {
  it("同一 triggerId 两次只建一个会话，第二次直接返回同一 sessionId", async () => {
    const repo = createMemoryRepo(telegramConfig, privateState());
    const taskService = createLegacyTaskService();
    const bindings = createMemoryTriggerTaskBindingStore();
    const service = createBotsService({
      repo,
      zcodeTaskService: taskService,
      triggerTaskBindingStore: bindings,
    });

    const first = await service.createBotTaskFromTrigger!({
      workspaceIdentity: WORKSPACE_IDENTITY,
      threadKey: "bot:telegram-1+user-1",
      triggerId: "trigger-1",
      payload: "wake text",
    });
    const second = await service.createBotTaskFromTrigger!({
      workspaceIdentity: WORKSPACE_IDENTITY,
      threadKey: "bot:telegram-1+user-1",
      triggerId: "trigger-1",
      payload: "wake text",
    });

    expect(first).toEqual({ sessionId: "task-1" });
    expect(second).toEqual(first);
    expect(vi.mocked(taskService.createTask)).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(vi.mocked(taskService.sendPrompt)).toHaveBeenCalledTimes(1));
    expect(bindings.snapshot()["trigger-1"]).toMatchObject({
      workspaceIdentity: WORKSPACE_IDENTITY,
      threadKey: "bot:telegram-1+user-1",
      sessionId: "task-1",
    });
  });

  it("已绑定 triggerId 跨 workspace/thread 重放 → 响亮失败，不返回错误会话", async () => {
    const repo = createMemoryRepo(telegramConfig, privateState());
    const taskService = createLegacyTaskService();
    const bindings = createMemoryTriggerTaskBindingStore();
    const service = createBotsService({
      repo,
      zcodeTaskService: taskService,
      triggerTaskBindingStore: bindings,
    });
    await service.createBotTaskFromTrigger!({
      workspaceIdentity: WORKSPACE_IDENTITY,
      threadKey: "bot:telegram-1+user-1",
      triggerId: "trigger-1",
      payload: "wake text",
    });
    await expect(
      service.createBotTaskFromTrigger!({
        workspaceIdentity: "remote:server:other:/srv/other",
        threadKey: "bot:telegram-1+user-2",
        triggerId: "trigger-1",
        payload: "wake text",
      }),
    ).rejects.toThrow(/已绑定到其他 workspace\/thread/u);
    expect(vi.mocked(taskService.createTask)).toHaveBeenCalledTimes(1);
  });

  it("既无私聊也无群上下文的 thread → 响亮失败，不按私聊猜测建会话", async () => {
    const service = createBotsService({
      repo: createMemoryRepo(telegramConfig, { version: 3, bots: {} }),
      zcodeTaskService: createLegacyTaskService(),
      triggerTaskBindingStore: createMemoryTriggerTaskBindingStore(),
    });
    await expect(
      service.createBotTaskFromTrigger!({
        workspaceIdentity: WORKSPACE_IDENTITY,
        threadKey: "bot:telegram-1+user-1",
        triggerId: "trigger-unknown",
        payload: "wake text",
      }),
    ).rejects.toThrow(/thread 归属不可判定/u);
  });

  it("群 thread 用既有 createTask 路径（permissionScope=session），不依赖 wire 中的 providerMessageId", async () => {
    const repo = createMemoryRepo(telegramConfig, groupState({}));
    const taskService = createLegacyTaskService();
    const bindings = createMemoryTriggerTaskBindingStore();
    const service = createBotsService({
      repo,
      zcodeTaskService: taskService,
      triggerTaskBindingStore: bindings,
    });

    await expect(
      service.createBotTaskFromTrigger!({
        workspaceIdentity: WORKSPACE_IDENTITY,
        threadKey: "bot:telegram-1+chat-1",
        triggerId: "trigger-group",
        payload: "wake text",
      }),
    ).resolves.toEqual({ sessionId: "task-1" });
    expect(vi.mocked(taskService.createTask)).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/tmp/workspace",
        permissionScope: "session",
        v4Create: true,
      }),
    );
  });

  it("陌生私聊 peer → 拒绝，不把 bot.providerUserId 当成任意 peer 的 owner", async () => {
    const repo = createMemoryRepo(telegramConfig, privateState());
    const service = createBotsService({
      repo,
      zcodeTaskService: createLegacyTaskService(),
      triggerTaskBindingStore: createMemoryTriggerTaskBindingStore(),
    });
    await expect(
      service.createBotTaskFromTrigger!({
        workspaceIdentity: WORKSPACE_IDENTITY,
        threadKey: "bot:telegram-1+stranger-9",
        triggerId: "trigger-stranger",
        payload: "wake text",
      }),
    ).rejects.toThrow(/私聊用户未绑定/u);
  });

  it("群未启用 → 拒绝（不能只靠 readContext 返回现值）", async () => {
    const service = createBotsService({
      repo: createMemoryRepo(telegramConfig, groupState({ enabled: false })),
      zcodeTaskService: createLegacyTaskService(),
      triggerTaskBindingStore: createMemoryTriggerTaskBindingStore(),
    });
    await expect(
      service.createBotTaskFromTrigger!({
        workspaceIdentity: WORKSPACE_IDENTITY,
        threadKey: "bot:telegram-1+chat-1",
        triggerId: "trigger-disabled-group",
        payload: "wake text",
      }),
    ).rejects.toThrow(/群未启用或 owner 不匹配/u);
  });

  it("群 ownerId 与 bot.providerUserId 漂移 → 拒绝", async () => {
    const service = createBotsService({
      repo: createMemoryRepo(telegramConfig, groupState({ ownerId: "other-owner" })),
      zcodeTaskService: createLegacyTaskService(),
      triggerTaskBindingStore: createMemoryTriggerTaskBindingStore(),
    });
    await expect(
      service.createBotTaskFromTrigger!({
        workspaceIdentity: WORKSPACE_IDENTITY,
        threadKey: "bot:telegram-1+chat-1",
        triggerId: "trigger-owner-drift",
        payload: "wake text",
      }),
    ).rejects.toThrow(/群未启用或 owner 不匹配/u);
  });

  it("未配置群的 threadKey 不得按私聊放行", async () => {
    const service = createBotsService({
      repo: createMemoryRepo(telegramConfig, privateState()),
      zcodeTaskService: createLegacyTaskService(),
      triggerTaskBindingStore: createMemoryTriggerTaskBindingStore(),
    });
    await expect(
      service.createBotTaskFromTrigger!({
        workspaceIdentity: WORKSPACE_IDENTITY,
        threadKey: "bot:telegram-1+unknown-chat",
        triggerId: "trigger-unknown-group",
        payload: "wake text",
      }),
    ).rejects.toThrow(/私聊用户未绑定/u);
  });

  it("接受 intake 复合 threadKey（<ws>|bot:...），绑定保存原始 wire key", async () => {
    const repo = createMemoryRepo(telegramConfig, privateState());
    const taskService = createLegacyTaskService();
    const bindings = createMemoryTriggerTaskBindingStore();
    const service = createBotsService({
      repo,
      zcodeTaskService: taskService,
      triggerTaskBindingStore: bindings,
    });
    const threadKey = `${WORKSPACE_IDENTITY}|bot:telegram-1+user-1`;
    await expect(
      service.createBotTaskFromTrigger!({
        workspaceIdentity: WORKSPACE_IDENTITY,
        threadKey,
        triggerId: "trigger-prefixed",
        payload: "wake text",
      }),
    ).resolves.toEqual({ sessionId: "task-1" });
    expect(bindings.snapshot()["trigger-prefixed"]).toMatchObject({ threadKey });
    expect(vi.mocked(taskService.createTask)).toHaveBeenCalledTimes(1);
  });

  it("同一 thread 两个不同 triggerId 并发 → 只建一个会话", async () => {
    const repo = createMemoryRepo(telegramConfig, privateState());
    const taskService = createLegacyTaskService();
    const bindings = createMemoryTriggerTaskBindingStore();
    const service = createBotsService({
      repo,
      zcodeTaskService: taskService,
      triggerTaskBindingStore: bindings,
    });
    const threadKey = "bot:telegram-1+user-1";
    await expect(
      Promise.all([
        service.createBotTaskFromTrigger!({
          workspaceIdentity: WORKSPACE_IDENTITY,
          threadKey,
          triggerId: "trigger-a",
          payload: "first",
        }),
        service.createBotTaskFromTrigger!({
          workspaceIdentity: WORKSPACE_IDENTITY,
          threadKey,
          triggerId: "trigger-b",
          payload: "second",
        }),
      ]),
    ).resolves.toEqual([{ sessionId: "task-1" }, { sessionId: "task-1" }]);
    expect(vi.mocked(taskService.createTask)).toHaveBeenCalledTimes(1);
    expect(bindings.snapshot()["trigger-a"]).toMatchObject({ sessionId: "task-1" });
    expect(bindings.snapshot()["trigger-b"]).toMatchObject({ sessionId: "task-1" });
  });
});

describe("evaluateBotAutoReplyGuard（复用 admitAutoReplyTurn，含占额）", () => {
  const identityMismatch = "remote:server:other:/srv/other";

  interface GuardInput {
    botId?: string;
    threadKey: string;
    actorId: string;
    workspaceIdentity?: string;
    chatType?: "private" | "group";
    senderType?: "user" | "app";
    mentionedBot?: boolean;
    groupCardAction?: boolean;
    elicitation?: boolean;
    providerMessageId?: string;
    commandText?: string;
  }

  async function guard(state: BotsStateFile, input: GuardInput): Promise<boolean> {
    const service = createBotsService({
      repo: createMemoryRepo(telegramConfig, state),
      triggerTaskBindingStore: createMemoryTriggerTaskBindingStore(),
    });
    return service.evaluateBotAutoReplyGuard!({
      workspaceIdentity: input.workspaceIdentity ?? WORKSPACE_IDENTITY,
      botId: input.botId ?? "telegram-1",
      threadKey: input.threadKey,
      actorId: input.actorId,
      ...(input.chatType !== undefined ? { chatType: input.chatType } : {}),
      ...(input.senderType !== undefined ? { senderType: input.senderType } : {}),
      ...(input.mentionedBot !== undefined ? { mentionedBot: input.mentionedBot } : {}),
      ...(input.groupCardAction !== undefined
        ? { groupCardAction: input.groupCardAction }
        : {}),
      ...(input.elicitation !== undefined ? { elicitation: input.elicitation } : {}),
      ...(input.providerMessageId !== undefined
        ? { providerMessageId: input.providerMessageId }
        : {}),
      ...(input.commandText !== undefined ? { commandText: input.commandText } : {}),
    });
  }

  it("私聊/非群 thread → 守卫不适用，真实 bot 发送者也 true", async () => {
    await expect(
      guard(
        { version: 3, bots: {} },
        {
          threadKey: "bot:telegram-1+user-1",
          actorId: "bot-other-app",
          senderType: "app",
        },
      ),
    ).resolves.toBe(true);
  });

  it("非话题群 owner 真人 senderType=user → true（不能把 owner 判成机器人）", async () => {
    await expect(
      guard(groupState({}), {
        threadKey: "bot:telegram-1+chat-1",
        actorId: "user-1",
        chatType: "group",
        senderType: "user",
      }),
    ).resolves.toBe(true);
  });

  it("非话题群真实另一台 bot（actorId≠owner）senderType=app 未被 @ → false", async () => {
    await expect(
      guard(groupState({}), {
        threadKey: "bot:telegram-1+chat-1",
        actorId: "bot-other-app",
        chatType: "group",
        senderType: "app",
        mentionedBot: false,
      }),
    ).resolves.toBe(false);
  });

  it("非话题群真实 bot 被 @ → true 并占额一次", async () => {
    const state = groupState({});
    const key = JSON.stringify(["telegram-1", "chat-1"]);
    await expect(
      guard(state, {
        threadKey: "bot:telegram-1+chat-1",
        actorId: "bot-other-app",
        chatType: "group",
        senderType: "app",
        mentionedBot: true,
        providerMessageId: "msg-1",
      }),
    ).resolves.toBe(true);
    expect(state.bots[key]!.group!.autoReplyGuard).toEqual({
      consecutive: 1,
      messageIds: ["msg-1"],
    });
  });

  it("owner 卡片回调/elicitation → 原样 true（不按发送者身份拒绝）", async () => {
    await expect(
      guard(groupState({}), {
        threadKey: "bot:telegram-1+chat-1",
        actorId: "bot-other-app",
        chatType: "group",
        senderType: "app",
        groupCardAction: true,
      }),
    ).resolves.toBe(true);
    await expect(
      guard(groupState({}), {
        threadKey: "bot:telegram-1+chat-1",
        actorId: "bot-other-app",
        chatType: "group",
        senderType: "app",
        elicitation: true,
      }),
    ).resolves.toBe(true);
  });

  it("话题群 topicActive=true 且占额未超 → 机器人 true", async () => {
    await expect(
      guard(groupState({ threadId: "thread-1", topicActive: true }), {
        threadKey: "bot:telegram-1+chat-1/thread-1",
        actorId: "bot-other-app",
        chatType: "group",
        senderType: "app",
        providerMessageId: "msg-topic-1",
      }),
    ).resolves.toBe(true);
  });

  it("话题群占额 consecutive>=5 → 机器人 false；真人仍 true", async () => {
    await expect(
      guard(groupState({ threadId: "thread-1", topicActive: true, consecutive: 5 }), {
        threadKey: "bot:telegram-1+chat-1/thread-1",
        actorId: "bot-other-app",
        chatType: "group",
        senderType: "app",
        providerMessageId: "msg-topic-2",
      }),
    ).resolves.toBe(false);
    await expect(
      guard(groupState({ threadId: "thread-1", topicActive: true, consecutive: 5 }), {
        threadKey: "bot:telegram-1+chat-1/thread-1",
        actorId: "human-9",
        chatType: "group",
        senderType: "user",
      }),
    ).resolves.toBe(true);
  });

  it("话题 context 未落地 → 机器人 false；真人 true", async () => {
    await expect(
      guard(
        { version: 3, bots: {} },
        {
          threadKey: "bot:telegram-1+chat-1/thread-1",
          actorId: "bot-other-app",
          chatType: "group",
          senderType: "app",
        },
      ),
    ).resolves.toBe(false);
    await expect(
      guard(
        { version: 3, bots: {} },
        {
          threadKey: "bot:telegram-1+chat-1/thread-1",
          actorId: "human-9",
          chatType: "group",
          senderType: "user",
        },
      ),
    ).resolves.toBe(true);
  });

  it("群未启用 → 机器人 false、真人 true（授权由后续流程处理）", async () => {
    await expect(
      guard(groupState({ enabled: false }), {
        threadKey: "bot:telegram-1+chat-1",
        actorId: "bot-other-app",
        chatType: "group",
        senderType: "app",
      }),
    ).resolves.toBe(false);
    await expect(
      guard(groupState({ enabled: false }), {
        threadKey: "bot:telegram-1+chat-1",
        actorId: "human-9",
        chatType: "group",
        senderType: "user",
      }),
    ).resolves.toBe(true);
  });

  it("bot 不是群 owner → 有消息 ID 时一律 false（legacy 同规则）", async () => {
    await expect(
      guard(groupState({ ownerId: "other-owner" }), {
        threadKey: "bot:telegram-1+chat-1",
        actorId: "human-9",
        chatType: "group",
        senderType: "user",
        providerMessageId: "msg-owner-1",
      }),
    ).resolves.toBe(false);
  });

  it("接受 intake 复合 threadKey（<ws>|bot:...）", async () => {
    await expect(
      guard(groupState({}), {
        threadKey: `${WORKSPACE_IDENTITY}|bot:telegram-1+chat-1`,
        actorId: "user-1",
        chatType: "group",
        senderType: "user",
      }),
    ).resolves.toBe(true);
  });

  it("threadKey 的 bot 与请求 botId 不一致 → 响亮失败", async () => {
    await expect(
      guard(groupState({}), {
        botId: "telegram-2",
        threadKey: "bot:telegram-1+chat-1",
        actorId: "human-9",
      }),
    ).rejects.toThrow(/不一致/u);
  });

  it("群 context 与请求 workspaceIdentity 不一致 → 响亮失败", async () => {
    await expect(
      guard(groupState({}), {
        threadKey: "bot:telegram-1+chat-1",
        actorId: "human-9",
        workspaceIdentity: identityMismatch,
      }),
    ).rejects.toThrow(/跨 workspace/u);
  });
});
