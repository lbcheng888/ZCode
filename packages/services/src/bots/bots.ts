import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ZCodeConfigOption,
  ZCodeProvider,
  BotConfig,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
  BotProvider,
  BotProviderCallbackResult,
  BotServiceStatus,
  BotWorkspaceRef,
  BotsConfigFile,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type { ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";
import type { BotOutboxDeadLetterRow } from "./outboxDeadLetter.js";

export interface BotOutboxDeadLetterRetrySummary {
  /** 本次扫描到的到期 pending 死信数。 */
  considered: number;
  /** 重放 payload 成功并清除的行数。 */
  sent: number;
  /** automation 引用行重放 watch 成功、投递路径恢复并清除的行数。 */
  restored: number;
  /** 本次重试后达到尝试上限、翻转为 dropped 的行数。 */
  dropped: number;
  /** 本次重试失败、仍保持 pending 的行数。 */
  failed: number;
}

export interface BotOutboxDeadLetterRetryParams {
  /** 只重试指定 bot 的死信；缺省扫描全部到期 pending 行。 */
  botId?: string;
}

export interface BotCreateBindCodeParams {
  botId?: string;
  allowedWorkspaces?: string[];
  ttlMs?: number;
}

export interface BotSaveBotParams {
  bot: BotConfig;
  credentialValue?: string;
  webhookSecretValue?: string;
}

export interface BotTestResult {
  ok: boolean;
  message: string;
  name?: string;
  provider?: BotProvider;
}

export interface BotBindCodeResult {
  code: string;
  expiresAt: number;
}

/** child `host.worker.createTask` 的 M2 冷启动上下文（与 wire schema 结构同源）。 */
export interface BotTriggerWorkerContext {
  goalSummary?: string;
  recentNarrowResults?: string[];
  openQuestions?: string[];
  recallSeedIds?: string[];
}

/**
 * child `host.worker.createTask`（B-SPEC §3.3）：按 `triggerId` 幂等创建 bot 会话，
 * 并沿既有 createTask/sendPrompt 路径投递唤醒文本。`payload` 已是 child 装配后的
 * 唤醒正文；`context` 随 wire 携带但正文优先，不做二次装配。
 */
export interface BotTriggerCreateTaskInput {
  workspaceIdentity: string;
  threadKey: string;
  triggerId: string;
  payload: string;
  context?: BotTriggerWorkerContext;
}

/**
 * child `host.autoReplyGuard`（B-SPEC §3.3）：`admitAutoReplyTurn` 包装。
 * 除定位事实外携带出口已规范化的发送者/寻址事实（与 TriggerSinkEnvelope.payload 同源）；
 * 判定与占额完全复用 legacy 守卫（命中即原子写 state），不按 actorId 猜发送者身份。
 * 缺省 senderType = "user"（与 legacy `!== "app"` 同义）。
 */
export interface BotAutoReplyGuardInput {
  workspaceIdentity: string;
  botId: string;
  threadKey: string;
  actorId: string;
  chatType?: "private" | "group";
  senderType?: "user" | "app";
  mentionedBot?: boolean;
  groupCardAction?: boolean;
  elicitation?: boolean;
  providerMessageId?: string;
  commandText?: string;
}

export interface BotListWorkspaceRefsParams {
  currentWorkspace?: BotWorkspaceRef;
}

export interface BotUserConfigOptionsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ZCodeProvider;
}

