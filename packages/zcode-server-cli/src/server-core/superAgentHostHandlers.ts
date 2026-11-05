/**
 * Core 侧 child→Core 回调处理器（B-SPEC §3.3 / §3.4 / §7.2）。
 *
 * child 的派发桥、human-explicit 分派器与 intake 守卫经反向 RPC 请求这些方法；
 * Core 只做「转发到既有权威投影」，不自建平行 admission、不读 child 域库：
 * - `host.command` → `IZCodeAgentService.sendConversationCommandV4`（agent v4 gateway
 *   `commands/query`/handleCommand 的宿主窄入口），admission 回执原样作为 CommandAck；
 * - `host.worker.find` → botsService `getBotStates()`（threadKey→activeTaskId）+
 *   agent `listSessions`（会话终态投影）；
 * - `host.worker.resume` → agent `resumeSession`（幂等打开既有会话）。
 *
 * 结构缺口必须 typed 拒绝，不伪造：
 * - `host.worker.createTask`：需要「同一 triggerId 只建一次」的 Core 侧投递去重/订阅
 *   唯一约束 + bot 会话绑定；Core 本地没有该幂等状态（B-SPEC §3.3 实施缺口），
 *   直接返回 proto.unimplemented，不做「先建再说」。
 * - `host.autoReplyGuard`：`admitAutoReplyTurn` 仍是 botsService 内部函数，未暴露窄
 *   IBotsService 方法（同 §3.3 实施缺口）；返回 proto.unimplemented，不拿 bot 状态
 *   近似守卫语义。
 *
 * 注意：`host.worker.resume` 的 wire params 只有 `{workspaceIdentity, sessionId,
 * triggerId}`（§3.3 方法表），本处理器只打开既有会话、不投递文本。唤醒文本由 child
 * 在 resume 成功后另发 `host.command`（commandId=`triggerId:sessionId`，与 owned 直通
 * 同一幂等键）投递；child 侧投递失败会原样上抛，事件保持未决，不会产生「成功回执但
 * 无投递」的伪接线。
 */
import { isAbsolute } from "node:path";
import { IBotsService, IZCodeAgentService, type ServiceDescriptor } from "@zcode/services";
import { parseRemoteWorkspaceIdentity, type BotContextState } from "@zcode/shared";
import {
  commandAckSchema,
  commandPayloadSchemas,
  type CommandAck,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import {
  CONTROL_PLANE_RPC_ERROR_CODES,
  backfillSeedsParamsSchema,
  backfillSeedsResultSchema,
  hostAutoReplyGuardParamsSchema,
  hostCommandParamsSchema,
  hostWorkerCreateTaskParamsSchema,
  hostWorkerFindParamsSchema,
  hostWorkerResumeParamsSchema,
  type HostDeliveryLane,
} from "@zcode/shared/super-agent-control-plane-protocol";
import type { ZodType } from "zod";

import { ControlPlaneRpcError } from "../supervisor/controlPlaneClient.js";

/** 只依赖 ServiceCollection 的读面；测试注入替身即可，不伪造服务实例。 */
export interface SuperAgentHostServiceAccess {
  getOptional<T>(descriptor: ServiceDescriptor<T>): T | undefined;
}

/**
 * Core 派发桥结算面（B-SPEC §3.5 / §4.4.3）：`host.command` 是 child 派发桥与
 * trigger 直通共用的唯一 admission 入口，Core 在此把回执回灌 scheduler 的 run 台账：
 * - `isDeliverable`：投递前守卫（桥行所属 run 已 permanent 失败时不得再执行）；
 * - `settle`：ACK/拒绝回执 → `settleDispatchResult`，并订阅 worker 终态。
 * 由 core.ts 装配（scheduler + IZCodeTaskService 终态事件）；未注入 = 仅转发回执。
 */
export interface SuperAgentHostDispatchSettlement {
  isDeliverable(commandId: string): boolean;
  settle(commandId: string, ack: CommandAck, sessionId: string): Promise<void>;
}

export interface SuperAgentHostHandlerOptions {
  /**
   * 延迟取 Core services：`createControlPlaneClient` 早于 `createServerHostServices`
   * 构造（child 可能在 services 就绪前连接），处理器不得在装配期捕获服务实例。
   * 未就绪时的入站请求按可重试 workspace.failed 原样拒绝，不猜默认服务。
   */
  getServices: () => SuperAgentHostServiceAccess | undefined;
  /**
   * 派发结算面（scheduler 早于/晚于 inbound handler 装配，按调用时取；未就绪 =
   * 只转发回执，不回灌台账——不得伪造结算）。
   */
  getDispatchSettlement?: () => SuperAgentHostDispatchSettlement | undefined;
}

/** threadKey 形状（`buildBotTriggerThreadKeyHint`）：`bot:<botId>+<peer>[/<threadId>]`。 */
interface ParsedBotThreadKey {
  botId: string;
  peer: string;
  threadId?: string;
}

function parseBotThreadKey(threadKey: string): ParsedBotThreadKey | null {
  const prefix = "bot:";
  if (!threadKey.startsWith(prefix)) return null;
  const rest = threadKey.slice(prefix.length);
  const plus = rest.indexOf("+");
  if (plus <= 0) return null;
  const botId = rest.slice(0, plus);
  const tail = rest.slice(plus + 1);
  const slash = tail.indexOf("/");
  const peer = slash < 0 ? tail : tail.slice(0, slash);
  const threadId = slash < 0 ? undefined : tail.slice(slash + 1);
  if (!botId || !peer) return null;
  return { botId, peer, ...(threadId ? { threadId } : {}) };
}

function parseOrThrow<T>(schema: ZodType<T>, raw: unknown, method: string): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ControlPlaneRpcError(
    CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
    `${method} params invalid: ${parsed.error.message}`.slice(0, 500),
    false,
  );
}

