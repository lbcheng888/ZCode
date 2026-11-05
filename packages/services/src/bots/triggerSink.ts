/**
 * TriggerSink 窄 port（spec super-agent-trigger-subsystem-spec §2.2）。
 *
 * packages/services 不依赖 @zcode/bootstrap：本文件只定义信封与摄取端口，实现由
 * daemon 组合根（§7-7）注入——灰度开（features.eventRouter + BotConfig.eventRouterEnabled）
 * 时注入 super-agent-intake 适配器；灰度关/全局 kill-switch 注入 {@link noopTriggerSink}
 * = legacy 直路（被裁决的生产回退路径，不是测试替身）。
 *
 * 信封形状与 bootstrap `super-agent-intake` 的 TriggerEnvelope 对齐（结构类型对表）；
 * taint 由本侧可信出口铸造，intake 对非 true 抛错。
 */

/** P2 trigger 枚举（§5.2）；git/file 仅类型预留。 */
export type TriggerSinkSource = "im" | "webhook" | "schedule" | "ci";

export type TriggerSinkActorKind = "human" | "bot" | "system";

export interface TriggerSinkActor {
  kind: TriggerSinkActorKind;
  /** providerUserId / botId / scheduler。 */
  id?: string;
}

export interface TriggerSinkEnvelope {
  workspaceIdentity: string;
  source: TriggerSinkSource;
  provider: string;
  providerMessageId?: string;
  /** P2 信道域键：`bot:<botId>+<peer>[/<threadId>]`（群 peer=chatId，私聊 peer=providerUserId）。 */
  threadKeyHint?: string;
  actor: TriggerSinkActor;
  /** 出口规范化的摘要载荷（凭据零字节）；键约定见 intake CONTRACT.md。 */
  payload: Record<string, unknown>;
  /** supervisor 铸造标记：本侧出口恒写 true，客户端路径不经过本文件。 */
  taint: true;
}

export type TriggerSinkRoute = "owned" | "human_explicit" | "unowned_candidate" | "rejected";

/**
 * §3.4 owned 投递结果（additive）：routed=host.command 已受理；
 * delivery_failed=host 拒绝/未受理，trigger_events.final_disposition 保持 NULL，
 * 启动重放扫描会重试；两种都仍返回 handled=true 防止 legacy 双跑。
 */
export type TriggerSinkDeliveryState = "routed" | "delivery_failed";

/**
 * 摄取结果二分：
 * - handled=false：sink 未接管（no-op 直通 = kill-switch），调用方继续 legacy 直路；
 * - handled=true：事件已归新链路（含幂等短路与 rejected 终态），调用方必须跳过
 *   legacy 直路，避免同一条消息双跑（路由动作由组合根注入的实现侧负责）。
 */
export type TriggerSinkOutcome =
  | {
      handled: true;
      triggerId: string;
      route: TriggerSinkRoute;
      delivery?: TriggerSinkDeliveryState;
    }
  | { handled: false };

export interface TriggerSink {
  /**
   * 摄取一条已规范化的入站信封。
   * 前置：信封由可信出口铸造（taint=true、凭据零字节）；markInboundDelivery 快速去重已做过。
   * 幂等：同 providerMessageId 重投返回同一 triggerId（DB unique 权威）。
   * 实现抛错时调用方应释放快速去重占位并把错误原样上浮（可重试）。
   */
  ingest(envelope: TriggerSinkEnvelope): Promise<TriggerSinkOutcome>;
}

/**
 * kill-switch 缺省适配器（spec §5.4：features.eventRouter=false = TriggerSink 注入 no-op
 * 直通 = legacy 直路）。恒 handled=false，不落 trigger_events、不做任何 I/O。
 */
export const noopTriggerSink: TriggerSink = {
  async ingest(): Promise<TriggerSinkOutcome> {
    return { handled: false };
  },
};

/**
 * P2 信道域键铸造（与 bootstrap intake `mintBotThreadDomainKey` 逐字节同格式；
 * 本包不能 import bootstrap，故在此复制格式——两处改动必须同步，格式合同见 intake CONTRACT.md）。
 * peer 槽与 resolveAutomationBotDeliveryTarget 的 providerUserId 语义一致：群=chatId，私聊=providerUserId。
 */
export function buildBotTriggerThreadKeyHint(actor: {
  botId: string;
  providerUserId: string;
  chatId?: string;
  threadId?: string;
}): string {
  const peer = actor.chatId?.trim() || actor.providerUserId.trim();
  const base = `bot:${actor.botId}+${peer}`;
  const threadId = actor.threadId?.trim();
  return threadId ? `${base}/${threadId}` : base;
}
