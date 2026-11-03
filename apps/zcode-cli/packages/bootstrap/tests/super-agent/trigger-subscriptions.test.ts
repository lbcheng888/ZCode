import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createTriggerSubscriptions } from "../../src/super-agent/trigger/subscriptions.js";
import { TRIGGER_SUBSCRIPTION_LEASE_TTL_MS } from "../../src/super-agent/trigger/contract.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

describe("super-agent-trigger trigger_subscriptions 仓储（§1.3）", () => {
  it("upsert 幂等（partial unique / INSERT OR IGNORE 首写者胜）：二次 upsert 零更新零新增行", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);

    const first = subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-1",
      lane: "followup",
      ownerKind: "session",
      now: NOW,
    });
    expect(first.status).toBe("active");
    expect(first.leaseExpiresAt).toBe(NOW + TRIGGER_SUBSCRIPTION_LEASE_TTL_MS);

    // 冲突零更新（§1.3 INSERT OR IGNORE）：lane/owner/lease 保持首写者值——
    // 防止 followup 写入把 guide/inject 车道降级（watch 事件唤醒语义会翻转）。
    const second = subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-1",
      lane: "guide",
      ownerKind: "goal",
      ownerRef: "goal-9",
      now: NOW + 1_000,
    });
    expect(second.id).toBe(first.id);
    expect(second.lane).toBe("followup");
    expect(second.ownerKind).toBe("session");
    expect(second.ownerRef).toBeNull();
    expect(second.leaseExpiresAt).toBe(NOW + TRIGGER_SUBSCRIPTION_LEASE_TTL_MS);
    expect(second.updatedAt).toBe(NOW);

    // lane/owner 变更走 renewActiveLeases（仅 lease）/显式 update（暂未提供），
    // 不经 upsert 覆盖。
    subscriptions.renewActiveLeases(NOW + 5_000, "ws-a");
    const renewed = subscriptions.listActive("ws-a", "bot:bot-1:u1:t1", NOW + 5_000);
    expect(renewed[0]!.leaseExpiresAt).toBe(NOW + 5_000 + TRIGGER_SUBSCRIPTION_LEASE_TTL_MS);
    expect(renewed[0]!.lane).toBe("followup");

    const count = db
      .prepare("select count(*) as n from trigger_subscriptions where status = 'active'")
      .get() as { n: number };
    expect(Number(count.n)).toBe(1);

    // 同 threadKey 的第二个订阅者是独立行（fan-out 多对多）。
    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-2",
      lane: "inject",
      ownerKind: "session",
      now: NOW,
    });
    const active = subscriptions.listActive("ws-a", "bot:bot-1:u1:t1", NOW);
    // 同毫秒落行时 id（uuid）排序不稳定，按集合断言。
    expect(active.map((row) => row.sessionId).sort()).toEqual(["session-1", "session-2"]);
    expect(active.find((row) => row.sessionId === "session-2")!.lane).toBe("inject");
  });

  it("sweepExpiredLeases 回收过期 lease 且幂等；renewActiveLeases 按 workspace 续期", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);

    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "schedule:auto-1",
      sessionId: "session-stale",
      lane: "followup",
      ownerKind: "session",
      leaseExpiresAt: NOW - 1_000,
      now: NOW - 60_000,
    });
    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "schedule:auto-1",
      sessionId: "session-fresh",
      lane: "followup",
      ownerKind: "session",
      leaseExpiresAt: NOW + 60_000,
      now: NOW,
    });
    subscriptions.upsert({
      workspaceIdentity: "ws-b",
      threadKey: "bot:bot-2:u2:t2",
      sessionId: "session-b",
      lane: "followup",
      ownerKind: "session",
      now: NOW,
    });

    expect(subscriptions.sweepExpiredLeases(NOW)).toBe(1);
    expect(subscriptions.sweepExpiredLeases(NOW)).toBe(0);

    // 过期行已 revoked，不再出现在 active 查询里。
    const active = subscriptions.listActive("ws-a", "schedule:auto-1", NOW);
    expect(active.map((row) => row.sessionId)).toEqual(["session-fresh"]);

    // leader 心跳续期只续指定 workspace。
    const renewed = subscriptions.renewActiveLeases(NOW + 10_000, "ws-a");
    expect(renewed).toBe(1);
    const refreshed = subscriptions.listActive("ws-a", "schedule:auto-1", NOW + 10_000);
    expect(refreshed[0]!.leaseExpiresAt).toBe(NOW + 10_000 + TRIGGER_SUBSCRIPTION_LEASE_TTL_MS);
    const bRow = subscriptions.listActive("ws-b", "bot:bot-2:u2:t2", NOW);
    expect(bRow[0]!.leaseExpiresAt).toBe(NOW + TRIGGER_SUBSCRIPTION_LEASE_TTL_MS);

    // 缺省续全部。
    expect(subscriptions.renewActiveLeases(NOW + 20_000)).toBe(2);
  });

  it("revoke 按 id / 按 owner 批量，且幂等", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);

    const row = subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-1",
      lane: "followup",
      ownerKind: "goal",
      ownerRef: "goal-7",
      now: NOW,
    });
    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t2",
      sessionId: "session-2",
      lane: "followup",
      ownerKind: "goal",
      ownerRef: "goal-7",
      now: NOW,
    });

    expect(subscriptions.revoke({ id: row.id })).toBe(1);
    expect(subscriptions.revoke({ id: row.id })).toBe(0);

    expect(
      subscriptions.revoke({
        workspaceIdentity: "ws-a",
        ownerKind: "goal",
        ownerRef: "goal-7",
      }),
    ).toBe(1);
    expect(subscriptions.listActive("ws-a", "bot:bot-1:u1:t1", NOW)).toHaveLength(0);
    expect(subscriptions.listActive("ws-a", "bot:bot-1:u1:t2", NOW)).toHaveLength(0);

    // revoked 行保留审计，不物理删除。
    const all = db.prepare("select count(*) as n from trigger_subscriptions").get() as {
      n: number;
    };
    expect(Number(all.n)).toBe(2);

    // 撤销后重新订阅：partial unique 只约束 active 行，revoked 行不挡新插入。
    const resurrected = subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-1",
      lane: "guide",
      ownerKind: "session",
      now: NOW + 60_000,
    });
    expect(resurrected.status).toBe("active");
    expect(resurrected.id).not.toBe(row.id);
    expect(resurrected.lane).toBe("guide");

    expect(() =>
      subscriptions.revoke({} as never),
    ).toThrow(/id 或 \(workspaceIdentity, ownerKind, ownerRef\)/);
  });

  it("listActive 过滤已过期行（启动清扫前不投递死订阅）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);
    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "webhook:route-1",
      sessionId: "session-1",
      lane: "followup",
      ownerKind: "session",
      leaseExpiresAt: NOW - 1,
      now: NOW - 10_000,
    });
    expect(subscriptions.listActive("ws-a", "webhook:route-1", NOW)).toHaveLength(0);
    expect(subscriptions.listActive("ws-a", "webhook:route-1", NOW - 20_000)).toHaveLength(1);
  });
});
