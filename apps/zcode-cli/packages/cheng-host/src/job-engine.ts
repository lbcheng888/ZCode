import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { classifyRunnerExit } from "@zcode/cheng-contract";

import { canonicalJson } from "./canonical.js";
import { HostError, toHostError } from "./errors.js";
import { JobStore, type JobFailureValue, type JobRecord } from "./job-store.js";
import {
  EventFrameSchema,
  type EventFrame,
  type GenerateResult,
  type JobCancelResult,
  type JobStatus,
} from "./protocol.js";
import {
  currentProcStart,
  isProcessGroupAlive,
  signalProcessGroup,
  startRunner,
  type RunnerHandle,
  type RunnerOutcome,
  type StartRunnerInput,
} from "./runner.js";
import { sha256Text, type RuntimePin } from "./runtime.js";

export type Emit = (event: EventFrame) => void;

const TERMINAL_STATES: ReadonlySet<JobRecord["state"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export interface GenerateInput {
  readonly specPath: string;
  readonly specsDir: string;
  readonly task: string;
  readonly budget: number;
  readonly attempt?: string;
  readonly emit: Emit;
}

interface ActiveJob {
  readonly jobId: string;
  readonly handle: RunnerHandle;
  heartbeat: NodeJS.Timeout | null;
}

export interface JobEngineOptions {
  readonly pin: RuntimePin;
  readonly store: JobStore;
  readonly env: Record<string, string>;
  readonly maxQueued?: number;
  readonly heartbeatMs?: number;
  readonly now?: () => Date;
  readonly spawnRunner?: (input: StartRunnerInput) => RunnerHandle;
  readonly terminateGraceMs?: number;
  readonly killGraceMs?: number;
}

/**
 * Single-writer job engine. `job.json` is the authority for state, dedup and
 * recovery; the in-memory queue is only a scheduler and never a second state
 * source.
 */
export class JobEngine {
  private readonly store: JobStore;
  private readonly pin: RuntimePin;
  private readonly env: Record<string, string>;
  private readonly maxQueued: number;
  private readonly heartbeatMs: number;
  private readonly now: () => Date;
  private readonly spawnRunner: (input: StartRunnerInput) => RunnerHandle;
  private readonly terminateGraceMs: number;
  private readonly killGraceMs: number;
  private readonly queue: string[] = [];
  private readonly emitters = new Map<string, Emit>();
  private readonly activeJobs = new Map<string, ActiveJob>();
  private closing = false;

  constructor(options: JobEngineOptions) {
    this.store = options.store;
    this.pin = options.pin;
    this.env = options.env;
    this.maxQueued = options.maxQueued ?? 8;
    this.heartbeatMs = options.heartbeatMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
    this.spawnRunner = options.spawnRunner ?? startRunner;
    this.terminateGraceMs = options.terminateGraceMs ?? 10_000;
    this.killGraceMs = options.killGraceMs ?? 5_000;
  }

  /**
   * Mark in-flight jobs from a previous host as failed. A process group is
   * killed only when `ps` still reports the recorded start stamp; an
   * unverifiable identity is left alone and surfaced, never guessed.
   */
  recover(): void {
    for (const record of this.store.list()) {
      if (record.state !== "queued" && record.state !== "running") {
        continue;
      }
      if (record.state === "running" && record.pid !== null && record.procStart !== null) {
        const current = currentProcStart(record.pid);
        if (current !== null && current === record.procStart) {
          signalProcessGroup(record.pgid ?? record.pid, "SIGKILL");
        }
      }
      this.failRecord(
        record,
        new HostError("host.hostRestarted", "job interrupted by host restart", {
          evidence: [`state=${record.state}`, `pid=${String(record.pid ?? "-")}`],
        }),
      );
    }
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    if (this.closing) {
      throw new HostError("host.shutdown", "host is shutting down");
    }
    const specSha = createHash("sha256").update(readFileSync(input.specPath)).digest("hex");
    const baseKey = sha256Text(
      canonicalJson({
        v: 1,
        specSha256: specSha,
        task: input.task,
        mode: "diagnostic",
        budget: input.budget,
        headSha: this.pin.headSha,
      }),
    );
    const attempt = input.attempt ?? null;
    const jobId = sha256Text(canonicalJson({ v: 1, baseKey, attempt }));

    if (this.store.has(jobId)) {
      const existing = this.store.read(jobId);
      if (!TERMINAL_STATES.has(existing.state)) {
        this.emitters.set(jobId, input.emit);
      }
      return { jobId, dedupKey: baseKey, state: existing.state };
    }

    if (this.queue.length >= this.maxQueued) {
      throw new HostError("host.busy", `queue is full (${String(this.maxQueued)})`, {
        evidence: [`queued=${String(this.queue.length)}`],
      });
    }

    const record: JobRecord = {
      version: 1,
      jobId,
      baseKey,
      attempt,
      state: "queued",
      phase: "queued",
      seq: 0,
      createdAt: this.now().toISOString(),
      startedAt: null,
      finishedAt: null,
      specPath: input.specPath,
      specsDir: input.specsDir,
      task: input.task,
      mode: "diagnostic",
      budget: input.budget,
      cancelRequested: false,
      pid: null,
      pgid: null,
      procStart: null,
      runId: null,
      runDir: null,
      exitCode: null,
      failure: null,
    };
    this.store.create(record);
    this.emitters.set(jobId, input.emit);
    this.queue.push(jobId);
    this.pump();
    return { jobId, dedupKey: baseKey, state: this.store.read(jobId).state };
  }

  status(jobId: string): JobStatus {
    return toStatus(this.store.read(jobId));
  }

  record(jobId: string): JobRecord {
    return this.store.read(jobId);
  }

  hasActiveJobs(): boolean {
    return this.activeJobs.size > 0 || this.queue.length > 0;
  }

  async cancel(jobId: string): Promise<JobCancelResult> {
    let record = this.store.read(jobId);
    if (TERMINAL_STATES.has(record.state)) {
      return { jobId, cancelRequested: record.cancelRequested, state: record.state };
    }

    if (record.state === "queued") {
      const index = this.queue.indexOf(jobId);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
      record = {
        ...record,
        cancelRequested: true,
        state: "cancelled",
        phase: "cancelled",
        finishedAt: this.now().toISOString(),
      };
      this.store.write(record);
      this.emitTerminal(record);
      return { jobId, cancelRequested: true, state: "cancelled" };
    }

    record = { ...record, cancelRequested: true };
    this.store.write(record);
    const active = this.activeJobs.get(jobId);
    if (active !== undefined) {
      active.handle.signalTree("SIGTERM");
      if (!(await this.waitForTerminal(jobId, this.terminateGraceMs))) {
        active.handle.signalTree("SIGKILL");
        if (!(await this.waitForTerminal(jobId, this.killGraceMs))) {
          const current = this.store.read(jobId);
          if (!TERMINAL_STATES.has(current.state)) {
            this.failRecord(
              current,
              new HostError("host.processTreeLeaked", "process tree did not exit after SIGKILL", {
                evidence: [`pid=${String(current.pid ?? "-")}`, `pgid=${String(current.pgid ?? "-")}`],
              }),
            );
          }
        }
      }
    }
    return this.cancelResult(jobId);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const jobId of this.queue.slice()) {
      const record = this.store.read(jobId);
      if (record.state !== "queued") {
        continue;
      }
      this.store.write({
        ...record,
        cancelRequested: true,
        state: "cancelled",
        phase: "cancelled",
        finishedAt: this.now().toISOString(),
      });
      this.emitTerminal(this.store.read(jobId));
    }
    this.queue.length = 0;

    for (const [jobId, active] of this.activeJobs) {
      const record = this.store.read(jobId);
      if (TERMINAL_STATES.has(record.state)) {
        continue;
      }
      this.store.write({ ...record, cancelRequested: true });
      active.handle.signalTree("SIGTERM");
      if (!(await this.waitForTerminal(jobId, this.terminateGraceMs))) {
        active.handle.signalTree("SIGKILL");
        if (!(await this.waitForTerminal(jobId, this.killGraceMs))) {
          const latest = this.store.read(jobId);
          if (!TERMINAL_STATES.has(latest.state) && !isProcessGroupAlive(active.handle.pgid)) {
            this.failRecord(latest, new HostError("host.shutdown", "host stopped while job was running"));
          }
        }
      }
    }
  }

  /** Test-only scheduler drain; production callers use job.status/events. */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.activeJobs.size > 0) {
      await delay(50);
    }
  }

  private pump(): void {
    if (this.closing || this.activeJobs.size > 0) {
      return;
    }
    while (this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (jobId === undefined) {
        return;
      }
      if (this.store.read(jobId).state !== "queued") {
        continue;
      }
      void this.runJob(jobId);
      return;
    }
  }

  private async runJob(jobId: string): Promise<void> {
    let record = this.store.read(jobId);
    if (record.state !== "queued") {
      this.pump();
      return;
    }
    if (record.cancelRequested) {
      this.store.write({
        ...record,
        state: "cancelled",
        phase: "cancelled",
        finishedAt: this.now().toISOString(),
      });
      this.emitTerminal(this.store.read(jobId));
      this.pump();
      return;
    }

    record = {
      ...record,
      state: "running",
      phase: "spawn",
      startedAt: this.now().toISOString(),
    };
    this.store.write(record);
    this.emitState(record);

    let handle: RunnerHandle;
    try {
      handle = this.spawnRunner({
        pin: this.pin,
        jobDir: this.store.jobDir(jobId),
        specsDir: record.specsDir,
        task: record.task,
        budget: record.budget,
        env: this.env,
      });
    } catch (error) {
      this.failRecord(this.store.read(jobId), toHostError(error));
      this.pump();
      return;
    }

    record = {
      ...record,
      pid: handle.pid,
      pgid: handle.pgid,
      procStart: handle.procStart,
      phase: "running",
    };
    this.store.write(record);
    this.emitState(record);

    const active: ActiveJob = {
      jobId,
      handle,
      heartbeat: setInterval(() => {
        this.emitProgress(jobId);
      }, this.heartbeatMs),
    };
    this.activeJobs.set(jobId, active);

    // A cancel that arrived between spawn and registration must still win.
    if (this.store.read(jobId).cancelRequested) {
      handle.signalTree("SIGTERM");
    }

    const outcome = await handle.wait();
    if (active.heartbeat !== null) {
      clearInterval(active.heartbeat);
      active.heartbeat = null;
    }
    this.activeJobs.delete(jobId);
    this.finishFromOutcome(jobId, outcome);
    this.pump();
  }

  private finishFromOutcome(jobId: string, outcome: RunnerOutcome): void {
    const record = this.store.read(jobId);
    if (TERMINAL_STATES.has(record.state)) {
      return;
    }

    if (record.cancelRequested) {
      this.store.write({
        ...record,
        state: "cancelled",
        phase: "cancelled",
        finishedAt: this.now().toISOString(),
        exitCode: outcome.exitCode,
        runId: outcome.runId,
        runDir: outcome.runDir,
      });
      this.emitTerminal(this.store.read(jobId));
      return;
    }

    if (outcome.exitCode === 41) {
      if (outcome.runId === null || outcome.runDir === null) {
        this.failRecord(
          this.store.read(jobId),
          new HostError("host.runVolumeMissing", "diagnostic run exited 41 but produced no run volume", {
            evidence: ["exit=41", `stdout_tail=${outcome.stdoutTail.slice(-500)}`],
          }),
        );
        return;
      }
      this.store.write({
        ...record,
        state: "succeeded",
        phase: "done",
        finishedAt: this.now().toISOString(),
        exitCode: 41,
        runId: outcome.runId,
        runDir: outcome.runDir,
      });
      this.emitTerminal(this.store.read(jobId));
      return;
    }

    if (outcome.exitCode === 0) {
      this.failRecord(
        this.store.read(jobId),
        new HostError(
          "host.unexpectedExit",
          "diagnostic mode returned 0; production PASS is not accepted in P2",
          { evidence: ["exit=0", `stdout_tail=${outcome.stdoutTail.slice(-500)}`] },
        ),
      );
      return;
    }

    const evidence = buildFailureEvidence(outcome);
    let failure: JobFailureValue;
    if (outcome.exitCode === null) {
      failure = new HostError("host.unknownRunnerExit", "runner ended without an exit code", {
        evidence,
      }).toPayload();
    } else {
      try {
        const classified = classifyRunnerExit(outcome.exitCode, evidence);
        failure =
          classified === null
            ? new HostError("host.unexpectedExit", "runner reported PASS without diagnostic evidence", {
                evidence,
              }).toPayload()
            : classified;
      } catch (error) {
        failure = new HostError(
          "host.unknownRunnerExit",
          `unclassified runner exit ${String(outcome.exitCode)}`,
          { evidence: [...evidence, error instanceof Error ? error.message : String(error)] },
        ).toPayload();
      }
    }

    this.store.write({
      ...record,
      state: "failed",
      phase: "failed",
      finishedAt: this.now().toISOString(),
      exitCode: outcome.exitCode,
      failure,
      runId: outcome.runId,
      runDir: outcome.runDir,
    });
    this.emitTerminal(this.store.read(jobId));
  }

  private failRecord(record: JobRecord, error: HostError): void {
    this.store.write({
      ...record,
      state: "failed",
      phase: "failed",
      finishedAt: this.now().toISOString(),
      failure: error.toPayload(),
    });
    this.emitTerminal(this.store.read(record.jobId));
  }

  private emitState(record: JobRecord): void {
    this.event(record, "job.state");
  }

  private emitTerminal(record: JobRecord): void {
    this.event(record, "job.state", true);
  }

  private emitProgress(jobId: string): void {
    const record = this.store.read(jobId);
    if (record.state !== "running") {
      return;
    }
    this.event(record, "job.progress");
  }

  private event(record: JobRecord, method: "job.progress" | "job.state", terminal = false): EventFrame {
    const seq = record.seq + 1;
    const startedMs = record.startedAt === null ? null : Date.parse(record.startedAt);
    const params = {
      jobId: record.jobId,
      seq,
      state: record.state,
      phase: record.phase,
      at: this.now().toISOString(),
      elapsedMs: startedMs === null ? 0 : Math.max(0, Date.now() - startedMs),
      ...(record.runId === null ? {} : { runId: record.runId }),
      ...(record.exitCode === null ? {} : { exitCode: record.exitCode }),
      ...(record.failure === null ? {} : { error: record.failure }),
    };
    const frame = EventFrameSchema.parse({
      v: 1,
      t: "evt",
      id: record.jobId,
      method,
      params,
    });
    this.store.appendEvent(record.jobId, frame);
    this.store.write({ ...record, seq });
    const emit = this.emitters.get(record.jobId);
    if (emit !== undefined) {
      emit(frame);
    }
    if (terminal) {
      this.emitters.delete(record.jobId);
    }
    return frame;
  }

  private async waitForTerminal(jobId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (TERMINAL_STATES.has(this.store.read(jobId).state)) {
        return true;
      }
      await delay(100);
    }
    return TERMINAL_STATES.has(this.store.read(jobId).state);
  }

  private cancelResult(jobId: string): JobCancelResult {
    const record = this.store.read(jobId);
    return { jobId, cancelRequested: record.cancelRequested, state: record.state };
  }
}

function toStatus(record: JobRecord): JobStatus {
  return {
    jobId: record.jobId,
    baseKey: record.baseKey,
    attempt: record.attempt,
    state: record.state,
    phase: record.phase,
    seq: record.seq,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    cancelRequested: record.cancelRequested,
    runId: record.runId,
    runDir: record.runDir,
    exitCode: record.exitCode,
    error: record.failure,
  };
}

function buildFailureEvidence(outcome: RunnerOutcome): string[] {
  const evidence = [`exit=${String(outcome.exitCode ?? "signal")}`, `signal=${outcome.signal ?? "-"}`];
  const stdout = outcome.stdoutTail.trim();
  if (stdout.length > 0) {
    evidence.push(`stdout_tail=${stdout.slice(-1000)}`);
  }
  const stderr = outcome.stderrTail.trim();
  if (stderr.length > 0) {
    evidence.push(`stderr_tail=${stderr.slice(-1000)}`);
  }
  return evidence;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
