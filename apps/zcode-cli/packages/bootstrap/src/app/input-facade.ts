import type { AgentRuntime, TurnAttachment, TurnResult } from "@zcode/core";
import {
  SessionEventType,
  createRootTraceContext,
  traceContextToLogContext,
  type InputHistoryEntry,
  type InputHistoryKind,
  type InputHistoryStorePort,
  type Logger,
  type SessionId,
  type ToolArtifactStorePort,
  type TraceContext,
} from "@zcode/contracts";
import {
  externalizePromptAttachments,
  materializeInputHistoryEntry,
  normalizePromptInput,
  projectInputHistoryAttachments,
} from "./prompt-input.js";
import type {
  PrepareUserExecutionBoundary,
  SendInputOptions,
  SubmitPromptOptions,
  ZCodeApp,
} from "./types.js";
import type { CliDefaultSelection } from "./cli-default-selection.js";
import type { BestPlanSuperAgent } from "./best-plan-super-agent.js";
import type { SuperAgentAdmissionMandateResolution } from "./super-agent-admission-facts.js";

type InputFacade = Pick<
  ZCodeApp,
  | "continueActiveTarget"
  | "enqueueDeferredInput"
  | "recordInputHistory"
  | "editQueueItem"
  | "lockQueueItemEdit"
  | "releaseQueueItemEdit"
  | "recallPreviousInputHistory"
  | "removeQueueItem"
  | "reserveQueueItem"
  | "markQueueItemPromoting"
  | "releaseQueueItemReservation"
  | "clearQueueItems"
  | "completeExternalQueueDrain"
  | "reorderQueueItem"
  | "setQueueAutoDrain"
  | "setFollowupMode"
  | "sendInput"
  | "steerTurn"
  | "submitPrompt"
>;

interface CreateInputFacadeDeps {
  cliDefaultSelection?: CliDefaultSelection;
  artifactStore?: ToolArtifactStorePort;
  customCommandPromptResolver?: (
    text: string,
    options?: Pick<SubmitPromptOptions, "abortSignal" | "traceContext">,
  ) => Promise<string | undefined>;
  inputHistoryStore?: InputHistoryStorePort;
  logger: Logger;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  runtime: AgentRuntime;
  sessionId: SessionId;
  traceContext: TraceContext;
  /**
   * 每轮用户输入起步后的独立方案 super-agent：TurnStarted 命中本次 inputId 时触发，
   * 由它经 ProposeBestPlan 把六字段卡注入当前回合。缺席时保持既有行为。
   */
  bestPlanSuperAgent?: BestPlanSuperAgent;
  /**
   * M4：按 inputId(=wire commandId) 取控制面在投递前解析的 mandate 结论。
   * 仅 features.eventRouter + features.mandateGate 同时打开时由组合根注入。
   */
  lookupAdmissionMandateFacts?: (
    inputId: string | undefined,
  ) => SuperAgentAdmissionMandateResolution | undefined;
  /**
   * M4：按 inputId 取本输入是否由 trigger 信封发起。即使 facts 因跨 app 交接缺失，
   * Core admission 也会按 trigger 来源响亮失败，而不是静默退回 user-origin。
   */
  lookupAdmissionTriggerSource?: (inputId: string | undefined) => "trigger" | undefined;
  /**
   * M4：在每次 admission 边界按 triggerId 重新解析结论（不复用投递时刻缓存）。
   * 排队输入提升、入队后 mandate 被 revoke / 新 promote，都必须按当时的授权重判
   * （spec §8-17②）；缺控制面 / 缺 trigger 行由实现响亮抛错，不退回旧结论。
   */
  revalidateAdmissionMandateFacts?: (
    triggerId: string,
  ) => SuperAgentAdmissionMandateResolution | undefined;
  /** 排队输入标记为待提升（登记表淘汰循环必须保留它）。 */
  retainAdmissionMandateFacts?: (inputId: string | undefined) => void;
  /** M4：回合已起步或判定不会再起轮时释放登记项；排队输入保留到提升边界。 */
  releaseAdmissionMandateFacts?: (inputId: string | undefined) => void;
}

