// ============================================================
// Goal Tool Handlers
// ============================================================

import {
  CoreErrorType,
  GOAL_TOOL_COMPLETION_EVIDENCE_NOTE,
  GoalBlockInputJsonSchema,
  GoalBlockInputSchema,
  GoalBlockOutputJsonSchema,
  GoalBlockOutputSchema,
  GoalCreateInputJsonSchema,
  GoalCreateInputSchema,
  GoalCreateOutputJsonSchema,
  GoalCreateOutputSchema,
  GoalReadInputJsonSchema,
  GoalReadInputSchema,
  GoalReadOutputJsonSchema,
  GoalReadOutputSchema,
  GoalUpdateInputJsonSchema,
  GoalUpdateInputSchema,
  GoalUpdateOutputJsonSchema,
  GoalUpdateOutputSchema,
  SessionEventType,
  createCoreError,
  createSessionEvent,
  type SessionGoal,
  type TargetChangedPayload,
} from "@zcode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";

const MAX_GOAL_MODEL_BYTES = 100_000;

/** 目标不存在(还没建/已被清空)。与 revision 冲突分开,模型下一步动作不同。 */
const GOAL_TOOL_MISSING_FAILURE_CODE = 404;
/** targetID+revision 过期或目标已 complete,调用未写入任何数据。 */
const GOAL_TOOL_CONFLICT_FAILURE_CODE = 409;

export const targetReadHandler: ToolHandler = async (input, context) => {
  GoalReadInputSchema.parse(input);
  assertTargetStore(context, "GoalRead");

  return {
    goal: await context.sessionStore.readTarget({ sessionID: context.sessionId }),
  };
};

export const targetReadToolEntry: ToolEntry = {
  capability: "Read the current session goal without modifying external state",
  metadata: {
    name: "GoalRead",
    description: "Read the current session goal and status.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_GOAL_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: targetReadHandler,
  inputSchema: GoalReadInputJsonSchema,
  outputSchema: GoalReadOutputJsonSchema,
  runtimeInputSchema: GoalReadInputSchema,
  runtimeOutputSchema: GoalReadOutputSchema,
  permission: {
    permission: "target.read",
    reason: "GoalRead only reads session-local goal state",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: targetResultBudget(),
  timeout: targetTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "GoalRead was cancelled before goal state was returned",
  },
  trace: targetTracePolicy(),
};

export const goalCreateHandler: ToolHandler = async (input, context) => {
  const { objective } = GoalCreateInputSchema.parse(input);
  assertTargetStore(context, "GoalCreate");

  const goal = await context.sessionStore.createTarget({
    objective,
    sessionID: context.sessionId,
  });
  if (!goal) {
    const current = await context.sessionStore.readTarget({ sessionID: context.sessionId });
    return {
      result: false,
      errorCode: GOAL_TOOL_CONFLICT_FAILURE_CODE,
      message: `GoalCreate wrote nothing: this session already has a goal (targetID ${current?.targetID ?? "unknown"}, revision ${current?.revision ?? "unknown"}, status ${current?.status ?? "unknown"}). Use GoalUpdate to change that goal's objective; only the user can replace a goal.`,
    };
  }

  await emitTargetChanged(context, {
    action: "set",
    source: "tool",
    target: goal,
    previousTarget: null,
  });
  return { goal };
};

export const goalUpdateHandler: ToolHandler = async (input, context) => {
  const { objective, revision, targetID } = GoalUpdateInputSchema.parse(input);
  assertTargetStore(context, "GoalUpdate");
  if (!context.sessionStore.updateTargetObjective) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort.updateTargetObjective is not configured for GoalUpdate",
      { context: { toolCallId: context.toolCallId, toolName: "GoalUpdate" }, recoverable: false },
    );
  }

  const current = await context.sessionStore.readTarget({ sessionID: context.sessionId });
  if (!current || current.status === "complete") {
    return goalStaleFailure("GoalUpdate", current, { revision, targetID });
  }
  const updated = await context.sessionStore.updateTargetObjective({
    objective,
    revision,
    sessionID: context.sessionId,
    targetID,
  });
  if (!updated) {
    const latest = await context.sessionStore.readTarget({ sessionID: context.sessionId });
    return goalStaleFailure("GoalUpdate", latest, { revision, targetID });
  }

  await emitTargetChanged(context, {
    action: "objective_edited",
    previousTarget: current,
    source: "tool",
    target: updated,
  });
  return { goal: updated, previousObjective: current.objective };
};

