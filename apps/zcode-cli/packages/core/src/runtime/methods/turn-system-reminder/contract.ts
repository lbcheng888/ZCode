/**
 * cli-turn-system-reminder 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */
import type { TurnId } from "../../deps.js";

/** 入队一条回合级隐藏提醒的全部参数。 */
export interface QueueTurnSystemReminderInput {
  /** 生效回合：drain 时按 turnId 精确匹配，不匹配（回合已结束）即丢弃。 */
  turnId: TurnId;
  /**
   * system-reminder 源，必须是已注册且声明 per-request 生命周期的源
   * （SYSTEM_REMINDER_PER_REQUEST_SOURCES）；未知或持久源在入队时抛错。
   */
  source: string;
  /** 提醒正文；空正文在入队时抛错（wrapSystemReminder 会炸掉整个模型请求）。 */
  body: string;
}
