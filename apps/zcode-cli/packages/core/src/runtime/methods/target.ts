import {
  CoreErrorType,
  SessionEventType,
  createChildTraceContext,
  createCoreError,
  findExhaustedTargetBudgetDimension,
  formatGoalContinuationPrompt,
  formatTargetBudgetOutcomePrompt,
  nextTurnPendingInputs,
  TARGET_BUDGET_EXHAUSTED_BLOCKER_CODE,
  traceContextToLogContext,
} from "../deps.js";
import type {
  ModelUsageSummary,
  SessionGoal,
  TargetChangedPayload,
  TraceContext,
} from "../deps.js";
import type { ContinueActiveTargetLoopOptions, TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  formatSwarmRoundEvidence,
  type SwarmRoundEvidence,
} from "../swarm-orchestrator.js";
import { runSwarmGoalContinuation } from "./target-swarm.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type {
  TargetContinuationRuntimeCommand,
  TargetContinuationRuntimeCommandOptions,
} from "../command-queue.js";
import { hasRunningBackgroundRuntimeTask } from "../../runtime-task/registry.js";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";
import { verifyActiveTargetCompletionForContinuation } from "./target-completion-verification.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import {
  telemetryInputOrigin,
  TELEMETRY_INPUT_ORIGIN_ATTRIBUTE,
} from "./input-intent-persistence.js";
import { isGoalLayerEnabled } from "../helpers/goal-layer.js";

export async function recordTargetChanged(
  this: AgentRuntimeInternal,
  input: TargetChangedPayload & { traceContext: TraceContext },
): Promise<void> {
  const { traceContext, ...payload } = input;
  const event = this.createEvent(SessionEventType.TargetChanged, payload, traceContext);
  await this.appendEvent(event, traceContext);
}

export async function continueActiveTargetIfIdle(
  this: AgentRuntimeInternal,
  options?: {
    traceContext?: TraceContext;
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TargetContinuationRuntimeCommandOptions["intent"];
    verifyBeforeContinue?: boolean;
    /** idle 驱动器预约标记:完成路径据此同步落 standing-down 信号(时序敏感)。 */
    idleDriver?: boolean;
  },
): Promise<TurnResult | null> {
  const originalTrace = options?.traceContext ?? this.rootTraceContext;
  // upstream v3.17.2 的 continuation telemetry：来源沿整条自动续跑因果链传递。
  const inputOrigin = telemetryInputOrigin(options?.intent, originalTrace.attributes);
  const traceContext = inputOrigin
    ? {
        ...originalTrace,
        attributes: {
          ...originalTrace.attributes,
          [TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]: inputOrigin,
        },
      }
    : originalTrace;

  return await enqueueCancellableRuntimeCommand<
    TurnResult | null,
    TargetContinuationRuntimeCommand
  >(this, {
    abortSignal: options?.abortSignal,
    createCommand: ({ reject, resolve }) => {
      const commandOptions: TargetContinuationRuntimeCommandOptions = {
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options?.idleDriver ? { idleDriver: true } : {}),
        ...(options?.inputId !== undefined ? { inputId: options.inputId } : {}),
        ...(options?.intent ? { intent: options.intent } : {}),
        traceContext,
        ...(options?.verifyBeforeContinue !== undefined
          ? { verifyBeforeContinue: options.verifyBeforeContinue }
          : {}),
      };
      return {
        createdAt: new Date(),
        id: createRuntimeCommandId(),
        mode: "target-continuation",
        options: commandOptions,
        priority: "next",
        reject,
        resolve,
        traceContext,
      };
    },
  });
}

/**
 * 手动 goal 续跑入口(/goal set/resume、v4 sendGoalCommand/resumeGoal 共用)。
 * 恒做「驱动器 arm + 立即预约一个回合」(设计 §3.2/§3.6):
 * - arm:idle 驱动器从此外围边缘自动预约后续回合,直至 paused/blocked/complete;
 * - 预约-准入:本命令执行时才做候选闸门与预算边界检查;预约入队后机器即非
 *   idle,驱动器不会重复预约;
 * - 用户消息不消耗回合预算(仅 inputSource=goal-continuation 的回合计数)。
 * 旧 while 忙碌循环已删除(设计 M11 Remove 清单);关闭 --goal-layer 时
 * scheduleIdleGoalRound 早退,故只跑本条显式预约的单回合。
 */