function unimplemented(method: string, reason: string): ControlPlaneRpcError {
  return new ControlPlaneRpcError(
    CONTROL_PLANE_RPC_ERROR_CODES.unimplemented,
    `${method}: ${reason}`,
    false,
  );
}

/**
 * workspaceIdentity → workspacePath（agent 投影的唯一入参是真实路径）。
 * 解析优先级固定、无猜测：
 * 1. 远程 identity（`remote:server:<id>:<path>` / canonical `remote:*`）→ 内嵌 path；
 * 2. 本地绝对路径 identity（daemon scheduler 的 `resolveWorkspaceKey` 对无 identity
 *    automation 返回 path）→ 本身即 path；
 * 3. 以上都不成立时查 botsService 的 workspace 投影（BotState 同时带 identity 与 path）。
 * 都取不到 = Core 无法路由，typed invalidParams 响亮拒绝（不选任意 workspace）。
 */
async function resolveWorkspacePath(
  services: SuperAgentHostServiceAccess,
  workspaceIdentity: string,
): Promise<string> {
  const parsed = parseRemoteWorkspaceIdentity(workspaceIdentity);
  if (parsed) return parsed.workspacePath;
  if (isAbsolute(workspaceIdentity)) return workspaceIdentity;
  const bots = services.getOptional(IBotsService);
  if (bots?.getBotStates) {
    const states = await bots.getBotStates();
    const matched = states.find((state) => state.workspaceIdentity === workspaceIdentity);
    if (matched?.workspacePath) return matched.workspacePath;
  }
  throw new ControlPlaneRpcError(
    CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
    `workspaceIdentity 无法映射到 workspacePath: ${workspaceIdentity}`,
    false,
  );
}

/**
 * lane 只补充「未显式声明 requestedDelivery」的 sendText：child 派发桥的 envelope
 * 不带该字段（followup 默认），Core 必须按 §3.3 lane 表落成 queue/guide，否则 CLI
 * admission 会按缺省 startNow 抢占在跑回合。显式 requestedDelivery 一律保留
 * （child 的 laneFromEnvelope 正是从它推导，重复覆盖会反向改语义）。
 */
function applyDeliveryLane(envelope: CommandEnvelope, lane: HostDeliveryLane): CommandEnvelope {
  if (envelope.type !== "sendText") return envelope;
  const payload = parseOrThrow(commandPayloadSchemas.sendText, envelope.payload, "host.command");
  if (payload.requestedDelivery !== undefined) return envelope;
  return {
    ...envelope,
    payload: { ...payload, requestedDelivery: lane === "guide" ? "guide" : "queue" },
  };
}

