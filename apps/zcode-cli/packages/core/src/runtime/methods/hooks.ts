import { HookEventName, traceContextToLogContext } from "../deps.js";
import type { HookRunResult, Model, TraceContext, TurnState } from "../deps.js";
import type { HookEventName as HookEventNameType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TurnStoppingListener, TurnStoppingListenerContext } from "../types.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

const MAX_STOP_HOOK_CONTINUATIONS = 3;
/** turn-stopping 异议链的单独上限(与 Stop hook 的续跑上限独立计数)。 */
export const MAX_TURN_STOPPING_OBJECTIONS = 3;

const EMPTY_HOOK_RESULT: HookRunResult = {
  additionalContexts: [],
};
const HOOK_CONTEXT_MAX_CHARS = 24_000;
const HOOK_PREVIEW_MAX_CHARS = 4_000;

type SessionStartSource = "startup" | "resume" | "clear" | "compact";

export async function runSessionStartHooks(
  this: AgentRuntimeInternal,
  source: SessionStartSource,
  traceContext: TraceContext,
  signal?: AbortSignal,
  model?: Pick<Model, "providerId" | "modelId">,
): Promise<HookRunResult> {
  if (this.sessionStartHookRan) return EMPTY_HOOK_RESULT;
  await this.workspaceHookAdmission?.activate(source, signal);
  this.sessionStartHookRan = true;
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  const selectedModel = model ?? this.getSessionModelSelection();
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.SessionStart,
      mode: this.getMode(),
      model: selectedModel ? `${selectedModel.providerId}/${selectedModel.modelId}` : undefined,
      sessionId: this.sessionId,
      source,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { matchValue: source, signal },
  );
}

export async function runUserPromptSubmitHooks(
  this: AgentRuntimeInternal,
  prompt: string,
  attachments: TurnState["attachments"] | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      attachmentsSummary: summarizeTurnAttachments(attachments),
      cwd: this.workingDirectory,
      hookEventName: HookEventName.UserPromptSubmit,
      mode: this.getMode(),
      prompt,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runStopHooks(
  this: AgentRuntimeInternal,
  response: string,
  toolCallCount: number,
  traceContext: TraceContext,
  signal?: AbortSignal,
  stopHookActive = false,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  const responsePreview = truncateForHook(response, HOOK_PREVIEW_MAX_CHARS);

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.Stop,
      mode: this.getMode(),
      responsePreview,
      responseText: response,
      sessionId: this.sessionId,
      stopHookActive,
      timestamp: new Date().toISOString(),
      toolCallCount,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export function injectHookAdditionalContextIntoMessageHistory(
  this: AgentRuntimeInternal,
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
): RuntimeMessageEntry | undefined {
  if (additionalContexts.length === 0) return undefined;
  const entry = systemReminderAttachmentEntry(
    "hook_context",
    formatLifecycleHookAdditionalContextBody(eventName, additionalContexts),
  );
  this.messageHistory.addEntries([entry]);
  return entry;
}

export function shouldContinueAfterStopHooks(
  result: HookRunResult,
  continuationCount: number,
): boolean {
  return (
    result.stopShouldContinue === true &&
    result.additionalContexts.length > 0 &&
    continuationCount < MAX_STOP_HOOK_CONTINUATIONS
  );
}

export function registerTurnStoppingListener(
  this: AgentRuntimeInternal,
  listener: TurnStoppingListener,
): () => void {
  this.turnStoppingListeners.push(listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = this.turnStoppingListeners.indexOf(listener);
    if (index >= 0) this.turnStoppingListeners.splice(index, 1);
  };
}

/**
 * turn-stopping 异议链(设计 §3.5):回合收尾前串行运行,首个反对者生效。
 * 监听者自身异常按「同意收尾」处理——异议链路故障不应把已完成的回合卡死,
 * 只记日志留痕。反对者应已在调用内经 steer/inject 车道补充输入,loop 随后
 * 重读收件箱决定是否真正续跑。
 */
export async function runTurnStoppingListeners(
  this: AgentRuntimeInternal,
  context: TurnStoppingListenerContext,
): Promise<boolean> {
  for (const listener of [...this.turnStoppingListeners]) {
    try {
      const verdict = await listener(context);
      if (verdict?.continue === true) {
        this.logger?.info("Turn stopping objection raised", {
          ...traceContextToLogContext(context.traceContext),
          event: "turn.stopping.objection_raised",
          module: "core.runtime",
          status: "waiting",
          ...(verdict.reason ? { reason: verdict.reason } : {}),
          turnId: context.turnId,
        });
        return true;
      }
    } catch (error) {
      this.logger?.warn("Turn stopping listener failed", {
        ...traceContextToLogContext(context.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "turn.stopping.listener_failed",
        module: "core.runtime",
        status: "failed",
        turnId: context.turnId,
      });
    }
  }
  return false;
}

function formatLifecycleHookAdditionalContextBody(
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
): string {
  const body = additionalContexts.map((context, index) => `#${index + 1}\n${context}`).join("\n\n");
  return truncateForHook(
    [`${eventName} hook additional context: `, body].join("\n"),
    HOOK_CONTEXT_MAX_CHARS,
  );
}

function summarizeTurnAttachments(
  attachments: TurnState["attachments"] | undefined,
): string | undefined {
  if (!attachments || attachments.length === 0) return undefined;

  return attachments
    .map((attachment, index) => {
      if (attachment.path) return `${index + 1}:${attachment.type}:${attachment.path}`;
      if (attachment.content)
        return `${index + 1}:${attachment.type}:inline:${attachment.content.length} chars`;
      return `${index + 1}:${attachment.type}`;
    })
    .join("\n");
}

function truncateForHook(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}
