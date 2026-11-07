import { describe, expect, it } from "vitest";

import {
  type ChengGenerateInput,
  type ChengHostPort,
  type ChengJobResult,
} from "../src/app/workflow-cheng-world-read.js";
import { createScopedChengHostPort } from "../src/app/workflow-cheng-scoped-port.js";

type LifecycleEvent = { type: "started" | "terminal"; jobId: string };

interface PendingJob {
  resolve: (result: ChengJobResult) => void;
  reject: (error: unknown) => void;
}

/**
 * 模拟共享 host 连接：generate 从预置 job id 队列取一个 id，先向**所有**订阅者广播
 * started（复现全局生命周期广播），再调用 `onStarted`，最后挂起等测试 settle。
 */
function stubBasePort(jobIds: readonly string[]) {
  const cancels: string[] = [];
  const listeners = new Set<(event: LifecycleEvent) => void>();
  const pending = new Map<string, PendingJob>();
  let nextJob = 0;

  const emit = (event: LifecycleEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const port: ChengHostPort = {
    async generate(_input: ChengGenerateInput, onStarted) {
      const jobId = jobIds[nextJob];
      nextJob += 1;
      if (jobId === undefined) throw new Error("stub base: no scripted job ids left");
      emit({ type: "started", jobId });
      onStarted?.(jobId);
      return await new Promise<ChengJobResult>((resolve, reject) => {
        pending.set(jobId, { resolve, reject });
      });
    },
    async inspect(jobId) {
      return {
        jobId,
        state: "running",
        runId: null,
        runDir: null,
        exitCode: null,
        cancelRequested: false,
      };
    },
    async verify() {
      throw new Error("stub base: verify not used");
    },
    async plan() {
      throw new Error("stub base: plan not used");
    },
    async graph() {
      throw new Error("stub base: graph not used");
    },
    async cancel(jobId) {
      cancels.push(jobId);
      return "cancelled";
    },
    async cancelActive() {
      return 0;
    },
    onJobLifecycle(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    port,
    cancels,
    emit,
    settle(jobId: string) {
      const job = pending.get(jobId);
      if (job === undefined) throw new Error(`stub base: job ${jobId} is not pending`);
      pending.delete(jobId);
      job.resolve({
        jobId,
        runId: `run-${jobId}`,
        state: "succeeded",
        exitCode: 0,
        verdict: "DIAGNOSTIC_NOT_ACCEPTANCE",
      });
    },
    fail(jobId: string, error: unknown) {
      const job = pending.get(jobId);
      if (job === undefined) throw new Error(`stub base: job ${jobId} is not pending`);
      pending.delete(jobId);
      job.reject(error);
    },
  };
}

const INPUT: ChengGenerateInput = { specPath: "/spec/p02.json", task: "p02_min2", budget: 1000 };

describe("createScopedChengHostPort", () => {
  it("attributes each job to its own run and cancels only that run's jobs", async () => {
    const base = stubBasePort(["JOB_A", "JOB_B"]);
    const a = createScopedChengHostPort(base.port);
    const b = createScopedChengHostPort(base.port);

    const startedIds: string[] = [];
    const jobA = a.port.generate(INPUT, (jobId) => startedIds.push(jobId));
    expect(startedIds).toEqual(["JOB_A"]);
    expect(a.activeJobIds()).toEqual(["JOB_A"]);

    const jobB = b.port.generate(INPUT);
    expect(b.activeJobIds()).toEqual(["JOB_B"]);
    // base 向所有订阅者广播了 JOB_B 的 started；A 不能把它算进自己的 active。
    expect(a.activeJobIds()).toEqual(["JOB_A"]);

    expect(await b.cancelActive()).toBe(1);
    expect(base.cancels).toEqual(["JOB_B"]);
    // A 的在途 job 不受 B 的取消影响。
    expect(a.activeJobIds()).toEqual(["JOB_A"]);

    base.settle("JOB_B");
    await jobB;
    expect(b.activeJobIds()).toEqual([]);

    base.settle("JOB_A");
    await jobA;
    expect(a.activeJobIds()).toEqual([]);
  });

  it("keeps failed cancellations active and surfaces the error", async () => {
    const base = stubBasePort(["JOB_A"]);
    const a = createScopedChengHostPort(base.port);
    base.port.cancel = async () => {
      throw new Error("cancel RPC failed");
    };

    const job = a.port.generate(INPUT);
    await expect(a.cancelActive()).rejects.toThrow("Failed to cancel Cheng jobs: JOB_A");
    expect(a.activeJobIds()).toEqual(["JOB_A"]);

    base.settle("JOB_A");
    await job;
    expect(a.activeJobIds()).toEqual([]);
  });

  it("cancels a job that starts after the run scope closed", async () => {
    const base = stubBasePort(["JOB_LATE"]);
    const a = createScopedChengHostPort(base.port);

    await a.cancelActive();
    const job = a.port.generate(INPUT);
    expect(base.cancels).toEqual(["JOB_LATE"]);
    expect(a.activeJobIds()).toEqual([]);

    base.settle("JOB_LATE");
    await job;
  });

  it("clears the active entry when generate rejects", async () => {
    const base = stubBasePort(["JOB_A"]);
    const a = createScopedChengHostPort(base.port);

    const job = a.port.generate(INPUT);
    expect(a.activeJobIds()).toEqual(["JOB_A"]);

    base.fail("JOB_A", new Error("host exploded"));
    await expect(job).rejects.toThrow("host exploded");
    expect(a.activeJobIds()).toEqual([]);
  });

  it("keeps forwarding base lifecycle events for observation after dispose", () => {
    const base = stubBasePort(["JOB_B"]);
    const a = createScopedChengHostPort(base.port);
    const observed: string[] = [];
    a.port.onJobLifecycle((event) => {
      if (event.type === "started") observed.push(event.jobId);
    });

    // dispose 只做兼容性 no-op，不能切断引擎的观察订阅。
    a.dispose();
    base.emit({ type: "started", jobId: "JOB_B" });
    expect(observed).toEqual(["JOB_B"]);
  });
});
