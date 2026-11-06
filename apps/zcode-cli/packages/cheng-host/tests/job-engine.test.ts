import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { JobEngine } from "../src/job-engine.js";
import { JobStore } from "../src/job-store.js";
import type { StartRunnerInput } from "../src/runner.js";
import { fakePin, fakeRunner, jobRecord, tempDir, waitFor, type FakeRunner } from "./helpers.js";

interface Harness {
  readonly engine: JobEngine;
  readonly store: JobStore;
  readonly specPath: string;
  readonly spawned: StartRunnerInput[];
  readonly last: () => FakeRunner;
}

function makeHarness(options: { maxQueued?: number; onSignal?: "resolve" | "ignore" } = {}): Harness {
  const store = new JobStore(tempDir("engine-"));
  const specDir = tempDir("spec-");
  const specPath = join(specDir, "p02_min2.spec.json");
  writeFileSync(specPath, "{}\n");
  const spawned: StartRunnerInput[] = [];
  let latest: FakeRunner | null = null;

  const engine = new JobEngine({
    pin: fakePin(),
    store,
    env: { PATH: "/usr/bin:/bin" },
    now: () => new Date("2026-11-06T00:00:00.000Z"),
    terminateGraceMs: 50,
    killGraceMs: 50,
    heartbeatMs: 10_000,
    ...(options.maxQueued === undefined ? {} : { maxQueued: options.maxQueued }),
    spawnRunner: (input) => {
      spawned.push(input);
      const fakeOptions = options.onSignal === undefined ? {} : { onSignal: options.onSignal };
      const fake = fakeRunner(fakeOptions);
      latest = fake;
      return fake.handle;
    },
  });

  return {
    engine,
    store,
    specPath,
    spawned,
    last: () => {
      if (latest === null) {
        throw new Error("no runner spawned yet");
      }
      return latest;
    },
  };
}

async function generate(h: Harness, attempt?: string) {
  return h.engine.generate({
    specPath: h.specPath,
    specsDir: join(h.specPath, ".."),
    task: "p02_min2",
    budget: 30_000,
    ...(attempt === undefined ? {} : { attempt }),
    emit: () => {},
  });
}