export const goalBlockHandler: ToolHandler = async (input, context) => {
  const { blockerCode, reason, revision, targetID } = GoalBlockInputSchema.parse(input);
  assertTargetStore(context, "GoalBlock");
  if (!context.sessionStore.blockTarget) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort.blockTarget is not configured for GoalBlock",
      { context: { toolCallId: context.toolCallId, toolName: "GoalBlock" }, recoverable: false },
    );
  }

  const current = await context.sessionStore.readTarget({ sessionID: context.sessionId });
  if (!current || current.status === "complete") {
    return goalStaleFailure("GoalBlock", current, { revision, targetID });
  }
  const blocked = await context.sessionStore.blockTarget({
    blockerCode,
    reason,
    revision,
    sessionID: context.sessionId,
    targetID,
  });
  if (!blocked) {
    const latest = await context.sessionStore.readTarget({ sessionID: context.sessionId });
    return goalStaleFailure("GoalBlock", latest, { revision, targetID });
  }

  await emitTargetChanged(context, {
    action: "status_updated",
    blockerCode,
    previousTarget: current,
    reason,
    source: "tool",
    target: blocked,
  });
  return { blockerCode, goal: blocked };
};

async function emitTargetChanged(
  context: ToolExecutionContext,
  payload: TargetChangedPayload,
): Promise<void> {
  await context.emitEvent?.(
    createSessionEvent(SessionEventType.TargetChanged, context.sessionId, payload, {
      turnId: context.turnId,
      traceId: context.traceId,
    }),
  );
}

/**
 * 目标不存在/已 complete/被替换/ revision 过期都归为「本次没有写入」。
 * 消息必须带当前 targetID+revision,模型才能当场改正而不必猜。
 */
function goalStaleFailure(
  toolName: "GoalUpdate" | "GoalBlock",
  current: SessionGoal | null,
  requested: { revision: number; targetID: string },
): ToolHandlerFailure {
  if (!current) {
    return {
      result: false,
      errorCode: GOAL_TOOL_MISSING_FAILURE_CODE,
      message: `${toolName} wrote nothing: this session has no goal.`,
    };
  }
  if (current.status === "complete") {
    return {
      result: false,
      errorCode: GOAL_TOOL_CONFLICT_FAILURE_CODE,
      message: `${toolName} wrote nothing: the goal (targetID ${current.targetID}, revision ${current.revision}) is already complete. A completed goal cannot be reopened or edited by a tool.`,
    };
  }
  const detail =
    current.targetID !== requested.targetID
      ? `the goal was replaced (requested targetID ${requested.targetID}, current targetID ${current.targetID})`
      : `revision ${requested.revision} is stale (current revision ${current.revision})`;
  return {
    result: false,
    errorCode: GOAL_TOOL_CONFLICT_FAILURE_CODE,
    message: `${toolName} wrote nothing: ${detail}. Nothing else changed; retry with targetID ${current.targetID} and revision ${current.revision} only if that is still the goal you mean.`,
  };
}

