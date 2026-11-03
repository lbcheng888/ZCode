/**
 * 存量订阅回填（spec §5.1 / M2 存量迁移）。
 *
 * 落点选择（ws6 分区声明）：任务放 intake 侧 `intake/backfill.ts`（spec §6 清单把回填列在
 * super-agent-trigger，但 trigger/backfill.ts 属另一 lane；本分区只许改 intake/**，
 * 故按任务书约定放这里）。写入面 = trigger_subscriptions 的幂等 INSERT OR IGNORE，
 * 与 super-agent-trigger 的 upsert 共用同一 partial unique index，双方都不越权改结构。
 *
 * 时机：daemon 启动（leader 获得后）+ botsService ready 之后一次性幂等任务（§5.1）。
 * 幂等：UNIQUE(workspace_identity, thread_key, session_id) WHERE status='active'，
 * 重复执行零新增行。
 */
import { randomUUID } from "node:crypto";

import type { IntakeDatabaseHandle } from "./contract.js";
import { mintBotThreadDomainKey, mintThreadKey } from "./fast-path.js";

/** 回填行初始租约：随 leader 心跳续期（§1.3）；首迁落 24h，过期扫描回收后由活跃链路续期。 */
export const SUBSCRIPTION_BACKFILL_LEASE_MS = 24 * 60 * 60 * 1000;

/**
 * 一条存量 bot conversation 的回填种子。
 * `peerId` 取 botDeliveryTarget.providerUserId 槽（resolveAutomationBotDeliveryTarget 语义：
 * 群=chatId，私聊=providerUserId），保证与出口铸造的域键逐字节一致。
 */
export interface SubscriptionBackfillSeed {
  workspaceIdentity: string;
  /** 订阅者（目标会话）。 */
  sessionId: string;
  botId: string;
  peerId: string;
  threadId?: string;
}

export interface SubscriptionBackfillResult {
  scanned: number;
  /** 实际新增的 active 行数；重复回填恒为 0。 */
  inserted: number;
}

const INSERT_OR_IGNORE_SQL = `
  insert or ignore into trigger_subscriptions (
    id, workspace_identity, thread_key, session_id, lane, filters,
    owner_kind, owner_ref, status, lease_expires_at, created_at, updated_at
  ) values (?, ?, ?, ?, 'followup', NULL, 'session', NULL, 'active', ?, ?, ?)
`;

/**
 * 一次性幂等回填：遍历种子 → 铸造与 Fast Path 相同格式的 threadKey → INSERT OR IGNORE。
 * lane=followup、owner_kind=session（§5.1 原文）。同步执行（node:sqlite）；不发事件。
 * 前置：域库已迁移（super-agent-storage open 之后调用）。
 */
export function runSubscriptionBackfill(options: {
  db: IntakeDatabaseHandle;
  seeds: readonly SubscriptionBackfillSeed[];
  /** 注入时钟；缺省 Date.now。 */
  now?: number;
  /** 租约到期时刻；缺省 now + SUBSCRIPTION_BACKFILL_LEASE_MS。 */
  leaseExpiresAt?: number;
}): SubscriptionBackfillResult {
  const at = options.now ?? Date.now();
  const leaseExpiresAt = options.leaseExpiresAt ?? at + SUBSCRIPTION_BACKFILL_LEASE_MS;
  const statement = options.db.prepare(INSERT_OR_IGNORE_SQL);
  let inserted = 0;
  for (const seed of options.seeds) {
    const domainKey = mintBotThreadDomainKey({
      botId: seed.botId,
      peerId: seed.peerId,
      threadId: seed.threadId,
    });
    const threadKey = mintThreadKey(seed.workspaceIdentity, domainKey);
    const result = statement.run(
      randomUUID(),
      seed.workspaceIdentity,
      threadKey,
      seed.sessionId,
      leaseExpiresAt,
      at,
      at,
    );
    if (Number(result.changes) > 0) inserted += 1;
  }
  return { scanned: options.seeds.length, inserted };
}
