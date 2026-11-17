import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SuperAgentDecisionLogContract } from "./decision-log/contract.js";

export const MAX_EVOLUTION_RUN_VOLUMES_PER_CYCLE = 32;
export const DEFAULT_EVOLUTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface ChengEvolveRpcResult {
  readonly ok: boolean;
  readonly kind: "counterexample" | "sleep";
  readonly exitCode: number;
  readonly receiptRef: string | null;
  readonly forbiddenHoldoutReads: number;
  readonly summary: Record<string, unknown>;
}

export interface ChengEvolutionHostPort {
  evolveCounterexample(input: {
    readonly runDirs: readonly string[];
    readonly dryRun?: boolean;
  }): Promise<ChengEvolveRpcResult>;
  evolveSleep(input: {
    readonly runDirs: readonly string[];
    readonly dryRun?: boolean;
  }): Promise<ChengEvolveRpcResult>;
}

export interface ActiveSeedPinRecord {
  readonly path: string;
  readonly sha256: string;
  readonly updatedAt: number;
  readonly receiptRef: string | null;
}

export interface FourLayerCycleReceiptSummary {
  readonly cycleId: string;
  readonly timestamp: number;
  readonly runDirs: readonly string[];
  readonly forbiddenHoldoutReads: number;
  readonly netMdlSavings: number | null;
  readonly mdlVerified: boolean;
  readonly approved: boolean;
  readonly seedPinUpdated: boolean;
  readonly activeSeedPin: ActiveSeedPinRecord | null;
  readonly counterexample: {
    readonly ok: boolean;
    readonly exitCode: number;
    readonly receiptRef: string | null;
    readonly forbiddenHoldoutReads: number;
  };
  readonly sleep: {
    readonly ok: boolean;
    readonly exitCode: number;
    readonly receiptRef: string | null;
    readonly forbiddenHoldoutReads: number;
  };
}

export interface ChengEvolutionFlywheelDeps {
  readonly workspaceIdentity: string;
  readonly chengHost: ChengEvolutionHostPort;
  readonly decisionLog: SuperAgentDecisionLogContract;
  readonly runsRoots?: readonly string[];
  readonly scanRunVolumes?: () => readonly string[];
  /** Optional path to active m5_prior.seed pin JSON file. */
  readonly activeSeedPinFile?: string;
  /** Whether mandate approves applying a verified m5_prior.seed pin update. */
  readonly approved?: boolean;
  readonly dryRun?: boolean;
  readonly maxVolumes?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
  readonly onSeedPinUpdated?: (pin: ActiveSeedPinRecord) => void | Promise<void>;
}

/**
 * Scan recent production run volumes (<= 32 per cycle) from runsRoots.
 * Only directories containing production acceptance evidence are included.
 */
export function scanRecentProductionRunVolumes(input: {
  readonly runsRoots: readonly string[];
  readonly maxVolumes?: number;
  readonly maxAgeMs?: number;
  readonly now?: number;
}): string[] {
  const maxVolumes = Math.min(
    MAX_EVOLUTION_RUN_VOLUMES_PER_CYCLE,
    Math.max(1, input.maxVolumes ?? MAX_EVOLUTION_RUN_VOLUMES_PER_CYCLE),
  );
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_EVOLUTION_LOOKBACK_MS;
  const now = input.now ?? Date.now();
  const cutoff = now - maxAgeMs;

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const root of input.runsRoots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoff) continue;
      if (!isProductionRunVolume(dir)) continue;
      candidates.push({ path: dir, mtimeMs });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, maxVolumes).map((item) => item.path);
}

function isProductionRunVolume(dir: string): boolean {
  const reportPath = join(dir, "report.txt");
  if (existsSync(reportPath)) {
    try {
      const report = readFileSync(reportPath, "utf8");
      if (/^production_acceptance=1$/m.test(report)) {
        return true;
      }
    } catch {
      // fall through
    }
  }
  const manifestPath = join(dir, "runtime_manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (raw.production_acceptance === 1 || raw.productionAcceptance === true) {
        return true;
      }
    } catch {
      // fall through
    }
  }
  return false;
}