export interface BotAutomationRunWatchParams {
  /** 与该次 sendPrompt.traceId 一致，避免排队期间污染其他轮次。 */
  runId?: string;
  target: ZCodeAutomationBotDeliveryTarget;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface BotWeixinRegistrationBeginResult {
  qrCode: string;
  qrUrl: string;
  interval: number;
  expiresAt: number;
}

export interface BotWeixinRegistrationPollParams {
  qrCode: string;
}

export type BotWeixinRegistrationPollResult =
  | {
      status: "pending" | "scanned";
      interval: number;
    }
  | {
      status: "success";
      botToken: string;
      botId?: string;
    }
  | {
      status: "expired" | "error";
      message?: string;
    };

export interface BotFeishuRegistrationBeginParams {
  domain?: "feishu" | "lark";
}

export interface BotFeishuRegistrationBeginResult {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export interface BotFeishuRegistrationPollParams {
  deviceCode: string;
  domain?: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export type BotFeishuRegistrationPollResult =
  | {
      status: "pending";
      interval: number;
      domain: "feishu" | "lark";
      pollDomain?: "feishu" | "lark";
    }
  | {
      status: "success";
      appId: string;
      appSecret: string;
      domain: "feishu" | "lark";
      appName?: string;
      openId?: string;
    }
  | {
      status: "access_denied" | "expired" | "error";
      message?: string;
      domain: "feishu" | "lark";
    };

export interface IBotsService {
  replyToChannel?(
    params: import("@zcode/shared").ChannelReplyHostRequest,
  ): Promise<import("@zcode/shared").ChannelReplyResult>;
  validateTopicResource?(
    params: import("#src/bots/topicResource.js").TopicResourceRequest,
  ): Promise<void>;
  readTopicResource?(
    params: import("#src/bots/topicResource.js").TopicResourceRequest,
  ): Promise<import("@zcode/shared").ZCodePromptAttachment>;
  /**
   * 将 App 全局交互偏好同步给 Bot 已持有的远端 runtime；不得为此建立新的远端连接。
   */
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  getStatus(): Promise<BotServiceStatus>;
  getConfig(): Promise<BotsConfigFile>;
  listWorkspaceRefs(params?: BotListWorkspaceRefsParams): Promise<BotWorkspaceRef[]>;
  getUserConfigOptions(params: BotUserConfigOptionsParams): Promise<ZCodeConfigOption[]>;
  beginFeishuRegistration(
    params?: BotFeishuRegistrationBeginParams,
  ): Promise<BotFeishuRegistrationBeginResult>;
  pollFeishuRegistration(
    params: BotFeishuRegistrationPollParams,
  ): Promise<BotFeishuRegistrationPollResult>;
  beginWeixinRegistration(): Promise<BotWeixinRegistrationBeginResult>;
  pollWeixinRegistration(
    params: BotWeixinRegistrationPollParams,
  ): Promise<BotWeixinRegistrationPollResult>;
  saveConfig(config: BotsConfigFile): Promise<BotsConfigFile>;
  listBots(): Promise<BotConfig[]>;
  saveBot(params: BotSaveBotParams): Promise<BotConfig>;
  removeBotSecret(botId: string): Promise<BotConfig>;
  deleteBot(botId: string): Promise<void>;
  testBot(botId: string): Promise<BotTestResult>;
  createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult>;
  getGroupMemberNames?(params: { botId: string; chatId: string }): Promise<Record<string, string>>;
  getBotStates(): Promise<BotContextState[]>;
  retryTopicPreparation?(params: {
    botId: string;
    chatId: string;
    threadId: string;
    messageId: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
  getTopicDetails?(params: {
    botId: string;
    chatId: string;
    threadId?: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    messageCount: number;
    hasGap: boolean;
    historyEnabled: boolean;
    summaries: Array<{ checkpoint: string; text: string }>;
  }>;

  setGroupEnabled?(params: { botId: string; chatId: string; enabled: boolean }): Promise<void>;
  reconcileGroupResult?(params: {
    botId: string;
    chatId: string;
    deliveryId: string;
    threadId?: string;
    received: boolean;
  }): Promise<import("@zcode/shared").BotGroupDelivery>;
  resendGroupResult?(params: {
    botId: string;
    chatId: string;
    deliveryId: string;
    threadId?: string;
  }): Promise<import("@zcode/shared").BotGroupDelivery>;
  retryPrivateDelivery?(params: { botId: string; deliveryId: string }): Promise<void>;
  resetBotState(contextKey: string): Promise<void>;
  /** M7③ 出站死信审计视图（只读，无 UI）。 */
  listOutboxDeadLetters?(): Promise<BotOutboxDeadLetterRow[]>;
  /** M7③ 出站死信重试权威：单飞重试到期 pending 行，成功清行、到上限翻 dropped。 */
  retryBotOutboxDeadLetters?(params?: BotOutboxDeadLetterRetryParams): Promise<BotOutboxDeadLetterRetrySummary>;
  /** 在 automation prompt 派发前订阅终态，并把结果回推到创建它的 Bot 会话。 */
  watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void>;
  /**
   * child `host.worker.createTask` 窄方法：按 triggerId 幂等（Core 持久化绑定），
   * 复用既有 bots createTask/sendPrompt 路径。结构缺口时由 Core handler 报 unimplemented。
   */
  createBotTaskFromTrigger?(input: BotTriggerCreateTaskInput): Promise<{ sessionId: string }>;
  /**
   * child `host.autoReplyGuard` 窄方法：复用 `admitAutoReplyTurn`（含占额写 state）。
   */
  evaluateBotAutoReplyGuard?(input: BotAutoReplyGuardInput): Promise<boolean>;
  handleInboundMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleProviderCallback(provider: BotProvider, payload: unknown): Promise<BotOutboundMessage[]>;
  handleProviderCallbackResponse(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

export const IBotsService = createServiceDescriptor<IBotsService>(ServiceChannels.Bots);

/** Host 负责把旧线路身份解析到当前 Source；不允许 services 猜测连接目录。 */
export interface BotRemoteWorkspaceResolution {
  workspacePath: string;
  workspaceIdentity: string;
  target: import("@zcode/shared").RemoteTarget;
  /** 只有当前窗口存在在线 logical session 才有值，用于 attachment 换代隔离。 */
  runtimeKey?: string;
}
export type BotRemoteWorkspaceResolver = (
  workspace: { workspacePath: string; workspaceIdentity: string },
  purpose: "lookup" | "reconnect",
) => Promise<BotRemoteWorkspaceResolution | null>;
