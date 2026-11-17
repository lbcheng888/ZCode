import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { HostError } from "./errors.js";
import type { ChengRunMode, RuntimePin } from "./runtime.js";

export interface RunnerOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly runId: string | null;
  readonly runDir: string | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface RunnerHandle {
  readonly pid: number;
  readonly pgid: number;
  readonly procStart: string | null;
  wait(): Promise<RunnerOutcome>;
  signalTree(signal: NodeJS.Signals): boolean;
  isTreeAlive(): boolean;
}

export interface StartRunnerInput {
  readonly pin: RuntimePin;
  readonly jobDir: string;
  readonly specsDir: string;
  readonly bundleDir?: string | null;
  readonly task: string;
  readonly mode: ChengRunMode;
  readonly budget: number;
  readonly allowDraftUnowned?: boolean;
  readonly moves?: "macro" | null;
  readonly useLiblearn?: boolean;
  readonly env: Record<string, string>;
}

export function buildRunnerArgs(input: {
  pin: RuntimePin;
  outDir: string;
  specsDir: string;
  bundleDir?: string | null;
  task: string;
  mode: ChengRunMode;
  budget: number;
  allowDraftUnowned?: boolean;
  moves?: "macro" | null;
  useLiblearn?: boolean;
}): string[] {
  const args = [
    `--out:${input.outDir}`,
    `--specs:${input.specsDir}`,
    `--tasks:${input.task}`,
    `--budget:${String(input.budget)}`,
  ];

  if (input.mode === "production") {
    const slot = input.pin.productionSlot;
    if (slot === null) {
      throw new HostError("host.runtimeUnavailable", "production slot is not available in runtime pin");
    }
    args.push(`--core0-driver:${slot.driverPath}`);
    args.push(`--core0-driver-sha:${slot.driverSha256}`);
    for (const donorPath of slot.donorPaths) {
      args.push(`--link-donor:${donorPath}`);
    }
    args.push(`--link-donor-provenance:${slot.donorProvenancePath}`);
  } else {
    if (input.pin.diagnosticSlot === null) {
      throw new HostError("host.runtimeUnavailable", "diagnostic slot is not available in runtime pin");
    }
    args.push("--diagnostic");
  }

  if (input.bundleDir !== undefined && input.bundleDir !== null && input.bundleDir.length > 0) {
    args.push(`--bundle-root:${input.bundleDir}`);
  }
  if (input.allowDraftUnowned === true) {
    args.push("--allow-draft-unowned");
  }
  if (input.moves === "macro") {
    args.push("--moves:macro");
  }
  if (input.useLiblearn === true && input.pin.activeSeedPin !== null) {
    args.push(`--liblearn:${input.pin.activeSeedPin.path}`);
  }

  return args;
}

/**
 * Spawn the pinned CSG v2 runner in its own process group. Verdicts are never
 * parsed from stdout; the run volume on disk is the only evidence source.
 */
export function startRunner(input: StartRunnerInput): RunnerHandle {
  const outDir = join(input.jobDir, "out");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  // Pure Cheng selfhost system-link-exec has a ~255-byte CLI arg buffer on --out/--report-out;
  // stage in a short /tmp dir when outDir > 100 bytes, then move runs/ back into outDir on exit.
  const useShortStage = Buffer.byteLength(outDir, "utf8") > 100;
  const stageOutDir = useShortStage
    ? `/tmp/ch-${createHash("sha256").update(outDir).digest("hex").slice(0, 12)}-${String(process.pid)}`
    : outDir;
  if (useShortStage) {
    rmSync(stageOutDir, { recursive: true, force: true });
    mkdirSync(stageOutDir, { recursive: true, mode: 0o700 });
  }

  const stdoutPath = join(input.jobDir, "runner.stdout.log");
  const stderrPath = join(input.jobDir, "runner.stderr.log");
  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");

  const args = buildRunnerArgs({
    pin: input.pin,
    outDir: stageOutDir,
    specsDir: input.specsDir,
    ...(input.bundleDir === undefined ? {} : { bundleDir: input.bundleDir }),
    task: input.task,
    mode: input.mode,
    budget: input.budget,
    ...(input.allowDraftUnowned === undefined ? {} : { allowDraftUnowned: input.allowDraftUnowned }),
    ...(input.moves === undefined ? {} : { moves: input.moves }),
    ...(input.useLiblearn === undefined ? {} : { useLiblearn: input.useLiblearn }),
  });

  const child = spawn(input.pin.runnerPath, args, {
    cwd: input.pin.chengRoot,
    env: input.env,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });

  closeSync(stdoutFd);
  closeSync(stderrFd);

  if (child.pid === undefined) {
    if (useShortStage) {
      rmSync(stageOutDir, { recursive: true, force: true });
    }
    throw new HostError("host.internal", "runner did not return a pid", {
      evidence: [`runner=${input.pin.runnerPath}`],
    });
  }
  const pid = child.pid;
  const pgid = pid;
  const procStart = currentProcStart(pid);

  const completion = new Promise<RunnerOutcome>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (useShortStage && existsSync(stageOutDir)) {
        try {
          cpSync(stageOutDir, outDir, { recursive: true, force: true, verbatimSymlinks: true });
        } catch {
          // Best-effort copy; resolveRunVolume below will fail closed if missing.
        } finally {
          rmSync(stageOutDir, { recursive: true, force: true });
        }
      }
      const resolved = resolveRunVolume(outDir);
      resolve({
        exitCode,
        signal,
        runId: resolved.runId,
        runDir: resolved.runDir,
        stdoutTail: readTail(stdoutPath),
        stderrTail: readTail(stderrPath),
      });
    };
    child.once("exit", finish);
    child.once("error", () => {
      finish(null, null);
    });
  });

  return {
    pid,
    pgid,
    procStart,
    wait: () => completion,
    signalTree: (signal) => signalProcessGroup(pgid, signal),
    isTreeAlive: () => isProcessGroupAlive(pgid),
  };
}

function resolveRunVolume(outDir: string): { runId: string | null; runDir: string | null } {
  const latest = join(outDir, "latest");
  if (!existsSync(latest)) {
    return { runId: null, runDir: null };
  }
  let target: string;
  try {
    target = readlinkSync(latest);
  } catch {
    return { runId: null, runDir: null };
  }
  const match = /^runs\/([^/]+)$/.exec(target);
  if (match === null) {
    return { runId: null, runDir: null };
  }
  const runId = match[1];
  if (runId === undefined || runId.length === 0) {
    return { runId: null, runDir: null };
  }
  const runDir = join(outDir, "runs", runId);
  try {
    if (!statSync(runDir).isDirectory()) {
      return { runId: null, runDir: null };
    }
  } catch {
    return { runId: null, runDir: null };
  }
  return { runId, runDir };
}

function readTail(path: string, maxBytes = 4000): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length <= maxBytes ? text : text.slice(text.length - maxBytes);
  } catch {
    return "";
  }
}

/** `ps -o lstart=` is stable enough to detect a reused pid at recovery time. */
export function currentProcStart(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  const value = (result.stdout ?? "").trim();
  return value.length > 0 ? value : null;
}

export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32") {
    throw new HostError("host.platformUnsupported", "process-group signals are POSIX only");
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return false;
    }
    throw error;
  }
}

export function isProcessGroupAlive(pgid: number): boolean {
  if (process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return false;
    }
    return true;
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