function extractNetMdlSavings(summary: Record<string, unknown>): number | null {
  for (const key of ["netMdlSavings", "net_mdl_savings", "mdlSavings", "mdl_savings"]) {
    const value = summary[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  const saved = summary.mdlSaved ?? summary.mdl_saved;
  const cost = summary.mdlCost ?? summary.mdl_cost;
  if (
    typeof saved === "number" &&
    Number.isFinite(saved) &&
    typeof cost === "number" &&
    Number.isFinite(cost)
  ) {
    return saved - cost;
  }
  return null;
}

function extractSeedPin(
  summary: Record<string, unknown>,
  timestamp: number,
  receiptRef: string | null,
): ActiveSeedPinRecord | null {
  const seedPath =
    typeof summary.seedPath === "string"
      ? summary.seedPath
      : typeof summary.seed_path === "string"
        ? summary.seed_path
        : null;
  if (seedPath === null || seedPath.trim().length === 0) return null;

  let sha256 =
    typeof summary.seedSha256 === "string"
      ? summary.seedSha256
      : typeof summary.seed_sha256 === "string"
        ? summary.seed_sha256
        : null;
  if (sha256 === null && existsSync(seedPath)) {
    try {
      sha256 = createHash("sha256").update(readFileSync(seedPath)).digest("hex");
    } catch {
      sha256 = null;
    }
  }
  if (sha256 === null || !/^[a-f0-9]{64}$/i.test(sha256)) return null;

  return {
    path: seedPath,
    sha256: sha256.toLowerCase(),
    updatedAt: timestamp,
    receiptRef,
  };
}

function writeSeedPinAtomically(pinFile: string, pin: ActiveSeedPinRecord): void {
  mkdirSync(dirname(pinFile), { recursive: true });
  const tmpFile = `${pinFile}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpFile, JSON.stringify(pin, null, 2));
  renameSync(tmpFile, pinFile);
}

/**
 * Off-Peak Four-Layer Evolution Flywheel (Wave 4):
 * 1. Scans recent production run volumes (<= 32/cycle)
 * 2. Runs evolve.counterexample (I1) and evolve.sleep (L4) via cheng-host
 * 3. Enforces forbiddenHoldoutReads === 0 and net MDL savings
 * 4. Persists FourLayerCycleReceipt summary to decision_log
 * 5. Atomically updates active m5_prior.seed pin when approved
 */
export async function runChengEvolutionFlywheelCycle(
  deps: ChengEvolutionFlywheelDeps,
): Promise<FourLayerCycleReceiptSummary | null> {
  const now = deps.now?.() ?? Date.now();
  const runDirs = deps.scanRunVolumes
    ? [...deps.scanRunVolumes()].slice(0, MAX_EVOLUTION_RUN_VOLUMES_PER_CYCLE)
    : scanRecentProductionRunVolumes({
        runsRoots: deps.runsRoots ?? [],
        ...(deps.maxVolumes === undefined ? {} : { maxVolumes: deps.maxVolumes }),
        ...(deps.maxAgeMs === undefined ? {} : { maxAgeMs: deps.maxAgeMs }),
        now,
      });

  if (runDirs.length === 0) {
    return null;
  }

  const cycleId = createHash("sha256")
    .update(JSON.stringify({ now, runDirs }))
    .digest("hex")
    .slice(0, 16);

  const counterexample = await deps.chengHost.evolveCounterexample({
    runDirs,
    ...(deps.dryRun === undefined ? {} : { dryRun: deps.dryRun }),
  });

  if (counterexample.forbiddenHoldoutReads > 0) {
    const rejected: FourLayerCycleReceiptSummary = {
      cycleId,
      timestamp: now,
      runDirs,
      forbiddenHoldoutReads: counterexample.forbiddenHoldoutReads,
      netMdlSavings: null,
      mdlVerified: false,
      approved: false,
      seedPinUpdated: false,
      activeSeedPin: null,
      counterexample: {
        ok: counterexample.ok,
        exitCode: counterexample.exitCode,
        receiptRef: counterexample.receiptRef,
        forbiddenHoldoutReads: counterexample.forbiddenHoldoutReads,
      },
      sleep: {
        ok: false,
        exitCode: -1,
        receiptRef: null,
        forbiddenHoldoutReads: 0,
      },
    };
    deps.decisionLog.record({
      workspaceIdentity: deps.workspaceIdentity,
      origin: "adjudication",
      disposition: "reject",
      modelTier: "cheng_evolution_flywheel",
      reason: JSON.stringify(rejected),
      evidence: counterexample.receiptRef ? [counterexample.receiptRef] : [],
      createdAt: now,
    });
    throw new Error(
      `Cheng evolution flywheel aborted: forbidden_holdout_reads=${String(counterexample.forbiddenHoldoutReads)}`,
    );
  }

  const sleep = await deps.chengHost.evolveSleep({
    runDirs,
    ...(deps.dryRun === undefined ? {} : { dryRun: deps.dryRun }),
  });

  const totalHoldoutReads =
    counterexample.forbiddenHoldoutReads + sleep.forbiddenHoldoutReads;
  const netMdlSavings = extractNetMdlSavings(sleep.summary);
  const mdlVerified =
    sleep.ok &&
    totalHoldoutReads === 0 &&
    (netMdlSavings === null ? true : netMdlSavings > 0);
  const approved = deps.approved === true && mdlVerified && counterexample.ok;
  const candidatePin = approved
    ? extractSeedPin(sleep.summary, now, sleep.receiptRef)
    : null;

  let seedPinUpdated = false;
  if (approved && candidatePin !== null && !deps.dryRun) {
    if (deps.activeSeedPinFile !== undefined) {
      writeSeedPinAtomically(deps.activeSeedPinFile, candidatePin);
    }
    await deps.onSeedPinUpdated?.(candidatePin);
    seedPinUpdated = true;
  }

  const summary: FourLayerCycleReceiptSummary = {
    cycleId,
    timestamp: now,
    runDirs,
    forbiddenHoldoutReads: totalHoldoutReads,
    netMdlSavings,
    mdlVerified,
    approved,
    seedPinUpdated,
    activeSeedPin: seedPinUpdated ? candidatePin : null,
    counterexample: {
      ok: counterexample.ok,
      exitCode: counterexample.exitCode,
      receiptRef: counterexample.receiptRef,
      forbiddenHoldoutReads: counterexample.forbiddenHoldoutReads,
    },
    sleep: {
      ok: sleep.ok,
      exitCode: sleep.exitCode,
      receiptRef: sleep.receiptRef,
      forbiddenHoldoutReads: sleep.forbiddenHoldoutReads,
    },
  };

  const evidence: string[] = [];
  if (counterexample.receiptRef) evidence.push(counterexample.receiptRef);
  if (sleep.receiptRef) evidence.push(sleep.receiptRef);
  if (candidatePin) evidence.push(`${candidatePin.path}#${candidatePin.sha256}`);

  deps.decisionLog.record({
    workspaceIdentity: deps.workspaceIdentity,
    origin: "adjudication",
    disposition: totalHoldoutReads > 0 ? "reject" : approved ? "accept" : "record_only",
    modelTier: "cheng_evolution_flywheel",
    reason: JSON.stringify(summary),
    evidence,
    createdAt: now,
  });

  if (totalHoldoutReads > 0) {
    throw new Error(
      `Cheng evolution flywheel aborted: forbidden_holdout_reads=${String(totalHoldoutReads)}`,
    );
  }

  return summary;
}
