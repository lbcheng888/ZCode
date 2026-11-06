import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JobRecord } from "../src/job-store.js";
import type { RunnerHandle, RunnerOutcome, StartRunnerInput } from "../src/runner.js";
import type { RuntimePin } from "../src/runtime.js";

export function tempDir(prefix = "cheng-host-"): string {
  // `mkdtemp` lies inside /var on macOS; roots are compared after realpath.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function sha256(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function fakePin(overrides: Partial<RuntimePin> = {}): RuntimePin {
  return {
    chengRoot: "/tmp/fake-cheng-root",
    headSha: "a".repeat(40),
    runnerPath: "/tmp/fake-runner",
    runnerSha256: "b".repeat(64),
    driverPath: "/tmp/fake-driver",
    driverSha256: "c".repeat(64),
    ...overrides,
  };
}

export function jobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    version: 1,
    jobId: "d".repeat(64),
    baseKey: "e".repeat(64),
    attempt: null,
    state: "queued",
    phase: "queued",
    seq: 0,
    createdAt: "2026-11-06T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    specPath: "/tmp/spec.json",
    specsDir: "/tmp",
    task: "p02_min2",
    mode: "diagnostic",
    budget: 30_000,
    cancelRequested: false,
    pid: null,
    pgid: null,
    procStart: null,
    runId: null,
    runDir: null,
    exitCode: null,
    failure: null,
    ...overrides,
  };
}

export function writeSpec(dir: string, task = "p02_min2"): string {
  const path = join(dir, `${task}.spec.json`);
  writeFileSync(path, `${JSON.stringify({ task, modules: [] }, null, 2)}\n`);
  return path;
}

export interface FakeRunner {
  readonly handle: RunnerHandle;
  readonly signals: NodeJS.Signals[];
  finish(outcome: Partial<RunnerOutcome>): void;
}

const EMPTY_OUTCOME: RunnerOutcome = {
  exitCode: null,
  signal: null,
  runId: null,
  runDir: null,
  stdoutTail: "",
  stderrTail: "",
};

export function fakeRunner(options: { onSignal?: "resolve" | "ignore" } = {}): FakeRunner {
  const signals: NodeJS.Signals[] = [];
  let resolveWait: ((outcome: RunnerOutcome) => void) | null = null;
  const wait = new Promise<RunnerOutcome>((resolve) => {
    resolveWait = resolve;
  });
  const finish = (outcome: Partial<RunnerOutcome>): void => {
    resolveWait?.({ ...EMPTY_OUTCOME, ...outcome });
  };
  const handle: RunnerHandle = {
    pid: 4242,
    pgid: 4242,
    procStart: "fake-start",
    wait: () => wait,
    signalTree: (signal) => {
      signals.push(signal);
      if (options.onSignal !== "ignore") {
        finish({ exitCode: 143, signal });
      }
      return true;
    },
    isTreeAlive: () => false,
  };
  return { handle, signals, finish };
}

export interface CapturedSpawn {
  readonly input: StartRunnerInput;
  readonly fake: FakeRunner;
}

export async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs = 5_000,
  stepMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null && value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("waitFor timed out");
}
