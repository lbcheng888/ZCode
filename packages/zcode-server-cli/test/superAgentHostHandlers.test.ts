/**
 * Core child→Core 回调处理器（B-SPEC §3.3）单测：用真实处理器 + 服务投影替身，
 * 验证 host.command 转发/ACK 原样、worker.find/resume 的 Core 投影查询、createTask/
 * autoReplyGuard 的窄方法转发，以及窄方法缺席时的 typed unimplemented。
 */
import { describe, expect, it } from "vitest";
import {
  IBotsService,
  IZCodeAgentService,
  type ServiceDescriptor,
} from "@zcode/services";
import type { BotContextState } from "@zcode/shared";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { CONTROL_PLANE_RPC_ERROR_CODES } from "@zcode/shared/super-agent-control-plane-protocol";
import {
  createSuperAgentControlPlaneInboundHandler,
  type SuperAgentHostDispatchSettlement,
  type SuperAgentHostServiceAccess,
} from "../src/server-core/superAgentHostHandlers.js";

function commandAck(commandId: string, status: CommandAck["status"] = "accepted"): CommandAck {
  return { commandId, status, revisionAtDecision: 1 };
}

function sendTextEnvelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    commandId: "cmd-1",
    clientId: "trigger",
    sessionId: "session-1",
    type: "sendText",
    payload: { text: "hello" },
    issuedAt: 1,
    ...overrides,
  };
}

interface FakeAgent {
  sendConversationCommandV4(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    envelope: CommandEnvelope;
  }): Promise<CommandAck>;
  listSessions(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionIds?: string[];
  }): Promise<Array<{ sessionId: string; status: string }>>;
  resumeSession(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
  }): Promise<{ session: { sessionId: string } }>;
}

function createServices(options: {
  agent?: FakeAgent;
  botStates?: BotContextState[];
  bots?: Record<string, unknown>;
}): SuperAgentHostServiceAccess {
  const bots =
    options.bots ??
    (options.botStates ? { getBotStates: async () => options.botStates } : undefined);
  return {
    getOptional<T>(descriptor: ServiceDescriptor<T>): T | undefined {
      if (descriptor === IZCodeAgentService) return options.agent as T | undefined;
      if (descriptor === IBotsService) return bots as T | undefined;
      return undefined;
    },
  };
}

function handler(
  services: SuperAgentHostServiceAccess | undefined,
  settlement?: SuperAgentHostDispatchSettlement,
) {
  return createSuperAgentControlPlaneInboundHandler({
    getServices: () => services,
    getDispatchSettlement: () => settlement,
  });
}

const REMOTE_IDENTITY = "remote:server:source-1:/srv/repo";

