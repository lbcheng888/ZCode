import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createDispatchBridge, dispatchCommandIdForRun } from "../../src/super-agent/trigger/dispatchBridge.js";
import type {
  DispatchPushCommand,
  DispatchPushOutcome,
} from "../../src/super-agent/trigger/dispatchBridgePort.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

/**
 * §1.6 dispatch_requests DDL 镜像（权威在 packages/services/src/session/tasksDatabase/
 * migrations.ts 的 0007_dispatch_requests；bootstrap 不依赖 services，测试按 spec 表面
 * 自建同形表——结构变更需两处同步，central verify 由 services 迁移测试兜底列面）。
 */
function openTasksIndexLikeDb(): DatabaseSync {
  const handle = new DatabaseSync(":memory:");
  handle.exec(`
    create table dispatch_requests (
      id text primary key,
      run_id text not null unique,
      command_id text not null unique,
      workspace_identity text not null,
      session_id text,
      payload text,
      status text not null,
      skip_reason text,
      dispatch_policy text not null,
      attempts integer not null default 0,
      claimed_at integer,
      pushed_at integer,
      acked_at integer,
      settled_at integer,
      created_at integer not null,
      updated_at integer not null
    );
  `);
  return handle;
}

/** 脚本化 push 端口（仅测试代码）：记录调用、按队列出回执、宿主在线态可切。 */
function createScriptedPush() {
  const calls: DispatchPushCommand[] = [];
  const outcomes: DispatchPushOutcome[] = [];
  let hostReachable = true;
  return {
    calls,
    outcomes,
    setHostReachable(value: boolean) {
      hostReachable = value;
    },
    port: {
      async push(command: DispatchPushCommand): Promise<DispatchPushOutcome> {
        calls.push(command);
        return outcomes.shift() ?? { status: "admitted" };
      },
      isHostReachable(): boolean {
        return hostReachable;
      },
    },
  };
}

function statusOf(database: DatabaseSync, runId: string): string {
  const row = database
    .prepare("select status, skip_reason, attempts, command_id from dispatch_requests where run_id = ?")
    .get(runId) as { status: string; skip_reason: string | null; attempts: number; command_id: string };
  return JSON.stringify(row);
}

