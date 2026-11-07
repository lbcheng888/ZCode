import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createTriggerSubscriptions } from "../../src/super-agent/trigger/subscriptions.js";
import {
  routeOwned,
  triggerDeliveryCommandId,
} from "../../src/super-agent/trigger/event-router.js";
import type {
  TriggerDeliveryInput,
  TriggerDeliveryReceipt,
} from "../../src/super-agent/trigger/contract.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

function seedTriggerEvent(
  database: DatabaseSync,
  input: {
    id: string;
    workspaceIdentity?: string;
    threadKey?: string;
    payload?: string;
    taint?: number;
  },
): void {
  const workspaceIdentity = input.workspaceIdentity ?? "ws-a";
  const threadKey = input.threadKey ?? "bot:bot-1:u1:t1";
  const payload = input.payload ?? JSON.stringify({ text: "PR #42 需要你跟进" });
  database
    .prepare(
      `insert into trigger_events (
        id, workspace_identity, source, thread_key, actor_kind, actor_id, payload,
        payload_digest, taint, provider, provider_message_id, fast_path,
        adjudication_status, final_disposition, settled_at, created_at, updated_at
      ) values (?, ?, 'im', ?, 'human', 'u1', ?, 'digest', ?, 'feishu', ?, 'owned',
        null, null, null, ?, ?)`,
    )
    .run(
      input.id,
      workspaceIdentity,
      threadKey,
      payload,
      input.taint ?? 1,
      `pm-${input.id}`,
      NOW,
      NOW,
    );
}

function makeDelivery(log: TriggerDeliveryInput[]): {
  deliver(input: TriggerDeliveryInput): Promise<TriggerDeliveryReceipt>;
} {
  return {
    async deliver(input) {
      log.push(input);
      return { status: "admitted" };
    },
  };
}

