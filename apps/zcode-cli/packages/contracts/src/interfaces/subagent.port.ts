// ============================================================
// Subagent Port - child agent execution boundary
// ============================================================

import type { AgentProfile } from "@zcode/shared";
import type { AgentBackgroundedOutput, AgentOutput } from "../tools/agent.js";
import type { Model, ModelSelection, ModelUsage } from "../model/index.js";
import type { ModelRequestDependencies } from "../model/invocation-context.js";
import type { ExecutionPort } from "./execution.port.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export interface SubagentRunRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  agentType: string;
  description: string;
  prompt: string;
  callerCanReadOutputFile?: boolean;
  workingDirectory: string;
  workspaceRoot: string;
  /**
   * swarm worker 的强制工作区边界（绝对路径，隔离工作树映射后的根）。在场时 child runtime
   * 的文件工具与显式 cwd 被限制在该目录内；非 swarm 请求不设。
   */
  workspaceBoundary?: string;
  /**
   * 文件域 lane 的写白名单（绝对路径）。只在写工具（Write/Edit/ApplyPatch）上生效：
   * path-policy 拒绝白名单外的目标；读、glob、grep 不受限。Bash 命令字符串不解析，
   * 不在本字段的强制范围内。
   */
  allowedWritePaths?: readonly string[];
  trace: TraceContext;
}

export interface SubagentRunOptions {
  signal?: AbortSignal;
  /** 未显式选模的 child 从父 Agent Loop 继承的不可变 Model。 */
  model?: Model;
  /** Core Server 对前台 child 的最高优先级 Selection；每个 child 仍自行创建 Model。 */
  modelOverride?: {
    selection: ModelSelection;
    requestDependencies?: ModelRequestDependencies;
    background: "deny" | "allow";
  };
  /**
   * 程序化启动的显式档案覆盖（spec lane 等宿主路径）：name 必须与 request.agentType
   * 一致；缺省从 runtime 的 agent registry 解析。Agent 工具路径不传，字节不变。
   */
  profile?: AgentProfile;
  /**
   * 本次 run 的执行端口覆盖（spec lane 无凭据 env + egress network）。缺省继承父
   * runtime 的执行端口；子 runtime 的 Bash 等子进程 I/O 在本次 run 内走覆盖端口。
   */
  executionPort?: ExecutionPort;
  /**
   * 程序化 spec run 的写租约 owner id（triggerId）。仅 spec lane 传；手动会话/subagent
   * 不传。写工具 admission 用它与 active lease owner 精确匹配，避免把 spec child 自己
   * 的写当成第二写者。
   */
  writeLeaseOwnerRunId?: string;
}

export interface SubagentLaunchRequest extends SubagentRunRequest {
  runInBackground?: boolean;
}

export type SubagentLaunchOptions = SubagentRunOptions;

export type SubagentStartRequest = SubagentRunRequest;

export type SubagentStartOptions = SubagentRunOptions;

export interface SubagentWaitOptions {
  signal?: AbortSignal;
}

/**
 * 失败子代理已持久化的模型用量事实：失败请求的 provider usage 与汇总 token。
 * 由宿主从原 error（或其 cause 链）读取，用于失败卡片展示真实消耗。
 */
export interface SubagentFailedUsage {
  usage?: ModelUsage;
  totalTokens?: number;
}

export interface SubagentStopOptions {
  /**
   * 谁在停：TaskStop 传 "model"，App 停止传 "user"，系统路径（rewind、闲时任务收尾）不传。
   * 后台 agent 的 killed 通知据此写 "was stopped by ZCode" / "by user" / "was stopped"。
   */
  initiator?: "user" | "model";
  signal?: AbortSignal;
}

export interface SubagentSendMessageRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  to: string;
  /** 可选：只用于 UI 预览，缺省时用 message 的第一行；交付给 child 的只有 message。 */
  summary?: string;
  message: string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

export type SubagentSendMessageOptions = SubagentRunOptions;

export type SubagentSendMessageDelivery = "queued" | "steered" | "resumed_background";

export interface SubagentSendMessageResult {
  status: "success" | "failed";
  messageId: string;
  delivery?: SubagentSendMessageDelivery;
  message?: string;
  error?: string;
  agentId?: string;
  taskId?: string;
  outputFile?: string;
}

export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "stopped"
  | "lost";

/**
 * 子代理任务终态的用量快照：耗时、模型 usage 明细、工具调用数与汇总 token。
 * runner 只在拿到真实事实时写对应字段；终态消费方（SwarmWorker 预算、通知卡片）
 * 统一从这里读取，不再把整块 snapshot.usage 当成 ModelUsage。
 */
export interface SubagentTaskUsageSnapshot {
  durationMs?: number;
  modelUsage?: ModelUsage;
  toolUseCount?: number;
  totalTokens?: number;
}

export interface SubagentTaskSnapshot {
  taskId: string;
  agentId: string;
  agentType: string;
  description: string;
  status: SubagentTaskStatus;
  startedAt: Date;
  completedAt?: Date;
  childSessionId?: SessionId;
  parentToolCallId?: ToolCallId | string;
  pid?: number;
  error?: string;
  output?: AgentOutput;
  outputFile?: string;
  /**
   * 任务终态用量：completed/stopped 由 runner 写入耗时等事实，失败路径从原 error
   * （或其 cause 链）提取已发生的模型用量；没有真实数据时只写 durationMs，不估算。
   */
  usage?: SubagentTaskUsageSnapshot;
  notified?: boolean;
}

export interface SubagentPort {
  /** 关闭准入，取消所属执行并等待真实执行和资源清理；不删除历史。 */
  close?(): Promise<void>;
  launch(request: SubagentLaunchRequest, options?: SubagentLaunchOptions): Promise<AgentOutput>;
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  start?(
    request: SubagentStartRequest,
    options?: SubagentStartOptions,
  ): Promise<AgentBackgroundedOutput>;
  backgroundTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  getTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: SubagentWaitOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  stopTask?(
    taskId: string,
    options?: SubagentStopOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  sendMessage?(
    request: SubagentSendMessageRequest,
    options?: SubagentSendMessageOptions,
  ): Promise<SubagentSendMessageResult>;
}
