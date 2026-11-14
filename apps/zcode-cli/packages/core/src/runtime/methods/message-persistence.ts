import type {
  PersistSyntheticToolPartInput,
  PersistSyntheticToolPartResult,
  RuntimeInputPresentation,
} from "@zcode/contracts";
import { createModelId, createModelProviderId } from "@zcode/contracts";
import {
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  SessionEventType,
  createMessageId,
  createPartId,
  traceContextToLogContext,
} from "../deps.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import type {
  EnvInfo,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageVisibility,
  Model,
  ModelTextContentBlock,
  SessionId,
  SessionProjection,
  SessionStorePort,
  TraceContext,
  SyntheticUserMessageSource,
  TurnExecutionKind,
  TurnId,
  TurnInputIntentMetadata,
} from "../deps.js";
import {
  emptyTokenUsageInfo,
  isHiddenReminderMessage,
  toRecordInput,
  toTokenUsageInfo,
} from "../helpers/index.js";
import type { ResolvedTurnAttachment } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildSyntheticUserNoticeMessageMetadata,
  buildSyntheticUserNoticePartMetadata,
  buildSyntheticUserNoticeSemantics,
} from "./synthetic-notice-metadata.js";
import { buildPersistedConversationInputIntent } from "./input-intent-persistence.js";
import { buildProjectionAnchor, mapSyntheticSourceToAnchorOrigin } from "./projection-anchor.js";

export async function persistUserPrompt(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  input: string,
  attachments: ResolvedTurnAttachment[] | undefined,
  traceContext: TraceContext,
  options?: {
    /**
     * drain 注入的输入把投递语义落到持久事实（metadata.turnSteerDelivery），
     * 冷恢复据此还原「queue=独立轮 / guide=内联当前轮」的切分，与 live 结构一致。
     */
    steerDelivery?: "guide" | "queue";
    inputPresentation?: RuntimeInputPresentation;
    /**
     * （promotion 原子性）：给定账本 id 且 store 支持时，账本置 promoted
     * 与 message/parts 持久化走同一事务——杜绝「queue 已消费但 transcript 无
     * user message」的孤儿窗口（旧 drain 跨 store 无事务）。
     */
    sessionInputId?: string;
    /** V4 command 幂等锚点；必须来自 CLI admission，不能在 drain 时换新 id。 */
    sourceCommandId?: string;
    clientId?: string;
    intent?: TurnInputIntentMetadata;
    /** 冷恢复所需的执行语义；不能只存在于 live TurnStarted。 */
    executionKind?: TurnExecutionKind;
    /** 引擎附加文本的起点；同样为冷恢复而存。 */
    epilogueStart?: number;
  },
): Promise<void> {
  this.latestConversationMessageId = messageID;
  if (!this.sessionStore) return;

  const created = Date.now();
  const tools = Object.fromEntries(this.getTools().map((tool) => [tool.name, true]));
  const conversationInputIntent = buildPersistedConversationInputIntent(
    input,
    options?.intent,
    "drained",
  );
  const message: Parameters<SessionStorePort["saveMessage"]>[0] = {
    id: messageID,
    sessionID: this.sessionId,
    role: "user",
    time: {
      created,
    },
    agent: this.config.agentName ?? "zcode-agent",
    modelSelection: this.getSessionModelSelection(),
    contextSnapshot: buildPersistedContextSnapshot(this.config.envInfo),
    semantics: {
      origin: "real_user",
      kind: "user_prompt",
      uiVisibility: "visible",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
    anchor: buildProjectionAnchor(
      traceContext,
      "realUser",
      options?.intent?.sourceCommandId ?? options?.sourceCommandId,
    ),
    system: this.config.systemPrompt,
    tools,
    ...(options?.inputPresentation ||
    options?.steerDelivery ||
    options?.clientId ||
    options?.intent ||
    options?.executionKind ||
    options?.epilogueStart !== undefined
      ? {
          metadata: {
            ...(options?.steerDelivery ? { turnSteerDelivery: options.steerDelivery } : {}),
            ...(options?.inputPresentation ? { inputPresentation: options.inputPresentation } : {}),
            ...(options?.intent ? { inputIntent: options.intent } : {}),
            ...(conversationInputIntent ? { conversationInputIntent } : {}),
            ...((options?.intent?.clientId ?? options?.clientId)
              ? { inputClientId: options?.intent?.clientId ?? options?.clientId }
              : {}),
            ...(options?.executionKind ? { executionKind: options.executionKind } : {}),
            ...(options?.intent?.highspeed ? { highspeed: options.intent.highspeed } : {}),
            ...(options?.epilogueStart === undefined
              ? {}
              : { epilogueStart: options.epilogueStart }),
          },
        }
      : {}),
  };
  const parts: MessagePart[] = [
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID,
      type: "text",
      text: withConversationQuotes(
        input,
        options?.intent?.conversationQuotes,
        options?.intent?.botGroupSource,
      ),
      time: {
        start: created,
        end: created,
      },
    },
    ...(attachments ?? []).map(
      (attachment): MessagePart => ({
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "file",
        mime: attachment.mime,
        filename: attachment.filename,
        url: attachment.url,
        source: attachment.source,
        metadata: attachment.metadata,
      }),
    ),
  ];

  if (options?.sessionInputId && this.sessionStore.promoteSessionInput) {
    await this.sessionStore.promoteSessionInput({
      id: options.sessionInputId,
      sessionID: this.sessionId,
      message,
      parts,
    });
    this.logger?.debug("Session input promoted", {
      ...traceContextToLogContext(traceContext),
      event: "session_input.promoted",
      messageId: messageID,
      module: "core.runtime",
      sessionInputId: options.sessionInputId,
      status: "completed",
    });
    const sourceCommandId =
      options.intent?.sourceCommandId ?? options.sourceCommandId ?? options.sessionInputId;
    // promotion 事务提交后再发事件：gateway 只能在此边界解除 live-input pin。
    // 若在 queue remove/TurnStarted 就解除，LRU churn 会在 transcript 尚未落盘时把
    // commands/query 退化成 unknown，重复执行同一输入。
    await this.appendEvent(
      this.createEvent(
        SessionEventType.SessionInputPromoted,
        {
          pendingInputId: options.sessionInputId,
          sourceCommandId,
          messageId: messageID,
        },
        traceContext,
      ),
      traceContext,
    );
    return;
  }

  await this.persistMessage(message, traceContext);
  for (const part of parts) {
    await this.persistPart(part, traceContext);
  }
}

