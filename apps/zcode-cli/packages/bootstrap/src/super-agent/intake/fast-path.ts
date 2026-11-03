/**
 * Fast Path 确定性准入表（spec §3.1 第 2 步）：来源白名单 → 线程域键（群范围）→
 * 订阅命中过守卫 → owned；无订阅 observed 直接拒（不进守卫）；无订阅 addressed
 * 过守卫 → human_explicit / unowned_candidate。纯函数 + 只读订阅查询；不写库、不发事件。
 *
 * 三边规则（M2）：
 * - 命中 active 订阅 → 过守卫后 owned（订阅者要本 thread 的事件，与是否被 @ 无关）；
 * - 未命中且 observed（未 addressed）→ rejected，不调守卫（与 legacy 在
 *   admitAutoReplyTurn 之前丢弃群内旁听对齐，见 botsService 出口）；
 * - 未命中且 addressed 且 actor=人 → 过守卫后 human_explicit（免 Mandate、免攒批）；
 * - 未命中且 addressed 且非人（environment-triggered explicit）→ 过守卫后 unowned_candidate。
 */
import type {
  FastPathDisposition,
  IntakeDatabaseHandle,
  TriggerEnvelope,
  TriggerSource,
} from "./contract.js";

/** P2 intake 来源白名单：schedule 由 scheduler 直落审计行不经 intake（§5.2）；git/file 仅预留。 */
const INTAKE_SOURCE_WHITELIST: ReadonlySet<TriggerSource> = new Set<TriggerSource>([
  "im",
  "webhook",
  "ci",
]);

export type FastPathRejectionReason =
  | "source-not-in-whitelist"
  | "auto-reply-guard"
  | "unscoped-thread"
  | "observed-not-addressed";

export type FastPathEvaluation =
  | { outcome: "route"; route: FastPathDisposition }
  | { outcome: "reject"; reason: FastPathRejectionReason };

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readPayloadBoolean(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

/**
 * P2 信道域键（M2 归一规则的 P2 档）：`bot:<botId>+<peer>`，话题追加 `/<threadId>`。
 * peer 槽与 botDeliveryTarget.providerUserId 同语义：群=chatId，私聊=providerUserId——
 * 出口（services triggerSink）与回填（backfill.ts）必须走同一格式，否则回填订阅匹配不上。
 */
export function mintBotThreadDomainKey(input: {
  botId: string;
  peerId: string;
  threadId?: string;
}): string {
  const base = `bot:${input.botId}+${input.peerId}`;
  const threadId = input.threadId?.trim();
  return threadId ? `${base}/${threadId}` : base;
}

/** thread_key 列格式：`<workspaceIdentity>|<域键>`（§1.2：workspaceIdentity + 域键）。 */
export function mintThreadKey(workspaceIdentity: string, domainKey: string): string {
  return `${workspaceIdentity}|${domainKey}`;
}

/** 无域键可用时的审计占位（仅 rejected 行使用；幂等仍由 provider_message_id 保证）。 */
export const UNSCOPED_THREAD_DOMAIN_KEY = "unscoped";

/** 从信封铸造域键；拿不到 botId/peer 时返回 undefined（调用方按 unscoped 拒绝）。 */
export function mintDomainKeyFromEnvelope(envelope: TriggerEnvelope): string | undefined {
  const hint = envelope.threadKeyHint?.trim();
  if (hint) return hint;
  const botId = readPayloadString(envelope.payload, "botId");
  const peer =
    readPayloadString(envelope.payload, "chatId") ??
    (envelope.actor.id?.trim() ? envelope.actor.id.trim() : undefined);
  if (!botId || !peer) return undefined;
  return mintBotThreadDomainKey({
    botId,
    peerId: peer,
    threadId: readPayloadString(envelope.payload, "threadId"),
  });
}

/** addressed-vs-observed（§3.1）：私聊恒 addressed；群内需 @、卡片交互或 elicitation。 */
export function isAddressedEnvelope(envelope: TriggerEnvelope): boolean {
  const chatType = readPayloadString(envelope.payload, "chatType");
  if (chatType !== "group") return true;
  return (
    readPayloadBoolean(envelope.payload, "mentionedBot") ||
    readPayloadBoolean(envelope.payload, "groupCardAction") ||
    readPayloadBoolean(envelope.payload, "elicitation")
  );
}

function hasActiveSubscription(
  db: IntakeDatabaseHandle,
  workspaceIdentity: string,
  threadKey: string,
): boolean {
  const row = db
    .prepare(
      `select 1 as hit from trigger_subscriptions
        where workspace_identity = ? and thread_key = ? and status = 'active'
        limit 1`,
    )
    .get(workspaceIdentity, threadKey);
  return row !== undefined;
}

/**
 * 确定性准入表（§3.1 第 2 步，顺序即语义）：
 * 1. 来源白名单；2. 域键铸造（群范围：群无 chatId/peer = unscoped 拒绝）；
 * 3. 订阅命中 → 守卫 → owned；4. 未命中且 observed → 直接拒（不调守卫，
 *    legacy 在 admitAutoReplyTurn 前已丢弃群内旁听）；5. 未命中且 addressed
 *    → 守卫 → human_explicit / unowned_candidate。
 */
export async function evaluateFastPath(
  db: IntakeDatabaseHandle,
  envelope: TriggerEnvelope,
  threadKey: string,
  guard: { admit(envelope: TriggerEnvelope): Promise<boolean> },
): Promise<FastPathEvaluation> {
  if (!INTAKE_SOURCE_WHITELIST.has(envelope.source)) {
    return { outcome: "reject", reason: "source-not-in-whitelist" };
  }
  // 群范围（域键铸造）先于订阅判定与守卫：拿不到 peer 的信封不消耗互答守卫占额（§3.1 顺序）。
  const domainKey = mintDomainKeyFromEnvelope(envelope);
  if (!domainKey) {
    return { outcome: "reject", reason: "unscoped-thread" };
  }
  if (hasActiveSubscription(db, envelope.workspaceIdentity, threadKey)) {
    // 订阅命中仍过互答守卫（占额语义原样复用），通过后 owned。
    if (!(await guard.admit(envelope))) {
      return { outcome: "reject", reason: "auto-reply-guard" };
    }
    return { outcome: "route", route: "owned" };
  }
  // 无订阅 + observed：legacy 在守卫之前丢弃群内旁听，此处不得进守卫改写互答状态。
  if (!isAddressedEnvelope(envelope)) {
    return { outcome: "reject", reason: "observed-not-addressed" };
  }
  if (!(await guard.admit(envelope))) {
    return { outcome: "reject", reason: "auto-reply-guard" };
  }
  if (envelope.actor.kind === "human") {
    return { outcome: "route", route: "human_explicit" };
  }
  return { outcome: "route", route: "unowned_candidate" };
}
