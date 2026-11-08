import {
  SessionEventType,
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  createChildTraceContext,
  failedGoalCompletionVerification,
  formatGoalCompletionVerificationPrompt,
  parseGoalCompletionVerificationResult,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  GoalCompletionVerificationOutput,
  Model,
  SessionEvent,
  SessionGoal,
  TraceContext,
} from "../deps.js";
import type { RuntimeChengGateVerdict } from "../types.js";
import { prepareRuntimeProviderRequest, throwIfTurnAborted } from "../helpers/index.js";
import { projectMessagesForModelMediaPolicy } from "../helpers/media-budget.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel } from "./runtime-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { isStartPlanBusyStreamRecoveryFailure } from "./streaming-recovery.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { runTargetCompletionVerificationWithTelemetry } from "./target-completion-verification-telemetry.js";
import { pauseActiveTargetWithReason } from "./target.js";

export interface TargetCompletionVerificationResult {
  target: SessionGoal;
  verification: GoalCompletionVerificationOutput;
}

const TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS = new Set([
  "account:bigmodel-start-plan",
  "account:zai-start-plan",
]);

export async function verifyActiveTargetCompletionForContinuation(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<TargetCompletionVerificationResult | null> {
  if (this.config.targetCompletionVerification?.enabled === false) return null;
  if (!this.sessionStore) return null;
  if (input.target.status !== "active") return null;

  // S4 完成门：真实 ChengGate 是程序谓词，先于 LLM verifier。红 gate 或低于目标要求
  // 的 acceptance 等级都直接失败返回，LLM 不调用、无法翻案；无 gate 才进入原 verifier。
  // gate RPC 超时/子进程退出不是「验证未通过」：显式 pause 目标，绝不 fail-open。
  let chengGate: RuntimeChengGateVerdict | undefined;
  try {
    chengGate = await this.targetCompletionChengGate?.(input.target);
  } catch (error) {
    this.logger?.warn("Cheng completion gate failed", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "cheng.gate.error",
      module: "core.runtime",
      status: "failed",
      targetId: input.target.targetID,
    });
    await pauseActiveTargetWithReason.call(this, {
      expectedRevision: input.target.revision,
      expectedTargetID: input.target.targetID,
      reason: "cheng_gate_unavailable",
      traceContext: input.traceContext,
    });
    return {
      target: input.target,
      verification: failedGoalCompletionVerification(
        "Cheng gate is unavailable (cheng_host_unavailable).",
      ),
    };
  }
  if (chengGate !== undefined) {
    const reasons = chengGate.reasons.join(",") || chengGate.level;
    // host 不可用没有可执行的 gate 结论：目标显式暂停，等 host 恢复后由用户 resume，
    // 不能把基建故障伪装成「模型还需要继续」或静默 stand-down。
    if (chengGate.reasons.includes("cheng_host_unavailable")) {
      await pauseActiveTargetWithReason.call(this, {
        expectedRevision: input.target.revision,
        expectedTargetID: input.target.targetID,
        reason: "cheng_gate_unavailable",
        traceContext: input.traceContext,
      });
      return {
        target: input.target,
        verification: failedGoalCompletionVerification(
          "Cheng gate is unavailable (cheng_host_unavailable).",
        ),
      };
    }
    if (!chengGate.ok || chengGate.level === "BLOCKED") {
      // 红 gate 是确定性结论：把 reasons 交给模型并让回合继续修复，不能因缺少
      // nextAction 被当成 verifier 基建失败而停止目标。LLM verifier 不参与、无法翻案。
      return {
        target: input.target,
        verification: {
          passed: false,
          reason: `cheng_gate_blocked:${reasons}`,
          nextAction: `Cheng gate blocked: ${reasons}. Inspect the run evidence, fix the failing gate, then re-verify.`,
        },
      };
    }
    // 绿 gate 独立出卡：不依赖 continuation prompt 是否组装；同一 plan/run 只发一次，
    // 事件重放后投影里已有同一卡则跳过，避免每个 goal 回合重复写账本。
    // 卡片是只读先验证据，读/写失败只告警并省略，绝不阻断续跑。
    try {
      await publishGreenChengPlanCard.call(this, input);
    } catch (error) {
      this.logger?.warn("Failed to publish ChengPlan route card", {
        ...traceContextToLogContext(input.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "target.cheng_plan_card.failed",
        module: "core.runtime",
        status: "failed",
        targetId: input.target.targetID,
      });
    }
    const requiredLevel =
      input.target.acceptanceLevel ?? this.targetCompletionAcceptanceLevel ?? "production";
    if (requiredLevel === "production" && chengGate.level !== "PRODUCTION") {
      // diagnostic 绿不是 production 验收，且不是模型能靠继续工作修复的代码缺陷：
      // 目标显式暂停并记录原因，等用户决定是否降低 acceptanceLevel 或补 production 证据。
      await pauseActiveTargetWithReason.call(this, {
        expectedRevision: input.target.revision,
        expectedTargetID: input.target.targetID,
        reason: "cheng_gate_not_production",
        traceContext: input.traceContext,
      });
      return {
        target: input.target,
        verification: failedGoalCompletionVerification(
          "Cheng gate did not reach production acceptance.",
        ),
      };
    }
  }

  const execute = async (): Promise<TargetCompletionVerificationResult> => {
    const events: SessionEvent[] = [];
    const verification = await verifyTargetCompletion.call(this, {
      abortSignal: input.abortSignal,
      events,
      target: input.target,
      traceContext: input.traceContext,
    });

    if (!verification.passed) {
      return {
        target: input.target,
        verification,
      };
    }

    // 验证可能跨用户命令返回：完成写入必须绑定验证发起时的目标身份。目标已被替换或
    // revision 被改写时跳过写入——旧验证结论不得把新目标标成 complete。
    const previousTarget = await this.readSessionTargetForContext(input.traceContext);
    if (
      !previousTarget ||
      previousTarget.targetID !== input.target.targetID ||
      previousTarget.revision !== input.target.revision ||
      previousTarget.status !== "active"
    ) {
      this.logger?.warn("Goal completion write skipped after target changed", {
        ...traceContextToLogContext(input.traceContext),
        currentRevision: previousTarget?.revision,
        currentTargetId: previousTarget?.targetID,
        event: "target.completion.write.skipped_target_changed",
        module: "core.runtime",
        status: "completed",
        targetId: input.target.targetID,
      });
      return {
        target: input.target,
        verification: failedGoalCompletionVerification(
          "Completion verification was superseded by a target change.",
        ),
      };
    }
    const completedTarget = await this.sessionStore!.updateTargetStatus({
      sessionID: this.sessionId,
      status: "complete",
      expectedStatus: "active",
      expectedTargetID: input.target.targetID,
      expectedRevision: input.target.revision,
    });
    // 读后写之间的 CAS 未命中同样不是完成：目标已被并发改写，保持 active 并如实告警。
    if (!completedTarget) {
      this.logger?.warn("Goal completion CAS missed after concurrent target change", {
        ...traceContextToLogContext(input.traceContext),
        event: "target.completion.write.cas_missed",
        module: "core.runtime",
        status: "completed",
        targetId: input.target.targetID,
      });
      return {
        target: input.target,
        verification: failedGoalCompletionVerification(
          "Completion verification CAS missed after a concurrent target change.",
        ),
      };
    }
    await this.recordTargetChanged({
      action: "status_updated",
      previousTarget,
      source: "runtime",
      target: completedTarget,
      traceContext: input.traceContext,
    });

    return {
      target: completedTarget,
      verification,
    };
  };
  return runTargetCompletionVerificationWithTelemetry(this, input, execute);
}

/**
 * 绿 gate 的 compact 卡独立于 continuation prompt：读到卡片事实后写 target_changed，
 * 由 event reducer / v4 product projection 暴露给 UI。同 target + 同 plan/run 不重复写。
 */
async function publishGreenChengPlanCard(
  this: AgentRuntimeInternal,
  input: { target: SessionGoal; traceContext: TraceContext },
): Promise<void> {
  const card = await this.goalContinuationChengPlan?.(input.target);
  if (card === undefined) return;
  const projection = await this.rebuildProjection();
  if (
    projection.target?.targetID === input.target.targetID &&
    projection.targetChengPlanCard?.planId === card.planId &&
    projection.targetChengPlanCard?.runId === card.runId
  ) {
    return;
  }
  await this.recordTargetChanged({
    action: "cheng_plan_card",
    chengPlanCard: card,
    source: "runtime",
    target: input.target,
    traceContext: input.traceContext,
  });
}

async function verifyTargetCompletion(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<GoalCompletionVerificationOutput> {
  // 目标验证期间也允许切换 session 默认模型；请求、重试和 usage 必须共用
  // 验证开始时的模型快照，不能在 provider 返回后重新读取 Session Selection。
  const requestedModelSelection = this.getSessionModelSelection();
  const model = createRuntimeModel(this, { selection: requestedModelSelection });
  const modelTraceContext = createChildTraceContext(input.traceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      targetId: input.target.targetID,
    },
  });
  const verificationId = modelTraceContext.spanId ?? modelTraceContext.traceId;
  const foregroundExecutionId = this.activeForegroundExecution?.foregroundExecutionId;
  const goalIteration = await getNextTargetCompletionVerificationIteration.call(
    this,
    input.target.targetID,
  );
  const anchor = targetCompletionVerificationAnchor.call(this, input.traceContext);
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TargetCompletionVerification,
      {
        ...anchor,
        ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
        goalIteration,
        status: "started",
        targetId: input.target.targetID,
        verificationId,
      },
      modelTraceContext,
    ),
    modelTraceContext,
  );
  // verifier 和轮内每个 model step 一样，按本次请求的模型重新投影前缀。
  // 修复原因：轮次结束后改语言、output style 等重建不带模型，默认写成 MCS 文案；
  // 不支持 MCS 的模型收到的 Harness 文案与实际送达方式矛盾，前缀缓存也失效。
  rebuildContextPrefix(this, { model });
  const prepared = prepareRuntimeProviderRequest(this, {
    entries: withoutTrailingPendingAssistantToolCallEntries(
      this.messageHistory.borrowReadOnlyRuntimeEntries(),
    ),
    prompt: formatGoalCompletionVerificationPrompt(input.target),
    tools: [],
    applyCacheControl: true,
    model,
  });
  // verifier 直接消费完整历史但曾绕过正常请求的媒体策略；只补 capability
  // 仍会让聚合超限失败进入 verifier 请求失败路径。请求前统一执行能力和预算投影。
  const messages = projectMessagesForModelMediaPolicy(
    prepared.request.messages,
    model.properties.inputFormat,
  ).messages;
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      toolCount: 0,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  input.events.push(modelRequestEvent);
  const modelStartedAt = Date.now();
  const networkEventStartIndex = input.events.length;

  try {
    const result = await generateTargetCompletionVerificationText.call(this, {
      abortSignal: input.abortSignal,
      events: input.events,
      request: { ...prepared.request, messages },
      model,
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(input.abortSignal);
    const toolCalls = this.extractToolCallsFromResult(result);
    const modelCompleteEvent = this.createEvent(
      SessionEventType.ModelComplete,
      {
        content: result.text,
        querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
        stopReason: result.finishReason,
        toolCallCount: toolCalls.length,
        usage: result.usage,
        // 冷恢复按事件写入时的策略重放：本事件是新 fail-closed 裁决下产生的，
        // 历史事件缺席该标记，保持旧 fail-open 解析。
        verificationPolicy: "fail_closed" as const,
      },
      modelTraceContext,
    );
    await this.appendEvent(modelCompleteEvent, modelTraceContext);
    input.events.push(modelCompleteEvent);
    await recordModelUsageFact(this, {
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      result,
      startedAt: modelStartedAt,
      status: "completed",
      toolCallCount: toolCalls.length,
      traceContext: modelTraceContext,
    });
    // 三类裁判链路失败（坏 JSON / 错误调用工具 / 请求异常）统一收口 failed_closed：
    // 它们都不是 verifier 的有效结论，投影 outcome=failed（有效结论才是 notSatisfied，
    // 见 packages/shared/src/zcode-protocol-v4/snapshot.ts 的 status 语义）。
    let verificationFailedClosed = false;
    let verification: GoalCompletionVerificationOutput;
    if (toolCalls.length > 0) {
      verificationFailedClosed = true;
      verification = failedGoalCompletionVerification(
        "The completion verifier attempted to call tools instead of returning a verification result.",
      );
    } else {
      const parsed = parseGoalCompletionVerificationResult(result.text);
      verificationFailedClosed = parsed.outcome === "protocol_failure";
      verification = parsed.verification;
    }
    // 目标身份必须在写完成之前校验；否则旧目标的 passed 事件会被投影到替换后的新目标。
    // 这里先读一次，命中变化就把结论降级为非通过（无 nextAction），调用方不会完成/续跑。
    const currentTarget = await this.readSessionTargetForContext(modelTraceContext);
    const targetUnchanged =
      currentTarget !== null &&
      currentTarget.targetID === input.target.targetID &&
      currentTarget.revision === input.target.revision &&
      currentTarget.status === "active";
    if (!targetUnchanged) {
      verification = failedGoalCompletionVerification(
        "Completion verification was superseded by a target change.",
      );
    }
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          goalIteration,
          status: verificationFailedClosed ? "failed_closed" : "completed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    // 坏 JSON / 错误调用工具与请求异常同属裁判链路故障：都不是「模型确认未完成」的
    // 可续跑结论。显式暂停目标（reason 上浮），消灭 active 上的静默停摆——否则空闲
    // 驱动器每个外部边缘都会重新预约，把内部协议错误变成无限目标迭代。
    if (verificationFailedClosed && targetUnchanged) {
      await pauseTargetAfterFailedClosedVerification.call(this, {
        target: input.target,
        traceContext: modelTraceContext,
      });
    }
    return verification;
  } catch (error) {
    await recordModelUsageFact(this, {
      error,
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      startedAt: modelStartedAt,
      status: input.abortSignal?.aborted ? "cancelled" : "error",
      traceContext: modelTraceContext,
    });
    if (input.abortSignal?.aborted) {
      const preserveQueueAutoDrainOnCancel =
        this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
      await this.appendEvent(
        this.createEvent(
          SessionEventType.TargetCompletionVerification,
          {
            ...anchor,
            ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
            goalIteration,
            status: "cancelled",
            targetId: input.target.targetID,
            ...(preserveQueueAutoDrainOnCancel ? { preserveQueueAutoDrainOnCancel: true } : {}),
            verification: failedGoalCompletionVerification(
              "Completion verifier request was cancelled.",
            ),
            verificationId,
          },
          modelTraceContext,
        ),
        modelTraceContext,
      );
      // send-now 抢占 verifier 是为了交付用户刚发的消息，不是停止目标；只有
      // 真正的 Stop 才暂停 target。保持 active 后，用户消息处理完 idle 驱动器
      // 会继续目标回合；若这里暂停，用户发一条消息就会让目标变成“已暂停”。
      if (!preserveQueueAutoDrainOnCancel) {
        await this.pauseActiveTargetForCancellation(modelTraceContext);
      }
      throw error;
    }
    // verifier 请求失败（含超上下文窗口）＝裁判链路故障＝未判定，fail-closed：
    // 绝不等于完成，也不能静默返回让目标悬在 active 上无人再验。参照
    // cheng_gate_unavailable 先例（本文件 :69-74/:87-92）显式暂停目标并把 reason
    // 上浮会话：用户可见地停在 paused，等 host/模型恢复后由用户 resume 或显式边缘重验。
    this.logger?.warn("Goal completion verification failed closed", {
      ...traceContextToLogContext(modelTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.completion_verification.failed_closed",
      module: "core.runtime",
      status: "failed",
      targetId: input.target.targetID,
    });
    const verification = failedGoalCompletionVerification(
      error instanceof Error
        ? `Completion verifier request failed: ${error.message}`
        : "The completion verifier could not confirm that every goal requirement is complete.",
    );
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          goalIteration,
          status: "failed_closed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    // 生命周期事实先落盘，暂停写失败也不能丢掉 failed_closed 的 reason：
    // helper 吞掉 pause 的写失败/CAS 未命中并告警，函数仍返回 failed_closed 结论。
    await pauseTargetAfterFailedClosedVerification.call(this, {
      target: input.target,
      traceContext: modelTraceContext,
    });
    return verification;
  }
}

/**
 * 裁判链路失败（请求异常 / 坏 JSON / 工具误用）后的显式暂停收口。
 * 生命周期事件已落盘时，暂停只是把状态上浮给用户；store 抛错或 CAS 未命中
 * 都不得改变函数返回值（否则 failed_closed 事实会随异常一起丢失）。失败记
 * warn 暴露，目标保持原状，等待用户显式 resume 或下一次外部边缘重验。
 */
async function pauseTargetAfterFailedClosedVerification(
  this: AgentRuntimeInternal,
  input: { target: SessionGoal; traceContext: TraceContext },
): Promise<void> {
  // 裁判链路故障即不再自动续跑：disarm 必须在暂停写入之前独立落定，不能依赖
  // pause 成功。pause 写失败时目标仍 active，若驱动器保持 armed，下一个外部
  // 空闲沿会重新预约、再次发起 verifier 请求，把一次内部协议错误变成无限目标
  // 迭代。失败只记 warn，目标状态与 failed_closed 结论原样上浮，等用户显式
  // resume 或显式边缘重验。
  this.goalRoundDriverArmed = false;
  try {
    const pausedTarget = await pauseActiveTargetWithReason.call(this, {
      expectedRevision: input.target.revision,
      expectedStatus: "active",
      expectedTargetID: input.target.targetID,
      reason: "goal_verifier_unavailable",
      traceContext: input.traceContext,
    });
    if (pausedTarget) return;
    // 目标已不是 active（并发暂停/完成）或身份已变：不是静默成功，留下可定位事实。
    this.logger?.warn("Goal verification failed closed but the target was not paused", {
      ...traceContextToLogContext(input.traceContext),
      event: "target.completion_verification.pause_skipped",
      module: "core.runtime",
      reason: "goal_verifier_unavailable",
      status: "failed",
      targetId: input.target.targetID,
    });
  } catch (error) {
    this.logger?.warn("Failed to pause goal after failed-closed verification", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.completion_verification.pause_failed",
      module: "core.runtime",
      reason: "goal_verifier_unavailable",
      status: "failed",
      targetId: input.target.targetID,
    });
  }
}

function targetCompletionVerificationAnchor(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): { anchorAssistantMessageId?: string; anchorTurnId?: string } {
  const anchorAssistantMessageId = this.latestAssistantMessageId;
  const anchorTurnId = this.latestAssistantTurnId ?? traceContext.turnId;
  return {
    ...(anchorAssistantMessageId ? { anchorAssistantMessageId } : {}),
    ...(anchorTurnId ? { anchorTurnId } : {}),
  };
}

async function generateTargetCompletionVerificationText(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    request: ReturnType<typeof prepareRuntimeProviderRequest>["request"];
    model: Model;
    traceContext: TraceContext;
  },
) {
  const maxAttempts = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const invocationContext = {
        metadata: traceContextToLogContext(input.traceContext),
        modelCall: {
          operation: "goal_completion_verification" as const,
        },
        statusSink: this.createModelStatusSink(input.traceContext, input.events),
        traceContext: input.traceContext,
        refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
          abortSignal: input.abortSignal,
          model: input.model,
          traceContext: input.traceContext,
        }),
      };
      return await runWithModelInvocationContext(invocationContext, () =>
        input.model.generateText({
          abortSignal: input.abortSignal,
          ...input.request,
          // Verifier 继承已绑定的思考配置，不能套用低成本辅助调用的降档和封顶策略。
          options: { maxOutputTokens: input.model.optionSpecs.maxOutputTokens.max },
        }),
      );
    } catch (error) {
      const retryDelayMs = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS[attempt - 1];
      if (
        input.abortSignal?.aborted ||
        retryDelayMs === undefined ||
        !isTargetVerifierStartPlanBusyFailure(error, input.model.providerId)
      ) {
        throw error;
      }

      // 目标完成验证发生在用户已看到 assistant 迭代之后；Start Plan busy
      // 是 admission 瞬时并发。先短暂重试，避免可恢复并发直接落成「未判定」。
      this.logger?.warn("Goal completion verification retrying after Start Plan busy", {
        ...traceContextToLogContext(input.traceContext),
        attempt,
        event: "target.completion_verification.retry_start_plan_busy",
        maxAttempts,
        module: "core.runtime",
        retryDelayMs,
        status: "waiting",
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      throwIfTurnAborted(input.abortSignal);
    }
  }

  throw new Error("Goal completion verification retry loop exhausted unexpectedly.");
}

