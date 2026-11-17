import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_EVOLUTION_RUN_VOLUMES_PER_CYCLE,
  runChengEvolutionFlywheelCycle,
  scanRecentProductionRunVolumes,
  type ChengEvolutionHostPort,
} from "../../src/super-agent/cheng-evolution-flywheel.js";
import type { DecisionLogEntryInput } from "../../src/super-agent/decision-log/contract.js";

describe("cheng-evolution-flywheel", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans at most 32 recent production run volumes", () => {
    const runsRoot = makeTempDir("flywheel-runs-");
    for (let i = 0; i < 40; i++) {
      const vol = join(runsRoot, `m5-run-${String(i).padStart(2, "0")}`);
      mkdirSync(vol, { recursive: true });
      writeFileSync(join(vol, "report.txt"), "production_acceptance=1\nverdict=PASS\n");
    }
    const nonProd = join(runsRoot, "diag-run");
    mkdirSync(nonProd, { recursive: true });
    writeFileSync(join(nonProd, "report.txt"), "production_acceptance=0\n");

    const found = scanRecentProductionRunVolumes({ runsRoots: [runsRoot] });
    expect(found).toHaveLength(MAX_EVOLUTION_RUN_VOLUMES_PER_CYCLE);
    expect(found).not.toContain(nonProd);
  });

  it("invokes evolveCounterexample + evolveSleep, logs FourLayerCycleReceipt, and updates m5_prior.seed pin when approved", async () => {
    const root = makeTempDir("flywheel-cycle-");
    const runsRoot = join(root, "runs");
    const vol = join(runsRoot, "m5-run-1");
    mkdirSync(vol, { recursive: true });
    writeFileSync(join(vol, "report.txt"), "production_acceptance=1\n");

    const seedPath = join(root, "m5_prior.seed");
    writeFileSync(seedPath, "seed-v1");
    const seedSha256 = "b".repeat(64);
    const pinFile = join(root, "active_seed_pin.json");

    const recorded: DecisionLogEntryInput[] = [];
    const chengHost: ChengEvolutionHostPort = {
      evolveCounterexample: vi.fn(async () => ({
        ok: true,
        kind: "counterexample" as const,
        exitCode: 0,
        receiptRef: "/tmp/ce-receipt.json",
        forbiddenHoldoutReads: 0,
        summary: { killRateDelta: 0.1 },
      })),
      evolveSleep: vi.fn(async () => ({
        ok: true,
        kind: "sleep" as const,
        exitCode: 0,
        receiptRef: "/tmp/sleep-receipt.json",
        forbiddenHoldoutReads: 0,
        summary: {
          netMdlSavings: 42,
          seedPath,
          seedSha256,
        },
      })),
    };

    const result = await runChengEvolutionFlywheelCycle({
      workspaceIdentity: "ws-cheng",
      chengHost,
      decisionLog: {
        record: (entry) => recorded.push(entry),
        sweepRetention: () => 0,
      },
      runsRoots: [runsRoot],
      activeSeedPinFile: pinFile,
      approved: true,
    });

    expect(result).not.toBeNull();
    expect(result?.forbiddenHoldoutReads).toBe(0);
    expect(result?.netMdlSavings).toBe(42);
    expect(result?.mdlVerified).toBe(true);
    expect(result?.seedPinUpdated).toBe(true);
    expect(existsSync(pinFile)).toBe(true);
    expect(JSON.parse(readFileSync(pinFile, "utf8"))).toMatchObject({
      path: seedPath,
      sha256: seedSha256,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      workspaceIdentity: "ws-cheng",
      disposition: "accept",
      modelTier: "cheng_evolution_flywheel",
    });
  });

  it("aborts and records reject when forbiddenHoldoutReads > 0 without updating seed pin", async () => {
    const root = makeTempDir("flywheel-holdout-");
    const pinFile = join(root, "active_seed_pin.json");
    const recorded: DecisionLogEntryInput[] = [];

    await expect(
      runChengEvolutionFlywheelCycle({
        workspaceIdentity: "ws-cheng",
        chengHost: {
          evolveCounterexample: async () => ({
            ok: false,
            kind: "counterexample",
            exitCode: 1,
            receiptRef: "/tmp/ce-bad.json",
            forbiddenHoldoutReads: 2,
            summary: {},
          }),
          evolveSleep: vi.fn(),
        },
        decisionLog: {
          record: (entry) => recorded.push(entry),
          sweepRetention: () => 0,
        },
        scanRunVolumes: () => ["/tmp/vol-1"],
        activeSeedPinFile: pinFile,
        approved: true,
      }),
    ).rejects.toThrow(/forbidden_holdout_reads=2/);

    expect(existsSync(pinFile)).toBe(false);
    expect(recorded[0]?.disposition).toBe("reject");
  });
});