describe("super-agent-trigger dispatchBridge（§1.6 / §3.2 M7② exactly-once）", () => {
  it("claimDue 写 pending_dispatch：commandId=hash(runId)，同 runId 二次 claim 幂等短路", () => {
    db = openTasksIndexLikeDb();
    const bridge = createDispatchBridge({ db, push: createScriptedPush().port, now: () => NOW });

    const first = bridge.claimDue({
      runId: "automation-1:1000",
      workspaceIdentity: "ws-a",
      payload: "跑测试",
      now: NOW,
    });
    expect(first.created).toBe(true);
    expect(first.status).toBe("pending_dispatch");
    expect(first.commandId).toBe(dispatchCommandIdForRun("automation-1:1000"));
    expect(first.commandId).toBe(createHash("sha256").update("automation-1:1000").digest("hex"));

    const second = bridge.claimDue({
      runId: "automation-1:1000",
      workspaceIdentity: "ws-a",
      now: NOW + 1,
    });
    expect(second).toEqual({ ...first, created: false });
    const count = db.prepare("select count(*) as n from dispatch_requests").get() as { n: number };
    expect(Number(count.n)).toBe(1);
  });

  it("kill-point ①：claim 后 push 前崩溃 → 重启无宿主不推，宽限结算 skipped(no_dispatcher)，终态零推送", async () => {
    db = openTasksIndexLikeDb();
    const first = createScriptedPush();
    const bridge = createDispatchBridge({ db, push: first.port, now: () => NOW });
    const claim = bridge.claimDue({ runId: "run-1", workspaceIdentity: "ws-a", now: NOW });

    // kill -9：桥进程状态丢失，行留在 pending_dispatch；重启 = 新实例同库。
    const restarted = createDispatchBridge({ db, push: first.port, now: () => NOW + 60_000 });
    const resume = await restarted.resumePendingAfterBoot({ hostAvailable: false });
    expect(resume.pushed).toEqual([]);
    expect(resume.pending).toEqual([claim.requestId]);
    expect(first.calls).toHaveLength(0);

    // in-window 宽限到 → skipped(no_dispatcher)（与 push CAS 互斥：结算后零推送）。
    expect(restarted.sweepSkipped(NOW + 120_000, 30_000)).toBe(1);
    expect(JSON.parse(statusOf(db, "run-1"))).toMatchObject({
      status: "skipped",
      skip_reason: "no_dispatcher",
    });
    const afterSkip = await restarted.pushDispatch(claim.requestId);
    expect(afterSkip).toEqual({
      kind: "already_terminal",
      requestId: claim.requestId,
      status: "skipped",
      skipReason: "no_dispatcher",
    });
    expect(first.calls).toHaveLength(0);
  });

  it("kill-point ②：push 后 ACK 前崩溃 → 重推同 commandId，host duplicate 回执一次消费后 settle dispatched", async () => {
    db = openTasksIndexLikeDb();
    const first = createScriptedPush();
    const bridge = createDispatchBridge({ db, push: first.port, now: () => NOW });
    const claim = bridge.claimDue({ runId: "run-2", workspaceIdentity: "ws-a", now: NOW });

    const pushed = await bridge.pushDispatch(claim.requestId);
    expect(pushed).toMatchObject({ kind: "pushed", commandId: claim.commandId });
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]?.commandId).toBe(claim.commandId);

    // kill -9：push 已达 host，ACK 未回；重启后停滞 pushed 行必须同 commandId 重推，
    // host 侧由 CommandInbox 幂等吸收（回执 duplicate），不双跑。
    first.outcomes.push({ status: "duplicate" });
    const restarted = createDispatchBridge({ db, push: first.port, now: () => NOW + 5_000 });
    const resume = await restarted.resumePendingAfterBoot({ hostAvailable: true });
    expect(resume.failures).toEqual([]);
    expect(resume.pushed).toEqual([{ requestId: claim.requestId, commandId: claim.commandId }]);
    expect(first.calls).toHaveLength(2);
    expect(first.calls[1]?.commandId).toBe(claim.commandId);

    const ack = restarted.onHostAck(claim.commandId, "duplicate");
    expect(ack).toEqual({ kind: "settled", requestId: claim.requestId });
    expect(JSON.parse(statusOf(db, "run-2"))).toMatchObject({ status: "dispatched", attempts: 2 });

    // ACK 后：终态，不再推（resume 与 pushDispatch 都零动作）。
    const resumeAfterAck = await restarted.resumePendingAfterBoot({ hostAvailable: true });
    expect(resumeAfterAck.pushed).toEqual([]);
    expect(first.calls).toHaveLength(2);
    const afterAck = await restarted.pushDispatch(claim.requestId);
    expect(afterAck).toMatchObject({ kind: "already_terminal", status: "dispatched" });
    expect(first.calls).toHaveLength(2);
  });

  it("kill-point ④：durable-wait 无宿主挂起不跳过，超最大陈旧期才 skipped(stale)", async () => {
    db = openTasksIndexLikeDb();
    const scripted = createScriptedPush();
    const bridge = createDispatchBridge({ db, push: scripted.port, now: () => NOW });
    const claim = bridge.claimDue({
      runId: "run-4",
      workspaceIdentity: "ws-a",
      dispatchPolicy: "durable_wait",
      now: NOW,
    });

    const restarted = createDispatchBridge({ db, push: scripted.port, now: () => NOW + 10_000 });
    const resume = await restarted.resumePendingAfterBoot({ hostAvailable: false });
    expect(resume.pending).toEqual([claim.requestId]);
    // 宽限结算只碰 in_window：durable-wait 停留 pending（等回连）。
    expect(restarted.sweepSkipped(NOW + 10_000, 0)).toBe(0);
    expect(JSON.parse(statusOf(db, "run-4"))).toMatchObject({ status: "pending_dispatch" });
    // 超最大陈旧期 → skipped(stale)。
    expect(restarted.sweepSkipped(NOW + 10_000, 0, { durableMaxStaleMs: 5_000 })).toBe(1);
    expect(JSON.parse(statusOf(db, "run-4"))).toMatchObject({
      status: "skipped",
      skip_reason: "stale",
    });
  });

  it("kill-point ⑤：skipped 与 push 的 CAS 恰好一边胜——pushed 行宽限扫不动，skipped 行推不动", async () => {
    db = openTasksIndexLikeDb();
    const scripted = createScriptedPush();
    const bridge = createDispatchBridge({ db, push: scripted.port, now: () => NOW });

    // A：push 先胜 → sweep 对 pushed 行 changes=0，行保持 pushed。
    const a = bridge.claimDue({ runId: "run-a", workspaceIdentity: "ws", now: NOW });
    await bridge.pushDispatch(a.requestId);
    expect(bridge.sweepSkipped(NOW + 60_000, 0)).toBe(0);
    expect(JSON.parse(statusOf(db, "run-a"))).toMatchObject({ status: "pushed" });

    // B：sweep 先胜 → pushDispatch 收敛 already_terminal，端口零调用。
    const b = bridge.claimDue({ runId: "run-b", workspaceIdentity: "ws", now: NOW });
    expect(bridge.sweepSkipped(NOW + 60_000, 0)).toBe(1);
    const bPush = await bridge.pushDispatch(b.requestId);
    expect(bPush).toMatchObject({ kind: "already_terminal", status: "skipped" });
    expect(scripted.calls).toHaveLength(1);
  });

  it("ACK 幂等：重复 ACK noop；未知 commandId 原样抛出；rejected 回执不 settle", async () => {
    db = openTasksIndexLikeDb();
    const scripted = createScriptedPush();
    const bridge = createDispatchBridge({ db, push: scripted.port, now: () => NOW });
    const claim = bridge.claimDue({ runId: "run-6", workspaceIdentity: "ws", now: NOW });

    scripted.outcomes.push({ status: "rejected", reasonCode: "proto.invalidPayload" });
    await bridge.pushDispatch(claim.requestId);
    // rejected 不是 ACK：行保持 pushed，可续推。
    expect(JSON.parse(statusOf(db, "run-6"))).toMatchObject({ status: "pushed" });

    expect(bridge.onHostAck(claim.commandId, "admitted")).toEqual({
      kind: "settled",
      requestId: claim.requestId,
    });
    expect(bridge.onHostAck(claim.commandId, "admitted")).toEqual({
      kind: "noop",
      requestId: claim.requestId,
      status: "dispatched",
    });
    expect(() => bridge.onHostAck("command-not-exist", "admitted")).toThrow(
      /未命中 dispatch_requests 行/,
    );

    // 推失败（端口抛错）：原样上浮，行保持 pushed、attempts 已累计，续推同 commandId。
    const claim2 = bridge.claimDue({ runId: "run-7", workspaceIdentity: "ws", now: NOW });
    scripted.port.push = async () => {
      throw new Error("host offline");
    };
    await expect(bridge.pushDispatch(claim2.requestId)).rejects.toThrow("host offline");
    expect(JSON.parse(statusOf(db, "run-7"))).toMatchObject({ status: "pushed", attempts: 1 });
  });
});
