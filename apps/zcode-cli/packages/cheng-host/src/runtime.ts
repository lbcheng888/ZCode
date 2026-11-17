import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { parseDonorsTsv } from "@zcode/cheng-contract";

import { HostError } from "./errors.js";

export type ChengRunMode = "production" | "diagnostic";

export interface ProductionSlot {
  readonly driverPath: string;
  readonly driverSha256: string;
  readonly provenancePath: string;
  readonly provenanceReportSha256: string;
  readonly linkerPath: string;
  readonly linkerSha256: string;
  readonly donorsListPath: string;
  readonly donorsListSha256: string;
  readonly donorProvenancePath: string;
  readonly donorProvenanceSha256: string;
  readonly donorCount: number;
  readonly donorPaths: readonly string[];
}

export interface DiagnosticSlot {
  readonly driverPath: string;
  readonly driverSha256: string;
}

export interface ActiveSeedPin {
  readonly path: string;
  readonly sha256: string;
}

export interface ToolchainPinV2 {
  /** Real path of the pinned cheng-lang checkout. */
  readonly chengRoot: string;
  readonly headSha: string;
  readonly runnerPath: string;
  readonly runnerSha256: string;
  readonly driverPath: string;
  readonly driverSha256: string;
  readonly productionSlot: ProductionSlot | null;
  readonly diagnosticSlot: DiagnosticSlot | null;
  readonly readyModes: readonly ChengRunMode[];
  readonly activeSeedPin: ActiveSeedPin | null;
}

export type RuntimePin = ToolchainPinV2;

export const PRODUCTION_DRIVER_REL = "artifacts/bootstrap/cheng.stage3";
export const PRODUCTION_PROVENANCE_REL = "artifacts/bootstrap/cheng.stage3.provenance.txt";
export const PRODUCTION_LINKER_REL = "artifacts/bootstrap/cheng.linker";
export const DONORS_LIST_REL = "artifacts/csg_donors/donors.list";
export const DONOR_PROVENANCE_REL = "artifacts/csg_donors/donor_provenance.tsv";
export const DIAGNOSTIC_DRIVER_REL = "artifacts/bootstrap/cheng.stage3.diagnostic";
export const ACTIVE_SEED_REL = ".c0run/four_layer_r2/sleep_prior/m5_prior.seed";

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
 * Resolve and verify the runtime checkout with dual-slot probing (ToolchainPinV2).
 * Succeeds if at least one slot (production or diagnostic) is valid; any SHA
 * mismatch or missing both slots fails closed with host.runtimeUnavailable.
 */
export function probeRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform } = {},
): ToolchainPinV2 {
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
  const runnerSha256 = sha256File(runnerPath);

  const productionSlot = probeProductionSlot(root);
  const diagnosticSlot = probeDiagnosticSlot(root, env);

  const readyModes: ChengRunMode[] = [];
  if (productionSlot !== null) readyModes.push("production");
  if (diagnosticSlot !== null) readyModes.push("diagnostic");

  if (readyModes.length === 0) {
    throw new HostError(
      "host.runtimeUnavailable",
      "neither productionSlot nor diagnosticSlot is available",
      {
        evidence: [
          `productionDriver=${join(root, PRODUCTION_DRIVER_REL)}`,
          `diagnosticDriver=${env.ZCODE_CHENG_DIAGNOSTIC_DRIVER ?? join(root, DIAGNOSTIC_DRIVER_REL)}`,
        ],
      },
    );
  }

  const activeSeedCandidate = join(root, ACTIVE_SEED_REL);
  let activeSeedPin: ActiveSeedPin | null = null;
  if (existsSync(activeSeedCandidate)) {
    try {
      if (statSync(activeSeedCandidate).isFile()) {
        activeSeedPin = {
          path: activeSeedCandidate,
          sha256: sha256File(activeSeedCandidate),
        };
      }
    } catch {
      activeSeedPin = null;
    }
  }

  const primaryDriverPath = productionSlot?.driverPath ?? diagnosticSlot!.driverPath;
  const primaryDriverSha256 = productionSlot?.driverSha256 ?? diagnosticSlot!.driverSha256;

  return {
    chengRoot: root,
    headSha,
    runnerPath,
    runnerSha256,
    driverPath: primaryDriverPath,
    driverSha256: primaryDriverSha256,
    productionSlot,
    diagnosticSlot,
    readyModes,
    activeSeedPin,
  };
}