describe("Core control-plane host handlers", () => {
  it("host.command：远程 identity 解析 workspacePath，lane 缺省补 requestedDelivery=queue", async () => {
    const commands: Array<{ workspacePath: string; workspaceIdentity?: string; envelope: CommandEnvelope }> = [];
    const agent: FakeAgent = {
      async sendConversationCommandV4(params) {
        commands.push(params);
        return commandAck(params.envelope.commandId);
      },
      async listSessions() {
        return [];
      },
      async resumeSession() {
        return { session: { sessionId: "session-1" } };
      },
    };
    const call = handler(createServices({ agent }));
    const result = await call("host.command", {
      workspaceIdentity: REMOTE_IDENTITY,
      commandId: "cmd-1",
      lane: "followup",
      sessionId: "session-1",
      envelope: sendTextEnvelope(),
    });
    expect(result).toEqual(commandAck("cmd-1"));
    expect(commands).toHaveLength(1);
    expect(commands[0]!.workspacePath).toBe("/srv/repo");
    expect((commands[0]!.envelope.payload as { requestedDelivery?: string }).requestedDelivery).toBe(
      "queue",
    );
  });

  it("host.command：lane=guide 补 requestedDelivery=guide；显式 requestedDelivery 不被覆盖", async () => {
    const envelopes: CommandEnvelope[] = [];
    const agent: FakeAgent = {
      async sendConversationCommandV4(params) {
        envelopes.push(params.envelope);
        return commandAck(params.envelope.commandId);
      },
      async listSessions() {
        return [];
      },
      async resumeSession() {
        return { session: { sessionId: "session-1" } };
      },
    };
    const call = handler(createServices({ agent }));
    await call("host.command", {
      workspaceIdentity: REMOTE_IDENTITY,
      commandId: "cmd-2",
      lane: "guide",
      sessionId: "session-1",
      envelope: sendTextEnvelope({ commandId: "cmd-2" }),
    });
    await call("host.command", {
      workspaceIdentity: REMOTE_IDENTITY,
      commandId: "cmd-3",
      lane: "guide",
      sessionId: "session-1",
      envelope: sendTextEnvelope({
        commandId: "cmd-3",
        payload: { text: "explicit", requestedDelivery: "startNow" },
      }),
    });
    expect(envelopes[0]!.payload).toMatchObject({ requestedDelivery: "guide" });
    expect(envelopes[1]!.payload).toMatchObject({ requestedDelivery: "startNow" });
  });

  it("host.command：sessionId 缺失/信封不一致 → invalidParams，不转发", async () => {
    const agent: FakeAgent = {
      async sendConversationCommandV4() {
        throw new Error("should not be called");
      },
      async listSessions() {
        return [];
      },
      async resumeSession() {
        return { session: { sessionId: "session-1" } };
      },
    };
    const call = handler(createServices({ agent }));
    await expect(
      call("host.command", {
        workspaceIdentity: REMOTE_IDENTITY,
        commandId: "cmd-4",
        lane: "followup",
        envelope: sendTextEnvelope({ sessionId: null }),
      }),
    ).rejects.toMatchObject({ code: CONTROL_PLANE_RPC_ERROR_CODES.invalidParams });
    await expect(
      call("host.command", {
        workspaceIdentity: REMOTE_IDENTITY,
        commandId: "cmd-5",
        lane: "followup",
        sessionId: "other-session",
        envelope: sendTextEnvelope(),
      }),
    ).rejects.toMatchObject({ code: CONTROL_PLANE_RPC_ERROR_CODES.invalidParams });
    await expect(
      call("host.command", {
        workspaceIdentity: REMOTE_IDENTITY,
        commandId: "cmd-other",
        lane: "followup",
        sessionId: "session-1",
        envelope: sendTextEnvelope({ sessionId: "session-1" }),
      }),
    ).rejects.toMatchObject({ code: CONTROL_PLANE_RPC_ERROR_CODES.invalidParams });
  });

  it("workspaceIdentity 无法映射到路径 → invalidParams（不猜 workspace）", async () => {
    const agent: FakeAgent = {
      async sendConversationCommandV4() {
        throw new Error("should not be called");
      },
      async listSessions() {
        return [];
      },
      async resumeSession() {
        return { session: { sessionId: "session-1" } };
      },
    };
    const call = handler(createServices({ agent }));
    await expect(
      call("host.command", {
        workspaceIdentity: "not-a-path-or-identity",
        commandId: "cmd-6",
        lane: "followup",
        sessionId: "session-1",
        envelope: sendTextEnvelope(),
      }),
    ).rejects.toMatchObject({ code: CONTROL_PLANE_RPC_ERROR_CODES.invalidParams });
  });

  it("host.worker.find：bot 投影 threadKey→activeTaskId + 会话状态→terminal", async () => {
    const botStates: BotContextState[] = [
      {
        botId: "bot-1",
        workspacePath: "/srv/repo",
        workspaceIdentity: REMOTE_IDENTITY,
        mode: "task",
        activeTaskId: "task-1",
        updatedAt: 1,
      },
      {
        botId: "bot-2",
        workspacePath: "/srv/repo",
        workspaceIdentity: REMOTE_IDENTITY,
        group: { chatId: "chat-1", threadId: "thread-1" } as never,
        mode: "task",
        activeTaskId: "task-2",
        updatedAt: 1,
      },
    ];
    const statuses = new Map([
      ["task-1", "completed"],
      ["task-2", "running"],
    ]);
    const listed: string[][] = [];
    const agent: FakeAgent = {
      async sendConversationCommandV4() {
        throw new Error("unused");
      },
      async listSessions(params) {
        listed.push(params.sessionIds ?? []);
        return (params.sessionIds ?? []).map((sessionId) => ({
          sessionId,
          status: statuses.get(sessionId) ?? "idle",
        }));
      },
      async resumeSession() {
        return { session: { sessionId: "session-1" } };
      },
    };
    const call = handler(createServices({ agent, botStates }));

    expect(
      await call("host.worker.find", {
        workspaceIdentity: REMOTE_IDENTITY,
        threadKey: "bot:bot-1+user-1",
      }),
    ).toEqual({ sessionId: "task-1", terminal: true, stoppedByHuman: false });
    expect(
      await call("host.worker.find", {
        workspaceIdentity: REMOTE_IDENTITY,
        threadKey: "bot:bot-2+chat-1/thread-1",
      }),
    ).toEqual({ sessionId: "task-2", terminal: false, stoppedByHuman: false });
    expect(
      await call("host.worker.find", {
        workspaceIdentity: REMOTE_IDENTITY,
        threadKey: "bot:bot-2+chat-1/other-thread",
      }),
    ).toBeNull();
    // 生产 wire 的 threadKey 是 intake `mintThreadKey`（`<ws>|域键`），必须能解析。
    expect(
      await call("host.worker.find", {
        workspaceIdentity: REMOTE_IDENTITY,
        threadKey: `${REMOTE_IDENTITY}|bot:bot-1+user-1`,
      }),
    ).toEqual({ sessionId: "task-1", terminal: true, stoppedByHuman: false });
    expect(listed).toEqual([["task-1"], ["task-2"], ["task-1"]]);
  });

  it("host.worker.resume：转发真实 session 并返回权威 sessionId", async () => {
    const resumed: Array<{ sessionId: string; workspacePath: string }> = [];
    const agent: FakeAgent = {
      async sendConversationCommandV4() {
        throw new Error("unused");
      },
      async listSessions() {
        return [];
      },
      async resumeSession(params) {
        resumed.push({ sessionId: params.sessionId, workspacePath: params.workspacePath });
        return { session: { sessionId: params.sessionId } };
      },
    };
    const call = handler(createServices({ agent }));
    await expect(
      call("host.worker.resume", {
        workspaceIdentity: REMOTE_IDENTITY,
        sessionId: "session-9",
        triggerId: "trigger-1",
      }),
    ).resolves.toEqual({ sessionId: "session-9" });
    expect(resumed).toEqual([{ sessionId: "session-9", workspacePath: "/srv/repo" }]);
  });

  it("host.worker.createTask：转发窄方法并按 triggerId 原样交付 sessionId", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const call = handler(
      createServices({
        bots: {
          getBotStates: async () => [],
          createBotTaskFromTrigger: async (input: Record<string, unknown>) => {
            calls.push(input);
            return { sessionId: "task-9" };
          },
        },
      }),
    );
    await expect(
      call("host.worker.createTask", {
        workspaceIdentity: REMOTE_IDENTITY,
        threadKey: "bot:bot-1+user-1",
        triggerId: "trigger-1",
        payload: "wake",
        context: { goalSummary: "goal" },
      }),
    ).resolves.toEqual({ sessionId: "task-9" });
    expect(calls).toEqual([
      {
        workspaceIdentity: REMOTE_IDENTITY,
        threadKey: "bot:bot-1+user-1",
        triggerId: "trigger-1",
        payload: "wake",
        context: { goalSummary: "goal" },
      },
    ]);
    // 复合 key（<ws>|bot:...）原样转发给 botsService；解析与授权由服务侧负责。
    const composite = `${REMOTE_IDENTITY}|bot:bot-1+user-1`;
    await expect(
      call("host.worker.createTask", {
        workspaceIdentity: REMOTE_IDENTITY,
        threadKey: composite,
        triggerId: "trigger-2",
        payload: "wake",
      }),
    ).resolves.toEqual({ sessionId: "task-9" });
    expect(calls[1]).toMatchObject({ threadKey: composite, triggerId: "trigger-2" });
  });

  it("host.autoReplyGuard：转发只读判定，false 原样作为 admitted=false 返回", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const call = handler(
      createServices({
        bots: {
          evaluateBotAutoReplyGuard: async (input: Record<string, unknown>) => {
            calls.push(input);
            return false;
          },
        },
      }),
    );
    await expect(
      call("host.autoReplyGuard", {
        workspaceIdentity: REMOTE_IDENTITY,
        botId: "bot-1",
        threadKey: "bot:bot-1+chat-1/thread-1",
        actorId: "user-1",
      }),
    ).resolves.toEqual({ admitted: false });
    expect(calls).toEqual([
      {
        workspaceIdentity: REMOTE_IDENTITY,
        botId: "bot-1",
        threadKey: "bot:bot-1+chat-1/thread-1",
        actorId: "user-1",
      },
    ]);
  });

  it("host.autoReplyGuard：发送者/寻址事实原样转发（不按 actorId 猜身份）", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const call = handler(
      createServices({
        bots: {
          evaluateBotAutoReplyGuard: async (input: Record<string, unknown>) => {
            calls.push(input);
            return true;
          },
        },
      }),
    );
    await expect(
      call("host.autoReplyGuard", {
        workspaceIdentity: REMOTE_IDENTITY,
        botId: "bot-1",
        threadKey: "bot:bot-1+chat-1",
        actorId: "bot-other-app",
        chatType: "group",
        senderType: "app",
        mentionedBot: false,
        groupCardAction: false,
        elicitation: false,
        providerMessageId: "msg-1",
        commandText: "hello",
      }),
    ).resolves.toEqual({ admitted: true });
    expect(calls[0]).toMatchObject({
      actorId: "bot-other-app",
      chatType: "group",
      senderType: "app",
      mentionedBot: false,
      groupCardAction: false,
      elicitation: false,
      providerMessageId: "msg-1",
      commandText: "hello",
    });
    expect(calls[0]).not.toHaveProperty("providerUserId");
  });

  it("窄方法缺席 → typed unimplemented（retriable=false），不伪造成功", async () => {
    const call = handler(createServices({}));
    await expect(
      call("host.worker.createTask", {
        workspaceIdentity: REMOTE_IDENTITY,
        threadKey: "bot:bot-1+user-1",
        triggerId: "trigger-1",
        payload: "wake",
      }),
    ).rejects.toMatchObject({
      code: CONTROL_PLANE_RPC_ERROR_CODES.unimplemented,
      retriable: false,
    });
    await expect(
      call("host.autoReplyGuard", {
        workspaceIdentity: REMOTE_IDENTITY,
        botId: "bot-1",
        threadKey: "bot:bot-1+user-1",
        actorId: "user-1",
      }),
    ).rejects.toMatchObject({
      code: CONTROL_PLANE_RPC_ERROR_CODES.unimplemented,
      retriable: false,
    });
  });

  it("host.command：派发结算面在回执后回灌，且不可投递的桥行不转发给 agent", async () => {
    const commands: CommandEnvelope[] = [];
    const agent: FakeAgent = {
      async sendConversationCommandV4(params) {
        commands.push(params.envelope);
        return commandAck(params.envelope.commandId);
      },
      async listSessions() {
        return [];
      },
      async resumeSession() {
        return { session: { sessionId: "session-1" } };
      },
    };
    const settled: Array<{ commandId: string; ack: CommandAck; sessionId: string }> = [];
    let deliverable = true;
    const settlement: SuperAgentHostDispatchSettlement = {
      isDeliverable: () => deliverable,
      async settle(commandId, ack, sessionId) {
        settled.push({ commandId, ack, sessionId });
      },
    };
    const call = handler(createServices({ agent }), settlement);

    await call("host.command", {
      workspaceIdentity: REMOTE_IDENTITY,
      commandId: "cmd-1",
      lane: "followup",
      sessionId: "session-1",
      envelope: sendTextEnvelope(),
    });
    expect(commands).toHaveLength(1);
    expect(settled).toEqual([
      { commandId: "cmd-1", ack: commandAck("cmd-1"), sessionId: "session-1" },
    ]);

    // run 已放弃（permanent 失败）：桥仍会续推 pushed 行，但不得再执行。
    deliverable = false;
    const rejected = await call("host.command", {
      workspaceIdentity: REMOTE_IDENTITY,
      commandId: "cmd-2",
      lane: "followup",
      sessionId: "session-1",
      envelope: sendTextEnvelope({ commandId: "cmd-2" }),
    });
    expect(commands).toHaveLength(1);
    expect(rejected).toMatchObject({
      commandId: "cmd-2",
      status: "rejected",
      reasonCode: "dispatch.runNotClaimed",
    });
    expect(settled).toHaveLength(1);
  });

  it("未知方法/未初始化 services：typed 错误，不把缺口伪装成可重试成功", async () => {
    await expect(handler(undefined)("host.command", {})).rejects.toMatchObject({
      code: CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
      retriable: true,
    });
    await expect(handler(undefined)("host.worker.unknown", {})).rejects.toMatchObject({
      code: CONTROL_PLANE_RPC_ERROR_CODES.unimplemented,
      retriable: false,
    });
    await expect(
      handler(undefined)("backfill.seeds", { workspaceIdentity: "ws-1" }),
    ).resolves.toEqual({ seeds: [] });
  });
});