export async function persistSyntheticUserNotice(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  text: string,
  traceContext: TraceContext,
): Promise<void> {
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    sessionId: this.sessionId,
    source: "rewind",
    text,
    traceContext,
  });
}

export async function persistSyntheticUserNoticeForSession(
  this: AgentRuntimeInternal,
  options: {
    messageID: MessageId;
    sessionId: SessionId;
    source: SyntheticUserMessageSource;
    /** 多段时每段一个文本 part，按顺序写入同一条消息。 */
    text: string | readonly string[];
    traceContext: TraceContext;
    /** 额外结构化 metadata，会与 `{ source }` 合并写到 part.metadata 上，供 UI 识别消息类型。 */
    metadata?: Record<string, unknown>;
    visibility?: MessageVisibility;
  },
): Promise<void> {
  const created = Date.now();
  const visibility = options.visibility ?? "model-only";
  const info: MessageInfo = {
    id: options.messageID,
    sessionID: options.sessionId,
    role: "user",
    time: {
      created,
    },
    agent: this.config.agentName ?? "zcode-agent",
    metadata: buildSyntheticUserNoticeMessageMetadata(options.source, visibility, options.metadata),
    modelSelection: this.getSessionModelSelection(),
    semantics: buildSyntheticUserNoticeSemantics(options.source, visibility),
    anchor: buildProjectionAnchor(
      options.traceContext,
      mapSyntheticSourceToAnchorOrigin(options.source),
    ),
    source: options.source,
    system: this.config.systemPrompt,
    synthetic: true,
    visibility,
  };
  const texts = typeof options.text === "string" ? [options.text] : options.text;
  const parts: MessagePart[] = texts.map((text) => ({
    id: createPartId(),
    sessionID: options.sessionId,
    messageID: options.messageID,
    type: "text",
    text,
    synthetic: true,
    time: {
      start: created,
      end: created,
    },
    metadata: buildSyntheticUserNoticePartMetadata(options.source, visibility, options.metadata),
  }));
  // 修复原因：冷恢复的 getLatestActiveSessionMessageId 跳过隐藏提醒（agent listing 等公告），
  // 这里却总移动指针，live 与冷恢复的 compaction 覆盖边界、timeline 锚点不一致。
  // 用同一个判定，并传入将要写入的同一条记录（含 part），与冷恢复读到的完全相同。
  if (options.sessionId === this.sessionId && !isHiddenReminderMessage({ info, parts })) {
    this.latestConversationMessageId = options.messageID;
  }
  if (!this.sessionStore) return;

  // 多个 part 同一事务写入：中途失败时不会留下只有前几段的消息，冷恢复读到的段数与 live 相同。
  if (parts.length > 1 && this.sessionStore.commitMessageBundle) {
    await this.sessionStore.commitMessageBundle({
      sessionID: options.sessionId,
      messages: [{ info, parts }],
    });
    this.logger?.debug("Session message bundle persisted", {
      ...traceContextToLogContext(options.traceContext),
      event: "session.message_bundle.persisted",
      messageId: options.messageID,
      module: "core.runtime",
      partCount: parts.length,
      status: "completed",
    });
    return;
  }
  await this.persistMessage(info, options.traceContext);
  for (const part of parts) await this.persistPart(part, options.traceContext);
}