describe("job engine", () => {
  it("runs a diagnostic job and keeps its run volume", async () => {
    const h = makeHarness();
    const started = await generate(h);
    expect(started.state).toBe("running");
    const runDir = tempDir("run-");
    h.last().finish({ exitCode: 41, runId: "m5-1", runDir });
    await waitFor(() => (h.store.read(started.jobId).state === "succeeded" ? true : null));
    const record = h.store.read(started.jobId);
    expect(record.exitCode).toBe(41);
    expect(record.runId).toBe("m5-1");
    expect(record.runDir).toBe(runDir);
    expect(h.spawned[0]?.task).toBe("p02_min2");
    expect(h.spawned[0]?.budget).toBe(30_000);
    await h.engine.close();
  });

  it("dedups a terminal job by key and requires a nonce to rerun", async () => {
    const h = makeHarness();
    const first = await generate(h);
    h.last().finish({ exitCode: 41, runId: "m5-1", runDir: tempDir("run-") });
    await waitFor(() => (h.store.read(first.jobId).state === "succeeded" ? true : null));

    const again = await generate(h);
    expect(again.jobId).toBe(first.jobId);
    expect(again.state).toBe("succeeded");
    expect(h.spawned).toHaveLength(1);

    const retried = await generate(h, "attempt-2");
    expect(retried.jobId).not.toBe(first.jobId);
    expect(h.spawned).toHaveLength(2);
    h.last().finish({ exitCode: 41, runId: "m5-2", runDir: tempDir("run-") });
    await waitFor(() => (h.store.read(retried.jobId).state === "succeeded" ? true : null));
    await h.engine.close();
  });

  it("classifies a runner failure instead of inventing a verdict", async () => {
    const h = makeHarness();
    const started = await generate(h);
    h.last().finish({ exitCode: 31, stdoutTail: "gap.txt: exhausted", stderrTail: "" });
    await waitFor(() => (h.store.read(started.jobId).state === "failed" ? true : null));
    const failure = h.store.read(started.jobId).failure;
    expect(failure).toMatchObject({ kind: "cheng_error", code: 31 });
    await h.engine.close();
  });

  it("refuses a diagnostic exit 0 and unknown exit codes", async () => {
    const zero = makeHarness();
    const first = await generate(zero);
    zero.last().finish({ exitCode: 0 });
    await waitFor(() => (zero.store.read(first.jobId).state === "failed" ? true : null));
    expect(zero.store.read(first.jobId).failure).toMatchObject({ code: "host.unexpectedExit" });
    await zero.engine.close();

    const unknown = makeHarness();
    const second = await generate(unknown);
    unknown.last().finish({ exitCode: 42, stderrTail: "signal" });
    await waitFor(() => (unknown.store.read(second.jobId).state === "failed" ? true : null));
    expect(unknown.store.read(second.jobId).failure).toMatchObject({ code: "host.unknownRunnerExit" });
    await unknown.engine.close();
  });

  it("cancels a running job and records a cancellation, not a failure", async () => {
    const h = makeHarness();
    const started = await generate(h);
    const result = await h.engine.cancel(started.jobId);
    expect(result.state).toBe("cancelled");
    expect(h.last().signals).toContain("SIGTERM");
    expect(h.store.read(started.jobId).state).toBe("cancelled");
    await h.engine.close();
  });

  it("fails loudly when the process tree cannot be reaped", async () => {
    const h = makeHarness({ onSignal: "ignore" });
    const started = await generate(h);
    const result = await h.engine.cancel(started.jobId);
    expect(result.state).toBe("failed");
    expect(h.store.read(started.jobId).failure).toMatchObject({ code: "host.processTreeLeaked" });
    h.last().finish({ exitCode: null });
    await waitFor(() => (h.engine.hasActiveJobs() ? null : true));
    await h.engine.close();
  });

  it("queues behind the single active slot and rejects a full queue", async () => {
    const h = makeHarness({ maxQueued: 1 });
    const first = await generate(h, "q1");
    const second = await generate(h, "q2");
    expect(h.store.read(second.jobId).state).toBe("queued");
    await expect(generate(h, "q3")).rejects.toMatchObject({ code: "host.busy" });

    h.last().finish({ exitCode: 41, runId: "m5-1", runDir: tempDir("run-") });
    await waitFor(() => (h.store.read(first.jobId).state === "succeeded" ? true : null));
    await waitFor(() => (h.store.read(second.jobId).state === "running" ? true : null));
    h.last().finish({ exitCode: 41, runId: "m5-2", runDir: tempDir("run-") });
    await waitFor(() => (h.store.read(second.jobId).state === "succeeded" ? true : null));
    await h.engine.close();
  });

  it("marks interrupted jobs failed on restart and never fakes a PASS", async () => {
    const store = new JobStore(tempDir("recover-"));
    const record = jobRecord({ state: "running", phase: "running", pid: 999_999, procStart: "dead-start" });
    store.create(record);
    const engine = new JobEngine({ pin: fakePin(), store, env: { PATH: "/usr/bin:/bin" }, spawnRunner: () => {
      throw new Error("must not spawn during recovery");
    } });
    engine.recover();
    const latest = store.read(record.jobId);
    expect(latest.state).toBe("failed");
    expect(latest.failure).toMatchObject({ code: "host.hostRestarted" });
    expect(store.readEvents(record.jobId).at(-1)?.method).toBe("job.state");
  });

  it("requires a spec file to exist before queueing", async () => {
    const store = new JobStore(tempDir("missing-"));
    const engine = new JobEngine({ pin: fakePin(), store, env: { PATH: "/usr/bin:/bin" }, spawnRunner: () => {
      throw new Error("must not spawn");
    } });
    await expect(
      engine.generate({
        specPath: "/nonexistent/spec.json",
        specsDir: "/nonexistent",
        task: "p02_min2",
        budget: 30_000,
        emit: () => {},
      }),
    ).rejects.toThrow();
  });
});