function probeProductionSlot(root: string): ProductionSlot | null {
  const driverPath = join(root, PRODUCTION_DRIVER_REL);
  const provenancePath = join(root, PRODUCTION_PROVENANCE_REL);
  const linkerPath = join(root, PRODUCTION_LINKER_REL);
  const donorsListPath = join(root, DONORS_LIST_REL);
  const donorProvenancePath = join(root, DONOR_PROVENANCE_REL);

  const requiredFiles = [
    driverPath,
    provenancePath,
    linkerPath,
    donorsListPath,
    donorProvenancePath,
  ];
  const anyPresent = requiredFiles.some((p) => existsSync(p));
  if (!anyPresent) {
    return null;
  }
  for (const p of requiredFiles) {
    if (!existsSync(p)) {
      throw new HostError("host.runtimeUnavailable", `production slot incomplete: missing ${p}`, {
        evidence: [`missing=${p}`],
      });
    }
  }

  assertExecutable(driverPath, "production driver");
  assertExecutable(linkerPath, "production linker");

  const driverSha256 = sha256File(driverPath);
  const linkerSha256 = sha256File(linkerPath);
  const provenanceText = readFileSync(provenancePath, "utf8");
  const provenanceReportSha256 = sha256Text(provenanceText);
  const kv = parseProvenanceKeyValues(provenanceText, provenancePath);

  if (kv.get("compiler_executable_sha256") !== driverSha256) {
    throw new HostError(
      "host.runtimeUnavailable",
      "production provenance compiler_executable_sha256 mismatch",
      {
        evidence: [
          `expected=${driverSha256}`,
          `actual=${kv.get("compiler_executable_sha256") ?? "<missing>"}`,
        ],
      },
    );
  }
  if (kv.get("cold_system_link_exec") !== "0") {
    throw new HostError(
      "host.runtimeUnavailable",
      "production provenance cold_system_link_exec must be 0",
      { evidence: [`actual=${kv.get("cold_system_link_exec") ?? "<missing>"}`] },
    );
  }

  const donorsListText = readFileSync(donorsListPath, "utf8");
  const donorsListSha256 = sha256Text(donorsListText);
  const rawDonorLines = donorsListText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (rawDonorLines.length === 0) {
    throw new HostError("host.runtimeUnavailable", "production donors.list is empty", {
      evidence: [`donorsListPath=${donorsListPath}`],
    });
  }

  const donorPaths = rawDonorLines.map((entry) =>
    isAbsolute(entry) ? entry : resolve(root, entry),
  );
  for (const objPath of donorPaths) {
    if (!existsSync(objPath) || !statSync(objPath).isFile()) {
      throw new HostError("host.runtimeUnavailable", `production donor object missing: ${objPath}`, {
        evidence: [`donor=${objPath}`],
      });
    }
  }

  const donorProvenanceText = readFileSync(donorProvenancePath, "utf8");
  const donorProvenanceSha256 = sha256Text(donorProvenanceText);
  let provenanceRows;
  try {
    provenanceRows = parseDonorsTsv(donorProvenanceText, donorProvenancePath);
  } catch (error) {
    throw new HostError(
      "host.runtimeUnavailable",
      `production donor_provenance.tsv invalid: ${error instanceof Error ? error.message : String(error)}`,
      { evidence: [`donorProvenancePath=${donorProvenancePath}`] },
    );
  }

  if (provenanceRows.length !== donorPaths.length) {
    throw new HostError(
      "host.runtimeUnavailable",
      `donor count mismatch: donors.list=${donorPaths.length} vs donor_provenance.tsv=${provenanceRows.length}`,
      { evidence: [`donorsList=${donorPaths.length}`, `provenance=${provenanceRows.length}`] },
    );
  }

  for (let i = 0; i < donorPaths.length; i += 1) {
    const objPath = donorPaths[i]!;
    const row = provenanceRows[i]!;
    const actualSha = sha256File(objPath);
    if (actualSha !== row.objectSha256) {
      throw new HostError(
        "host.runtimeUnavailable",
        `donor object sha256 mismatch at index ${row.index}: ${objPath}`,
        { evidence: [`expected=${row.objectSha256}`, `actual=${actualSha}`] },
      );
    }
    if (row.compilerSha256 !== driverSha256) {
      throw new HostError(
        "host.runtimeUnavailable",
        `donor compiler_sha256 mismatch at index ${row.index}`,
        { evidence: [`expected=${driverSha256}`, `actual=${row.compilerSha256}`] },
      );
    }
  }

  return {
    driverPath,
    driverSha256,
    provenancePath,
    provenanceReportSha256,
    linkerPath,
    linkerSha256,
    donorsListPath,
    donorsListSha256,
    donorProvenancePath,
    donorProvenanceSha256,
    donorCount: donorPaths.length,
    donorPaths,
  };
}

function probeDiagnosticSlot(root: string, env: NodeJS.ProcessEnv): DiagnosticSlot | null {
  const override = env.ZCODE_CHENG_DIAGNOSTIC_DRIVER?.trim() ?? "";
  if (override.length > 0) {
    const resolved = resolve(override);
    assertExecutable(resolved, "diagnostic driver (ZCODE_CHENG_DIAGNOSTIC_DRIVER)");
    return {
      driverPath: resolved,
      driverSha256: sha256File(resolved),
    };
  }
  const defaultPath = join(root, DIAGNOSTIC_DRIVER_REL);
  if (!existsSync(defaultPath)) {
    return null;
  }
  assertExecutable(defaultPath, "diagnostic driver");
  return {
    driverPath: defaultPath,
    driverSha256: sha256File(defaultPath),
  };
}

function parseProvenanceKeyValues(text: string, sourcePath: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key.length > 0) {
      map.set(key, val);
    }
  }
  if (map.size === 0) {
    throw new HostError("host.runtimeUnavailable", `empty provenance report: ${sourcePath}`);
  }
  return map;
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