async function handleHostCommand(
  services: SuperAgentHostServiceAccess,
  rawParams: unknown,
  settlement?: SuperAgentHostDispatchSettlement,
): Promise<CommandAck> {
  const params = parseOrThrow(hostCommandParamsSchema, rawParams, "host.command");
  const sessionId = params.sessionId ?? params.envelope.sessionId;
  if (sessionId === null) {
    // createSession 不是触发投递面；无目标会话无法构成 sendText admission。
    throw new ControlPlaneRpcError(
      CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
      "host.command requires a non-null sessionId",
      false,
    );
  }
  if (params.envelope.sessionId !== sessionId) {
    throw new ControlPlaneRpcError(
      CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
      "host.command sessionId does not match envelope.sessionId",
      false,
    );
  }
  if (params.commandId !== params.envelope.commandId) {
    // commandId 是 ACK/CAS 的唯一键；params 与信封不一致会让 settle 对错行，直接拒绝。
    throw new ControlPlaneRpcError(
      CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
      "host.command commandId does not match envelope.commandId",
      false,
    );
  }
  if (settlement && !settlement.isDeliverable(params.commandId)) {
    // 桥行所属 run 已失败/放弃：迟到的 pushed 行仍会被派发桥续推，若直接转发，
    // host 恢复后可能接受并执行一条已放弃的 automation。这里按确定性拒绝回执
    // （不是 RPC 错误：命令语义上不可投递），桥行保持 pushed 由 scheduler 重新 claim 后再投。
    return commandAckSchema.parse({
      commandId: params.commandId,
      status: "rejected",
      reasonCode: "dispatch.runNotClaimed",
      message: "dispatch run is not claimed; refusing delivery",
      revisionAtDecision: params.envelope.baseRevision ?? 0,
    });
  }
  const agent = services.getOptional(IZCodeAgentService);
  if (!agent) {
    throw new ControlPlaneRpcError(
      CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
      "host.command: IZCodeAgentService unavailable in Core",
      true,
    );
  }
  const workspacePath = await resolveWorkspacePath(services, params.workspaceIdentity);
  const ack = commandAckSchema.parse(
    await agent.sendConversationCommandV4({
      workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      envelope: applyDeliveryLane(params.envelope, params.lane),
    }),
  );
  // 回执先回灌 run 台账再返回给 child：结算失败原样上抛（child 会重推同 commandId，
  // 下一次 ACK 幂等重结算），不把「回执成功但台账丢失」伪装成已交付。
  await settlement?.settle(params.commandId, ack, sessionId);
  return ack;
}

/**
 * threadKey → BotState。group 键是 `getBotConversationKey` 的 JSON 元组
 * `[botId, chatId, threadId?]`；私聊键只是 botId（每 bot 至多一个私聊上下文）。
 */
function findBotStateForThreadKey(
  states: readonly BotContextState[],
  parsed: ParsedBotThreadKey,
): BotContextState | undefined {
  for (const state of states) {
    if (state.botId !== parsed.botId) continue;
    if (state.group) {
      if (state.group.chatId !== parsed.peer) continue;
      const stateThreadId = state.group.threadId ?? undefined;
      if (stateThreadId !== parsed.threadId) continue;
      return state;
    }
    // 私聊 threadKey 不携带 chatId；BotState 私聊键 = botId，已由上行过滤保证。
    if (parsed.threadId === undefined) return state;
  }
  return undefined;
}

/**
 * 会话是否已终态（可 resume）。`idle` 无活动回合、`completed/error` 已结束；
 * `running/waiting/paused` 均视为在跑（human-explicit 走 busying guide 投递）。
 *
 * `stoppedByHuman`：Core 会话投影没有「用户显式停止」事实面（task/session 状态只有
 * idle/running/waiting/paused/completed/error）。按存档单会话 worker 的同一诚实边界
 * 返回 false，不伪造 user-stop；该字段的权威归 runtime 控制面后续接线。
 */
function sessionIsTerminal(status: string): boolean {
  return status === "idle" || status === "completed" || status === "error";
}

async function handleWorkerFind(
  services: SuperAgentHostServiceAccess,
  rawParams: unknown,
): Promise<unknown> {
  const params = parseOrThrow(hostWorkerFindParamsSchema, rawParams, "host.worker.find");
  const parsedThreadKey = parseBotThreadKey(params.threadKey);
  if (!parsedThreadKey) {
    throw new ControlPlaneRpcError(
      CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
      `host.worker.find threadKey 不是 bot threadKey: ${params.threadKey}`,
      false,
    );
  }
  const bots = services.getOptional(IBotsService);
  const agent = services.getOptional(IZCodeAgentService);
  if (!agent) {
    throw new ControlPlaneRpcError(
      CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
      "host.worker.find: IZCodeAgentService unavailable in Core",
      true,
    );
  }
  // Core 的 threadKey→session 权威投影在 botsService；缺席即结构缺口，不能返回 null
  // 冒充「无 worker」（那会让 human-explicit 盲目 createTask）。
  if (!bots?.getBotStates) {
    throw unimplemented("host.worker.find", "botsService getBotStates unavailable in Core");
  }
  const botState = findBotStateForThreadKey(await bots.getBotStates(), parsedThreadKey);
  if (!botState?.activeTaskId) return null;
  // bot 投影自带真实 workspacePath；若它声明的 identity 与请求不一致，说明 threadKey
  // 命中了别的 workspace 的会话，必须响亮失败而不是跨 workspace 查询。
  if (botState.workspaceIdentity && botState.workspaceIdentity !== params.workspaceIdentity) {
    throw new ControlPlaneRpcError(
      CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
      `host.worker.find 跨 workspace: threadKey=${params.threadKey} bot=${botState.workspaceIdentity} request=${params.workspaceIdentity}`,
      false,
    );
  }
  const workspacePath = botState.workspacePath.trim();
  if (!workspacePath) {
    throw new ControlPlaneRpcError(
      CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
      `host.worker.find: bot 投影 workspacePath 为空（botId=${botState.botId}）`,
      false,
    );
  }
  const sessions = await agent.listSessions({
    workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    sessionIds: [botState.activeTaskId],
    limit: 1,
  });
  const session = sessions.find((entry) => entry.sessionId === botState.activeTaskId);
  if (!session) {
    // bot 投影指向的会话不在 agent 投影 = 投影不一致（会话被删/未 hydrate）。
    // 不能伪造 resumable worker；返回 typed 失败交给 Core 暴露真实不一致。
    throw new ControlPlaneRpcError(
      CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
      `host.worker.find: bot 投影 session 不在 agent 投影（sessionId=${botState.activeTaskId}）`,
      false,
    );
  }
  return {
    sessionId: session.sessionId,
    terminal: sessionIsTerminal(session.status),
    stoppedByHuman: false,
  };
}