export function createInputFacade(deps: CreateInputFacadeDeps): InputFacade {
  const preparePromptBoundary = async (options?: SubmitPromptOptions): Promise<void> => {
    await deps.prepareUserExecutionBoundary(options);
  };

  const recordAcceptedInputHistory = async (
    text: string,
    kind: InputHistoryKind,
    recordTraceContext: TraceContext,
    attachments?: TurnAttachment[],
  ): Promise<InputHistoryEntry | null> => {
    if (!deps.inputHistoryStore) return null;
    try {
      return await deps.inputHistoryStore.recordInputHistory({
        attachments: projectInputHistoryAttachments(attachments),
        kind,
        projectID: deps.runtime.getProjectId(),
        sessionID: deps.sessionId,
        text,
      });
    } catch (error) {
      deps.logger.warn("Input history write failed", {
        ...traceContextToLogContext(recordTraceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "input_history.record.failed",
        kind,
        module: "bootstrap",
        projectId: deps.runtime.getProjectId(),
        status: "failed",
      });
      return null;
    }
  };

  const recallPreviousInputHistory = async (skip?: number): Promise<InputHistoryEntry | null> => {
    if (!deps.inputHistoryStore) return null;
    const entry = await deps.inputHistoryStore.recallPreviousInputHistory({
      projectID: deps.runtime.getProjectId(),
      skip,
    });
    return await materializeInputHistoryEntry(entry, deps.artifactStore);
  };

  const runPromptTurn = async (
    promptInput: ReturnType<typeof normalizePromptInput>,
    options?: SubmitPromptOptions,
  ): Promise<TurnResult> => {
    const storedAttachments = await externalizePromptAttachments(promptInput.attachments, {
      artifactStore: deps.artifactStore,
      sessionId: deps.sessionId,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    await recordAcceptedInputHistory(
      promptInput.text,
      "prompt",
      options?.traceContext ?? deps.traceContext,
      storedAttachments,
    );
    const resolvedCommandPrompt = await deps.customCommandPromptResolver?.(promptInput.text, {
      abortSignal: options?.abortSignal,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    const runtimePromptText = resolvedCommandPrompt ?? promptInput.text;
    const turnAttribution = options?.automationId
      ? { automationId: options.automationId }
      : options?.offPeakTaskId
        ? {
            offPeakTaskId: options.offPeakTaskId,
            ...(options.offPeakRunType ? { offPeakRunType: options.offPeakRunType } : {}),
          }
        : {};
    return await deps.runtime.executeTurn(runtimePromptText, storedAttachments, {
      abortSignal: options?.abortSignal,
      browserAmbientContext: options?.browserAmbientContext,
      // goal 续跑不挂在 prompt 之后(设计 §3.6):drain 收口的空闲沿由 idle 驱动器
      // 统一预约。旧触发源 continueActiveTargetAfterTurn 已删除。
      ...(resolvedCommandPrompt !== undefined ? { displayInput: promptInput.text } : {}),
      inputId: options?.inputId,
      ...turnAttribution,
      intent: options?.intent,
      sharedContextRefs: options?.sharedContextRefs,
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext ?? deps.traceContext,
      modelExecution: options?.modelExecution,
    });
  };

  const prepareRuntimePrompt = async (
    promptInput: ReturnType<typeof normalizePromptInput>,
    options?: SubmitPromptOptions,
  ): Promise<{ input: string; storedAttachments?: TurnAttachment[] }> => {
    const storedAttachments = await externalizePromptAttachments(promptInput.attachments, {
      artifactStore: deps.artifactStore,
      sessionId: deps.sessionId,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    const resolvedCommandPrompt = await deps.customCommandPromptResolver?.(promptInput.text, {
      abortSignal: options?.abortSignal,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    return {
      input: resolvedCommandPrompt ?? promptInput.text,
      ...(storedAttachments ? { storedAttachments } : {}),
    };
  };

  return {
    continueActiveTarget: async (options) => {
      const unsubscribe = options?.onEvent
        ? deps.runtime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      try {
        // cold resume 会在 prepare boundary 内触发 SessionStart Hook review。必须先订阅，
        // 否则 ReviewRequested 发生在订阅窗口之前，Dual ACK 永远拿不到释放 authority。
        await preparePromptBoundary(options);
        return await deps.runtime.continueActiveTargetLoop({
          abortSignal: options?.abortSignal,
          inputId: options?.inputId,
          intent: options?.intent,
          traceContext: options?.traceContext ?? deps.traceContext,
          trigger: "manual",
          verifyBeforeFirstContinue: false,
        });
      } finally {
        unsubscribe?.();
      }
    },
    recordInputHistory: async (input, kind = "slash_command") => {
      const promptInput = normalizePromptInput(input);
      const attachments = await externalizePromptAttachments(promptInput.attachments, {
        artifactStore: deps.artifactStore,
        sessionId: deps.sessionId,
        traceContext: deps.traceContext,
      });
      return recordAcceptedInputHistory(promptInput.text, kind, deps.traceContext, attachments);
    },
    recallPreviousInputHistory,
    sendInput: async (input, options) => {
      const promptInput = normalizePromptInput(input);
      const delivery = options?.delivery ?? "auto";
      // M4：事件回合的 mandate 结论按 commandId 登记，admission 前取出交给 Core；
      // 排队输入要保留到提升时的下一次 admission，其余路径在收口处释放。
      const admissionInputId = options?.inputId;
      let admissionResolution = deps.lookupAdmissionMandateFacts?.(admissionInputId);
      // M4：登记表只是「本输入属于事件回合」的身份凭据，档位结论必须在本次 admission
      // 边界按 triggerId 重新解析——排队期间 mandate 可能被 revoke 或 promote 出新档，
      // 复用投递时刻的旧结论会放行已撤销的写操作，或让新提升的 auto 档继续被拒。
      if (admissionResolution?.kind === "mandate" && deps.revalidateAdmissionMandateFacts) {
        const fresh = deps.revalidateAdmissionMandateFacts(admissionResolution.facts.triggerId);
        if (!fresh) {
          throw new Error(
            `事件回合 mandate 重新解析失败: triggerId=${admissionResolution.facts.triggerId}（flag-on 控制面缺席，禁止复用投递时刻结论）`,
          );
        }
        admissionResolution = fresh;
      }
      // human-explicit 直通「免 Mandate」：即使信封带 triggerId 也不向 Core 声明事件来源，
      // 否则未配置显式 mandate 的人类直接消息会被隐式 record_only 判成只读。
      // 其余情况以宿主从信封推导的来源为准；登记表命中则为 trigger。
      const admissionTriggerSource =
        admissionResolution?.kind === "human_explicit_exempt"
          ? undefined
          : (options?.triggerSource ?? deps.lookupAdmissionTriggerSource?.(admissionInputId));
      const admissionMandateFacts =
        admissionResolution?.kind === "mandate" ? admissionResolution.facts : undefined;
      let keepAdmissionMandateFacts = false;
      let startedTurn = false;
      const bestPlanAbort = new AbortController();
      const unsubscribe =
        options?.onEvent || options?.onTurnStartedObserved || deps.bestPlanSuperAgent
          ? deps.runtime.subscribeEvents({
              onSessionEvent: async (event) => {
                await options?.onEvent?.(event);
                if (
                  event.type === SessionEventType.TurnStarted &&
                  (event.payload as { inputId?: unknown }).inputId === options?.inputId
                ) {
                  // TurnStarted 只用于后续关联；admission ACK 不等待 projection commit。
                  options?.onTurnStartedObserved?.(event);
                  const bestPlanSuperAgent = deps.bestPlanSuperAgent;
                  if (bestPlanSuperAgent) {
                    const turnId = event.turnId;
                    if (turnId === undefined) {
                      deps.logger.warn(
                        "Best plan super-agent skipped: TurnStarted without turnId",
                        {
                          ...traceContextToLogContext(deps.traceContext),
                          event: "best_plan.super_agent.turn_id_missing",
                          module: "bootstrap",
                          sessionId: String(deps.sessionId),
                          status: "failed",
                        },
                      );
                      return;
                    }
                    // 用事件自身的 traceId + turnId 建独立根上下文：super-agent 的模型调用与
                    // 注入的工具事件都归属当前回合，写前门禁按同一 turnId 记账。
                    const bestPlanTraceContext = createRootTraceContext({
                      traceId: event.traceId,
                      sessionId: deps.sessionId,
                      turnId,
                      attributes: { querySource: "best_plan_super_agent" },
                    });
                    void bestPlanSuperAgent
                      .onTurnStarted({
                        turnId,
                        requestText: promptInput.text,
                        traceContext: bestPlanTraceContext,
                        // wire 用户回合会显式带 triggerSource="user"（session-flow 的
                        // promptTriggerSourceOf），只有 "trigger" 才是事件回合；缺席同样是
                        // 用户直接输入（human-explicit 免 Mandate），不能误判成非用户回合。
                        userOrigin: admissionTriggerSource !== "trigger",
                        signal: bestPlanAbort.signal,
                      })
                      .catch((error: unknown) => {
                        // 卡片注入失败不能让回合静默无卡：留 warn 供诊断，worker 仍受硬门禁约束。
                        deps.logger.warn("Best plan super-agent failed", {
                          ...traceContextToLogContext(bestPlanTraceContext),
                          error: error instanceof Error ? error.message : String(error),
                          event: "best_plan.super_agent.failed",
                          module: "bootstrap",
                          sessionId: String(deps.sessionId),
                          status: "failed",
                        });
                      });
                  }
                }
              },
            })
          : undefined;
      try {
        // resume review 属于本次 prompt 生命周期，订阅覆盖 prepare boundary；Core admission
        // 在同一个 session runtime 内完成 start/queue，不在这里读取 activeTurn 做分叉。
        await preparePromptBoundary(options);
        options = deps.cliDefaultSelection?.prepareInput(options) ?? options;
        const prepared = await prepareRuntimePrompt(promptInput, options);
        // M4：显式剥掉宿主传入的 triggerSource 再展开。human-explicit 免 Mandate 时
        // admissionTriggerSource 必须真正缺席；直接展开 options 会把宿主的 "trigger"
        // 原样带进 Core，导致缺 facts 的 admission 响亮失败。
        const admissionOptions: SendInputOptions = { ...options };
        delete admissionOptions.triggerSource;
        const result = await deps.runtime.admitPrompt(prepared.input, prepared.storedAttachments, {
          ...admissionOptions,
          delivery,
          traceContext: options?.traceContext ?? deps.traceContext,
          ...(prepared.input !== promptInput.text ? { displayInput: promptInput.text } : {}),
          ...(admissionTriggerSource ? { triggerSource: admissionTriggerSource } : {}),
          ...(admissionMandateFacts ? { mandateFacts: admissionMandateFacts } : {}),
        });
        if (result.kind === "started") {
          startedTurn = true;
          void result.completion.finally(() => bestPlanAbort.abort());
          await recordAcceptedInputHistory(
            promptInput.text,
            "prompt",
            options?.traceContext ?? deps.traceContext,
            prepared.storedAttachments,
          );
          if (unsubscribe) void result.completion.then(unsubscribe, unsubscribe);
          return {
            completion: result.completion,
            kind: "started_turn",
            turnId: result.turnId,
          };
        }
        unsubscribe?.();
        if (result.kind === "queued") {
          keepAdmissionMandateFacts = true;
          // 待提升项必须在登记表淘汰中保留，否则提升后的 admission 会丢掉事件来源。
          deps.retainAdmissionMandateFacts?.(admissionInputId);
          await recordAcceptedInputHistory(
            promptInput.text,
            "steered_input",
            options?.traceContext ?? deps.traceContext,
            prepared.storedAttachments,
          );
        }
        return result;
      } catch (error) {
        unsubscribe?.();
        throw error;
      } finally {
        if (!startedTurn) bestPlanAbort.abort();
        if (!keepAdmissionMandateFacts) {
          deps.releaseAdmissionMandateFacts?.(admissionInputId);
        }
      }
    },
    enqueueDeferredInput: async (input, options) => {
      options = deps.cliDefaultSelection?.prepareInput(options) ?? options;
      const result = await deps.runtime.enqueueDeferredInput({
        input,
        inputPresentation: "user_steer",
        ...(options?.commandKind ? { commandKind: options.commandKind } : {}),
        ...(options?.delivery ? { delivery: options.delivery } : {}),
        ...(options?.intent ? { intent: options.intent } : {}),
        ...(options?.attachments ? { attachments: options.attachments } : {}),
        ...(options?.toolDisallowlist ? { toolDisallowlist: options.toolDisallowlist } : {}),
        ...(options?.intent?.queueItemId ? { pendingInputId: options.intent.queueItemId } : {}),
        ...(options?.inputId ? { inputId: options.inputId } : {}),
        ...(options?.queryId ? { queryId: options.queryId } : {}),
        traceContext: options?.traceContext ?? deps.traceContext,
      });
      if (result.kind === "queued") {
        await recordAcceptedInputHistory(
          input,
          "steered_input",
          options?.traceContext ?? deps.traceContext,
        );
      }
      return result;
    },
    steerTurn: async (input, options) => {
      options = deps.cliDefaultSelection?.prepareInput(options) ?? options;
      const unsubscribe = options?.onEvent
        ? deps.runtime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      try {
        const result = await deps.runtime.steerTurn({
          inputPresentation: "user_steer",
          commandKind: options?.commandKind,
          inputId: options?.inputId,
          queryId: options?.queryId,
          expectedTurnId: options?.expectedTurnId,
          delivery: options?.delivery,
          intent: options?.intent,
          attachments: options?.attachments,
          pendingInputId: options?.intent?.queueItemId,
          input,
          toolDisallowlist: options?.toolDisallowlist,
          traceContext: options?.traceContext ?? deps.traceContext,
        });
        if (result.kind === "queued") {
          await recordAcceptedInputHistory(
            input,
            "steered_input",
            options?.traceContext ?? deps.traceContext,
          );
        }
        return result;
      } finally {
        unsubscribe?.();
      }
    },
    removeQueueItem: async (pendingInputId, options) => {
      // v4 queue 单项删除：把 v4 命令桥到 runtime 单项 pending-input 移除。
      return deps.runtime.removePendingInputById({
        pendingInputId,
        reason: options?.reason ?? "user_removed",
        reservationId: options?.reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    reserveQueueItem: async (pendingInputId, reservationId, options) =>
      deps.runtime.reservePendingInputById({
        pendingInputId,
        reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    markQueueItemPromoting: async (pendingInputId, reservationId, options) =>
      deps.runtime.markPendingInputPromoting({
        pendingInputId,
        reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    releaseQueueItemReservation: async (pendingInputId, reservationId, options) =>
      deps.runtime.releasePendingInputReservation({
        pendingInputId,
        reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    editQueueItem: async (pendingInputId, newText, options) => {
      // v4 queue 单项编辑：原地替换排队输入（reducer 同 id 原地更新，保位）。
      const { traceContext, ...edit } = options ?? {};
      return deps.runtime.editPendingInputById({
        ...edit,
        pendingInputId,
        ...(newText !== undefined ? { newText } : {}),
        traceContext: traceContext ?? deps.traceContext,
      });
    },
    lockQueueItemEdit: async (pendingInputId, editLock, options) =>
      deps.runtime.lockPendingInputEdit({
        pendingInputId,
        editLock,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    releaseQueueItemEdit: async (pendingInputId, options) =>
      deps.runtime.releasePendingInputEdit({
        pendingInputId,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    reorderQueueItem: async (pendingInputId, beforePendingInputId, options) => {
      // v4 queue 重排：移动排队项到锚点前（null=队尾）。
      return deps.runtime.reorderPendingInput({
        pendingInputId,
        beforePendingInputId,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    clearQueueItems: async (options) => {
      // v4 clearQueueAndSend：清空 active turn 内存项 + held 投影残留。
      return deps.runtime.clearAllPendingInputs(options?.traceContext ?? deps.traceContext);
    },
    setQueueAutoDrain: async (autoDrain, options) => {
      // v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级配置事件）。
      await deps.runtime.setQueueAutoDrain({
        autoDrain,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    completeExternalQueueDrain: () => {
      deps.runtime.completeExternalQueueDrain();
    },
    setFollowupMode: async (mode, options) => {
      // v4 setFollowupMode：翻转 followup 路由模式（queue/guide）。
      await deps.runtime.setFollowupMode({
        mode,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    submitPrompt: async (prompt, options) => {
      const promptInput = normalizePromptInput(prompt);
      const unsubscribe = options?.onEvent
        ? deps.runtime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      try {
        await preparePromptBoundary(options);
        options = deps.cliDefaultSelection?.prepareInput(options) ?? options;
        return await runPromptTurn(promptInput, options);
      } finally {
        unsubscribe?.();
      }
    },
  };
}
