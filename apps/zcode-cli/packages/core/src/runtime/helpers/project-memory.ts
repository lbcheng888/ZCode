import type { AgentRuntimeConfig } from "../types.js";
import { resolveProjectMemoryRoot } from "../../memory/project-root.js";

export function resolveEnabledProjectMemoryRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  const memory = config.memory;
  if (!memory?.enabled || memory.use === false || !memory.cliStorageRoot) return undefined;
  if (!isMainAgentTaskType(config.taskType)) return undefined;

  return resolveProjectMemoryRoot({
    cliStorageRoot: memory.cliStorageRoot,
    workspaceIdentity: memory.workspaceIdentity,
    workspacePath,
  });
}

/**
 * 会话主 agent 的任务类型：interactive / fork / selection_side_chat / workflow_parent。
 * fork 与 selection side chat 虽然带 parentSessionId（session-fork 的父子事实），仍是用户可
 * 直接交互、拥有独立 todo 与 memory 的主会话；只有子代理/workflow 子会话（subagent_child /
 * workflow_child / nested_workflow_child）不是主 agent。project memory 与 todo reminder 共用
 * 这一分类，避免两处各自维护 child 类型清单后漂移。
 */
export function isMainAgentTaskType(taskType: AgentRuntimeConfig["taskType"]): boolean {
  return (
    taskType === undefined ||
    taskType === "interactive" ||
    taskType === "fork" ||
    taskType === "selection_side_chat" ||
    taskType === "workflow_parent"
  );
}