async function handleWorkerResume(
  services: SuperAgentHostServiceAccess,
  rawParams: unknown,
): Promise<{ sessionId: string }> {
  const params = parseOrThrow(hostWorkerResumeParamsSchema, rawParams, "host.worker.resume");
  const agent = services.getOptional(IZCodeAgentService);
  if (!agent) {
    throw new ControlPlaneRpcError(
      CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
      "host.worker.resume: IZCodeAgentService unavailable in Core",
      true,
    );
  }
  const workspacePath = await resolveWorkspacePath(services, params.workspaceIdentity);
  // resumeSession 幂等打开既有会话（同 sessionId 重复调用收敛同一 runtime）。
  const snapshot = await agent.resumeSession({
    workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    sessionId: params.sessionId,
  });
  return { sessionId: snapshot.session.sessionId };
}

/**
 * Core 侧入站方法处理器（§3.3）。未知/未实现方法一律 `proto.unimplemented`
 * （retriable=false），不把结构缺口伪装成可重试错误让 child 无限重投。
 */
export function createSuperAgentControlPlaneInboundHandler(
  options: SuperAgentHostHandlerOptions,
): (method: string, params: unknown) => Promise<unknown> {
  return async (method, params) => {
    switch (method) {
      case "backfill.seeds": {
        // 解析失败即协议错误；空表表示 Core 当前没有可回填种子，不是伪造订阅。
        parseOrThrow(backfillSeedsParamsSchema, params, "backfill.seeds");
        return backfillSeedsResultSchema.parse({ seeds: [] });
      }
      case "host.command": {
        const services = options.getServices();
        if (!services) {
          throw new ControlPlaneRpcError(
            CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
            "host.command: Core services not initialized",
            true,
          );
        }
        return await handleHostCommand(
          services,
          params,
          options.getDispatchSettlement?.(),
        );
      }
      case "host.worker.find": {
        const services = options.getServices();
        if (!services) {
          throw new ControlPlaneRpcError(
            CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
            "host.worker.find: Core services not initialized",
            true,
          );
        }
        return await handleWorkerFind(services, params);
      }
      case "host.worker.resume": {
        const services = options.getServices();
        if (!services) {
          throw new ControlPlaneRpcError(
            CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
            "host.worker.resume: Core services not initialized",
            true,
          );
        }
        return await handleWorkerResume(services, params);
      }
      case "host.worker.createTask": {
        parseOrThrow(hostWorkerCreateTaskParamsSchema, params, "host.worker.createTask");
        throw unimplemented(
          "host.worker.createTask",
          "Core 缺少按 triggerId 幂等的会话创建/订阅绑定面，禁止「先建再说」",
        );
      }
      case "host.autoReplyGuard": {
        parseOrThrow(hostAutoReplyGuardParamsSchema, params, "host.autoReplyGuard");
        throw unimplemented(
          "host.autoReplyGuard",
          "botsService admitAutoReplyTurn 尚未暴露窄方法；不能用 bot 状态近似守卫",
        );
      }
      default:
        throw unimplemented(String(method), `Core has no handler for control-plane inbound method`);
    }
  };
}

/**
 * 兼容壳（无 services 注入）：只保留 backfill.seeds 的既有行为，其余方法
 * `proto.unimplemented`。生产装配用 `createSuperAgentControlPlaneInboundHandler`。
 */
export async function handleSuperAgentControlPlaneInboundRequest(
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method === "backfill.seeds") {
    parseOrThrow(backfillSeedsParamsSchema, params, "backfill.seeds");
    return backfillSeedsResultSchema.parse({ seeds: [] });
  }
  throw unimplemented(String(method), "Core inbound handler run without services");
}
