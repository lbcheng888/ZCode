import { describe, expect, it } from "vitest";
import {
  BEST_PLAN_RECORDED_MESSAGE,
  BEST_PLAN_TOOL_NAME,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type BestPlanOutput,
  type PermissionRequestedPayload,
  type SessionEvent,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { resolveRuntimeDisallowedTools } from "../src/runtime/helpers/tool-allowlist.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { bestPlanToolEntry } from "../src/tool/handlers/best-plan.js";
import { builtInTools } from "../src/tool/handlers/index.js";
import { orderProviderVisibleToolContracts } from "../src/tool/provider-visible-order.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { READ_ONLY_TOOLS } from "../src/tool/scheduler.js";
import { SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS } from "../src/subagent/tool-policy.js";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";

const validInput = {
  summary: "Normalize the tool result before the card renders it",
  currentEvidence:
    "packages/core/src/tool/handlers/list-models.ts:172 returns a ToolHandlerFailure instead of an empty list.",
  candidateOptions: [
    {
      option: "Normalize inside the handler before returning",
      cost: "One extra pass over the parsed input; no schema change.",
    },
    {
      option: "Normalize in the UI projection",
      cost: "Every host would have to repeat the same normalization.",
    },
  ],
  recommendation:
    "Normalize in the handler: one owner, and the model sees the same bytes the card does.",
  impact: "Touches packages/core only; no protocol or storage change; revert is a single file.",
  verification:
    "pnpm --dir apps/zcode-cli exec vitest run packages/core/tests/best-plan-tool.test.ts",
};

interface RunOutcome {
  brokerCalls: number;
  permissionRequested: PermissionRequestedPayload[];
  result: ToolExecutionResult;
}

async function run(name: string, input: unknown): Promise<RunOutcome> {
  const sessionId = createSessionId(name);
  const turnId = createTurnId(name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];
  let brokerCalls = 0;

  const registry = createToolRegistry();
  registry.register(bestPlanToolEntry);

  const executor = createToolExecutor({
    emitEvent: async (event) => {
      events.push(event);
    },
    mode: "build",
    permissionBroker: {
      async requestPermission() {
        brokerCalls += 1;
        return { decision: "allow" as const };
      },
    },
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
    workingDirectory: "/workspace/never-read",
  });

  const result = await executor.execute(
    { id: createToolCallId(name), input, name: BEST_PLAN_TOOL_NAME },
    { traceContext },
  );

  return {
    brokerCalls,
    permissionRequested: events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => event.payload as PermissionRequestedPayload),
    result,
  };
}

describe("ProposeBestPlan handler", () => {
  it("records the plan and returns ok, a 12-hex planId and the execution receipt", async () => {
    const output = (await bestPlanToolEntry.handler(validInput, {
      workingDirectory: "/workspace/never-read",
    } as unknown as ToolExecutionContext)) as BestPlanOutput;

    expect(output.ok).toBe(true);
    expect(output.planId).toMatch(/^[0-9a-f]{12}$/);
    expect(output.message).toBe(BEST_PLAN_RECORDED_MESSAGE);
  });

  it("fingerprints the same plan identically regardless of key order, and a different plan differently", async () => {
    const context = {
      workingDirectory: "/workspace/never-read",
    } as unknown as ToolExecutionContext;
    const [first, second] = validInput.candidateOptions as [
      { option: string; cost: string },
      { option: string; cost: string },
    ];
    const reordered = {
      verification: validInput.verification,
      impact: validInput.impact,
      recommendation: validInput.recommendation,
      candidateOptions: [
        { cost: first.cost, option: first.option },
        { cost: second.cost, option: second.option },
      ],
      currentEvidence: validInput.currentEvidence,
      summary: validInput.summary,
    };

    const baseline = (await bestPlanToolEntry.handler(validInput, context)) as BestPlanOutput;
    const same = (await bestPlanToolEntry.handler(reordered, context)) as BestPlanOutput;
    const changed = (await bestPlanToolEntry.handler(
      { ...validInput, impact: `${validInput.impact} Also drops the old helper.` },
      context,
    )) as BestPlanOutput;

    expect(same.planId).toBe(baseline.planId);
    expect(changed.planId).not.toBe(baseline.planId);
  });

  it("runs without asking for approval and shows the model only the receipt", async () => {
    const outcome = await run("best-plan-executor", validInput);

    expect(outcome.result.success).toBe(true);
    expect(outcome.brokerCalls).toBe(0);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect((outcome.result.output as BestPlanOutput).planId).toMatch(/^[0-9a-f]{12}$/);
    expect(outcome.result.modelContent).toBe(BEST_PLAN_RECORDED_MESSAGE);
  });
});

