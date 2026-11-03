/**
 * super-agent-intake 对外契约（spec super-agent-trigger-subsystem-spec §2.1 / §3.1）。
 * 调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * ingest 是唯一对外命令：落 trigger_events 行 + Fast Path 确定性准入 → 返回三边路由。
 * 路由动作（EventRouter.routeOwned / dispatchHumanExplicit / notifyCandidate）归
 * super-agent-trigger，本模块只做路由决策，不派发（§3.1）。
 */
import type { DatabaseSync } from "node:sqlite";

/** P2 trigger 枚举（§5.2）：git/file 仅类型预留，不产生行。 */
export type TriggerSource = "im" | "webhook" | "schedule" | "ci";

export type TriggerActorKind = "human" | "bot" | "system";

export interface TriggerEnvelopeActor {
  kind: TriggerActorKind;
  /** providerUserId / botId / scheduler。 */
  id?: string;
}

/**
 * 归一化入站信封：由出口规范化适配器（botsService processProviderCallback）铸造，
 * taint 恒为 true——客户端不可伪造（§5）。intake 对 taint !== true 直接抛错，不吞。
 */
export interface TriggerEnvelope {
  /** 身份 key（`workspaceIdentity?.trim() || workspacePath`；未绑定会话可为空串）。 */
  workspaceIdentity: string;
  source: TriggerSource;
  provider: string;
  providerMessageId?: string;
  /**
   * P2 信道域键提示：`bot:<botId>+<peer>`（群 peer=chatId，私聊 peer=providerUserId，
   * 与 botDeliveryTarget.providerUserId 槽同语义），话题追加 `/<threadId>`。
   * 缺省时 intake 按 payload.botId/payload.chatId/actor.id 同规则铸造；两者都拿不到
   * → 按 unscoped 拒绝（rejected，审计行 thread_key 落 `<ws>|unscoped`）。
   */
  threadKeyHint?: string;
  actor: TriggerEnvelopeActor;
  /**
   * 出口规范化的摘要载荷（凭据零字节）。im/webhook 事件约定键：
   * `botId` / `chatType`("private"|"group") / `chatId?` / `threadId?` /
   * `mentionedBot`(boolean) / `groupCardAction`(boolean) / `elicitation`(boolean) /
   * `senderType`("user"|"app") / `commandText?` / `text`。
   * intake 摘要化为 JSON 落 trigger_events.payload（≤64KB，超限截断），sha256 入 payload_digest。
   */
  payload: Record<string, unknown>;
  /** supervisor 铸造标记（M2/§5）：永不构成指令权威。 */
  taint: true;
}

/** Fast Path 三态（= trigger_events.fast_path 列值）；rejected 不落 fast_path（NULL=未路由/被拒）。 */
export type FastPathDisposition = "owned" | "human_explicit" | "unowned_candidate";

/** ingest 结果：路由决策本身；route 动作由 super-agent-trigger 按此执行（§3.1）。 */
export type IngestRoute = FastPathDisposition | "rejected";

export interface IngestResult {
  triggerId: string;
  route: IngestRoute;
}

/**
 * decision_log 端口（结构类型；生产注入 super-agent-decision-log 的 record）。
 * Intake 只写 fast_path origin 行：owned/explicit 记 routed、快路径拒绝记 reject、
 * candidate 记 record_only（§3.1）；幂等短路不重复落行（T6）。
 */
export interface IntakeDecisionLogPort {
  record(entry: {
    workspaceIdentity: string;
    triggerId: string;
    origin: "fast_path";
    disposition: "routed" | "reject" | "record_only";
    reason?: string | null;
    createdAt?: number;
  }): void;
}

/**
 * bot 互答守卫端口（admitAutoReplyTurn 语义复用，§3.1 Fast Path 第四项）。
 * 生产由组合根注入 botsService 的 admitAutoReplyTurn 包装：非守卫适用面（私聊、
 * 卡片回调、elicitation、非 IM 来源）必须原样返回 true；占额语义与原守卫一致
 * （占额后即使后续失败不回滚）。返回 false = 快路径拒绝（route=rejected）。
 */
export interface AutoReplyGuardPort {
  admit(envelope: TriggerEnvelope): Promise<boolean>;
}

/**
 * daemon 域库句柄：与 super-agent-storage 的 SuperAgentDatabaseHandle 同一 node:sqlite
 * 类型（结构类型即端口；不 import storage 模块，requires 保持 []）。
 */
export type IntakeDatabaseHandle = DatabaseSync;

export interface SuperAgentIntakeContract {
  /**
   * 落 trigger_events 行 + Fast Path 确定性准入 → 三边路由决策。
   * 前置：信封已由可信出口铸造（taint=true）；providerMessageId 幂等键成员可空。
   * 后置：trigger_events 行已写且 fast_path / rejected 终态列与 decision_log
   * fast_path origin 行**同事务原子提交**（任一步失败整体回滚，重投按行状态重算补写，
   * 恰好一行 decision）；幂等短路（行已收敛）不重复落 decision 行。
   * 事务前提：decisionLog 端口与 db 为同一库句柄（组合根注入同一 openSuperAgentDatabase）。
   * 幂等性：同 (provider, providerMessageId) 重投返回已收敛 triggerId 与原 route，零新增行
   * （DB partial unique index 权威；进程内 Map 只是快速守卫，裁定 3）。
   * 失败：taint 非 true 抛错；DB 约束冲突原样上浮。不发事件、不等待其它持久化。
   */
  ingest(envelope: TriggerEnvelope): Promise<IngestResult>;
}

export interface CreateSuperAgentIntakeOptions {
  db: IntakeDatabaseHandle;
  decisionLog: IntakeDecisionLogPort;
  autoReplyGuard: AutoReplyGuardPort;
  /** 注入时钟（测试/回放）；缺省 Date.now。 */
  now?: () => number;
}
