/**
 * 蜂群 goal 回合的执行与收口：预算记账（H2）、目标竞态（M4）、Pause/Stop 取消域（M5）
 * 与失败 cause 链（M7）。
 *
 * 从 target.ts 拆出是为了让 target 生命周期文件保持职责边界：这里只拥有「一轮蜂群
 * 如何跑、如何记账、如何在目标变化/失败时收口」，target.ts 仍决定何时进入蜂群。
 */
import {
  SessionEventType,
  findExhaustedTargetBudgetDimension,
  traceContextToLogContext,
} from "../deps.js";
import type { SessionGoal, TargetChangedPayload, TraceContext } from "../deps.js";
import type { TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TargetContinuationRuntimeCommandOptions } from "../command-queue.js";
import {
  SwarmOrchestrator,
  SwarmRoundSupersededError,
  type SwarmRoundEvidence,
  type SwarmRoundUsage,
} from "../swarm-orchestrator.js";
import { SwarmRoundCancelledError } from "../swarm-aggregator.js";
import { isGoalLayerEnabled } from "../helpers/goal-layer.js";
import { executeTargetBudgetOutcomeTurn, pauseActiveTargetWithReason } from "./target.js";

export interface SwarmGoalContinuationInput {
  abortSignal?: AbortSignal;
  inputId?: string;
  intent?: TargetContinuationRuntimeCommandOptions["intent"];
  nextAction?: string;
  target: SessionGoal;
  traceContext: TraceContext;
}

/** 一轮蜂群对续跑命令的裁决：跳过 / 继续普通回合 / 直接返回终局回合结果。 */
export type SwarmGoalContinuationResult =
  | { kind: "skip" }
  | { evidence: SwarmRoundEvidence; kind: "continue"; target: SessionGoal }
  | { kind: "turn_result"; result: TurnResult | null };

/**
 * 蜂群回合失败收口：目标显式 pause 并落带失败 reason 的 TargetChanged，让 idle
 * 驱动器经候选闸门自然停下，而不是把 active 目标留在原地静默停摆。GoalStatus 没有
 * failed 态，paused + reason 是唯一合法的停机迁移；失败细节随 reason 与日志保留。
 */
async function pauseActiveTargetAfterSwarmFailure(
  this: AgentRuntimeInternal,
  input: { error: unknown; target: SessionGoal; traceContext: TraceContext },
): Promise<void> {
  const reason = formatSwarmFailureReason(input.error);
  this.logger?.warn("Goal swarm round failed; pausing active target", {
    ...traceContextToLogContext(input.traceContext),
    event: "target.swarm.round_failed",
    reason,
    targetId: input.target.targetID,
  });
  try {
    await pauseActiveTargetWithReason.call(this, {
      expectedStatus: "active",
      expectedTargetID: input.target.targetID,
      // 复核与 pause 之间仍可能发生 GoalUpdate（revision 递增、状态仍 active）；
      // 不带 revision 的 CAS 会把旧轮的失败 reason 写到新目标上。
      expectedRevision: input.target.revision,
      reason,
      traceContext: input.traceContext,
    });
  } catch (error) {
    // 原始执行错误才是调用方必须看到的错误；暂停写入失败只记录，不遮蔽它。
    this.logger?.warn("Failed to pause active target after swarm round failure", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.swarm.round_failed.pause_failed",
    });
  }
}

/**
 * M7：把失败 error 及其 cause 链展开成 pause reason。聚合层把原始 worker 错误挂在
 * cause 上；这里逐层写出，单行 message 之外的 root cause 不会丢失。
 */
function formatSwarmFailureReason(error: unknown): string {
  const messages: string[] = [];
  collectSwarmFailureMessages(error, messages, new Set<unknown>());
  const detail = messages.length > 0 ? messages.join("\ncaused by: ") : String(error);
  return `swarm_execution_failed: ${detail}`;
}

function collectSwarmFailureMessages(error: unknown, messages: string[], seen: Set<unknown>): void {
  if (error instanceof Error) {
    if (seen.has(error)) return;
    seen.add(error);
    const message = error.message.trim();
    if (message && messages.at(-1) !== message) messages.push(message);
    collectSwarmFailureMessages(error.cause, messages, seen);
    return;
  }
  if (Array.isArray(error)) {
    if (seen.has(error)) return;
    seen.add(error);
    for (const cause of error) collectSwarmFailureMessages(cause, messages, seen);
    return;
  }
  if (error !== undefined && error !== null) {
    const message = String(error);
    if (message && messages.at(-1) !== message) messages.push(message);
  }
}

