import { createChildTraceContext, createQueryId, createTurnId } from "../deps.js";
import type { QueryId, TurnInputIntentMetadata } from "../deps.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { PromptTriggerSource } from "@zcode/shared/zcode-protocol-v4";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { acceptSubmissionModelSelection, captureHighspeedFallbackSelection } from "./turn-model.js";
import type { TurnPermissionFacts } from "../../permission/service.js";
import type {
  ActiveTurnStartReservation,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  TurnResult,
} from "../types.js";

const EVENT_ADMISSION_MISSING_MANDATE_FACTS =
  "事件回合 admission 缺少 mandateFacts：flag-on 必须由控制面注入 mandate.resolveFor 结论（spec §8-15②），禁止静默降级为 user-origin";
const EVENT_ADMISSION_USER_WITH_FACTS =
  "user 回合 admission 不得携带 mandateFacts：mandate 门只作用于事件驱动回合（M4 例外②）";
const EVENT_ADMISSION_MISSING_QUERY_ID =
  "事件回合 admission 缺少 queryId/inputId：无法把 mandate 结论绑定到回合作用域";
const EVENT_ADMISSION_MISSING_TRIGGER_ID =
  "事件回合 mandateFacts 缺少 triggerId：无法证明本回合的事件权威";

// 触发来源枚举与 wire schema 同源（设计 §7 Upgrade / spec §2.2「三处合同同步」）：
// 枚举定义在 shared command.ts 的 promptTriggerSourceSchema，本文件只再导出 + 提供
// 信封→来源的唯一推导函数，禁止在 admission 侧另写字面量枚举。
export type { PromptTriggerSource };

/**
 * wire 信封 → prompt-admission 触发来源。envelope.triggerId 存在（非空）即
 * super-agent EventRouter / human-explicit 分派器投递；缺省 = 宿主/用户直接输入。
 * 组合根把信封映射进 admission options 时必须经本函数，不得自行判断字符串。
 */
export function promptTriggerSourceOf(envelope: {
  triggerId?: string | null;
}): PromptTriggerSource {
  return typeof envelope.triggerId === "string" && envelope.triggerId.trim().length > 0
    ? "trigger"
    : "user";
}

/**
 * M4 admission 边界解析：把控制面注入的 mandate 结论落成回合作用域的权限事实。
 *
 * - `mandateFacts` 在场 ⇒ 事件回合；来源必须推导为 trigger，否则是宿主接线错误（响亮失败）。
 * - `triggerSource=trigger` 而 facts 缺席 ⇒ flag-on 注入缺失，直接抛错；绝不静默按
 *   user-origin 放行（那会让 M4 门在生产路径上假死）。
 * - 两者都缺席 ⇒ 既有 user 回合，返回 undefined（字节兼容）。
 */
function resolveAdmissionPermissionFacts(
  options: PromptAdmissionOptions | undefined,
): TurnPermissionFacts | undefined {
  const mandateFacts = options?.mandateFacts;
  if (mandateFacts) {
    if (
      typeof mandateFacts.triggerId !== "string" ||
      mandateFacts.triggerId.trim().length === 0
    ) {
      throw new Error(EVENT_ADMISSION_MISSING_TRIGGER_ID);
    }
    const triggerSource =
      options?.triggerSource ?? promptTriggerSourceOf({ triggerId: mandateFacts.triggerId });
    if (triggerSource !== "trigger") {
      throw new Error(EVENT_ADMISSION_USER_WITH_FACTS);
    }
    const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined);
    if (!queryId) throw new Error(EVENT_ADMISSION_MISSING_QUERY_ID);
    return {
      origin: "event",
      mandate: {
        tier: mandateFacts.tier,
        ...(mandateFacts.mandateId ? { mandateId: mandateFacts.mandateId } : {}),
        expiresAt: mandateFacts.expiresAt ?? null,
      },
    };
  }
  if (options?.triggerSource === "trigger") {
    throw new Error(EVENT_ADMISSION_MISSING_MANDATE_FACTS);
  }
  return undefined;
}

/**
 * 每个 AgentRuntime 自己完成 prompt 的 admission：检查 busy 边界、建立 reservation、
 * 把 command 放进该 runtime 的 FIFO。Bootstrap 不应把这些步骤拆开，否则 reservation
 * 建立前的异步窗口会让同一 session 产生第二条 turn。
 */
