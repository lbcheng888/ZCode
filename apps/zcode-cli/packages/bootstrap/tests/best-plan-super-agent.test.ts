// Best-plan super-agent：独立 model-only 调用生成六字段方案，再经 ProposeBestPlan 注入。
// 这里用 fake runtime 锁住四条边界：非用户回合不调模型、缺选型不执行、合法方案调度并执行
// 工具、坏 JSON / 坏字段只 warn 不伪造卡；另断言 input-facade 的 TurnStarted 接线。
import { describe, expect, it, vi } from "vitest";
import {
  BEST_PLAN_TOOL_NAME,
  BestPlanInputJsonSchema,
  createRootTraceContext,
  SessionEventType,
  type Logger,
  type SessionEvent,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import {
  createBestPlanSuperAgent,
  type BestPlanSuperAgentTurnStartedInput,
} from "../src/app/best-plan-super-agent.js";
import { createInputFacade } from "../src/app/input-facade.js";

const SESSION_ID = "session-1";
const TURN_ID = "turn-1";

const VALID_PLAN = {
  summary: "由独立 super-agent 生成方案并注入卡片",
  currentEvidence: "input-facade.ts 的 TurnStarted 订阅此前只服务观察者，没有方案生成入口",
  candidateOptions: [
    {
      option: "super-agent 调 ProposeBestPlan 注入六字段卡",
      cost: "每个用户回合多一次模型请求",
    },
    {
      option: "继续依赖 worker 主动调用 ProposeBestPlan",
      cost: "worker 忘记调用时会被写前门禁拒绝，回合起步延迟",
    },
  ],
  recommendation: "选 super-agent：模型只读生成方案，worker 专注执行，门禁仍兜底",
  impact: "只改 bootstrap 组合根与 input-facade；无协议/存储变更；删除注入即可回滚",
  verification: "tsc 与 best-plan-super-agent.test.ts 通过",
};

const PLAN_FIELDS = [
  "candidateOptions",
  "currentEvidence",
  "impact",
  "recommendation",
  "summary",
  "verification",
];

interface FakeSelection {
  providerId: string;
  modelId: string;
}

interface ScheduledToolCall {
  id: string;
  name: string;
  input: unknown;
}

interface GenerateCallInput {
  messages: Array<{ role: string; content: string }>;
  querySource: string;
  maxOutputTokens: number;
  selection: FakeSelection;
  responseJsonSchema: unknown;
}

interface FakeRuntimeOptions {
  generatedText?: string;
  hasProposeBestPlan?: boolean;
  selection?: FakeSelection;
  bestPlanSatisfied?: boolean;
  currentTurnId?: string;
  executeToolsSuccess?: boolean;
}

interface PersistSyntheticToolPartInput {
  turnId: string;
  parentUserMessageId?: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  startedAt: number;
  endedAt: number;
}

function createFakeRuntime(options: FakeRuntimeOptions = {}) {
  const selection = Object.hasOwn(options, "selection")
    ? options.selection
    : { providerId: "provider-a", modelId: "model-a" };
  const generateWorkspaceText = vi.fn(
    async (_input: GenerateCallInput, _options?: { traceContext?: unknown }) => ({
      text: options.generatedText ?? JSON.stringify(VALID_PLAN),
      selection: selection ?? { providerId: "provider-a", modelId: "model-a" },
      finishReason: "stop",
    }),
  );
  const scheduleTools = vi.fn(async (toolCalls: ScheduledToolCall[]) => {
    const ids = toolCalls.map((toolCall) => toolCall.id);
    return {
      items: toolCalls.map((toolCall) => ({
        toolCallId: toolCall.id,
        dependencies: [],
        canRunParallel: true,
      })),
      parallelGroups: [ids],
      executionOrder: ids,
    };
  });
  const appendEvent = vi.fn(async (_event: SessionEvent, _traceContext: unknown) => {});
  const executeTools = vi.fn(
    async (
      toolCalls: ScheduledToolCall[],
      _schedule: unknown,
      _options?: { traceContext?: unknown },
    ) => ({
      results: toolCalls.map((toolCall) => ({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        success: options.executeToolsSuccess !== false,
        ...(options.executeToolsSuccess === false
          ? { error: { type: "tool_error", message: "injection rejected by gate" } }
          : {}),
        output: {},
        durationMs: 0,
        startedAt: new Date(0),
        completedAt: new Date(0),
      })),
      events: [],
    }),
  );
  const persistSyntheticToolPart = vi.fn(
    async (
      _input: PersistSyntheticToolPartInput,
      _traceContext?: unknown,
    ): Promise<{ assistantMessageId: string; partId: string }> => ({
      assistantMessageId: "assistant-persisted",
      partId: "part-persisted",
    }),
  );
  const isBestPlanSatisfied = vi.fn(
    (_turnId: string) => options.bestPlanSatisfied === true,
  );
  const queueTurnSystemReminder = vi.fn();
  const getProjection = vi.fn(async () => ({
    currentTurnId: options.currentTurnId ?? TURN_ID,
  }));
  const runtime = {
    getToolRegistry: () => ({
      has: (name: string) => name === BEST_PLAN_TOOL_NAME && options.hasProposeBestPlan !== false,
    }),
    getSessionModelSelection: () => selection,
    isBestPlanSatisfied,
    getProjection,
    generateWorkspaceText,
    scheduleTools,
    appendEvent,
    executeTools,
    persistSyntheticToolPart,
    queueTurnSystemReminder,
  };
  return {
    runtime,
    generateWorkspaceText,
    scheduleTools,
    appendEvent,
    executeTools,
    persistSyntheticToolPart,
    isBestPlanSatisfied,
    queueTurnSystemReminder,
    getProjection,
    selection,
  };
}

function traceContextForTurn() {
  return createRootTraceContext({
    sessionId: SESSION_ID as never,
    turnId: TURN_ID as never,
  });
}

function createHarness(options: FakeRuntimeOptions = {}) {
  const runtime = createFakeRuntime(options);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  const agent = createBestPlanSuperAgent({
    runtime: runtime.runtime as unknown as AgentRuntime,
    sessionId: SESSION_ID as never,
    logger: logger as unknown as Logger,
  });
  return { agent, logger, ...runtime };
}

function turnStartedInput(
  overrides: Partial<BestPlanSuperAgentTurnStartedInput> = {},
): BestPlanSuperAgentTurnStartedInput {
  return {
    turnId: TURN_ID as never,
    requestText: "ship the feature",
    traceContext: traceContextForTurn(),
    userOrigin: true,
    ...overrides,
  };
}

function warnedEvents(logger: { warn: ReturnType<typeof vi.fn> }): Array<string | undefined> {
  return logger.warn.mock.calls.map((call) => (call[1] as { event?: string } | undefined)?.event);
}

describe("createBestPlanSuperAgent", () => {
  it("非用户回合不调用模型，也不注入工具", async () => {
    const harness = createHarness();
    await harness.agent.onTurnStarted(turnStartedInput({ userOrigin: false }));

    expect(harness.generateWorkspaceText).not.toHaveBeenCalled();
    expect(harness.scheduleTools).not.toHaveBeenCalled();
    expect(harness.executeTools).not.toHaveBeenCalled();
    expect(harness.logger.warn).not.toHaveBeenCalled();
  });

  it("工具面没有 ProposeBestPlan 时静默跳过（能力缺席，不伪造卡）", async () => {
    const harness = createHarness({ hasProposeBestPlan: false });
    await harness.agent.onTurnStarted(turnStartedInput());

    expect(harness.generateWorkspaceText).not.toHaveBeenCalled();
    expect(harness.scheduleTools).not.toHaveBeenCalled();
    expect(harness.executeTools).not.toHaveBeenCalled();
  });

  it("会话模型选型缺席时 warn 后返回，不调模型也不注入", async () => {
    const harness = createHarness({ selection: undefined });
    await harness.agent.onTurnStarted(turnStartedInput());

    expect(harness.generateWorkspaceText).not.toHaveBeenCalled();
    expect(harness.scheduleTools).not.toHaveBeenCalled();
    expect(harness.executeTools).not.toHaveBeenCalled();
    expect(warnedEvents(harness.logger)).toEqual(["best_plan.super_agent.selection_missing"]);
  });

  it("合法 JSON：schedule 并执行 ProposeBestPlan，input 是六字段方案", async () => {
    const harness = createHarness();
    const input = turnStartedInput();
    await harness.agent.onTurnStarted(input);

    expect(harness.generateWorkspaceText).toHaveBeenCalledTimes(1);
    const [generateInput, generateOptions] = harness.generateWorkspaceText.mock.calls[0]!;
    expect(generateInput).toMatchObject({
      selection: { providerId: "provider-a", modelId: "model-a" },
      querySource: "best_plan_super_agent",
      maxOutputTokens: 2048,
      responseJsonSchema: BestPlanInputJsonSchema,
    });
    expect(generateOptions).toEqual({ traceContext: input.traceContext });
    expect(generateInput.messages[0]?.role).toBe("system");
    expect(generateInput.messages[0]?.content).toContain("six-field");
    expect(generateInput.messages[0]?.content).toContain("do not call tools");
    expect(generateInput.messages[1]).toEqual({
      role: "user",
      content: expect.stringContaining("ship the feature"),
    });

    expect(harness.scheduleTools).toHaveBeenCalledTimes(1);
    const scheduledCall = harness.scheduleTools.mock.calls[0]![0][0]!;
    expect(scheduledCall.name).toBe(BEST_PLAN_TOOL_NAME);
    expect(scheduledCall.id).toContain(TURN_ID);
    expect(Object.keys(scheduledCall.input as object).sort()).toEqual(PLAN_FIELDS);

    expect(harness.appendEvent).toHaveBeenCalledTimes(1);
    const scheduledEvent = harness.appendEvent.mock.calls[0]![0];
    expect(scheduledEvent.type).toBe(SessionEventType.ToolCallScheduled);
    expect(scheduledEvent.turnId).toBe(TURN_ID);
    expect((scheduledEvent.payload as { toolCallId: string }).toolCallId).toBe(scheduledCall.id);

    expect(harness.executeTools).toHaveBeenCalledTimes(1);
    const [executedCalls, , executeOptions] = harness.executeTools.mock.calls[0]!;
    expect(executedCalls).toEqual([scheduledCall]);
    expect(executeOptions).toEqual({ traceContext: input.traceContext });

    // 注入成功后卡片补成 transcript 事实：六字段 plan 为 input，parent 缺省交由 Core 按
    // turnId 解析；startedAt/endedAt 是注入前后的真实时刻。
    expect(harness.persistSyntheticToolPart).toHaveBeenCalledTimes(1);
    const [persistInput, persistTraceContext] = harness.persistSyntheticToolPart.mock.calls[0]!;
    expect(persistInput.turnId).toBe(TURN_ID);
    expect(persistInput.parentUserMessageId).toBeUndefined();
    expect(persistInput.toolCallId).toBe(scheduledCall.id);
    expect(persistInput.toolName).toBe(BEST_PLAN_TOOL_NAME);
    expect(persistInput.input).toEqual(scheduledCall.input);
    expect(Object.keys(persistInput.input as object).sort()).toEqual(PLAN_FIELDS);
    expect(persistInput.output).toEqual({});
    expect(typeof persistInput.startedAt).toBe("number");
    expect(typeof persistInput.endedAt).toBe("number");
    expect(persistInput.startedAt).toBeLessThanOrEqual(persistInput.endedAt);
    expect(persistTraceContext).toEqual(input.traceContext);
    const debugEvents = harness.logger.debug.mock.calls.map(
      (call) => (call[1] as { event?: string } | undefined)?.event,
    );
    expect(debugEvents).toEqual([
      "best_plan.super_agent.reminder_queued",
      "best_plan.super_agent.persisted",
    ]);
    expect(harness.logger.warn).not.toHaveBeenCalled();
  });

  it("注入失败：抛错且不调用持久化（卡片未成立，没有可恢复的事实）", async () => {
    const harness = createHarness({ executeToolsSuccess: false });
    await expect(harness.agent.onTurnStarted(turnStartedInput())).rejects.toThrow(
      "ProposeBestPlan 注入失败: injection rejected by gate",
    );

    expect(harness.executeTools).toHaveBeenCalledTimes(1);
    expect(harness.persistSyntheticToolPart).not.toHaveBeenCalled();
    expect(harness.logger.debug).not.toHaveBeenCalled();
  });

  it("坏 JSON：warn 后返回，不调度也不执行工具", async () => {
    const harness = createHarness({ generatedText: "not json at all" });
    await harness.agent.onTurnStarted(turnStartedInput());

    expect(harness.scheduleTools).not.toHaveBeenCalled();
    expect(harness.executeTools).not.toHaveBeenCalled();
    expect(harness.appendEvent).not.toHaveBeenCalled();
    expect(warnedEvents(harness.logger)).toEqual(["best_plan.super_agent.parse_failed"]);
  });

  it("JSON 合法但字段不合规：warn 后返回，不调度也不执行工具", async () => {
    const harness = createHarness({
      generatedText: JSON.stringify({
        ...VALID_PLAN,
        candidateOptions: [VALID_PLAN.candidateOptions[0]],
      }),
    });
    await harness.agent.onTurnStarted(turnStartedInput());

    expect(harness.scheduleTools).not.toHaveBeenCalled();
    expect(harness.executeTools).not.toHaveBeenCalled();
    expect(harness.appendEvent).not.toHaveBeenCalled();
    expect(warnedEvents(harness.logger)).toEqual(["best_plan.super_agent.parse_failed"]);
  });
});

describe("input-facade best-plan super-agent wiring", () => {
  it("TurnStarted 命中 inputId 时触发，并传入回合 turnId、原始文本与 userOrigin", async () => {
    let sink: { onSessionEvent(event: SessionEvent): Promise<void> | void } | undefined;
    const onTurnStarted = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      subscribeEvents: vi.fn(
        (next: { onSessionEvent(event: SessionEvent): Promise<void> | void }) => {
          sink = next;
          return () => {};
        },
      ),
      admitPrompt: vi.fn().mockResolvedValue({
        completion: Promise.resolve({}),
        kind: "started",
        turnId: TURN_ID,
      }),
    };
    const facade = createInputFacade({
      bestPlanSuperAgent: { onTurnStarted },
      logger: { warn: vi.fn() } as never,
      prepareUserExecutionBoundary: async () => {
        await sink?.onSessionEvent({
          type: SessionEventType.TurnStarted,
          turnId: TURN_ID,
          traceId: "trace-turn",
          payload: { inputId: "cmd-1" },
        } as unknown as SessionEvent);
      },
      runtime: runtime as never,
      sessionId: SESSION_ID as never,
      traceContext: createRootTraceContext({ sessionId: SESSION_ID as never }),
    });

    await facade.sendInput("propose the plan", { inputId: "cmd-1", triggerSource: "user" });

    expect(runtime.subscribeEvents).toHaveBeenCalledTimes(1);
    expect(onTurnStarted).toHaveBeenCalledTimes(1);
    const input = onTurnStarted.mock.calls[0]![0] as BestPlanSuperAgentTurnStartedInput;
    expect(input.turnId).toBe(TURN_ID);
    expect(input.requestText).toBe("propose the plan");
    expect(input.userOrigin).toBe(true);
    expect(input.traceContext).toMatchObject({
      traceId: "trace-turn",
      sessionId: SESSION_ID,
      turnId: TURN_ID,
    });
  });

  it("super-agent 失败经 logger.warn 暴露，不吞成无声", async () => {
    let sink: { onSessionEvent(event: SessionEvent): Promise<void> | void } | undefined;
    const logger = { warn: vi.fn() };
    const runtime = {
      subscribeEvents: vi.fn(
        (next: { onSessionEvent(event: SessionEvent): Promise<void> | void }) => {
          sink = next;
          return () => {};
        },
      ),
      admitPrompt: vi.fn().mockResolvedValue({
        completion: Promise.resolve({}),
        kind: "started",
        turnId: TURN_ID,
      }),
    };
    const facade = createInputFacade({
      bestPlanSuperAgent: {
        onTurnStarted: vi.fn().mockRejectedValue(new Error("model unavailable")),
      },
      logger: logger as never,
      prepareUserExecutionBoundary: async () => {
        await sink?.onSessionEvent({
          type: SessionEventType.TurnStarted,
          turnId: TURN_ID,
          traceId: "trace-turn",
          payload: { inputId: "cmd-1" },
        } as unknown as SessionEvent);
      },
      runtime: runtime as never,
      sessionId: SESSION_ID as never,
      traceContext: createRootTraceContext({ sessionId: SESSION_ID as never }),
    });

    await facade.sendInput("propose the plan", { inputId: "cmd-1" });

    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));
    expect(logger.warn.mock.calls[0]?.[0]).toBe("Best plan super-agent failed");
    expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({
      error: "model unavailable",
      event: "best_plan.super_agent.failed",
    });
  });
});

