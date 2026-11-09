/**
 * 蜂群编排的共享类型与轮级身份生成。
 *
 * 编排实现（swarm-orchestrator.ts）、worker、聚合器、证据格式化与 journal 都引用
 * 这里的同一组定义；拆出独立模块是为了让 runtime 入口只承载轮生命周期，而不是
 * 把纯类型堆在实现文件里。
 */

import type {
  AgentTextContentBlock,
  Model,
  ModelUsage,
  SessionId,
  SubagentPort,
  SwarmJournalTaskResult,
  ToolCallId,
  TraceContext,
  TurnId,
} from "@zcode/contracts";

import type { AgentRuntimeInternal } from "./internal.js";

/** 子任务生命周期状态。 */
export type SwarmTaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/**
 * 蜂群中的一个子任务：既是分解产物，也是交给 SubagentPort.run 的执行请求。
 * status 在 runSwarm 期间原位迁移，调用方可据此观察进度。workingDirectory /
 * workspaceRoot 始终是调用方的基准目录；worker 实际执行目录由隔离工作树覆盖。
 */
export interface SwarmTask {
  /** swarm 内的任务标识，用于把结果对回任务。 */
  taskId: string;
  /** 子代理档案名（由 SubagentPort 解析成 profile；默认 general-purpose 带完整工具集）。 */
  agentType: string;
  /** 给用户看的短描述。 */
  description: string;
  /** 交给子代理的任务提示词。 */
  prompt: string;
  status: SwarmTaskStatus;
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
  callerCanReadOutputFile?: boolean;
}

export interface SwarmTaskCompletedResult {
  status: "completed";
  taskId: string;
  agentId: string;
  agentType: string;
  description: string;
  content: AgentTextContentBlock[];
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
  /**
   * 工作树清理失败（git worktree remove / 临时目录删除报错）。改动已成功回写，
   * 因此不把任务反标成失败；错误原文留在结果里，避免清理故障静默消失。
   */
  workspaceCleanupError?: string;
}

export interface SwarmTaskFailedResult {
  status: "failed";
  taskId: string;
  agentType: string;
  description: string;
  /** 原始错误消息，不吞异常。 */
  error: string;
  /** 原始错误对象（含 cause 链），供上层定位。 */
  cause?: unknown;
  totalDurationMs: number;
  /** 失败前已发生的真实模型 usage；只从错误对象读取，不估算。 */
  usage?: ModelUsage;
  totalTokens?: number;
}

export interface SwarmTaskCancelledResult {
  status: "cancelled";
  taskId: string;
  agentType: string;
  description: string;
  reason?: string;
  totalDurationMs: number;
  /** 取消前已发生的真实模型 usage；只从错误对象读取，不估算。 */
  usage?: ModelUsage;
  totalTokens?: number;
}

/** 单个子任务的终态结果；非 completed 都算未完成，不得当作执行证据。 */
export type SwarmTaskResult =
  | SwarmTaskCompletedResult
  | SwarmTaskFailedResult
  | SwarmTaskCancelledResult;

/** 一轮蜂群的执行作用域：追踪与取消信号在分解和所有子任务之间共享。 */
export interface SwarmExecutionScope {
  /** 本轮 trace context：子任务在其下派生 child trace。 */
  trace: TraceContext;
  /** Stop 信号：分解请求与全部子任务共用；abort 后 1+N 个在途请求立即取消。 */
  signal?: AbortSignal;
  /** 子任务子代理档案名；缺省 general-purpose（tools:["*"]，完整工具集）。 */
  agentType?: string;
}

/** 为一个 worker 建隔离工作树的输入。 */
export interface SwarmWorkspaceRequest {
  roundId: string;
  taskId: string;
  /** 调用方基准工作目录；工作树创建前用它定位 git 仓库。 */
  baseWorkingDirectory: string;
  /** 调用方基准 workspaceRoot；工作树内映射到同一相对位置。 */
  baseWorkspaceRoot: string;
}

/** 一个 worker 独占的隔离工作树；merge 是唯一的回写通道。 */
export interface SwarmWorkspace {
  /** 子代理实际 cwd（映射到工作树内与 baseWorkingDirectory 相同的相对位置）。 */
  readonly workingDirectory: string;
  /** 子代理实际 workspaceRoot（映射到工作树内与 baseWorkspaceRoot 相同的相对位置）。 */
  readonly workspaceRoot: string;
  /** 合并闸门：预检冲突后把本 worker 的 commit 合入基准工作树；冲突时抛错且不改基准。 */
  merge(): Promise<void>;
  /** 移除工作树与临时目录；失败原样上浮。 */
  dispose(): Promise<void>;
}

/** 隔离工作树的创建面；生产实现是 GitWorktreeSwarmWorkspaceFactory，测试可注入替身。 */
export interface SwarmWorkspaceFactory {
  create(request: SwarmWorkspaceRequest): Promise<SwarmWorkspace>;
}