describe("super-agent-trigger EventRouter.routeOwned（§3.1 owned 边，零 LLM）", () => {
  it("红 ChengGate 丢弃 owned 回复：零投递，final_disposition=record_only", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);
    seedTriggerEvent(db, {
      id: "trigger-gated",
      payload: JSON.stringify({ text: "reply candidate", chengJobId: "job-red" }),
    });
    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-a",
      lane: "followup",
      ownerKind: "session",
      now: NOW,
    });

    const delivered: TriggerDeliveryInput[] = [];
    const outcome = await routeOwned(
      {
        db,
        subscriptions,
        delivery: makeDelivery(delivered),
        resolveGate: async () => ({
          ok: false,
          level: "BLOCKED",
          reasons: ["settle_not_solved"],
        }),
        now: () => NOW,
      },
      "trigger-gated",
    );

    expect(outcome).toEqual({
      kind: "gate_blocked",
      triggerId: "trigger-gated",
      reason: "cheng_gate_blocked:settle_not_solved",
    });
    expect(delivered).toEqual([]);
    expect(
      db
        .prepare("select final_disposition from trigger_events where id = 'trigger-gated'")
        .get(),
    ).toEqual({ final_disposition: "record_only" });
  });

  it("多订阅者 fan-out：逐订阅者投递一次，lane 原样透传，幂等键 = triggerId:sessionId", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);
    seedTriggerEvent(db, { id: "trigger-1" });
    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-a",
      lane: "followup",
      ownerKind: "session",
      now: NOW,
    });
    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-b",
      lane: "inject",
      ownerKind: "goal",
      ownerRef: "goal-1",
      now: NOW,
    });

    const delivered: TriggerDeliveryInput[] = [];
    const outcome = await routeOwned(
      { db, subscriptions, delivery: makeDelivery(delivered), now: () => NOW },
      "trigger-1",
    );

    expect(outcome.kind).toBe("routed");
    expect(delivered).toHaveLength(2);
    const bySession = new Map(delivered.map((item) => [item.sessionId, item]));
    expect(bySession.get("session-a")!.lane).toBe("followup");
    expect(bySession.get("session-b")!.lane).toBe("inject");
    expect(bySession.get("session-a")!.commandId).toBe(
      triggerDeliveryCommandId("trigger-1", "session-a"),
    );
    expect(bySession.get("session-a")!.triggerId).toBe("trigger-1");
    // taint 随 trigger_events 行透传（永不构成指令权威，§5）。
    expect(bySession.get("session-a")!.taint).toBe(true);
    expect(bySession.get("session-a")!.text).toContain("PR #42");

    const row = db
      .prepare("select final_disposition from trigger_events where id = 'trigger-1'")
      .get() as { final_disposition: string };
    expect(row.final_disposition).toBe("routed");

    // 重复路由：commandId 不变（inbox 幂等吸收的键稳定性）。
    const again: TriggerDeliveryInput[] = [];
    await routeOwned(
      { db, subscriptions, delivery: makeDelivery(again), now: () => NOW },
      "trigger-1",
    );
    expect(again.map((item) => item.commandId)).toEqual(
      delivered.map((item) => item.commandId),
    );
  });

  it("无订阅者 → orphaned（final_disposition 落行，计数告警由 outcome 承载）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);
    seedTriggerEvent(db, { id: "trigger-2", threadKey: "webhook:route-9" });

    const delivered: TriggerDeliveryInput[] = [];
    const outcome = await routeOwned(
      { db, subscriptions, delivery: makeDelivery(delivered), now: () => NOW },
      "trigger-2",
    );
    expect(outcome).toEqual({ kind: "orphaned", triggerId: "trigger-2" });
    expect(delivered).toHaveLength(0);

    const row = db
      .prepare("select final_disposition from trigger_events where id = 'trigger-2'")
      .get() as { final_disposition: string };
    expect(row.final_disposition).toBe("orphaned");
  });

  it("投递回执 rejected → outcome=delivery_failed 且 final_disposition 保持未决（NULL）", async () => {
    // 回归锚（reviewer major）：宿主冷启动/会话未 hydrate 时 CommandInbox 判
    // sessionNotFound → 回执 rejected。若此时仍落 routed，启动重放扫描（§4 流五 3
    // 只覆盖未决行）永远看不到该事件，且审计失真——必须保持未决并从 outcome 暴露。
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);
    seedTriggerEvent(db, { id: "trigger-r1" });
    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-ok",
      lane: "followup",
      ownerKind: "session",
      now: NOW,
    });
    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-cold",
      lane: "followup",
      ownerKind: "session",
      now: NOW,
    });

    const delivered: TriggerDeliveryInput[] = [];
    const outcome = await routeOwned(
      {
        db,
        subscriptions,
        delivery: {
          async deliver(input) {
            delivered.push(input);
            return input.sessionId === "session-cold"
              ? { status: "rejected", reasonCode: "sessionNotFound" }
              : { status: "admitted" };
          },
        },
        now: () => NOW,
      },
      "trigger-r1",
    );

    expect(outcome.kind).toBe("delivery_failed");
    // 全部订阅者都被尝试投递（部分失败不中断 fan-out；重放时 admitted 侧靠幂等键吸收）。
    expect(delivered).toHaveLength(2);
    const row = db
      .prepare("select final_disposition from trigger_events where id = 'trigger-r1'")
      .get() as { final_disposition: string | null };
    expect(row.final_disposition).toBeNull();

    // 全部 admitted 后重放：才收敛 routed（幂等 commandId 不变）。
    const replay = await routeOwned(
      {
        db,
        subscriptions,
        delivery: makeDelivery([]),
        now: () => NOW,
      },
      "trigger-r1",
    );
    expect(replay.kind).toBe("routed");
    const after = db
      .prepare("select final_disposition from trigger_events where id = 'trigger-r1'")
      .get() as { final_disposition: string };
    expect(after.final_disposition).toBe("routed");
  });

  it("缺 trigger 行 → not_found（响亮暴露 intake 侧缺口，不静默吞）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);
    const outcome = await routeOwned(
      { db, subscriptions, delivery: makeDelivery([]), now: () => NOW },
      "missing-trigger",
    );
    expect(outcome).toEqual({ kind: "not_found", triggerId: "missing-trigger" });
  });

  it("过期订阅不投递（lease 死订阅在 sweep 前即被 listActive 过滤）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);
    seedTriggerEvent(db, { id: "trigger-3" });
    subscriptions.upsert({
      workspaceIdentity: "ws-a",
      threadKey: "bot:bot-1:u1:t1",
      sessionId: "session-dead",
      lane: "followup",
      ownerKind: "session",
      leaseExpiresAt: NOW - 1,
      now: NOW - 10_000,
    });

    const delivered: TriggerDeliveryInput[] = [];
    const outcome = await routeOwned(
      { db, subscriptions, delivery: makeDelivery(delivered), now: () => NOW },
      "trigger-3",
    );
    expect(outcome.kind).toBe("orphaned");
    expect(delivered).toHaveLength(0);
  });
});
