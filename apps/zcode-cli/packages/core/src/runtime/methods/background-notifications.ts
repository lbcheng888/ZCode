import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import type { BackgroundResultOriginMeta } from "@zcode/contracts";
import {
  createRuntimeCommandId,
  type RuntimeCommandId,
  type TaskNotificationRuntimeCommand,
} from "../command-queue.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { SealBackgroundTaskNotificationsInput } from "../types.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/notification-policy.js";
import { joinTaskNotificationBatch } from "../../runtime-task/notification.js";

/**
 * claim 键行落库（at-most-once 的认领凭证）。成功返回 true；账本缺席或写失败返回 false
 * （fail-closed，调用方据此不入队/不认领，留待下次 resume 重试）。
 */
export async function persistBackgroundTaskNotificationClaim(
  this: AgentRuntimeInternal,
  input: {
    commandId: string;
    originMeta?: BackgroundResultOriginMeta;
    taskId?: string;
    text: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const claim = this.sessionStore?.saveSessionInput?.({
    id: input.commandId,
    sessionID: this.sessionId,
    kind: "backgroundNotification",
    delivery: "queue",
    payload: {
      text: input.text,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.originMeta ? { originMeta: input.originMeta } : {}),
    },
  });
  if (!claim) {
    this.logger?.warn("Background notification claim unavailable: ledger missing", {
      ...traceContextToLogContext(input.traceContext),
      commandId: input.commandId,
      event: "runtime.background_task_notification.claim_unavailable",
      module: "core.runtime",
      taskId: input.taskId,
    });
    return false;
  }
  try {
    await this.trackResidencyBlockingWork(claim);
    return true;
  } catch (error) {
    this.logger?.warn("Failed to persist background notification claim", {
      ...traceContextToLogContext(input.traceContext),
      commandId: input.commandId,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_input.claim_persist_failed",
      module: "core.runtime",
      status: "failed",
      taskId: input.taskId,
    });
    return false;
  }
}

/**
 * 常规入队（同步 void，既有调用方零改动）：先入队、账本行 fire-and-forget。
 *
 * 带 `commandId` 的 claim 路径（仅 wake re-feed）不走这里——重投必须先 await claim 键行
 * 落库、确认成功再入队，否则键行写失败而通知已投递时，下一次 resume 会把同一条 wake
 * 再投一次（at-most-once 退化为 at-least-once）。claim 路径见 refeed 的
 * persistBackgroundTaskNotificationClaim + 本函数 `claimPersisted: true`。
 */