describe("createBestPlanSuperAgent turn lifecycle", () => {
  it("主回合已经结束时不再注入卡片", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();
    await harness.agent.onTurnStarted(turnStartedInput({ signal: controller.signal }));

    expect(harness.generateWorkspaceText).not.toHaveBeenCalled();
    expect(harness.scheduleTools).not.toHaveBeenCalled();
    expect(harness.executeTools).not.toHaveBeenCalled();
  });

  it("worker 已经自行提交方案时不再注入第二张卡", async () => {
    const harness = createHarness({ bestPlanSatisfied: true });
    await harness.agent.onTurnStarted(turnStartedInput());

    expect(harness.generateWorkspaceText).not.toHaveBeenCalled();
    expect(harness.scheduleTools).not.toHaveBeenCalled();
    expect(harness.executeTools).not.toHaveBeenCalled();
  });
});

describe("createBestPlanSuperAgent turn projection", () => {
  it("注入前发现当前回合已不是本 turn 时丢弃卡片", async () => {
    const harness = createHarness({ currentTurnId: "turn-next" });
    await harness.agent.onTurnStarted(turnStartedInput());

    expect(harness.generateWorkspaceText).toHaveBeenCalledTimes(1);
    expect(harness.scheduleTools).not.toHaveBeenCalled();
    expect(harness.executeTools).not.toHaveBeenCalled();
  });
});

