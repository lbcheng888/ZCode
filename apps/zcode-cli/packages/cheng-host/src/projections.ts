import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  evaluateChengGate,
  planChengNextAction,
  readChengSpecRef,
  readDerivationGraph,
  readRunVolume,
  readRuntimeManifest,
  readSettleReceipt,
  readStructureReceipt,
  readZeroCReceipt,
  type ChengGateResult,
  type ChengPlanResult,
  type ChengSpecRef,
  type RunVolumeReceipt,
  type RuntimeManifest,
  type SettleReceipt,
  type StructureReceipt,
  type ZeroCReceipt,
} from "@zcode/cheng-contract";

import { HostError } from "./errors.js";
import type { JobRecord } from "./job-store.js";
import type { GraphDiffResult, GraphResult, VerifyResult } from "./protocol.js";
import { sha256File } from "./runtime.js";

const TERMINAL_OK = "succeeded";

export interface ProjectVerifyOptions {
  readonly chengRoot?: string;
  readonly expectedDriverSha256?: string | null;
}

export function projectSettle(record: JobRecord, task: string): SettleReceipt {
  requireSucceeded(record);
  requireTask(record, task);
  const trace = tracePath(requireRunDir(record), task);
  if (!existsSync(trace)) {
    throw new HostError("host.runVolumeMissing", "run has no replay trace", {
      evidence: [`runDir=${requireRunDir(record)}`, `trace=${trace}`],
    });
  }
  try {
    return readSettleReceipt(trace);
  } catch (error) {
    throw wrap("host.verifyUnavailable", `settle projection failed for ${task}`, error);
  }
}

export function resolveJobSpecRef(
  record: Pick<JobRecord, "specPath" | "bundleDir">,
  chengRoot?: string,
): ChengSpecRef | null {
  if (!existsSync(record.specPath)) {
    return null;
  }
  const candidates: string[] = [];
  if (record.bundleDir !== undefined && record.bundleDir !== null) {
    candidates.push(join(record.bundleDir, "index.json"));
  }
  candidates.push(join(dirname(record.specPath), "..", "index.json"));
  if (chengRoot !== undefined && chengRoot.length > 0) {
    candidates.push(join(chengRoot, "data", "spec_v2", "index.json"));
  }
  const indexPath = candidates.find((p) => existsSync(p));
  try {
    return readChengSpecRef(record.specPath, indexPath);
  } catch (error) {
    throw wrap("host.verifyUnavailable", "spec ref projection failed", error);
  }
}

export function projectVerify(
  record: JobRecord,
  options: ProjectVerifyOptions = {},
): VerifyResult {
  requireSucceeded(record);
  const runDir = requireRunDir(record);

  let receipt: RunVolumeReceipt;
  try {
    receipt = readRunVolume(runDir);
  } catch (error) {
    throw wrap("host.verifyUnavailable", "run volume failed contract projection", error);
  }

  const trace = tracePath(runDir, record.task);
  let settle: SettleReceipt | null = null;
  if (existsSync(trace)) {
    try {
      settle = readSettleReceipt(trace);
    } catch (error) {
      throw wrap("host.verifyUnavailable", "settle projection failed", error);
    }
  }

  let structure: StructureReceipt | null = null;
  let structureReason: string | null = null;
  const modulesPath = findModulesPath(runDir);
  if (modulesPath === null) {
    structureReason = "run has no modules.tsv (single-module run)";
  } else {
    try {
      structure = readStructureReceipt(record.specPath, modulesPath);
    } catch (error) {
      throw wrap("host.verifyUnavailable", "structure projection failed", error);
    }
  }

  let runtimeManifest: RuntimeManifest | null = null;
  if (existsSync(join(runDir, "run.env")) && existsSync(join(runDir, "hashes.tsv"))) {
    try {
      runtimeManifest = readRuntimeManifest(runDir);
    } catch (error) {
      throw wrap("host.verifyUnavailable", "runtime manifest projection failed", error);
    }
  }

  let zeroC: ZeroCReceipt | null = null;
  if (existsSync(join(runDir, "zero_c.tsv"))) {
    try {
      const expectedDriverSha256 =
        options.expectedDriverSha256 ?? runtimeManifest?.runEnv.driverSha256 ?? null;
      zeroC = readZeroCReceipt(runDir, { expectedDriverSha256 });
    } catch (error) {
      throw wrap("host.verifyUnavailable", "zero-c receipt projection failed", error);
    }
  }

  const specRef = resolveJobSpecRef(record, options.chengRoot);
  const gate = evaluateVerifyGate({
    receipt,
    settle,
    structure,
    runtimeManifest,
    zeroC,
    specRef,
  });

  return {
    receipt,
    settle,
    structure,
    structureReason,
    runtimeManifest,
    zeroC,
    gate,
    artifactRef: runDir,
  };
}

/**
 * 真实 ChengGate 评估（P4/v3 contract）：直接吃已校验的原始回执，不从 verify 摘要二次推断。
 * unknown mode 按 production fail-closed；生产档校验 runtimeManifestComplete、zeroCProductionOk 与 specRef。
 */
export function evaluateVerifyGate(input: {
  receipt: RunVolumeReceipt;
  settle: SettleReceipt | null;
  structure: StructureReceipt | null;
  runtimeManifest?: RuntimeManifest | null;
  zeroC?: ZeroCReceipt | null;
  specRef?: ChengSpecRef | null;
}): ChengGateResult {
  const mode = input.receipt.acceptance.mode === "diagnostic" ? "diagnostic" : "production";
  return evaluateChengGate({
    error: null,
    run: input.receipt,
    settle: input.settle,
    structure: input.structure,
    mode,
    runtimeManifestComplete: input.runtimeManifest?.checks.manifestComplete ?? false,
    ...(input.specRef === undefined ? {} : { specRef: input.specRef }),
    ...(mode === "production" ? { zeroC: input.zeroC ?? null } : {}),
  });
}

