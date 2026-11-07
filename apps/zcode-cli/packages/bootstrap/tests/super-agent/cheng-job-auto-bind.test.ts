// S4 内化：owner-scoped 结构自动绑定的机器用例。
// 契约：本会话 job 终态 succeeded 且 task 已知 → goal.chengRef 自动指向该 job
//（TargetChanged source="runtime"）；用户显式绑定永不覆盖；无 goal/非 succeeded/
// task 未知（重启丢映射）/CAS 竞态 → 跳过不上抛。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { SqliteBackgroundRunStore } from "../../src/super-agent/storage/background-run-store.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";
import { createChengJobObserver } from "../../src/super-agent/cheng-job-observer.js";

function fakeLedger() {
  return {
    hasClaim: vi.fn(async () => false),
    claim: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => undefined),
  } as never;
}

function makeSessionStore() {
  const state: {
    target?: {
      targetID: string;
      revision: number;
      status: string;
      chengRef?: { jobId: string; task: string; runId?: string } | null;
    };
    writes: number;
  } = {
    target: {
      targetID: "t1",
      revision: 1,
      status: "active",
      chengRef: null,
    },
    writes: 0,
  };
  return {
    state,
    readTarget: vi.fn(async () => state.target),
    updateTargetChengRef: vi.fn(async (input: { chengRef: unknown; revision: number }) => {
      if (input.revision !== state.target!.revision) return null;
      state.target = {
        ...state.target!,
        chengRef: input.chengRef as { jobId: string; task: string },
        revision: state.target!.revision + 1,
      };
      state.writes += 1;
      return state.target;
    }),
  };
}

describe("cheng-job owner-scoped 自动绑定（S4 内化）", () => {
  let db: DatabaseSync | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  async function makeObserver(store: ReturnType<typeof makeSessionStore>) {
    db = (await openSuperAgentDatabase({ databasePath: ":memory:" })) as never as DatabaseSync;
    const registry = new BackgroundRunRegistry(500, new SqliteBackgroundRunStore(db as never));
    const recordTargetChanged = vi.fn(async () => undefined);
    const observer = createChengJobObserver({
      registry,
      ledger: fakeLedger(),
      ownerSession: "s1",
      workspaceKey: "/w",
      autoBind: {
        onOwnJobSucceeded: async ({ jobId, task, runId }) => {
          const target = await store.readTarget();
          if (!target || target.status === "complete") return;
          const currentJob = (target.chengRef as { jobId?: string } | null)?.jobId;
          // 用户显式绑定（或来源不明）：自动绑定永不覆盖——由调用方用 lastAutoBound 指纹守卫；
          // 本测试用最小守卫：仅当 currentJob 为空时写。
          if (currentJob) return;
          const updated = await store.updateTargetChengRef({
            chengRef: { jobId, task, ...(runId ? { runId } : {}) },
            revision: target.revision,
          } as never);
          if (updated) await recordTargetChanged({ source: "runtime" });
        },
      },
    });
    return { observer, recordTargetChanged, store };
  }

  it("succeeded + task 已知 + goal 无绑定 → 自动写入 chengRef", async () => {
    const store = makeSessionStore();
    const { observer, recordTargetChanged } = await makeObserver(store);
    observer.started({ jobId: "job-1", task: "p06_fib" });
    await observer.terminal({ jobId: "job-1", state: "succeeded", runId: "run-1" });

    expect(store.state.target?.chengRef).toEqual({
      jobId: "job-1",
      task: "p06_fib",
      runId: "run-1",
    });
    expect(store.state.writes).toBe(1);
    expect(recordTargetChanged).toHaveBeenCalledWith({ source: "runtime" });
  });

  it("failed/cancelled 不触发；task 未随 started 透传（重启丢映射）不触发", async () => {
    const store = makeSessionStore();
    const { observer } = await makeObserver(store);
    observer.started({ jobId: "job-f", task: "t" });
    await observer.terminal({ jobId: "job-f", state: "failed" });
    observer.started({ jobId: "job-c", task: "t" });
    await observer.terminal({ jobId: "job-c", state: "cancelled" });
    observer.started({ jobId: "job-notask" });
    await observer.terminal({ jobId: "job-notask", state: "succeeded" });

    expect(store.state.target?.chengRef).toBeNull();
    expect(store.state.writes).toBe(0);
  });

  it("已有用户显式绑定 → 自动绑定不覆盖", async () => {
    const store = makeSessionStore();
    store.state.target!.chengRef = { jobId: "user-job", task: "t" };
    const { observer, recordTargetChanged } = await makeObserver(store);
    observer.started({ jobId: "job-2", task: "p11" });
    await observer.terminal({ jobId: "job-2", state: "succeeded" });

    expect(store.state.target?.chengRef).toEqual({ jobId: "user-job", task: "t" });
    expect(store.state.writes).toBe(0);
    expect(recordTargetChanged).not.toHaveBeenCalled();
  });
});