describe("createBestPlanSuperAgent reminder queue", () => {
  it("executeTools 成功后把六字段要点作为隐藏 system reminder 入队", async () => {
    const harness = createHarness({
      generatedText: JSON.stringify({
        ...VALID_PLAN,
        currentEvidence: "证据一行\n证据二行",
      }),
    });
    await harness.agent.onTurnStarted(turnStartedInput());

    expect(harness.queueTurnSystemReminder).toHaveBeenCalledTimes(1);
    const queued = harness.queueTurnSystemReminder.mock.calls[0]![0];
    expect(queued).toMatchObject({
      turnId: TURN_ID,
      source: "best_plan_super_agent",
    });
    const body = queued.body as string;
    // summary / recommendation / verification 全文。
    expect(body).toContain(VALID_PLAN.summary);
    expect(body).toContain(
      "选 super-agent：模型只读生成方案，worker 专注执行，门禁仍兜底",
    );
    expect(body).toContain("tsc 与 best-plan-super-agent.test.ts 通过");
    // 其余字段压缩成单行。
    expect(body).toContain("证据一行；证据二行");
    expect(body).toContain(VALID_PLAN.candidateOptions[0]!.option);
    // worker 执行指令：先陈述推荐方案，再按其执行；不重复调用 ProposeBestPlan。
    expect(body).toContain("陈述推荐方案");
    expect(body).toContain("不要调用 ProposeBestPlan");
    // 成功补 debug 事件。
    const debugEvents = harness.logger.debug.mock.calls.map(
      (call) => (call[1] as { event?: string } | undefined)?.event,
    );
    expect(debugEvents).toContain("best_plan.super_agent.reminder_queued");
  });

  it("入队失败只 warn，不抛断回合，卡片持久化照常", async () => {
    const harness = createHarness();
    harness.queueTurnSystemReminder.mockImplementation(() => {
      throw new Error("reminder source not registered");
    });
    await expect(harness.agent.onTurnStarted(turnStartedInput())).resolves.toBeUndefined();

    expect(warnedEvents(harness.logger)).toEqual(["best_plan.super_agent.reminder_failed"]);
    expect(harness.logger.warn.mock.calls[0]![1]).toMatchObject({
      error: "reminder source not registered",
    });
    // 卡片已成立：持久化恢复层不依赖提醒队列。
    expect(harness.persistSyntheticToolPart).toHaveBeenCalledTimes(1);
  });
});