/** 真实 planner：同一批原始回执 → ChengPlan；不调模型、不读日志。 */
export function evaluateVerifyPlan(input: {
  receipt: RunVolumeReceipt;
  settle: SettleReceipt | null;
  structure: StructureReceipt | null;
  runtimeManifest?: RuntimeManifest | null;
  zeroC?: ZeroCReceipt | null;
  specRef?: ChengSpecRef | null;
  task: string;
  jobId?: string;
}): ChengPlanResult {
  const mode = input.receipt.acceptance.mode === "diagnostic" ? "diagnostic" : "production";
  return planChengNextAction({
    error: null,
    run: input.receipt,
    settle: input.settle,
    structure: input.structure,
    mode,
    runtimeManifestComplete: input.runtimeManifest?.checks.manifestComplete ?? false,
    ...(input.specRef === undefined ? {} : { specRef: input.specRef }),
    ...(mode === "production" ? { zeroC: input.zeroC ?? null } : {}),
    task: input.task,
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
  });
}

export function projectGraph(record: JobRecord, task: string, view: "structure" | "decision"): GraphResult {
  requireSucceeded(record);
  requireTask(record, task);
  const runDir = requireRunDir(record);

  if (view === "decision") {
    const trace = tracePath(runDir, task);
    if (!existsSync(trace)) {
      throw new HostError("host.runVolumeMissing", "run has no replay trace", {
        evidence: [`runDir=${runDir}`, `trace=${trace}`],
      });
    }
    let graph;
    try {
      graph = readDerivationGraph(trace);
    } catch (error) {
      throw wrap("host.verifyUnavailable", "decision graph projection failed", error);
    }
    return {
      available: true,
      reason: null,
      artifactRef: trace,
      digest: sha256File(trace),
      summary: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        roots: graph.roots.length,
        gateOk: null,
      },
    };
  }

  const modulesPath = findModulesPath(runDir);
  if (modulesPath === null) {
    return {
      available: false,
      reason: "run has no modules.tsv (single-module run)",
      artifactRef: record.specPath,
      digest: sha256File(record.specPath),
      summary: null,
    };
  }
  let structure;
  try {
    structure = readStructureReceipt(record.specPath, modulesPath);
  } catch (error) {
    throw wrap("host.verifyUnavailable", "structure projection failed", error);
  }
  return {
    available: true,
    reason: null,
    artifactRef: modulesPath,
    digest: sha256File(modulesPath),
    summary: {
      nodes: structure.ledger.length,
      edges: structure.checks.ledgerCallEdgesSum,
      roots: structure.specModules.length,
      gateOk: structure.checks.structureGateOk,
    },
  };
}

export function projectGraphDiff(runDirA: string, runDirB: string): GraphDiffResult {
  const hashesA = join(runDirA, "hashes.tsv");
  const hashesB = join(runDirB, "hashes.tsv");
  if (!existsSync(hashesA) || !existsSync(hashesB)) {
    throw new HostError("host.runVolumeMissing", "graph.diff requires hashes.tsv in both run directories", {
      evidence: [`runDirA=${runDirA}`, `runDirB=${runDirB}`],
    });
  }
  let mfA: RuntimeManifest;
  let mfB: RuntimeManifest;
  try {
    mfA = readRuntimeManifest(runDirA);
    mfB = readRuntimeManifest(runDirB);
  } catch (error) {
    throw wrap("host.verifyUnavailable", "graph.diff manifest projection failed", error);
  }
  const mapA = new Map<string, string>(
    Object.entries(mfA.hashes ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const mapB = new Map<string, string>(
    Object.entries(mfB.hashes ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [k, shaB] of mapB) {
    const shaA = mapA.get(k);
    if (shaA === undefined) {
      added.push(k);
    } else if (shaA !== shaB) {
      changed.push(k);
    }
  }
  for (const k of mapA.keys()) {
    if (!mapB.has(k)) {
      removed.push(k);
    }
  }
  added.sort();
  removed.sort();
  changed.sort();

  return {
    added,
    removed,
    changed,
    digestA: sha256File(hashesA),
    digestB: sha256File(hashesB),
  };
}

export function tracePath(runDir: string, task: string): string {
  return join(runDir, "tasks", task, "replay.run1", "trace.jsonl");
}

function findModulesPath(runDir: string): string | null {
  for (const candidate of [join(runDir, "evidence", "modules.tsv"), join(runDir, "modules.tsv")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function requireSucceeded(record: JobRecord): void {
  if (record.state !== TERMINAL_OK) {
    throw new HostError("host.jobNotSucceeded", `job ${record.jobId} is ${record.state}`, {
      evidence: [`state=${record.state}`],
    });
  }
}

function requireRunDir(record: JobRecord): string {
  if (record.runDir === null) {
    throw new HostError("host.runVolumeMissing", `job ${record.jobId} has no run volume`);
  }
  return record.runDir;
}

function requireTask(record: JobRecord, task: string): void {
  if (task !== record.task) {
    throw new HostError("host.invalidParams", `task ${task} does not belong to job ${record.jobId}`, {
      evidence: [`jobTask=${record.task}`, `requested=${task}`],
    });
  }
}

function wrap(code: "host.verifyUnavailable", message: string, error: unknown): HostError {
  if (error instanceof HostError) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  const contractCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : null;
  return new HostError(code, message, {
    evidence: contractCode === null ? [detail] : [contractCode, detail],
  });
}