export function enqueueBackgroundTaskNotification(
  this: AgentRuntimeInternal,
  notification: {
    /**
     * 稳定幂等键（重投路径从 taskId 派生，如 `refeed_<runId>`）：在场时作为 runtime 命令 id
     * 与账本行 id，claim-once 据此吸收重复。缺席时维持进程内序列 id——既有调用方零改动。
     */
    commandId?: string;
    /**
     * claim 路径专用：调用方已 await claim 键行落库成功（persistBackgroundTaskNotificationClaim），
     * 本函数跳过账本写入——键行已在场，重复 upsert 无意义且必须保持「先落库后入队」的代码序。
     */
    claimPersisted?: boolean;
    originMeta?: BackgroundResultOriginMeta;
    taskId?: string;
    text: string;
    toolName?: string;
    traceContext: TraceContext;
  },
): boolean {
  if (this.shuttingDown) {
    // 防御直接调用路径：session teardown 期间只允许任务状态收口，不能再启动模型轮次。
    this.logger?.info?.("Dropped background task notification during runtime shutdown", {
      ...traceContextToLogContext(notification.traceContext),
      event: "runtime.background_task_notification.shutdown_dropped",
      module: "core.runtime",
      taskId: notification.taskId,
      toolName: notification.toolName,
    });
    return false;
  }
  const task = notification.taskId ? this.runtimeTaskRegistry.get(notification.taskId) : undefined;
  const branchGeneration = task?.branchGeneration ?? this.branchGeneration;
  if (branchGeneration !== this.branchGeneration) {
    this.logger?.debug("Dropped stale-branch background task notification", {
      ...traceContextToLogContext(notification.traceContext),
      branchGeneration,
      currentBranchGeneration: this.branchGeneration,
      event: "runtime.background_task_notification.stale_branch_dropped",
      module: "core.runtime",
      taskId: notification.taskId,
    });
    return false;
  }
  const commandId = notification.commandId
    ? (notification.commandId as RuntimeCommandId)
    : createRuntimeCommandId();
  this.enqueueRuntimeCommand({
    branchGeneration,
    createdAt: new Date(),
    id: commandId,
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    originMeta: notification.originMeta,
    taskId: notification.taskId,
    text: notification.text,
    toolName: notification.toolName,
    traceContext: notification.traceContext,
  });
  if (notification.claimPersisted) return true;
  // wake 入账本（admitted）。runtime 命令队列是纯内存的，账本是唯一 durable 痕迹——
  // 崩溃重启后 resume 把残留 admitted 收口为 discarded(session_resumed)（留痕不静默）；
  // 其中主体仍存活的终态 workflow 窄结果由 wake re-feed（background-wake-refeed.ts）
  // 以稳定键幂等重投，死 Bash/死 subagent 维持丢弃。
  const admission = this.sessionStore?.saveSessionInput?.({
    id: String(commandId),
    sessionID: this.sessionId,
    kind: "backgroundNotification",
    delivery: "queue",
    payload: {
      text: notification.text,
      ...(notification.taskId ? { taskId: notification.taskId } : {}),
      ...(notification.originMeta ? { originMeta: notification.originMeta } : {}),
    },
  });
  if (admission) {
    void this.trackResidencyBlockingWork(admission).catch((error) => {
      this.logger?.warn("Failed to admit background notification to ledger", {
        ...traceContextToLogContext(notification.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.admit_failed",
        module: "core.runtime",
        status: "failed",
      });
    });
  }
  return true;
}

export function sealBackgroundTaskNotifications(
  this: AgentRuntimeInternal,
  input: SealBackgroundTaskNotificationsInput,
): void {
  if (this.config.taskType !== "subagent_child") return;
  this.backgroundTaskNotificationsSealed = true;
  this.backgroundTaskNotificationSealReason = input.reason;
  this.logger?.info?.("Subagent runtime background task notifications sealed", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "runtime.background_task_notifications.sealed",
    module: "core.runtime",
    reason: input.reason,
  });
}

export async function persistBackgroundTaskNotificationCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): Promise<MessageId> {
  const persisted = await persistBackgroundTaskNotificationBatch.call(this, [command], true);
  return persisted.messageId;
}

export interface PersistedBackgroundTaskNotificationBatch {
  /** 仅整批来源一致时存在；混合/缺失来源不能从代表任务推断。 */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  messageId: MessageId;
  originMeta?: BackgroundResultOriginMeta;
  text: string;
}

const MAX_BACKGROUND_RESULT_TITLES = 3;

function resolveBackgroundTaskNotificationSource(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): BackgroundResultOriginMeta["backgroundSource"] | undefined {
  const source = commands[0].originMeta?.backgroundSource;
  if (!source || commands.some((command) => command.originMeta?.backgroundSource !== source)) {
    // 展示 metadata 只保留代表任务，不能把首项来源当作整批因果来源；
    // 混合或缺失来源留空，避免 notification 到达顺序改变 message_source。
    return undefined;
  }
  return source;
}