export const goalCreateToolEntry: ToolEntry = {
  capability:
    "Create the session's long-running goal from a user-stated objective, without budget or completion input",
  metadata: {
    name: "GoalCreate",
    description: [
      "Create the session's long-running goal from an objective the user asked for. Fails if a goal already exists — use GoalUpdate for the existing goal. Takes no budget, status, or completion input and cannot mark the goal complete.",
      GOAL_TOOL_COMPLETION_EVIDENCE_NOTE,
    ].join("\n\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_GOAL_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: goalCreateHandler,
  inputSchema: GoalCreateInputJsonSchema,
  outputSchema: GoalCreateOutputJsonSchema,
  runtimeInputSchema: GoalCreateInputSchema,
  runtimeOutputSchema: GoalCreateOutputSchema,
  permission: {
    permission: "target.create",
    reason: "GoalCreate only creates session-local goal state",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: targetResultBudget(),
  timeout: targetTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "GoalCreate was cancelled before the goal was created",
  },
  trace: targetTracePolicy(),
};

export const goalUpdateToolEntry: ToolEntry = {
  capability:
    "Replace the objective of the session's current goal under an optimistic revision guard",
  metadata: {
    name: "GoalUpdate",
    description: [
      "Replace the objective of the current session goal. Pass the targetID and revision from the goal state in this session; a stale pair is rejected and nothing is written. The whole objective is replaced, never merged. Does not change status or budgets and cannot mark the goal complete. Never rewrite the objective to shrink scope or make the completion check easier.",
      GOAL_TOOL_COMPLETION_EVIDENCE_NOTE,
    ].join("\n\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_GOAL_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: goalUpdateHandler,
  inputSchema: GoalUpdateInputJsonSchema,
  outputSchema: GoalUpdateOutputJsonSchema,
  runtimeInputSchema: GoalUpdateInputSchema,
  runtimeOutputSchema: GoalUpdateOutputSchema,
  permission: {
    permission: "target.update",
    reason: "GoalUpdate only rewrites the session-local goal objective",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: targetResultBudget(),
  timeout: targetTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "GoalUpdate was cancelled before the goal objective was written",
  },
  trace: targetTracePolicy(),
};

export const goalBlockToolEntry: ToolEntry = {
  capability:
    "Pause the session's current goal behind a stable blocker code when real work cannot continue",
  metadata: {
    name: "GoalBlock",
    description: [
      "Stop pursuing the current session goal because of a real blocker. The goal becomes paused — not complete — keeps its budget, and only the user can resume it. Pass the targetID and revision from the goal state; a stale pair is rejected and nothing is written. Record a stable blocker code plus a short reason, then tell the user what blocks the goal and what would unblock it.",
      GOAL_TOOL_COMPLETION_EVIDENCE_NOTE,
    ].join("\n\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_GOAL_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: goalBlockHandler,
  inputSchema: GoalBlockInputJsonSchema,
  outputSchema: GoalBlockOutputJsonSchema,
  runtimeInputSchema: GoalBlockInputSchema,
  runtimeOutputSchema: GoalBlockOutputSchema,
  permission: {
    permission: "target.block",
    reason: "GoalBlock only pauses the session-local goal and records a blocker code",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: targetResultBudget(),
  timeout: targetTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "GoalBlock was cancelled before the goal was paused",
  },
  trace: targetTracePolicy(),
};

function assertTargetStore(
  context: ToolExecutionContext,
  toolName: "GoalRead" | "GoalCreate" | "GoalUpdate" | "GoalBlock",
): asserts context is ToolExecutionContext & { sessionStore: NonNullable<ToolExecutionContext["sessionStore"]> } {
  if (context.sessionStore) return;

  throw createCoreError(CoreErrorType.ConfigurationError, `SessionStorePort is not configured for ${toolName}`, {
    context: {
      toolCallId: context.toolCallId,
      toolName,
    },
    recoverable: false,
  });
}

function targetResultBudget() {
  return {
    maxInlineBytes: MAX_GOAL_MODEL_BYTES,
    maxModelBytes: MAX_GOAL_MODEL_BYTES,
    strategy: "truncate" as const,
    preview: {
      maxBytes: MAX_GOAL_MODEL_BYTES,
      direction: "head" as const,
    },
  };
}

function targetTimeout() {
  return {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  };
}

function targetTracePolicy() {
  return {
    required: true as const,
    propagateToAdapters: false,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  };
}