export async function admitPrompt(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: Parameters<AgentRuntimeInternal["executeTurn"]>[1],
  options?: PromptAdmissionOptions,
): Promise<PromptAdmissionReceipt> {
  // M4：准入边界先校验事件来源事实（trigger 来源缺 facts 立即响亮失败，绝不静默
  // 退回 user-origin）。真正绑定发生在起轮分支：只有真实回合才有不可复用的 turnId；
  // 排队/steer 不绑，避免把结论挂到客户端可复用的 queryId 上。
  const admissionPermission = resolveAdmissionPermissionFacts(options);
  if (options?.requireQueue === true) {
    // Bug 根因：Highspeed 临时 provider 只能在独立 turn 的提升边界安装。如果仅依据
    // Bootstrap 的 busy 快照决定是否排队，状态在跨层 await 期间转为空闲会误用普通模型启动。
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options.commandKind,
      delivery: "queue",
      input,
      inputId: options.inputId,
      intent: admissionIntent(options.intent, "queue"),
      modelSelectionScope: options.modelExecution?.selectionScope,
      highspeedFallbackSelection: options.modelExecution?.selectionFallback?.target,
      queryId: options.queryId,
      toolDisallowlist: options.toolDisallowlist,
      traceContext: options.traceContext,
    });
  }
  const promotionLeaseOnly =
    options?.requireIdle === true &&
    this.foregroundPromotionLease !== undefined &&
    this.activeForegroundExecution === undefined &&
    this.runtimeCommandDrainActive === false &&
    this.runtimeCommandQueue.hasPending() === false &&
    this.activeTurn === undefined &&
    this.activeTurnStartReservation === undefined;
  const busy = this.hasActiveOrQueuedTurnWork() && !promotionLeaseOnly;
  // inject 目标(设计 §3.5):绝不唤醒——不 start turn、不占跑道。idle 时只落
  // next-step 收件箱,由下一个真正起跑的回合在其首个 step 边界消费。
  // inject 车道恒可用(设计 M11 Remove 清单已删 inject→queue 降级残留)。
  const wantsInject = options?.queueDelivery === "inject";
  if (!busy && wantsInject) {
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options?.commandKind,
      delivery: "inject",
      input,
      inputId: options?.inputId,
      intent: options?.intent,
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext,
    });
  }
  if (busy) {
    if (options?.requireIdle === true || options?.modelExecution !== undefined) {
      return {
        activeTurnId: this.activeTurn?.turnId,
        kind: "rejected",
        reason: this.activeTurn ? "turn_not_steerable" : "no_active_turn",
      };
    }

    const activeTurn = this.activeTurn;
    const canSteer =
      attachments === undefined &&
      activeTurn?.steerable === true &&
      (wantsInject ||
        options?.queueDelivery === "guide" ||
        options?.delivery === "auto" ||
        options?.delivery === "steer_active_turn") &&
      options?.queueDelivery !== "queue";
    if (canSteer) {
      const delivery = wantsInject
        ? ("inject" as const)
        : options?.queueDelivery === "guide"
          ? ("guide" as const)
          : undefined;
      return await this.steerTurn({
        commandKind: options?.commandKind,
        delivery,
        expectedTurnId: options?.expectedTurnId,
        input,
        inputPresentation:
          options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
        inputId: options?.inputId,
        intent: admissionIntent(options?.intent, delivery ?? "queue"),
        queryId: options?.queryId,
        toolDisallowlist: options?.toolDisallowlist,
        traceContext: options?.traceContext,
      });
    }

    const delivery = wantsInject
      ? ("inject" as const)
      : options?.queueDelivery === "guide" && attachments === undefined
        ? ("guide" as const)
        : ("queue" as const);
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options?.commandKind,
      delivery,
      input,
      inputPresentation:
        options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
      inputId: options?.inputId,
      intent: admissionIntent(options?.intent, delivery),
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext,
    });
  }

  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const turnId = createTurnId();
  // M4：事件回合的 mandate 结论绑定到本次真实回合。turnId 由运行时生成、每轮回新，
  // 后续工具判定经 trace.turnId 命中同一份事实；回合结束由 releaseTurnStart 删除。
  // 排队输入在提升时会再次走本函数（新 turnId），因此每次都按当时的授权重新绑定。
  if (admissionPermission) {
    this.permissionService.bindTurnPermissionFacts({
      sessionId: this.sessionId,
      turnId,
      facts: admissionPermission,
    });
  }
  const turnTraceContext = createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
    queryId,
    sessionId: this.sessionId,
    turnId,
    attributes: { turnNumber: this.turnNumber },
  });
  const reservation: ActiveTurnStartReservation = {
    kind: "regular",
    traceContext: turnTraceContext,
    turnId,
  };
  this.reserveTurnStart(turnId, turnTraceContext, "regular");
  let selectionAccepted = Promise.resolve();

  if (options?.modelExecution) {
    options = {
      ...options,
      modelExecution: captureHighspeedFallbackSelection(this, options.modelExecution),
    };
  }
  const executeOptions = options as ExecuteTurnOptions | undefined;
  const completion = enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    onCommandCancelled: () => this.releaseTurnStart(turnId),
    onCommandAccepted: () => {
      selectionAccepted = acceptSubmissionModelSelection(
        this,
        options?.intent,
        turnTraceContext,
        options?.modelExecution,
      );
    },
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options: {
        ...executeOptions,
        queryId,
        traceContext: options?.traceContext ?? this.rootTraceContext,
      },
      priority: "next",
      reject,
      resolve,
      startReservation: reservation,
      traceContext: turnTraceContext,
    }),
  });
  // admission 已经完成；执行失败由现有 turn 事件/调用方消费，不制造 unhandled rejection。
  void completion.catch(() => undefined);
  await selectionAccepted;
  return { completion, kind: "started", turnId };
}

function admissionIntent(
  intent: TurnInputIntentMetadata | undefined,
  admittedDelivery: "guide" | "queue" | "inject",
): TurnInputIntentMetadata | undefined {
  if (!intent) return undefined;
  return {
    ...intent,
    // intent.admittedDelivery 是持久化元数据域(仅 startNow/queue/guide,消费方含
    // transcript hydration/wire 投影);inject 车道的权威在 pendingInput.delivery /
    // TurnSteerQueued.delivery,这里映射到同属 next-step 的 guide,不扩持久枚举。
    admittedDelivery: admittedDelivery === "inject" ? "guide" : admittedDelivery,
  };
}