export function resolveBackgroundTaskNotificationOriginMeta(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): BackgroundResultOriginMeta | undefined {
  // 单条：originMeta 整体透传，workflowNotification 载荷免费搭车（manifest 渲染的唯一数据源）。
  if (commands.length === 1) return commands[0].originMeta;

  const originMetas: BackgroundResultOriginMeta[] = [];
  for (const command of commands) {
    const originMeta = command.originMeta;
    if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
    originMetas.push(originMeta);
  }

  const representative = originMetas[0];
  if (!representative) return undefined;
  const visibleTitles = originMetas
    .slice(0, MAX_BACKGROUND_RESULT_TITLES)
    .map((originMeta) => originMeta.title.trim());
  const remainingCount = originMetas.length - visibleTitles.length;
  const title = [...visibleTitles, ...(remainingCount > 0 ? [`+${remainingCount}`] : [])].join(
    " · ",
  );

  // 多 notification 共用一个 turn 后若直接丢弃 originMeta，后台结果会退化为
  // 普通 assistant 渲染。这里复用首个任务的展示锚点并只合成 title，不引入 batch schema。
  //
  // workflowNotification 载荷**刻意不合成**：manifest 是「一轮 ↔ 一张」的对应，批量下这条关系不成立——谎报第一条的
  // 载荷比整轮退化成裸标题行更坏。只保留 {backgroundSource, title, workId} 三个基字段，
  // 整轮据此退回现状标题行。
  return {
    backgroundSource: representative.backgroundSource,
    title,
    workId: representative.workId,
  };
}

export async function persistBackgroundTaskNotificationBatch(
  this: AgentRuntimeInternal,
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
  midTurn = false,
): Promise<PersistedBackgroundTaskNotificationBatch> {
  const firstCommand = commands[0];
  const backgroundSource = resolveBackgroundTaskNotificationSource(commands);
  const originMeta = resolveBackgroundTaskNotificationOriginMeta(commands);
  const texts = commands.map((command) => command.text);
  // 这一轮的输入文本仍以 "\n\n" 相连，App 据此逐条解析任务卡片。
  const text = joinTaskNotificationBatch(texts);
  // 修复原因：整批原来存成一个连接字符串，投影时再按 <task-notification> 开头猜每条的边界；
  // workflow 运行中通知不以它开头，会被并进前一条通知的包装。空闲整批的每条通知改为同一条消息的
  // 一个文本块，模型看到的和冷恢复读回的都按块包装，边界不靠猜。轮中通知每条单独入队，不成批。
  const blocks = !midTurn && texts.length > 1 ? texts : undefined;
  await this.ensureContextInitialized(firstCommand.traceContext);
  const messageID = createMessageId();
  const inputPresentation = midTurn ? "task_notification_steer" : "task_notification";
  this.messageHistory.addUser(
    blocks ? blocks.map((block) => ({ type: "text" as const, text: block })) : text,
    runtimeInputMetadata(inputPresentation),
  );
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    metadata: {
      inputPresentation,
      ...(originMeta ? { originMeta } : {}),
      visibility: "model-only",
    },
    sessionId: this.sessionId,
    source: "background_task",
    text: blocks ?? text,
    traceContext: firstCommand.traceContext,
    visibility: "model-only",
  });
  // outer drain 过去逐条持久化并逐条启动模型轮，pending 数量会线性放大
  // request 数。整批只写一条 synthetic message，同时仍逐项结算 ledger 身份。
  for (const command of commands) {
    await this.sessionStore
      ?.markSessionInputPromoted?.({
        id: String(command.id),
        sessionID: this.sessionId,
        promotedMessageID: messageID,
      })
      .catch((error) => {
        this.logger?.warn("Failed to mark background notification promoted", {
          ...traceContextToLogContext(command.traceContext),
          commandId: command.id,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "session_input.promote_mark_failed",
          module: "core.runtime",
          status: "failed",
        });
      });
  }
  return {
    ...(backgroundSource ? { backgroundSource } : {}),
    messageId: messageID,
    ...(originMeta ? { originMeta } : {}),
    text,
  };
}

export function shouldSuppressTaskNotificationRuntimeCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): boolean {
  const registryTask = command.taskId ? this.runtimeTaskRegistry.get(command.taskId) : undefined;
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: this.config.taskType === "subagent_child",
      notificationSealed: this.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: command.toolName,
    })
  ) {
    return false;
  }

  this.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(command.traceContext),
    commandId: command.id,
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: this.backgroundTaskNotificationSealReason,
    taskId: command.taskId,
    toolName: command.toolName,
  });
  return true;
}