export async function persistAssistantMessage(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  parentID: MessageId,
  created: number,
  update:
    | {
        completed?: number;
        error?: { name: string; data?: Record<string, unknown> };
        finish?: string;
        tokens?: ReturnType<typeof toTokenUsageInfo>;
        /** 这一步来自签名修复后的重试；写进 metadata，冷恢复后投影继续去掉修复前的签名块。 */
        signedReasoningReset?: boolean;
      }
    | undefined,
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  this.latestConversationMessageId = messageID;
  this.latestAssistantMessageId = messageID;
  if (traceContext.turnId) {
    this.latestAssistantTurnId = traceContext.turnId;
  }
  if (!this.sessionStore) return;
  const selection = this.getSessionModelSelection();
  const providerId =
    model?.providerId ?? (selection && createModelProviderId(selection.providerId));
  const modelId = model?.modelId ?? (selection && createModelId(selection.modelId));

  await this.persistMessage(
    {
      id: messageID,
      sessionID: this.sessionId,
      role: "assistant",
      time: {
        created,
        completed: update?.completed,
      },
      error: update?.error,
      parentID,
      // 默认模型可能在请求进行中切换；模型请求路径必须显式传入生成这条
      // 消息的模型。默认值只保留给不经过模型结果的既有 synthetic/fallback 路径。
      modelId,
      providerId,
      mode: this.config.mode ?? "build",
      planEnabled: this.getPlanEnabled(),
      agent: this.config.agentName ?? "zcode-agent",
      path: {
        cwd: this.workingDirectory,
        // cwd 可随 Bash cd 变化，root 必须保留会话初始工作区身份。
        root: this.workspaceRoot,
      },
      cost: 0,
      tokens: update?.tokens ?? emptyTokenUsageInfo(),
      finish: update?.finish,
      semantics: {
        origin: "agent_runtime",
        kind: "assistant_response",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: buildProjectionAnchor(traceContext),
      // 同一条消息每次保存都是整行覆盖；完成时必须带上标记，不能只在某次中间保存里写。
      ...(update?.signedReasoningReset ? { metadata: { signedReasoningReset: true } } : {}),
    },
    traceContext,
  );
}

/**
 * super-agent 经 runtime.executeTools 注入的合成工具调用（ProposeBestPlan 卡等）只发
 * 会话事件、不落 tool part，而冷恢复的 transcript hydration 只从 message 的 tool part
 * 合成 ToolCallScheduled（bootstrap transcript-hydration.ts synthesizeToolPart），卡片
 * 刷新/重启后消失。这里把它持久化成 transcript 事实：一条 assistant message + 一个
 * completed tool part，字段形状与 turn-tools 正常路径（tool-result-settlement）一致。
 */
export async function persistSyntheticToolPart(
  this: AgentRuntimeInternal,
  input: PersistSyntheticToolPartInput,
  traceContext?: TraceContext,
): Promise<PersistSyntheticToolPartResult> {
  // 幂等：callID 全局唯一，hydration 与产品投影都按它认领同一次工具调用；重放
  // （刷新自愈、调用方重试）直接返回既有 id。查重必须在 parent 解析之前——重启后
  // 重放时 store 已有事实，即使当前 turn 查不到 user message 也应短路返回。
  if (this.sessionStore) {
    const messages = await this.sessionStore.messages({ sessionID: this.sessionId });
    for (const message of messages) {
      const part = message.parts.find(
        (candidate) => candidate.type === "tool" && candidate.callID === input.toolCallId,
      );
      if (part) return { assistantMessageId: part.messageID, partId: part.id };
    }
  }

  const parentUserMessageId =
    input.parentUserMessageId ?? (await findTurnUserMessageId.call(this, input.turnId));
  if (!parentUserMessageId) {
    throw new Error(
      `persistSyntheticToolPart: turn ${input.turnId} 找不到 parent user message；` +
        "合成工具调用必须挂在真实轮次上，拒绝静默落一条无 parent 的 assistant 消息",
    );
  }

  const assistantMessageId = createMessageId();
  const partId = createPartId();
  // anchor.turnId 决定冷恢复轮归属；必须以声明的 turnId 入参为准，可选上下文不能改写它。
  const trace: TraceContext = { ...(traceContext ?? this.rootTraceContext), turnId: input.turnId };

  // time.completed 必须落：assistant 行缺 completed 且无 error 时冷路径判 cancelled。
  await this.persistAssistantMessage(
    assistantMessageId,
    parentUserMessageId,
    input.startedAt,
    { completed: input.endedAt },
    trace,
  );
  await this.persistPart(
    {
      id: partId,
      sessionID: this.sessionId,
      messageID: assistantMessageId,
      type: "tool",
      callID: input.toolCallId,
      tool: input.toolName,
      state: {
        status: "completed",
        input: toRecordInput(input.input),
        output: syntheticToolOutputToPersistedString(input.output),
        title: input.toolName,
        metadata: { schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION },
        time: { start: input.startedAt, end: input.endedAt },
      },
    },
    trace,
  );
  return { assistantMessageId, partId };
}

/** 查当前 turn 的 user message：v4 起 user prompt 把 turnId 落进 anchor（persistUserPrompt）。 */
async function findTurnUserMessageId(
  this: AgentRuntimeInternal,
  turnId: TurnId,
): Promise<MessageId | undefined> {
  if (!this.sessionStore) return undefined;
  const messages = await this.sessionStore.messages({ sessionID: this.sessionId });
  let found: MessageId | undefined;
  let created = -Infinity;
  for (const message of messages) {
    const info = message.info;
    if (info.role !== "user" || info.anchor?.turnId !== turnId) continue;
    // 同 turn 多条 user message（如 guide 内联）取最新一条作 parent。
    if (info.time.created >= created) {
      created = info.time.created;
      found = info.id;
    }
  }
  return found;
}

/** completed tool part 的 output 是字符串；非字符串按正常路径的结算语义序列化。 */
function syntheticToolOutputToPersistedString(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined) return "";
  return JSON.stringify(output) ?? "";
}