function isTargetVerifierStartPlanBusyFailure(error: unknown, providerId: string): boolean {
  return (
    START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS.has(providerId) &&
    isStartPlanBusyStreamRecoveryFailure(error)
  );
}

async function getNextTargetCompletionVerificationIteration(
  this: AgentRuntimeInternal,
  targetId: string,
): Promise<number> {
  const projection = await this.rebuildProjection();
  const targetTimeline = projection.targetCompletionVerificationTimeline.filter(
    (item) => item.targetId === targetId,
  );
  const latestIteration = targetTimeline.reduce(
    (maxIteration, item, index) => Math.max(maxIteration, item.goalIteration ?? index + 1),
    0,
  );
  // goal 迭代由 verifier lifecycle 推进，而不是普通 turn 或用户继续次数。
  // runtime 在 started/completed/failed_closed/cancelled 上固定同一个编号，UI 与 snapshot 才不会各自猜。
  return latestIteration + 1;
}

function withoutTrailingPendingAssistantToolCallEntries(
  entries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  const last = entries.at(-1);
  if (
    !last ||
    isRuntimeAttachmentEntry(last) ||
    last?.message.role !== "assistant" ||
    !last.message.toolCalls ||
    last.message.toolCalls.length === 0
  ) {
    return entries;
  }
  return entries.slice(0, -1);
}
