import type {
  ExpertWorkflowRunSnapshot,
  SessionEvent,
  TraceContext,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowRunStatus,
  WorkflowStorePort,
} from "@zcode/contracts";
import type { AgentProfile } from "@zcode/shared";

export interface ExpertWorkflowAgentRunInput {
  abortSignal?: AbortSignal;
  activityId: string;
  cwd: string;
  onChildSessionStarted?: (event: ExpertWorkflowChildSessionStartedEvent) => void | Promise<void>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  parentSessionId?: string;
  phase: string;
  /** 子执行进程 env（约定传 buildSpecRunEnv 产出）；缺席由 child runtime 回落 appOptions.env。 */
  processEnv?: Record<string, string>;
  /** spec 受限子代理档案；在场时 child 工具面走 spec 受限链过滤（super-agent-spec-lane-spec §6-1）。 */
  profile?: AgentProfile;
  prompt: string;
  runId: string;
  task: string;
  traceContext?: TraceContext;
  workflowKind?: string;
}

export interface ExpertWorkflowChildSessionStartedEvent {
  model?: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

export interface ExpertWorkflowAgentRunResult {
  model?: string;
  response: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

export interface ExpertWorkflowAgentRunner {
  run(input: ExpertWorkflowAgentRunInput): Promise<ExpertWorkflowAgentRunResult>;
}

export interface ExpertWorkflowRuntimeDeps {
  agentRunner: ExpertWorkflowAgentRunner;
  createActivityId?: () => string;
  createRunId?: () => string;
  definition?: WorkflowDefinition;
  now?: () => Date;
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  store: WorkflowStorePort;
}

export interface ExpertWorkflowRunOptions {
  abortSignal?: AbortSignal;
  cwd: string;
  definitionId?: string;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  sessionId?: string;
  task: string;
  traceContext?: TraceContext;
  workflowKind?: string;
}

export interface ExpertWorkflowLookupOptions {
  abortSignal?: AbortSignal;
  cwd: string;
  definitionId?: string;
  runId?: string;
  workflowKind?: string;
}

export interface ExpertWorkflowRetryOptions extends ExpertWorkflowLookupOptions {
  activityId?: string;
  nodeId?: string;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  phase?: string;
  traceContext?: TraceContext;
}

export interface ExpertWorkflowListOptions {
  abortSignal?: AbortSignal;
  cwd: string;
  definitionId?: string;
  limit?: number;
  workflowKind?: string;
}

export interface ExpertWorkflowEventsOptions {
  abortSignal?: AbortSignal;
  limit?: number;
  runId: string;
}

export interface ExpertWorkflowCommandResult {
  reportPath?: string;
  response: string;
  runId?: string;
  snapshot?: ExpertWorkflowRunSnapshot;
  status?: WorkflowRunStatus;
  traceId?: string;
}

export interface ExpertPhaseRunResult {
  response: string;
  snapshot: ExpertWorkflowRunSnapshot;
}

export type WorkflowAgentRunInput = ExpertWorkflowAgentRunInput;
export type WorkflowAgentRunResult = ExpertWorkflowAgentRunResult;
export type WorkflowAgentRunner = ExpertWorkflowAgentRunner;
export type WorkflowRuntimeDeps = ExpertWorkflowRuntimeDeps;
export type WorkflowRunOptions = ExpertWorkflowRunOptions;
export type WorkflowLookupOptions = ExpertWorkflowLookupOptions;
export type WorkflowRetryOptions = ExpertWorkflowRetryOptions;
export type WorkflowListOptions = ExpertWorkflowListOptions;
export type WorkflowEventsOptions = ExpertWorkflowEventsOptions;
export type WorkflowCommandResult = ExpertWorkflowCommandResult;
