import type { AgentRuntimeInternal } from "../internal.js";
import type { ContinueActiveTargetLoopOptions, TurnResult } from "../types.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { TargetContinuationLoopRuntimeCommand } from "../command-queue.js";
import { executeTargetContinuationCommand } from "./target.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";

interface RunActiveTargetContinuationLoopOptions extends ContinueActiveTargetLoopOptions {
  yieldBeforeFirstContinue?: boolean;
}

/**
 * goal 灰度旗关闭时的旧续跑入口：把 while 忙碌循环作为一条 runtime command 入队。
 * 开旗时由 idle 驱动器（target.ts 的 continueActiveTargetLoop 预约路径）取代。
 */
export async function enqueueActiveTargetContinuationLoop(
  this: AgentRuntimeInternal,
  options: ContinueActiveTargetLoopOptions,
): Promise<TurnResult | null> {
  const traceContext = options.traceContext ?? this.rootTraceContext;

  return await enqueueCancellableRuntimeCommand<
    TurnResult | null,
    TargetContinuationLoopRuntimeCommand
  >(this, {
    abortSignal: options.abortSignal,
    createCommand: ({ reject, resolve }) => ({
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "target-continuation-loop",
      options: {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
        ...(options.intent ? { intent: options.intent } : {}),
        traceContext,
        trigger: options.trigger,
        ...(options.verifyBeforeFirstContinue !== undefined
          ? { verifyBeforeFirstContinue: options.verifyBeforeFirstContinue }
          : {}),
      },
      priority: "next",
      reject,
      resolve,
      traceContext,
    }),
  });
}

export async function runActiveTargetContinuationLoop(
  this: AgentRuntimeInternal,
  options: RunActiveTargetContinuationLoopOptions,
): Promise<TurnResult | null> {
  const traceContext = options.traceContext ?? this.rootTraceContext;
  let verifyBeforeContinue = options.verifyBeforeFirstContinue === true;
  let lastResult: TurnResult | null = null;
  let yieldToPendingCommands = options.yieldBeforeFirstContinue !== false;
  let continuationIntent = options.intent;

  while (!options.abortSignal?.aborted) {
    if (yieldToPendingCommands && this.runtimeCommandQueue.hasPending()) {
      return lastResult;
    }

    if (
      options.trigger === "task-notification" &&
      verifyBeforeContinue &&
      this.config.targetCompletionVerification?.enabled === false
    ) {
      return lastResult;
    }

    const result = await executeTargetContinuationCommand.call(this, {
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
      ...(continuationIntent ? { intent: continuationIntent } : {}),
      traceContext,
      verifyBeforeContinue,
    });
    if (!result) return lastResult;

    lastResult = result;
    // 第一次 continuation 应用并持久化本次 Submission；后续自动轮次读取新的
    // Session Selection，从而沿用上一轮，也允许中间插入的用户 Turn 成为新权威。
    continuationIntent = undefined;
    verifyBeforeContinue = true;
    yieldToPendingCommands = true;
  }

  return lastResult;
}