export async function persistMessage(
  this: AgentRuntimeInternal,
  input: Parameters<SessionStorePort["saveMessage"]>[0],
  traceContext: TraceContext,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): Promise<void> {
  if (!this.sessionStore) return;
  await this.sessionStore.saveMessage(input, copyFrom);
  this.logger?.debug("Session message persisted", {
    ...traceContextToLogContext(traceContext),
    event: "session.message.persisted",
    messageId: input.id,
    module: "core.runtime",
    role: input.role,
    status: "completed",
  });
}

export async function persistPart(
  this: AgentRuntimeInternal,
  input: MessagePart,
  traceContext: TraceContext,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): Promise<void> {
  if (!this.sessionStore) return;
  await this.sessionStore.savePart(input, copyFrom);
  this.logger?.debug("Session part persisted", {
    ...traceContextToLogContext(traceContext),
    event: "session.part.persisted",
    messageId: input.messageID,
    module: "core.runtime",
    partId: input.id,
    partType: input.type,
    status: "completed",
  });
}

/**
 * 每个文字块写一个 text part，冷恢复与 live 一样一块一行；空块不写。
 * 没有 textBlocks 时（旧路径）整段文字写成一个不带序号的 part。
 */
export async function persistTextBlockParts(
  runtime: AgentRuntimeInternal,
  input: {
    messageId: MessageId;
    textBlocks: readonly ModelTextContentBlock[] | undefined;
    text: string;
    time: { start: number; end: number };
  },
  traceContext: TraceContext,
): Promise<void> {
  const textBlocks = input.textBlocks ?? [{ type: "text" as const, text: input.text }];
  for (const block of textBlocks) {
    if (block.text.length === 0) continue;
    await runtime.persistPart(
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID: input.messageId,
        type: "text",
        text: block.text,
        ...(block.blockIndex !== undefined ? { blockIndex: block.blockIndex } : {}),
        time: { ...input.time },
      },
      traceContext,
    );
  }
}

function buildPersistedContextSnapshot(envInfo: EnvInfo | undefined):
  | {
      envInfo: EnvInfo;
    }
  | undefined {
  if (!envInfo) {
    return undefined;
  }

  return { envInfo: { ...envInfo } };
}

export async function rebuildProjection(this: AgentRuntimeInternal): Promise<SessionProjection> {
  const events = await this.eventStore.getEvents(this.sessionId);
  return this.eventReducer.reduce(events);
}