export interface SwarmOrchestratorDeps {
  /** 会话模型：只用于目标分解。 */
  model: Model;
  /** 记账 runtime：每次蜂群模型调用后写 usage fact，纳入 token/时间预算。 */
  runtime: AgentRuntimeInternal;
  /** 真实子代理执行面（生产实现见 subagent/runner.ts）。 */
  subagentPort: SubagentPort;
  scope: SwarmExecutionScope;
  /** 隔离工作树工厂；缺省使用真实 git worktree。 */
  workspaceFactory?: SwarmWorkspaceFactory;
}

/** 合并闸门裁决：拒绝时 reason 进入取消原因与 round_completed.error。 */
export type SwarmMergeGateVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/** 一轮蜂群执行的聚合证据：子任务清单 + 部分/全部成功的产出与失败清单。 */
export interface SwarmRoundEvidence {
  output: string;
  taskDescriptions: readonly string[];
  completedTaskIds: readonly string[];
  failures: readonly SwarmAggregationFailure[];
  /** journal 落盘失败：结果与产出仍有效，仅供调用方显式暴露。 */
  journalWarnings?: readonly string[];
}

export interface SwarmAggregationFailure {
  taskId: string;
  reason: string;
}

/**
 * 一轮蜂群的预算记账槽：分解调用与全部终态 worker 的真实 token/墙钟开销。
 * 调用方（target 续跑）在 round 结束后原位读取并写入目标预算行；失败/取消回合也不丢
 * 已发生的调用（分解成功但 worker 全失败时仍记分解 token，失败 worker 错误上挂的
 * usage 同样计入）。
 */
export interface SwarmRoundUsage {
  /** 本轮全部模型调用（分解 + 全部终态 worker）的 token 合计。 */
  tokensUsed: number;
  /** 本轮墙钟耗时（分解 + 并行执行），毫秒。 */
  elapsedMs: number;
}

/** 崩溃恢复断点：按最近一轮 journal 重建的蜂群状态。 */
export interface SwarmRoundCheckpoint {
  roundId: string;
  objective: string;
  taskIds: readonly string[];
  taskDescriptions: readonly string[];
  /** 按 taskId 去重后的 worker 终态；崩溃时未完成的 worker 不在其中。 */
  results: readonly SwarmJournalTaskResult[];
  /** 是否见到 round_completed；false = 上一轮在途/中断。 */
  completed: boolean;
  completedTaskIds: readonly string[];
  failedTaskIds: readonly string[];
  output?: string;
}

/** runGoalRound 的可选输入；nextAction 来自完成 verifier 的未完成结论。 */
export interface SwarmRoundOptions {
  nextAction?: string;
  /** 显式 roundId（测试/恢复用）；缺省每次调用生成唯一值，parentToolCallId 不再跨轮碰撞。 */
  roundId?: string;
  /** 预算记账槽：编排层把真实调用开销累加到这里；缺省不记账但仍返回证据。 */
  usage?: SwarmRoundUsage;
  /**
   * 合并闸门前置：每一次 workspace.merge() 之前都会调用；中途拒绝时已合并的前序
   * 结果保留，剩余 completed 结果按取消收口、工作树清理并抛 SwarmRoundSupersededError。
   */
  mergeGate?: () => Promise<SwarmMergeGateVerdict>;
  /** @internal runGoalRoundInner 注入的中断断点，用于避免重复已完成子任务。 */
  resumeCheckpoint?: SwarmRoundCheckpoint;
  /** @internal 本轮 journal 状态；标记 round_started 已落盘并承载 journal 警告。 */
  journalState?: SwarmRoundJournalState;
}

/** 一轮 journal 的局部状态；只在本轮内共享，防止 round_completed 重复写。 */
export interface SwarmRoundJournalState {
  /** round_started 已成功落盘；失败收口只在有起点时才补 round_completed。 */
  roundStartedWritten: boolean;
  roundCompletedWritten: boolean;
  journalWarnings: string[];
}

/** 合并闸门拒绝（或基准树不清洁）时的轮级收口错误；本轮产出零回写。 */
export class SwarmRoundSupersededError extends Error {
  readonly code = "swarm_round_superseded";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SwarmRoundSupersededError";
  }
}

/** runSwarm 的可选输入；roundId 用于 worker journal，缺省自动生成。 */
export interface SwarmRunOptions {
  roundId?: string;
  /** 合并闸门；runGoalRound 从 SwarmRoundOptions 透传。 */
  mergeGate?: () => Promise<SwarmMergeGateVerdict>;
  /** @internal 由 runGoalRoundInner 注入，保证本轮 round_completed 恰好写一次。 */
  journalState?: SwarmRoundJournalState;
  /** @internal 预算槽；闸门拒绝的零回写轮也要计入已完成 worker 的真实 token。 */
  usage?: SwarmRoundUsage;
}

/** 已建/建树失败的任务条目；finalize 按输入顺序消费。 */
export interface PreparedSwarmTask {
  task: SwarmTask;
  workspace?: SwarmWorkspace;
  workspaceError?: { error: unknown; durationMs: number };
}

/** 进程内单调序号；与 pid + 时间戳组合，同一毫秒内的多轮也不会重复。 */
let swarmRoundSequence = 0;

/** 生成一轮蜂群的唯一 id；tool call id 与 journal 都以它为命名空间。 */
export function createSwarmRoundId(): string {
  swarmRoundSequence += 1;
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${swarmRoundSequence.toString(36)}`;
}
