import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { HostError } from "./errors.js";

export interface RuntimePin {
  /** Real path of the pinned cheng-lang checkout. */
  readonly chengRoot: string;
  readonly headSha: string;
  readonly runnerPath: string;
  readonly runnerSha256: string;
  readonly driverPath: string;
  readonly driverSha256: string;
}

/** Diagnostic driver pinned by the runner script itself. */
export const DIAGNOSTIC_DRIVER_REL = "artifacts/bootstrap/cheng.stage3.bak.bd9a95ce";

const RUNNER_REL = "tools/csg_spec_v2_cli_run";

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface ExpectedPins {
  readonly headSha?: string;
  readonly runnerSha256?: string;
  readonly driverSha256?: string;
}

/**
 * Compare the probed runtime against pins supplied by the launcher. Without
 * explicit expectations the host records the probes; with them a mismatch is a
 * startup failure, never a warning.
 */
export function assertExpectedPins(pin: RuntimePin, expected: ExpectedPins): void {
  const checks: Array<[keyof ExpectedPins, string, string]> = [
    ["headSha", pin.headSha, expected.headSha ?? pin.headSha],
    ["runnerSha256", pin.runnerSha256, expected.runnerSha256 ?? pin.runnerSha256],
    ["driverSha256", pin.driverSha256, expected.driverSha256 ?? pin.driverSha256],
  ];
  for (const [field, actual, wanted] of checks) {
    if (actual !== wanted) {
      throw new HostError("host.runtimeUnavailable", `runtime pin mismatch: ${field}`, {
        evidence: [`expected=${wanted}`, `actual=${actual}`],
      });
    }
  }
}

/**
 * Resolve and verify the runtime checkout. Any missing fact is a startup
 * failure: no compiled runtime fallback, no "latest binary", no guessing.
 */
export function probeRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform } = {},
): RuntimePin {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new HostError(
      "host.platformUnsupported",
      `cheng-host P2 supports POSIX only; got ${platform}`,
      { evidence: [`platform=${platform}`] },
    );
  }

  const rawRoot = env.ZCODE_CHENG_ROOT?.trim() ?? "";
  if (rawRoot.length === 0) {
    throw new HostError("host.runtimeUnavailable", "ZCODE_CHENG_ROOT is not set", {
      evidence: ["ZCODE_CHENG_ROOT=<unset>"],
    });
  }
  const rootInput = resolve(rawRoot);
  let root: string;
  try {
    if (!statSync(rootInput).isDirectory()) {
      throw new Error("not a directory");
    }
    root = realpathSync(rootInput);
  } catch (error) {
    throw new HostError("host.runtimeUnavailable", `ZCODE_CHENG_ROOT is not a directory: ${rootInput}`, {
      evidence: [error instanceof Error ? error.message : String(error)],
    });
  }

  const workTree = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (workTree.status !== 0 || workTree.stdout.trim() !== "true") {
    throw new HostError(
      "host.runtimeUnavailable",
      "ZCODE_CHENG_ROOT must be a git work tree (git rev-parse --is-inside-work-tree != true)",
      { evidence: [workTree.stderr.trim() || workTree.stdout.trim() || `exit=${String(workTree.status)}`] },
    );
  }
  const head = runGit(root, ["rev-parse", "HEAD"]);
  const headSha = head.stdout.trim();
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new HostError("host.runtimeUnavailable", "cannot read HEAD of ZCODE_CHENG_ROOT", {
      evidence: [head.stderr.trim() || head.stdout.trim() || `exit=${String(head.status)}`],
    });
  }

  const runnerPath = join(root, RUNNER_REL);
  assertExecutable(runnerPath, "runner");
  const driverPath = join(root, DIAGNOSTIC_DRIVER_REL);
  assertExecutable(driverPath, "diagnostic driver");

  return {
    chengRoot: root,
    headSha,
    runnerPath,
    runnerSha256: sha256File(runnerPath),
    driverPath,
    driverSha256: sha256File(driverPath),
  };
}

function assertExecutable(path: string, label: string): void {
  try {
    if (!statSync(path).isFile()) {
      throw new Error("not a regular file");
    }
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw new HostError("host.runtimeUnavailable", `${label} missing or not executable: ${path}`, {
      evidence: [error instanceof Error ? error.message : String(error)],
    });
  }
}

function runGit(cwd: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new HostError("host.runtimeUnavailable", `git probe failed: ${result.error.message}`, {
      evidence: [`git -C ${cwd} ${args.join(" ")}`],
    });
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Env keys a session-scope runner may inherit. Everything else is dropped. */
export const SESSION_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "USER",
  "LOGNAME",
  "TZ",
] as const;

const CREDENTIAL_KEY_PATTERN = /TOKEN|SECRET|API_KEY|ANTHROPIC|OPENAI|ZCODE_/i;

/**
 * Build the environment for a runner process. The allowlist is structural:
 * credentials cannot be forwarded even if the host inherited them.
 */
export function buildSessionEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SESSION_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined && value.length > 0) {
      out[key] = value;
    }
  }
  out.PYTHONUNBUFFERED = "1";
  for (const key of Object.keys(out)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new HostError("host.internal", `session env leaked a credential key: ${key}`);
    }
  }
  return out;
}