describe("ProposeBestPlan registration", () => {
  it("is registered as a resident read-only tool with no approval", () => {
    expect(builtInTools.map((entry) => entry.metadata.name)).toContain(BEST_PLAN_TOOL_NAME);

    expect(bestPlanToolEntry.metadata).toMatchObject({
      name: BEST_PLAN_TOOL_NAME,
      shouldDefer: false,
      alwaysLoad: true,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      allowedInPlanMode: true,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    });
    expect(bestPlanToolEntry.permission.permission).toBe("best-plan.propose");
    expect(bestPlanToolEntry.permission.needsApproval).toBe(false);
    expect(bestPlanToolEntry.permission.alwaysAllowPatternSources).toEqual(["toolName"]);
    expect(bestPlanToolEntry.timeout.kind).toBe("none");
    expect(bestPlanToolEntry.metadata.timeoutMs).toBeUndefined();
    expect(READ_ONLY_TOOLS.has(BEST_PLAN_TOOL_NAME)).toBe(true);
  });

  it("tells the model exactly when to call it and never to repeat it", () => {
    const description = bestPlanToolEntry.metadata.description ?? "";

    expect(description).toContain("exactly once before the first side-effecting tool call");
    expect(description).toContain("investigate read-only as needed");
    expect(description).toContain("without waiting for approval");
    expect(description).toContain("Never repeat it in the same turn");
  });

  it("is ordered with the shared provider tool names", () => {
    expect(
      orderProviderVisibleToolContracts([{ name: "Read" }, { name: BEST_PLAN_TOOL_NAME }]).map(
        (tool) => tool.name,
      ),
    ).toEqual([BEST_PLAN_TOOL_NAME, "Read"]);
  });

  it("is disallowed in workflow-child runtimes, where the card would land in the parent transcript", () => {
    const child = resolveRuntimeDisallowedTools({
      taskType: "workflow_child",
    } as AgentRuntimeConfig);
    const main = resolveRuntimeDisallowedTools({} as AgentRuntimeConfig);

    expect(child).toContain(BEST_PLAN_TOOL_NAME);
    expect(main).toBeUndefined();
  });

  it("is force-disallowed in every subagent child, not only workflow children", () => {
    expect(SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS).toContain(BEST_PLAN_TOOL_NAME);
  });
});

describe("ProposeBestPlan runtime gate", () => {
  function sideEffectEntry(
    name: string,
    sideEffectScope: ToolEntry["metadata"]["sideEffectScope"],
    readOnly: boolean,
  ): ToolEntry {
    return {
      ...bestPlanToolEntry,
      metadata: {
        ...bestPlanToolEntry.metadata,
        name,
        readOnly,
        sideEffectScope,
        description: `${name} test double`,
      },
      permission: {
        ...bestPlanToolEntry.permission,
        permission: `${name.toLowerCase()}.test`,
      },
      handler: async () => ({
        ok: true as const,
        planId: "test-plan",
        message: "ok",
      }),
    };
  }

  async function executorWithGate() {
    const sessionId = createSessionId("best-plan-gate");
    const turnId = createTurnId("best-plan-gate");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    registry.register(bestPlanToolEntry);
    registry.register(sideEffectEntry("Write", "workspace", false));
    registry.register(sideEffectEntry("Read", "none", true));
    registry.register(sideEffectEntry("Agent", "session", false));

    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "build",
      bestPlanGate: true,
      permissionBroker: {
        async requestPermission() {
          return { decision: "allow" as const };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
      workingDirectory: "/workspace/never-read",
    });

    const execute = (name: string) =>
      executor.execute({ id: createToolCallId(name), input: validInput, name }, { traceContext });

    return { events, execute, turnId };
  }

  it("lets read-only tools run, then blocks the first write and delegation until a plan is recorded", async () => {
    const { execute, events } = await executorWithGate();

    const read = await execute("Read");
    expect(read.success).toBe(true);

    const blockedWrite = await execute("Write");
    expect(blockedWrite.success).toBe(false);
    expect(blockedWrite.modelContent).toContain("Call ProposeBestPlan first");

    const blockedAgent = await execute("Agent");
    expect(blockedAgent.success).toBe(false);

    // 门禁拒绝也要留下可见的错误事件，UI 不能停在 running。
    expect(
      events.filter((event) => event.type === SessionEventType.ToolCallError).length,
    ).toBeGreaterThanOrEqual(2);

    const plan = await execute(BEST_PLAN_TOOL_NAME);
    expect(plan.success).toBe(true);

    const write = await execute("Write");
    expect(write.success).toBe(true);
  });

  it("scopes the recorded plan to its own turn", async () => {
    const { execute } = await executorWithGate();
    expect((await execute(BEST_PLAN_TOOL_NAME)).success).toBe(true);
    expect((await execute("Write")).success).toBe(true);
  });
});