/**
 * H2：把蜂群的真实模型开销写入目标预算行——分解调用 + 全部 completed worker 的
 * token 合计，以及本轮墙钟耗时。失败回合同样记账；目标被替换时 store 按 targetID
 * 拒绝写入，旧目标的开销不会被记到新目标。
 */
async function accountSwarmRoundUsage(
  this: AgentRuntimeInternal,
  input: { target: SessionGoal; traceContext: TraceContext; usage: SwarmRoundUsage },
): Promise<void> {
  if (!this.sessionStore) return;
  const tokensUsedDelta = Math.max(0, Math.trunc(input.usage.tokensUsed));
  const timeUsedSecondsDelta = Math.max(0, Math.ceil(input.usage.elapsedMs / 1000));
  if (tokensUsedDelta === 0 && timeUsedSecondsDelta === 0) return;
  try {
    const previousTarget = await this.readSessionTargetForContext(input.traceContext);
    const accountedTarget = await this.sessionStore.accountTargetUsage({
      goalLayerEnabled: isGoalLayerEnabled(this.config),
      sessionID: this.sessionId,
      targetID: input.target.targetID,
      timeUsedSecondsDelta,
      tokensUsedDelta,
    });
    if (accountedTarget?.targetID === input.target.targetID) {
      await this.recordTargetChanged({
        action: "usage_accounted",
        previousTarget,
        source: "runtime",
        target: accountedTarget,
        traceContext: input.traceContext,
      });
    }
  } catch (error) {
    this.logger?.warn("Failed to account goal swarm round usage", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.swarm.usage_account.failed",
      module: "core.runtime",
      status: "failed",
      targetId: input.target.targetID,
    });
  }
}

/** 蜂群一轮的结算结果：成功证据或原始失败 + 始终在手的预算开销。 */
type SwarmRoundOutcome =
  | {
      kind: "completed";
      evidence: SwarmRoundEvidence;
      targetChanged: boolean;
      usage: SwarmRoundUsage;
    }
  | {
      kind: "failed";
      error: unknown;
      targetChanged: boolean;
      usage: SwarmRoundUsage;
    };

/**
 * 在目标续跑上下文里跑一轮蜂群：
 * - 把回合 abortSignal 与目标失效事件合成同一个取消域：Stop 直接取消在途 worker，
 *   Pause/替换目标时订阅 TargetChanged 立即 abort，worker 不会继续写；
 * - objective 改写（revision 递增、状态仍 active）不在这里 abort，交给合并闸门与
 *   回合结束后的 revision 复核（M4）——旧产出不得拼进新 objective；
 * - 合并闸门在每一份 workspace 回写之前重读目标，身份/版本/状态或取消信号任一
 *   变化即拒绝该份合并；中途拒绝时未回写的产出作废，已回写的前序结果保留；
 * - 返回真实模型开销（分解 + completed worker），失败路径不丢已发生调用。
 */
