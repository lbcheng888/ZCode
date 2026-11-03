import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createTriggerSubscriptions } from "../../src/super-agent/trigger/subscriptions.js";
import { dispatchHumanExplicit } from "../../src/super-agent/trigger/human-explicit-dispatch.js";
import type {
  CreateTaskInput,
  FindWorkerByThreadKeyInput,
  ResumableWorker,
  ResumeWorkerInput,
  TriggerDeliveryInput,
  TriggerDeliveryReceipt,
} from "../../src/super-agent/trigger/contract.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

function seedTriggerEvent(database: DatabaseSync, id: string, threadKey: string): void {
  database
    .prepare(
      `insert into trigger_events (
        id, workspace_identity, source, thread_key, actor_kind, actor_id, payload,
        payload_digest, taint, provider, provider_message_id, fast_path,
        adjudication_status, final_disposition, settled_at, created_at, updated_at
      ) values (?, 'ws-a', 'im', ?, 'human', 'u1', ?, 'digest', 1, 'feishu', ?,
        'human_explicit', null, null, null, ?, ?)`,
    )
    .run(
      id,
      threadKey,
      JSON.stringify({ text: "帮我把这个 bug 修了" }),
      `pm-${id}`,
      NOW,
      NOW,
    );
}

interface WorkerHarness {
  findWorkerByThreadKey: (input: FindWorkerByThreadKeyInput) => ResumableWorker | undefined;
  resume: (input: ResumeWorkerInput) => Promise<{ sessionId: string }>;
  createTask: (input: CreateTaskInput) => Promise<{ sessionId: string }>;
  resumeSpy: ReturnType<typeof vi.fn>;
  createTaskSpy: ReturnType<typeof vi.fn>;
}

function makeWorker(worker: ResumableWorker | undefined): WorkerHarness {
  const resumeSpy = vi.fn(async (input: ResumeWorkerInput) => ({ sessionId: input.sessionId }));
  const createTaskSpy = vi.fn(async (input: CreateTaskInput) => ({
    sessionId: `created-for-${input.threadKey}`,
  }));
  return {
    findWorkerByThreadKey: () => worker,
    resume: resumeSpy,
    createTask: createTaskSpy,
    resumeSpy,
    createTaskSpy,
  };
}

interface DeliveryHarness {
  delivered: TriggerDeliveryInput[];
  receipt: TriggerDeliveryReceipt;
  deliver: (input: TriggerDeliveryInput) => Promise<TriggerDeliveryReceipt>;
  deliverSpy: ReturnType<typeof vi.fn>;
}

function makeDelivery(receipt: TriggerDeliveryReceipt = { status: "admitted" }): DeliveryHarness {
  const delivered: TriggerDeliveryInput[] = [];
  const deliverSpy = vi.fn(async (input: TriggerDeliveryInput) => {
    delivered.push(input);
    return receipt;
  });
  return { delivered, receipt, deliver: deliverSpy, deliverSpy };
}

async function run(
  worker: ResumableWorker | undefined,
  triggerId = "trigger-hx",
  delivery: DeliveryHarness = makeDelivery(),
): Promise<{
  outcome: Awaited<ReturnType<typeof dispatchHumanExplicit>>;
  workerHarness: WorkerHarness;
  delivery: DeliveryHarness;
  subscriptions: ReturnType<typeof createTriggerSubscriptions>;
}> {
  db = await openSuperAgentDatabase({ databasePath: ":memory:" });
  seedTriggerEvent(db, triggerId, "bot:bot-1:u1:t1");
  const subscriptions = createTriggerSubscriptions(db);
  const workerHarness = makeWorker(worker);
  const outcome = await dispatchHumanExplicit(
    { db, subscriptions, worker: workerHarness, delivery, now: () => NOW },
    triggerId,
  );
  return { outcome, workerHarness, delivery, subscriptions };
}

