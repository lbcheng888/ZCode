/**
 * cli-turn-system-reminder 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { TurnId } from "../../deps.js";
import type { AgentRuntimeInternal } from "../../internal.js";
import type { RegularTurnLoopState } from "../turn-loop-state.js";
import { drainQueuedTurnSystemReminders, queueTurnSystemReminder } from "./index.js";

export function exampleTurnSystemReminder(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  workerTurnId: TurnId,
): void {
  // 场景：super-agent 等回合并发车道想把一条一次性指导送进 worker 的下一次模型请求。
  // 入队即忘；不等待、无回执。turn 结束未被消费的条目按丢弃语义清除。
  queueTurnSystemReminder.call(runtime, {
    turnId: workerTurnId,
    source: "best_plan_super_agent",
    body: "<best_plan_guidance>...</best_plan_guidance>",
  });

  // 回合循环每次迭代、compaction 之后、请求投影之前消费一次（methods/turn-loop.ts）。
  drainQueuedTurnSystemReminders(runtime, state);
}
