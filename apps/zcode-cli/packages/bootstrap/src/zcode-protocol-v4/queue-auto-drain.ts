/**
 * 普通 queue 的唯一自动提升闸门。
 *
 * 裁定 b（2026-10-25 常驻闭环验收，设计文档 §4.2 裁定 2 增补）：排队的用户输入
 * 必须先于 idle 驱动器的下一回合执行。旧闸门用 targetStatus ∈ {null, complete}
 * 把普通 queue 压在整个目标后面（验收复现：active 目标三轮驱动器回合先跑，用户
 * 消息等 complete 后才提升）；驱动器侧已在空闲沿对非空用户队列让位后，这里的
 * targetStatus 条件不再承担排队顺序——提升资格只看机器空闲与队列自身状态，
 * active/paused/budget_limited 目标期间的用户排队输入按 FIFO 先行，目标在用户
 * 回合排空后的下一空闲沿继续。verifier 在途仍由 sessionBusy（前台执行）挡住，
 * goal 终局判定不受本闸门影响。
 */
export function shouldAutoDrainV4QueueHead(input: {
  autoDrain: boolean;
  dispatchState: "queued" | "reserved" | "promoting";
  sessionBusy: boolean;
}): boolean {
  return input.autoDrain && input.dispatchState === "queued" && !input.sessionBusy;
}