export async function continueActiveTargetLoop(
  this: AgentRuntimeInternal,
  options: ContinueActiveTargetLoopOptions,
): Promise<TurnResult | null> {
  const traceContext = options.traceContext ?? this.rootTraceContext;
  // goal↔workflow 桥(设计 §3.3):goal 回合是 workflow run 的发起方。onDemand 灰度会话
  // 出生不注册十个工作流工具,模型在 goal 回合内看不见 CreateWorkflow 就无法发起 run——
  // arm(用户显式 set/resume,goal 长跑的声明动作)即「本会话第一次真的要用到它们」的
  // 同族信号,与 /workflow、run_control 并列。enabled=false 时注册门
  // (resolveRuntimeDynamicWorkflowToolsIncluded)挡住工具,激活状态无害;非 onDemand
  // 会话已激活,此处 no-op。桥失败只记日志:它不得阻断 goal 续跑本身。
  try {
    await this.activateDynamicWorkflowTools({ source: "goal_arm", traceContext });
  } catch (error) {
    this.logger?.warn("Failed to activate workflow tools for goal arm", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.workflow_bridge.activation_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
  // 取消窗口的第二个检查点：workflow 激活写入是 await 边界；若 Stop/抢占在
  // 「调用前检查」与 arm 之间落下，arm 前复查信号，不能把驱动器拉起。
  if (options.abortSignal?.aborted) return null;
  this.goalRoundDriverArmed = true;
  this.goalRoundDriverStandingDown = false;
  return await this.continueActiveTargetIfIdle({
    abortSignal: options.abortSignal,
    inputId: options.inputId,
    intent: options.intent,
    traceContext,
    verifyBeforeContinue: options.verifyBeforeFirstContinue === true,
  });
}

/**
 * idle 驱动器(设计 §3.2):整机 idle(无 pending 命令、无在途/预留回合、无在途
 * 后台任务)的边缘上预约下一个 goal 回合。挂在 drainRuntimeCommandQueue 的空闲沿
 * (与 workflowBlockedReminder.sessionIdle 同点),是 goal 续跑的唯一自动触发源
 * (旧 while 循环 / continueActiveTargetAfterTurn / task-notification 回填已删)。
 * 预约未兑现(命令返回 null:目标非 active/后台任务在跑/verifier 基建失败)时
 * 驱动器站到一边(standing-down),只消费下一个外部边缘,避免空转轮询;
 * 预约兑现则继续在下一个 idle 边缘预约,goal 循环由此在边缘间展开。
 */
export function scheduleIdleGoalRound(this: AgentRuntimeInternal): void {
  // 关闭 --goal-layer:没有 idle 驱动器,goal 回合只由手动续跑入口产生。
  if (!isGoalLayerEnabled(this.config)) return;
  // 上一次预约未兑现:消费该信号后保持静默,等待下一个外部事件(用户输入、
  // 通知、手动续跑)制造的真正边缘。否则任何非终态 null 都会变成轮询循环。
  if (this.goalRoundDriverStandingDown) {
    this.goalRoundDriverStandingDown = false;
    return;
  }
  if (!this.goalRoundDriverArmed || this.shuttingDown) return;
  if (!this.sessionStore || !this.sessionPersisted) return;
  if (this.getPlanEnabled()) return;
  // held 队列(autoDrain=false)代表用户显式暂停了收件箱;外部提升进行中同样让位。
  if (this.queueAutoDrain === false || this.queueExternalDrainActive) return;
  if (this.permissionFullAccessPending) return;
  if (hasRunningBackgroundRuntimeTask(this.runtimeTaskRegistry)) return;
  // 预约前的用户队列判定要读事件投影(异步);同步预约改成了异步判定 + 预约,
  // 在途标志挡住判定窗口内新出现的空闲沿,避免同一边缘预约两个回合。
  if (this.goalRoundDriverReservationPending) return;
  this.goalRoundDriverReservationPending = true;
  void reserveIdleGoalRoundAfterQueueCheck
    .call(this)
    .catch((error: unknown) => {
      // 预约命令本身极少数在入队前失败(abort 已决);回合内失败经 runRuntimeCommand
      // 的同步 standing-down 落档,此处只兜日志,不承担时序。
      this.logger?.warn("Idle goal round reservation failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "target.round_driver.reservation_failed",
        module: "core.runtime",
        status: "failed",
      });
    })
    .finally(() => {
      // 兜底释放:判定/入队前的异常路径。正常路径在入队同步段内已释放(见下)。
      this.goalRoundDriverReservationPending = false;
    });
}

/**
 * 空闲沿预约前的用户队列判定(裁定 b,2026-10-25 常驻闭环验收发现):
 * 排队的用户输入必须先于驱动器的下一回合执行。验收证据——round 1 执行中以默认
 * sendText 排队的用户消息要等目标 complete 后才被 v4 auto-drain 提升,用户排在了
 * 整个目标后面。queue 的『不打断当前回合』语义不变,只修正排空顺序:空闲沿若
 * next-turn 用户队列非空,驱动器不预约(quiet yield,不落 standing-down,armed
 * 保持),让既有提升路径(v4 auto-drain → sendQueuedNow)先跑用户回合;用户回合
 * 排空后的下一空闲沿照常预约。不新增车道,队列存储与提升机制本身不动。
 */
async function reserveIdleGoalRoundAfterQueueCheck(this: AgentRuntimeInternal): Promise<void> {
  const projection = await this.rebuildProjection();
  // 判定窗口内 Stop 可能已 disarm（pauseActiveTargetForCancellation 先 disarm 再写
  // pause，写失败时目标仍 active）。入队前必须按此刻的 arm 状态复查，否则旧快照
  // 会让被 Stop 的目标在空闲沿重新预约续跑。
  if (!this.goalRoundDriverArmed) return;
  if (nextTurnPendingInputs(projection).length > 0) return;
  // 判定期间机器可能已不再空闲(新命令入队/别的回合起跑);预约入队前复查,
  // 让那一轮自己排空时制造的空闲沿再走本函数。
  if (this.hasActiveOrQueuedTurnWork()) return;
  // 入队发生在本次同步段内(continueActiveTargetIfIdle 的命令创建与 enqueue 不经
  // await);在途标志必须在入队后立即释放——预约命令的完成反应(≥2 跳微任务)必然
  // 晚于该命令排空后的空闲沿,拖到 finally 释放会让下一个空闲沿被误判为「判定在
  // 途」而错过预约(与 standing-down 同类时序,见 runtime-command-queue 的实测记录)。
  const reservation = this.continueActiveTargetIfIdle({
    idleDriver: true,
    verifyBeforeContinue: true,
  });
  this.goalRoundDriverReservationPending = false;
  await reservation;
}

export async function executeTargetContinuationCommand(
  this: AgentRuntimeInternal,
  options: TargetContinuationRuntimeCommandOptions,
): Promise<TurnResult | null> {
  const traceContext = options.traceContext;
  const target = await targetContinuationCandidateForCommand.call(this, traceContext);
  if (!target) return null;

  // goal↔workflow 互锁(设计 §3.3「workflow 在途时目标 disarm,消除双重驱动」):
  // 后台任务(workflow run、后台化 Bash)在途时目标一律不续跑——手动 resume 与 idle
  // 驱动器(scheduleIdleGoalRound 的整机 idle 闸门)同受此约束;终态回填的通知轮排空后
  // 产生新的空闲沿,goal 回合在那里拿到窄结果继续裁决。旧实现只在 verifyBeforeContinue
  // 时检查,手动 resume 会在 run 在途时照跑回合,形成双重驱动。
  // 任何续跑都让位给在途后台任务(设计 M5「无条件 interlock」):旧循环删除后,
  // 手动 resume 也必须让位,否则与 workflow run 形成双重驱动。
  if (await hasRunningBackgroundTaskForGoalContinuation.call(this)) {
    this.logger?.info("Goal continuation deferred while background tasks are running", {
      ...traceContextToLogContext(traceContext),
      event: "target.continuation.deferred_background_running",
      module: "core.runtime",
      status: "waiting",
      targetId: target.targetID,
    });
    return null;
  }

  const verificationResult = options.verifyBeforeContinue
    ? await verifyActiveTargetCompletionForContinuation.call(this, {
        abortSignal: options.abortSignal,
        target,
        traceContext,
      })
    : null;
  if (verificationResult?.verification.passed) {
    this.logger?.info("Goal continuation skipped after completion verifier passed", {
      ...traceContextToLogContext(traceContext),
      event: "target.continuation.skipped_complete",
      module: "core.runtime",
      status: "completed",
      targetId: verificationResult.target.targetID,
    });
    return null;
  }
  // 没有 nextAction 的失败结果来自 verifier 自身失败或无效输出，
  // 不是模型确认的下一步工作；继续自动续跑会把内部错误变成无限目标迭代。
  if (verificationResult && !verificationResult.verification.nextAction?.trim()) {
    this.logger?.warn("Goal continuation skipped after verifier failed without next action", {
      ...traceContextToLogContext(traceContext),
      event: "target.continuation.skipped_no_next_action",
      module: "core.runtime",
      reason: verificationResult.verification.reason,
      targetId: verificationResult.target.targetID,
    });
    return null;
  }
  const latestTarget = await this.readSessionTargetForContext(traceContext);
  // 目标校验请求可能在用户点击 Stop 后才返回；队列会保持 stopRequested，
  // 但 verifier 拿到的是校验开始前的 active target。这里必须重读目标状态，避免用旧对象继续续跑。
  if (
    !latestTarget ||
    latestTarget.status !== "active" ||
    latestTarget.targetID !== target.targetID
  ) {
    this.logger?.info("Goal continuation skipped after target changed during verification", {
      ...traceContextToLogContext(traceContext),
      currentStatus: latestTarget?.status ?? "missing",
      currentTargetId: latestTarget?.targetID,
      event: "target.continuation.skipped_inactive_after_verification",
      module: "core.runtime",
      targetId: target.targetID,
    });
    return null;
  }
  let continuationTarget = latestTarget;
  // 三维预算回合边界检查(设计 §3.2/§4.1):任一维已到 100% 时,先把 target 置
  // blocked(budget_limited,code budget-exhausted),再执行一次宽限终局回合——
  // 全程工具 veto,逼模型写面向用户的终局总结;终局回合结束后循环的候选闸门
  // (只认 active)自然收口,不会再续跑。
  // 回合维不带 +1 预约:turnsUsed == budget 说明最后一个允许回合已完成,
  // 若 turnsUsed + 1 == budget,该回合仍属预算内,应完整执行并由结算翻 blocked。
  const exhaustedDimension = isGoalLayerEnabled(this.config)
    ? findExhaustedTargetBudgetDimension(continuationTarget)
    : undefined;
  if (exhaustedDimension && this.sessionStore) {
    const previousTarget = continuationTarget;
    const blockedTarget = await this.sessionStore.updateTargetStatus({
      reason: TARGET_BUDGET_EXHAUSTED_BLOCKER_CODE,
      sessionID: this.sessionId,
      status: "budget_limited",
    });
    if (blockedTarget) {
      await this.recordTargetChanged({
        action: "status_updated",
        blockerCode: TARGET_BUDGET_EXHAUSTED_BLOCKER_CODE,
        previousTarget,
        reason: TARGET_BUDGET_EXHAUSTED_BLOCKER_CODE,
        source: "runtime",
        target: blockedTarget,
        traceContext,
      });
      return await executeTargetBudgetOutcomeTurn.call(this, {
        abortSignal: options.abortSignal,
        inputId: options.inputId,
        intent: options.intent,
        pressure: exhaustedDimension,
        target: blockedTarget,
        traceContext,
      });
    }
  }
  // 蜂群模式（swarm 灰度）：目标已确认 active 且 Host 开启 swarm 时，本回合先由
  // SwarmOrchestrator 把目标分解为并行子任务并执行；聚合产出拼进回合提示，随
  // goal-continuation 输入进入会话历史，完成 verifier 下一轮据此判分。
  // swarm 恒受 goal layer 约束：关掉 goal 层就没有三维预算闸门可依（M10）。
  let swarmEvidence: SwarmRoundEvidence | undefined;
  if (this.config.swarm === true && isGoalLayerEnabled(this.config)) {
    const nextAction = verificationResult?.verification.nextAction;
    const swarmContinuation = await runSwarmGoalContinuation.call(this, {
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      ...(options.inputId === undefined ? {} : { inputId: options.inputId }),
      ...(options.intent === undefined ? {} : { intent: options.intent }),
      ...(nextAction === undefined ? {} : { nextAction }),
      target: continuationTarget,
      traceContext,
    });
    if (swarmContinuation.kind === "skip") return null;
    if (swarmContinuation.kind === "turn_result") return swarmContinuation.result;
    continuationTarget = swarmContinuation.target;
    swarmEvidence = swarmContinuation.evidence;
  }
  // S4：goal continuation 的路线卡先于 prompt 组装现读；无 plan 事实不制造空卡。
  // 卡片只是只读先验证据：host RPC 失败时告警并省略，绝不能阻断续跑回合。
  let chengPlanCard: Awaited<
    ReturnType<NonNullable<AgentRuntimeInternal["goalContinuationChengPlan"]>>
  >;
  if (this.goalContinuationChengPlan) {
    try {
      chengPlanCard = await this.goalContinuationChengPlan(continuationTarget);
    } catch (error) {
      this.logger?.warn("Failed to read ChengPlan route card for goal continuation", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "target.cheng_plan_card.failed",
        module: "core.runtime",
        status: "failed",
        targetId: continuationTarget.targetID,
      });
    }
  }
  const continuationPrompt = formatGoalContinuationPrompt(
    continuationTarget,
    verificationResult?.verification,
    {
      goalLayerEnabled: isGoalLayerEnabled(this.config),
      workflowDelegation:
        isGoalLayerEnabled(this.config) &&
        this.config.dynamicWorkflowEnabled !== false &&
        this.dynamicWorkflowToolsActivated,
      ...(chengPlanCard === undefined ? {} : { chengPlanCard }),
    },
  );
  const prompt = wrapSystemReminderForSource(
    "target_continuation",
    // workflow 委派指引与判定权阶梯(设计 §3.3)只在工具面在场时进入提示:
    // CreateWorkflow 缺席的会话(fail-closed 灰度)模型无处发起 run,指引只会误导。
    swarmEvidence === undefined
      ? continuationPrompt
      : `${continuationPrompt}\n\n${formatSwarmRoundEvidence(swarmEvidence)}`,
  );
  const continuationTrace = createChildTraceContext(traceContext, {
    sessionId: this.sessionId,
    attributes: {
      targetId: continuationTarget.targetID,
      targetContinuation: true,
    },
  });

  this.logger?.info("Goal continuation started", {
    ...traceContextToLogContext(continuationTrace),
    event: "target.continuation.started",
    module: "core.runtime",
    status: "started",
    targetId: continuationTarget.targetID,
  });

  const continuationResult = await this.executeTurnCommand(prompt, undefined, {
    abortSignal: options.abortSignal,
    // session/send 期间触发的目标自动续跑仍属于同一次用户提交。
    // 若这里丢掉 inputId，最终 turn.completed 会回落到 runtime trace，
    // 桌面端 activeInputId 对不上后会一直停在 streaming/loading。
    inputId: options.inputId,
    intent: options.intent,
    inputSource: "goal-continuation",
    inputVisibility: "model-only",
    targetId: continuationTarget.targetID,
    traceContext: continuationTrace,
  });
  // 刚结束的回合把 target 翻到 budget_limited 但回合内未交付终局提示时
  // (如 token 在最后一次 ModelComplete 才越线、模型直接收尾),补发一次宽限
  // 终局回合;回合内已交付(veto 置位)或本轮就是终局回合时不重复。
  // 旧忙碌循环在循环体内做此补偿;循环删除后由单回合命令自带(设计 §3.2)。
  if (isGoalLayerEnabled(this.config)) {
    await runTargetBudgetOutcomeTurnIfNeeded.call(this, options, traceContext);
  }
  return continuationResult;
}