describe("super-agent-trigger dispatchHumanExplicit 决策矩阵（§2.1，免 Mandate 免攒批）", () => {
  it("已终态且非人为停止 → resume，并 upsert followup 订阅", async () => {
    const { outcome, workerHarness, delivery, subscriptions } = await run({
      sessionId: "session-live",
      terminal: true,
      stoppedByHuman: false,
      context: {
        goalSummary: "修复登录闪退",
        recentNarrowResults: ["定位到 auth.ts 的空指针"],
        openQuestions: ["是否影响 web 端"],
        recallSeedIds: ["recall-1", "recall-2"],
      },
    });

    expect(outcome).toEqual({
      kind: "resumed",
      triggerId: "trigger-hx",
      sessionId: "session-live",
    });
    expect(workerHarness.createTaskSpy).not.toHaveBeenCalled();
    expect(workerHarness.resumeSpy).toHaveBeenCalledTimes(1);
    const resumeInput = workerHarness.resumeSpy.mock.calls[0]![0];
    expect(resumeInput.triggerId).toBe("trigger-hx");
    // M2 上下文装配进入唤醒文本。
    expect(resumeInput.text).toContain("帮我把这个 bug 修了");
    expect(resumeInput.text).toContain("目标：修复登录闪退");
    expect(resumeInput.text).toContain("recall 种子：recall-1, recall-2");
    // 终态分支不走 delivery 端口。
    expect(delivery.deliverSpy).not.toHaveBeenCalled();

    const active = subscriptions.listActive("ws-a", "bot:bot-1:u1:t1", NOW);
    expect(active).toHaveLength(1);
    expect(active[0]!.sessionId).toBe("session-live");
    expect(active[0]!.lane).toBe("followup");
    expect(active[0]!.ownerKind).toBe("session");
  });

  it("人为停止的 worker → createTask（不复活被停会话）", async () => {
    const { outcome, workerHarness } = await run({
      sessionId: "session-stopped",
      terminal: true,
      stoppedByHuman: true,
    });
    expect(outcome.kind).toBe("created_task");
    expect(workerHarness.resumeSpy).not.toHaveBeenCalled();
    expect(workerHarness.createTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("未终态 worker（在跑）→ lane=guide 行内投递，不新建平行会话（M1 busy 语义）", async () => {
    // 回归锚（reviewer major）：spec §2.1 无「在跑 → createTask」分支；同 threadKey
    // 新建平行会话会造成双订阅双跑与 findWorkerByThreadKey 消歧歧义（A2 与现状持平）。
    const delivery = makeDelivery();
    const { outcome, workerHarness, delivery: used, subscriptions } = await run(
      {
        sessionId: "session-busy",
        terminal: false,
        stoppedByHuman: false,
        context: { goalSummary: "已在跑的目标" },
      },
      "trigger-hx",
      delivery,
    );

    expect(outcome).toEqual({
      kind: "delivered",
      triggerId: "trigger-hx",
      sessionId: "session-busy",
    });
    expect(workerHarness.createTaskSpy).not.toHaveBeenCalled();
    expect(workerHarness.resumeSpy).not.toHaveBeenCalled();
    expect(used.deliverSpy).toHaveBeenCalledTimes(1);
    const deliverInput = used.delivered[0]!;
    expect(deliverInput.sessionId).toBe("session-busy");
    expect(deliverInput.lane).toBe("guide");
    expect(deliverInput.triggerId).toBe("trigger-hx");
    // 幂等键与 owned fan-out 同构（triggerId:sessionId），inbox 重复投递可吸收。
    expect(deliverInput.commandId).toBe("trigger-hx:session-busy");
    // 在跑会话上下文已在会话内：行内只送原文，不重复装配 M2 冷启动上下文。
    expect(deliverInput.text).toBe("帮我把这个 bug 修了");
    expect(deliverInput.text).not.toContain("目标：已在跑的目标");

    // 订阅绑定照常落库；首写者胜不改既有车道。
    const active = subscriptions.listActive("ws-a", "bot:bot-1:u1:t1", NOW);
    expect(active).toHaveLength(1);
    expect(active[0]!.sessionId).toBe("session-busy");
    expect(active[0]!.lane).toBe("followup");
  });

  it("在跑 worker 但投递被拒 → delivery_failed 响亮暴露，不降级 createTask", async () => {
    const delivery = makeDelivery({ status: "rejected", reasonCode: "sessionNotFound" });
    const { outcome, workerHarness } = await run(
      { sessionId: "session-busy", terminal: false, stoppedByHuman: false },
      "trigger-hx",
      delivery,
    );
    expect(outcome).toEqual({
      kind: "delivery_failed",
      triggerId: "trigger-hx",
      sessionId: "session-busy",
      reasonCode: "sessionNotFound",
    });
    expect(workerHarness.createTaskSpy).not.toHaveBeenCalled();
    expect(workerHarness.resumeSpy).not.toHaveBeenCalled();
  });

  it("无 worker（新线程）→ createTask，延迟面 = 直通既有 createTask port（A2）", async () => {
    const { outcome, workerHarness, delivery, subscriptions } = await run(undefined);
    expect(outcome).toEqual({
      kind: "created_task",
      triggerId: "trigger-hx",
      sessionId: "created-for-bot:bot-1:u1:t1",
    });
    expect(workerHarness.resumeSpy).not.toHaveBeenCalled();
    expect(workerHarness.createTaskSpy).toHaveBeenCalledTimes(1);
    expect(delivery.deliverSpy).not.toHaveBeenCalled();
    const createInput = workerHarness.createTaskSpy.mock.calls[0]![0];
    expect(createInput.workspaceIdentity).toBe("ws-a");
    expect(createInput.threadKey).toBe("bot:bot-1:u1:t1");

    const active = subscriptions.listActive("ws-a", "bot:bot-1:u1:t1", NOW);
    expect(active).toHaveLength(1);
    expect(active[0]!.sessionId).toBe("created-for-bot:bot-1:u1:t1");
  });

  it("缺 trigger 行 → not_found（不创建任务、不写订阅、不投递）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const subscriptions = createTriggerSubscriptions(db);
    const workerHarness = makeWorker(undefined);
    const delivery = makeDelivery();
    const outcome = await dispatchHumanExplicit(
      { db, subscriptions, worker: workerHarness, delivery, now: () => NOW },
      "missing-trigger",
    );
    expect(outcome).toEqual({ kind: "not_found", triggerId: "missing-trigger" });
    expect(workerHarness.createTaskSpy).not.toHaveBeenCalled();
    expect(delivery.deliverSpy).not.toHaveBeenCalled();
    expect(subscriptions.listActive("ws-a", "bot:bot-1:u1:t1", NOW)).toHaveLength(0);
  });
});
