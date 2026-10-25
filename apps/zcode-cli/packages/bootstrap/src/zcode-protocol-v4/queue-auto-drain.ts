import type { GoalStatus } from "@zcode/contracts";

/**
 * 普通 queue 的唯一自动提升闸门。
 *
 * 开旗（goalLayerEnabled）：排队的用户输入必须先于 idle 驱动器的下一回合执行，目标状态
 * 不参与排队顺序——调用方为此传 null。active/paused/budget_limited 目标期间的用户排队输入
 * 按 FIFO 先行，目标在用户回合排空后的下一空闲沿继续；verifier 在途仍由 sessionBusy
 * （前台执行）挡住，goal 终局判定不受本闸门影响。
 *
 * 关旗：恢复旧条件 targetStatus ∈ {null, complete}，把普通 queue 压在整个目标后面；
 * 调用方必须读真实目标状态并在读失败时继续 hold。
 */
export function shouldAutoDrainV4QueueHead(input: {
  autoDrain: boolean;
  dispatchState: "queued" | "reserved" | "promoting";
  sessionBusy: boolean;
  targetStatus: GoalStatus | null;
}): boolean {
  return (
    input.autoDrain &&
    input.dispatchState === "queued" &&
    !input.sessionBusy &&
    (input.targetStatus === null || input.targetStatus === "complete")
  );
}
