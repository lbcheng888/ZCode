import type { SessionGoal } from "@zcode/contracts";

import type {
  GoalStateSnapshot,
  GoalStateSource,
} from "../super-agent/watchdog/index.js";

/**
 * watchdog 升级信道的生产 goal 控制面：readAsync 从 sessionStore 现读当前 target，
 * pauseGoal 暂停目标并中止在途前台执行。终态只由 target 状态机写；命令面不写 registry。
 */
export interface WatchdogGoalControlDeps {
  readTarget(): Promise<SessionGoal | null>;
  pauseTarget(input: { status: "paused"; reason: string }): Promise<SessionGoal | null>;
  stopActiveForegroundExecution(): void;
  recordTargetChanged(input: { previousTarget: SessionGoal; target: SessionGoal }): Promise<void>;
}

export interface WatchdogGoalControl {
  readonly goalState: GoalStateSource;
  pauseGoal(goalId: string): Promise<boolean>;
}

export function createWatchdogGoalControl(
  deps: WatchdogGoalControlDeps,
): WatchdogGoalControl {
  let cached: GoalStateSnapshot | undefined;
  const readTarget = async (): Promise<SessionGoal | null> => {
    const target = await deps.readTarget();
    cached =
      target === null
        ? undefined
        : {
            goalId: target.targetID,
            status: target.status === "complete" ? "completed" : target.status,
            // 本切片没有 open-question 数据源；budget-limited 探针保持不造数。
            openQuestionCount: 0,
          };
    return target;
  };

  return {
    goalState: {
      read: () => cached,
      readAsync: async () => {
        await readTarget();
        return cached;
      },
    },
    async pauseGoal(goalId) {
      const target = await readTarget();
      if (target === null || target.targetID !== goalId) return false;
      if (target.status === "paused") return true;
      if (target.status !== "active") return false;
      const paused = await deps.pauseTarget({
        status: "paused",
        reason: "watchdog-escalation",
      });
      if (
        paused === null ||
        paused.targetID !== goalId ||
        paused.status !== "paused"
      ) {
        return false;
      }
      // 与 v4 pauseGoal 同语义：先暂停目标，再中止在途前台执行。
      deps.stopActiveForegroundExecution();
      await deps.recordTargetChanged({ previousTarget: target, target: paused });
      return true;
    },
  };
}