async function runSwarmRoundForTarget(
  this: AgentRuntimeInternal,
  input: SwarmGoalContinuationInput,
): Promise<SwarmRoundOutcome> {
  const usage: SwarmRoundUsage = { elapsedMs: 0, tokensUsed: 0 };
  const swarmAbort = new AbortController();
  const parentSignal = input.abortSignal;
  const abortFromParent = () => {
    swarmAbort.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  let targetChanged = false;
  const unsubscribe = this.subscribeEvents({
    onSessionEvent: (event) => {
      if (event.sessionId !== this.sessionId || event.type !== SessionEventType.TargetChanged) {
        return;
      }
      const changed = (event.payload as TargetChangedPayload).target;
      // 目标离开 active 或被替换/清除：旧蜂群的执行证据已不属于当前目标。
      if (
        changed === null ||
        changed.targetID !== input.target.targetID ||
        changed.status !== "active"
      ) {
        targetChanged = true;
        if (!swarmAbort.signal.aborted) {
          swarmAbort.abort(new Error("Goal target changed while the swarm round was running"));
        }
      }
    },
  });

  let evidence: SwarmRoundEvidence | undefined;
  let error: unknown;
  try {
    evidence = await SwarmOrchestrator.forGoalRound(this, {
      trace: input.traceContext,
      signal: swarmAbort.signal,
    }).runGoalRound(input.target.objective, {
      ...(input.nextAction === undefined ? {} : { nextAction: input.nextAction }),
      // 合并闸门：每一份 worker 结果回写之前执行。此处按权威目标重读，身份、版本、
      // 状态与取消信号四者全稳才允许当前 merge；中途拒绝时未回写的剩余产出作废，
      // 已回写的前序结果保留（它们在各自过闸时已通过同一 CAS）。
      mergeGate: async () => {
        if (swarmAbort.signal.aborted) {
          return { allowed: false, reason: "swarm round aborted before workspace merge" };
        }
        const current = await this.readSessionTargetForContext(input.traceContext);
        if (!current || current.targetID !== input.target.targetID) {
          return { allowed: false, reason: "target replaced or cleared before workspace merge" };
        }
        if (current.revision !== input.target.revision) {
          return { allowed: false, reason: "target revision changed before workspace merge" };
        }
        if (current.status !== "active") {
          return { allowed: false, reason: `target is ${current.status} before workspace merge` };
        }
        return { allowed: true };
      },
      usage,
    });
  } catch (caught) {
    error = caught;
  } finally {
    unsubscribe();
    parentSignal?.removeEventListener("abort", abortFromParent);
  }

  if (evidence !== undefined) {
    return { evidence, kind: "completed", targetChanged, usage };
  }
  return { error, kind: "failed", targetChanged, usage };
}

/**
 * 跑一轮蜂群并按目标身份/预算/取消语义裁决后续动作。调用方（target.ts）只在
 * swarm 灰度开启且 goal layer 在场时进入。
 */
export async function runSwarmGoalContinuation(
  this: AgentRuntimeInternal,
  input: SwarmGoalContinuationInput,
): Promise<SwarmGoalContinuationResult> {
  const swarmRound = await runSwarmRoundForTarget.call(this, input);
  // H2：蜂群开销在任何结局下都先入目标预算；预算翻越 100% 时下面按 budget_limited
  // 走宽限终局回合，而不是继续启动普通回合。
  await accountSwarmRoundUsage.call(this, {
    target: input.target,
    traceContext: input.traceContext,
    usage: swarmRound.usage,
  });
  // 记账可能把目标翻到 budget_limited（成功/失败/取消一视同仁）。宽限终局回合必须
  // 先于任何 pause/throw：失败轮的收口不能把预算终局语义吞掉。Stop 例外——前台
  // 取消已 abort，再起回合只会得到 TurnCancelled 并把目标 pause，违背 Stop 语义。
  if (input.abortSignal?.aborted !== true) {
    const accountedTarget = await this.readSessionTargetForContext(input.traceContext);
    if (
      accountedTarget?.targetID === input.target.targetID &&
      accountedTarget.status === "budget_limited"
    ) {
      const pressure = findExhaustedTargetBudgetDimension(accountedTarget);
      if (pressure) {
        return {
          kind: "turn_result",
          result: await executeTargetBudgetOutcomeTurn.call(this, {
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            ...(input.inputId !== undefined ? { inputId: input.inputId } : {}),
            ...(input.intent ? { intent: input.intent } : {}),
            pressure,
            target: accountedTarget,
            traceContext: input.traceContext,
          }),
        };
      }
    }
  }
  if (swarmRound.kind === "failed") {
    const error = swarmRound.error;
    const typedCancellation =
      error instanceof SwarmRoundSupersededError || error instanceof SwarmRoundCancelledError;
    // Stop/抢占：整条前台执行已被取消。旧轮失败既不能 pause 当前目标，也不能把
    // 失败原因盖到可能已被替换的新目标上。
    if (input.abortSignal?.aborted) {
      this.logger?.info("Goal swarm round skipped after foreground cancellation", {
        ...traceContextToLogContext(input.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "target.swarm.round_skipped_after_cancel",
        module: "core.runtime",
        status: "cancelled",
        targetId: input.target.targetID,
        typedCancellation,
      });
      return { kind: "skip" };
    }
    if (swarmRound.targetChanged) {
      // Pause/替换已经由取消订阅落定；不能用失败 reason 覆盖用户停用意图。
      this.logger?.info("Goal swarm round stopped after target changed", {
        ...traceContextToLogContext(input.traceContext),
        event: "target.swarm.round_cancelled_by_target_change",
        module: "core.runtime",
        status: "cancelled",
        targetId: input.target.targetID,
        typedCancellation,
      });
      return { kind: "skip" };
    }
    // 失败收口前按权威目标复核（M4）：轮内 GoalUpdate 改写 objective（revision 递增、
    // 状态仍 active）不会触发取消订阅；旧轮失败不得 pause 改写后的新目标。
    const currentTarget = await this.readSessionTargetForContext(input.traceContext);
    if (
      !currentTarget ||
      currentTarget.targetID !== input.target.targetID ||
      currentTarget.revision !== input.target.revision ||
      currentTarget.status !== "active"
    ) {
      this.logger?.info("Goal swarm round failure discarded after target change", {
        ...traceContextToLogContext(input.traceContext),
        currentRevision: currentTarget?.revision,
        currentStatus: currentTarget?.status ?? "missing",
        currentTargetId: currentTarget?.targetID,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "target.swarm.round_failure_skipped_target_changed",
        expectedRevision: input.target.revision,
        module: "core.runtime",
        status: "cancelled",
        targetId: input.target.targetID,
        typedCancellation,
      });
      return { kind: "skip" };
    }
    await pauseActiveTargetAfterSwarmFailure.call(this, {
      error,
      target: input.target,
      traceContext: input.traceContext,
    });
    throw error;
  }
  // 蜂群是长 await：期间 GoalUpdate 可能改写 objective（状态仍 active、revision 递增）。
  // 必须比较 revision：旧目标的蜂群产出不得拼进新 objective 的回合提示（M4）。
  const refreshedTarget = await this.readSessionTargetForContext(input.traceContext);
  if (
    !refreshedTarget ||
    refreshedTarget.targetID !== input.target.targetID ||
    refreshedTarget.revision !== input.target.revision
  ) {
    this.logger?.info("Goal continuation skipped after target changed during swarm round", {
      ...traceContextToLogContext(input.traceContext),
      currentRevision: refreshedTarget?.revision,
      expectedRevision: input.target.revision,
      event: "target.continuation.skipped_target_changed_after_swarm",
      module: "core.runtime",
      status: "completed",
      targetId: input.target.targetID,
    });
    return { kind: "skip" };
  }
  // Stop 可能落在聚合/journal/plan card 之后、executeTurnCommand 之前：此时目标身份
  // 未变，但前台执行已被取消；不得启动一个带旧蜂群证据的续跑回合（含预算终局回合）。
  if (input.abortSignal?.aborted === true) {
    this.logger?.info("Goal swarm continuation skipped after foreground cancellation", {
      ...traceContextToLogContext(input.traceContext),
      event: "target.continuation.skipped_after_swarm_cancel",
      module: "core.runtime",
      status: "cancelled",
      targetId: input.target.targetID,
    });
    return { kind: "skip" };
  }
  // 蜂群记账自身可能把目标翻到 budget_limited：走一次宽限终局回合后收口。
  if (refreshedTarget.status === "budget_limited") {
    const pressure = findExhaustedTargetBudgetDimension(refreshedTarget);
    if (pressure) {
      return {
        kind: "turn_result",
        result: await executeTargetBudgetOutcomeTurn.call(this, {
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          ...(input.inputId !== undefined ? { inputId: input.inputId } : {}),
          ...(input.intent ? { intent: input.intent } : {}),
          pressure,
          target: refreshedTarget,
          traceContext: input.traceContext,
        }),
      };
    }
  }
  if (refreshedTarget.status !== "active") {
    this.logger?.info("Goal continuation skipped after target changed during swarm round", {
      ...traceContextToLogContext(input.traceContext),
      currentStatus: refreshedTarget.status,
      event: "target.continuation.skipped_inactive_after_swarm",
      module: "core.runtime",
      status: "completed",
      targetId: input.target.targetID,
    });
    return { kind: "skip" };
  }
  return { evidence: swarmRound.evidence, kind: "continue", target: refreshedTarget };
}
