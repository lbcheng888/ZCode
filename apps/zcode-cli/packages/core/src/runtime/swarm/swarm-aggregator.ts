/**
 * Swarm 子任务结果聚合：把多个子任务结果合并为部分成功产出 + 失败清单。
 *
 * 语义（确定性、无降级）：
 * - 全部 completed：按传入顺序拼接各子任务交付正文，以空行（"\n\n"）分隔。
 * - 部分完成：返回已完成产出与每个未完成任务的失败原因；单个 worker 的瞬时
 *   provider 错误不再让整批结果蒸发，长程 goal 可以带着部分证据继续下一轮。
 * - 全部未完成（failed / cancelled / 空文本）：抛出错误，信息原样带上每个未完成
 *   子任务的 taskId 与原因——这是调用方 pause 目标（或按取消收口）的信号，不静默
 *   跳过、不把模型自述当证据。全部为 cancelled 时抛 SwarmRoundCancelledError。
 * - 空输入返回空聚合（没有任务就没有失败，由编排层的批次校验拒绝空批次）。
 * - SwarmTaskResult 统一在 swarm-types.ts 定义，这里只消费，不另立同名类型。
 */

import type { SwarmAggregationFailure, SwarmTaskResult } from "./swarm-types.js";

/** 整轮因取消而没有产出：调用方按取消语义收口，不当作执行失败。 */
export class SwarmRoundCancelledError extends Error {
  readonly code = "swarm_round_cancelled";

  constructor(message: string) {
    super(message);
    this.name = "SwarmRoundCancelledError";
  }
}

/** 聚合结果：可进入回合提示的部分成功产出 + 失败清单。 */
export interface SwarmAggregation {
  output: string;
  completedTaskIds: readonly string[];
  failures: readonly SwarmAggregationFailure[];
}

export class SwarmAggregator {
  async aggregate(results: readonly SwarmTaskResult[]): Promise<SwarmAggregation> {
    const outputs: string[] = [];
    const completedTaskIds: string[] = [];
    const failures: SwarmAggregationFailure[] = [];
    for (const result of results) {
      switch (result.status) {
        case "completed": {
          // 与编排层的交付正文同口径：文本块按空行拼接并去空白；空正文不是执行证据。
          const output = result.content
            .map((block) => block.text)
            .join("\n\n")
            .trim();
          if (output) {
            outputs.push(output);
            completedTaskIds.push(result.taskId);
          } else {
            failures.push({ taskId: result.taskId, reason: "produced no text output" });
          }
          break;
        }
        case "failed":
          failures.push({ taskId: result.taskId, reason: result.error });
          break;
        case "cancelled":
          failures.push({
            taskId: result.taskId,
            reason: `cancelled${result.reason === undefined ? "" : ` (${result.reason})`}`,
          });
          break;
      }
    }
    if (outputs.length === 0 && failures.length > 0) {
      const detail = failures.map((failure) => `${failure.taskId}: ${failure.reason}`).join("\n");
      const onlyCancelled = results.every((result) => result.status === "cancelled");
      if (onlyCancelled) {
        // 全部任务是取消（不是失败）时按取消语义抛错：调用方据此停止而不 pause 目标。
        throw new SwarmRoundCancelledError(
          `Swarm round cancelled before any task delivered output:\n${detail}`,
        );
      }
      // M7：整批失败是 pause 目标的唯一信号；把各 worker 的原始错误对象挂到
      // cause 链上，调用方展开后不会只剩聚合层拼出来的字符串。
      const causes = results.flatMap((result) =>
        result.status === "failed" && result.cause !== undefined ? [result.cause] : [],
      );
      throw new Error(`Swarm aggregation failed for all ${failures.length} task(s):\n${detail}`, {
        cause: causes.length === 0 ? undefined : causes.length === 1 ? causes[0] : causes,
      });
    }
    return {
      output: outputs.join("\n\n"),
      completedTaskIds,
      failures,
    };
  }
}
