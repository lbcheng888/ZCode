/**
 * 蜂群回合证据的格式化与输出预算。
 *
 * 子代理产出、任务描述与失败原因都来自模型/子进程，进 goal 提示前统一
 * escapeGoalPromptText，防止 worker 正文里的伪标签改写回合结构。
 */

import { escapeGoalPromptText } from "@zcode/contracts";

import type {
  SwarmRoundEvidence,
  SwarmTaskCompletedResult,
} from "./swarm-types.js";

/** 每份 worker 输出进入聚合前的字符上限：2-5 份拼接不得顶爆回合上下文。 */
export const SWARM_WORKER_OUTPUT_MAX_CHARS = 2_000;
const SWARM_OUTPUT_TRUNCATION_MARKER = "\n[truncated]";

/** 完成结果的交付正文；聚合与空文本判定共用同一口径。 */
export function swarmTaskCompletedText(result: SwarmTaskCompletedResult): string {
  return result.content
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/** 单份 worker 输出的上下文预算：超限截断并留显式标记，不静默丢尾部。 */
export function truncateSwarmWorkerOutput(output: string): string {
  return truncateTo(output, SWARM_WORKER_OUTPUT_MAX_CHARS);
}

export function truncateTo(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  return (
    output.slice(0, maxChars - SWARM_OUTPUT_TRUNCATION_MARKER.length) +
    SWARM_OUTPUT_TRUNCATION_MARKER
  );
}

/**
 * 把一轮蜂群证据格式化成 goal 回合提示片段（完成 verifier 下一轮判分依据）。
 * 子代理产出、任务描述与失败原因都来自模型/子进程，进提示前统一
 * escapeGoalPromptText，防止 worker 正文里的伪标签改写回合结构。
 */
export function formatSwarmRoundEvidence(evidence: SwarmRoundEvidence): string {
  const total = evidence.taskDescriptions.length;
  const completed = evidence.completedTaskIds.length;
  const lines = [
    "<goal_swarm_round>",
    `The swarm decomposed this round's objective into ${total} parallel subtasks:`,
    ...evidence.taskDescriptions.map(
      (description, index) => `${index + 1}. ${escapeGoalPromptText(description)}`,
    ),
  ];
  if (evidence.failures.length === 0) {
    lines.push(
      "Every subtask completed and SwarmAggregator combined the deliverables below. Treat it as this round's execution evidence; the completion verifier will judge it against the objective.",
    );
  } else {
    lines.push(
      `${completed} of ${total} subtasks completed; their deliverables are below. The failed subtasks are listed with their original errors and are NOT execution evidence:`,
      ...evidence.failures.map(
        (failure) => `- ${escapeGoalPromptText(failure.taskId)}: ${escapeGoalPromptText(failure.reason)}`,
      ),
    );
  }
  if (evidence.journalWarnings !== undefined && evidence.journalWarnings.length > 0) {
    // journal 落盘失败不改变产出有效性；显式告警，避免恢复面缺事件却无人知晓。
    lines.push(
      "Journal warnings (the round's results and deliverables remain valid, but these entries could not be persisted):",
      ...evidence.journalWarnings.map((warning) => `- ${escapeGoalPromptText(warning)}`),
    );
  }
  lines.push("", escapeGoalPromptText(evidence.output), "</goal_swarm_round>");
  return lines.join("\n");
}