async function runTargetBudgetOutcomeTurnIfNeeded(
  this: AgentRuntimeInternal,
  options: TargetContinuationRuntimeCommandOptions,
  traceContext: TraceContext,
): Promise<void> {
  if (options.abortSignal?.aborted) return;
  const outcomeDelivered = this.targetBudgetOutcomeDeliveredInTurn === true;
  this.targetBudgetOutcomeDeliveredInTurn = undefined;
  if (outcomeDelivered || !this.sessionStore) return;
  try {
    const target = await this.readSessionTargetForContext(traceContext);
    if (!target || target.status !== "budget_limited") return;
    const pressure = findExhaustedTargetBudgetDimension(target);
    if (!pressure) return;
    await executeTargetBudgetOutcomeTurn.call(this, {
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
      ...(options.intent ? { intent: options.intent } : {}),
      pressure,
      target,
      traceContext,
    });
  } catch (error) {
    this.logger?.warn("Failed to run goal budget outcome turn", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.budget.outcome_turn.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export async function targetContinuationCandidate(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (this.hasActiveOrQueuedTurnWork()) return null;
  return await targetContinuationCandidateForCommand.call(this, traceContext);
}

/**
 * 宽限终局回合:预算 100% 后的一次性收尾 turn(设计 §3.2)。
 * 输入即终局 outcome prompt,targetBudgetGrace 让本轮从第一步起 veto 全部工具。
 */
export async function executeTargetBudgetOutcomeTurn(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TargetContinuationRuntimeCommandOptions["intent"];
    pressure: NonNullable<ReturnType<typeof findExhaustedTargetBudgetDimension>>;
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<TurnResult | null> {
  const outcomeTrace = createChildTraceContext(input.traceContext, {
    sessionId: this.sessionId,
    attributes: {
      targetBudgetOutcome: true,
      targetId: input.target.targetID,
    },
  });
  this.logger?.info("Goal budget outcome turn started", {
    ...traceContextToLogContext(outcomeTrace),
    dimension: input.pressure.dimension,
    event: "target.budget.outcome_turn.started",
    module: "core.runtime",
    status: "started",
    targetId: input.target.targetID,
  });
  const prompt = wrapSystemReminderForSource(
    "target_continuation",
    formatTargetBudgetOutcomePrompt(input.target, input.pressure),
  );
  return await this.executeTurnCommand(prompt, undefined, {
    abortSignal: input.abortSignal,
    inputId: input.inputId,
    intent: input.intent,
    inputSource: "goal-continuation",
    inputVisibility: "model-only",
    targetBudgetGrace: true,
    targetId: input.target.targetID,
    traceContext: outcomeTrace,
  });
}

async function targetContinuationCandidateForCommand(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (!this.sessionStore) return null;
  if (this.getPlanEnabled()) return null;
  if (this.activeTurn || this.activeTurnStartReservation) return null;
  if (!this.sessionPersisted) return null;

  const target = await this.readSessionTargetForContext(traceContext);
  if (!target || target.status !== "active") return null;
  return target;
}

export async function hasRunningBackgroundTaskForGoalContinuation(
  this: AgentRuntimeInternal,
): Promise<boolean> {
  return hasRunningBackgroundRuntimeTask(this.runtimeTaskRegistry);
}

export async function accountTargetTurnCompletion(
  this: AgentRuntimeInternal,
  input: {
    countsTurn?: boolean;
    inputID: string;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
    usage?: ModelUsageSummary;
  },
): Promise<void> {
  const target = input.startedTarget;
  if (!target || !this.sessionStore) return;
  if (target.status !== "active") return;

  const tokensUsedDelta = input.usage?.totalTokens ?? 0;
  // 回合预算只计 goal 续跑回合;用户消息不消耗(设计 §3.2 预约-准入语义在
  // Phase 1 的对应裁定,见设计文档 §4.1)。关旗时回调旧的纯 token/挂钟记账。
  const goalLayerEnabled = isGoalLayerEnabled(this.config);
  const turnsUsedDelta = goalLayerEnabled && input.countsTurn === true ? 1 : 0;
  const endedAtMs = Date.now();

  try {
    const previousTarget = await this.readSessionTargetForContext(input.traceContext);
    const accountedTarget = this.sessionStore.finishTargetRun
      ? await this.sessionStore.finishTargetRun({
          endedAtMs,
          inputID: input.inputID,
          sessionID: this.sessionId,
          targetID: target.targetID,
          tokensUsedDelta,
          turnsUsedDelta,
          goalLayerEnabled,
        })
      : await this.sessionStore.accountTargetUsage({
          sessionID: this.sessionId,
          targetID: target.targetID,
          tokensUsedDelta,
          timeUsedSecondsDelta: Math.max(0, Math.ceil((endedAtMs - input.startedAtMs) / 1000)),
          turnsUsedDelta,
          goalLayerEnabled,
        });
    if (accountedTarget?.targetID === target.targetID) {
      await this.recordTargetChanged({
        action: this.sessionStore.finishTargetRun ? "run_finished" : "usage_accounted",
        previousTarget,
        source: "runtime",
        target: accountedTarget,
        traceContext: input.traceContext,
      });
    }
  } catch (error) {
    this.logger?.warn("Failed to account goal turn completion", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.account.failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
  }
}

export async function startTargetTurnAccounting(
  this: AgentRuntimeInternal,
  input: {
    inputID: string;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
  },
): Promise<SessionGoal | null> {
  const target = input.startedTarget;
  if (!target || !this.sessionStore?.startTargetRun) return target;
  if (target.status !== "active") return target;

  try {
    const startedTarget = await this.sessionStore.startTargetRun({
      inputID: input.inputID,
      sessionID: this.sessionId,
      startedAtMs: input.startedAtMs,
      targetID: target.targetID,
    });
    if (startedTarget?.targetID === target.targetID) {
      await this.recordTargetChanged({
        action: "run_started",
        previousTarget: target,
        source: "runtime",
        target: startedTarget,
        traceContext: input.traceContext,
      });
      return startedTarget;
    }
    return target;
  } catch (error) {
    this.logger?.warn("Failed to start goal active run accounting", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.run_start.failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
    return target;
  }
}

export async function heartbeatTargetTurnAccounting(
  this: AgentRuntimeInternal,
  input: {
    inputID: string;
    seenAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
  },
): Promise<void> {
  const target = input.startedTarget;
  if (!target || !this.sessionStore?.heartbeatTargetRun) return;
  if (target.status !== "active") return;
  try {
    await this.sessionStore.heartbeatTargetRun({
      inputID: input.inputID,
      seenAtMs: input.seenAtMs,
      sessionID: this.sessionId,
      targetID: target.targetID,
    });
  } catch (error) {
    this.logger?.debug("Failed to heartbeat goal active run accounting", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.run_heartbeat.failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
  }
}

export async function finishTargetTurnAccounting(
  this: AgentRuntimeInternal,
  input: {
    inputID: string;
    endedAtMs: number;
    startedTarget: SessionGoal | null;
    status?: "paused";
    reason?: string;
    traceContext: TraceContext;
  },
): Promise<SessionGoal | null> {
  const target = input.startedTarget;
  if (!target || !this.sessionStore?.finishTargetRun) return target;
  if (target.status !== "active") return target;

  try {
    const previousTarget = await this.readSessionTargetForContext(input.traceContext);
    const finishedTarget = await this.sessionStore.finishTargetRun({
      endedAtMs: input.endedAtMs,
      inputID: input.inputID,
      reason: input.reason,
      sessionID: this.sessionId,
      status: input.status,
      targetID: target.targetID,
      goalLayerEnabled: isGoalLayerEnabled(this.config),
    });
    if (finishedTarget?.targetID === target.targetID) {
      await this.recordTargetChanged({
        action: "run_finished",
        previousTarget,
        source: "runtime",
        target: finishedTarget,
        traceContext: input.traceContext,
      });
      return finishedTarget;
    }
    return target;
  } catch (error) {
    this.logger?.warn("Failed to finish goal active run accounting", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.run_finish.failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
    return target;
  }
}

/**
 * 显式把 active 目标置 paused 并落 TargetChanged 事件（完成门不可继续类结论专用）。
 * 与取消收口共用同一状态机路径，但 reason 由调用方给出，让 UI/恢复链路能区分
 * 「gate 不可用」「gate 能力不足」与用户 Stop。
 */
export async function pauseActiveTargetWithReason(
  this: AgentRuntimeInternal,
  input: {
    reason: string;
    traceContext: TraceContext;
    /** 结论所针对的目标身份；给出时暂停走 CAS，避免误暂停替换后的新目标。 */
    expectedTargetID?: string;
    expectedRevision?: number;
    /** 可选状态 CAS：暂停只允许从 active 迁移，避免覆盖并发的 paused/complete。 */
    expectedStatus?: SessionGoal["status"];
  },
): Promise<SessionGoal | null> {
  if (!this.sessionStore) return null;

  const target = await this.readSessionTargetForContext(input.traceContext);
  if (!target || target.status !== "active") return null;

  try {
    const pausedTarget = await this.sessionStore.updateTargetStatus({
      sessionID: this.sessionId,
      status: "paused",
      reason: input.reason,
      ...(input.expectedTargetID === undefined
        ? {}
        : { expectedTargetID: input.expectedTargetID }),
      ...(input.expectedRevision === undefined
        ? {}
        : { expectedRevision: input.expectedRevision }),
      ...(input.expectedStatus === undefined
        ? {}
        : { expectedStatus: input.expectedStatus }),
    });
    if (pausedTarget) {
      await this.recordTargetChanged({
        action: "status_updated",
        previousTarget: target,
        reason: input.reason,
        source: "runtime",
        target: pausedTarget,
        traceContext: input.traceContext,
      });
    } else {
      // CAS 未命中：目标在判定与暂停之间被替换/改写。不能静默当成已暂停。
      this.logger?.warn("Goal pause CAS missed after concurrent target change", {
        ...traceContextToLogContext(input.traceContext),
        event: "target.pause.cas_missed",
        expectedRevision: input.expectedRevision,
        expectedTargetID: input.expectedTargetID,
        module: "core.runtime",
        reason: input.reason,
        status: "failed",
        targetId: target.targetID,
      });
    }
    return pausedTarget;
  } catch (error) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      `Failed to pause active goal (${input.reason})`,
      {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { reason: input.reason, sessionId: this.sessionId, targetId: target.targetID },
        recoverable: true,
      },
    );
  }
}

export async function pauseActiveTargetForCancellation(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;

  // Stop 语义即 disarm：取消是用户停止目标循环的显式意图，必须在暂停写入之前
  // 落定。若等 pause 成功才 disarm，写失败（目标仍 active）时驱动器保持 armed，
  // 用户下一条消息排空后的空闲沿会重新预约——Stop 停不住目标。命令失败边缘的
  // standing-down 只消费一个边缘，不能作为唯一兜底。
  this.goalRoundDriverArmed = false;

  const target = await this.readSessionTargetForContext(traceContext);
  if (!target || target.status !== "active") return;

  try {
    const pausedTarget = await this.sessionStore.updateTargetStatus({
      sessionID: this.sessionId,
      status: "paused",
    });
    if (pausedTarget) {
      await this.recordTargetChanged({
        action: "status_updated",
        previousTarget: target,
        source: "runtime",
        target: pausedTarget,
        traceContext,
      });
    }
  } catch (error) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      "Failed to pause active goal after turn cancellation",
      {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { sessionId: this.sessionId, targetId: target.targetID },
        recoverable: true,
      },
    );
  }
}

export async function activatePausedTargetAfterResume(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (!this.sessionStore || this.getPlanEnabled()) return null;
  const target = await this.readSessionTargetForContext(traceContext);
  if (!target) return null;
  if (target.status !== "active") {
    // 冷恢复的 v4 投影由事件重建，可能停在上一次 verification 的 notSatisfied；
    // 持久层已是 paused/complete 时也必须发布一次权威状态，否则重启后 UI 仍显示
    // 「未达成」，既看不到 resume 入口，也把已暂停的目标误当成仍在进行。
    await this.recordTargetChanged({
      action: "status_updated",
      previousTarget: target,
      reason: "session-start-status-sync",
      source: "runtime",
      target,
      traceContext,
    });
    return target;
  }
  // session-start 边缘(冷启动 resume/fork 子会话恢复)强制 disarm(设计 §3.2):
  // active 一律转 paused,续跑需人显式 /goal resume。此前"两轮之间"残留的 active
  // 会在重启后被 idle 驱动器的空闲沿预约静默拉起续跑。进程内 armed 标志随重启
  // 归零,与该规则互为双保险。
  // 与取消收口(pauseActiveTargetForCancellation)同向:冷恢复绝不自动续跑。
  try {
    const pausedTarget = await this.sessionStore.updateTargetStatus({
      reason: "session-start-disarm",
      sessionID: this.sessionId,
      status: "paused",
    });
    if (pausedTarget) {
      await this.recordTargetChanged({
        action: "status_updated",
        previousTarget: target,
        reason: "session-start-disarm",
        source: "runtime",
        target: pausedTarget,
        traceContext,
      });
      this.logger?.info("Active goal disarmed to paused at session start", {
        ...traceContextToLogContext(traceContext),
        event: "target.disarm.session_start",
        module: "core.runtime",
        status: "completed",
        targetId: pausedTarget.targetID,
      });
      return pausedTarget;
    }
  } catch (error) {
    this.logger?.warn("Failed to disarm active goal at session start", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.disarm.session_start.failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
  }
  return target;
}
