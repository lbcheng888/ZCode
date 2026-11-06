import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  readDerivationGraph,
  readRunVolume,
  readSettleReceipt,
  readStructureReceipt,
  type SettleReceipt,
} from "@zcode/cheng-contract";

import { HostError } from "./errors.js";
import type { JobRecord } from "./job-store.js";
import type { GraphResult, VerifyResult } from "./protocol.js";
import { sha256File } from "./runtime.js";

const TERMINAL_OK = "succeeded";

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

export function projectVerify(record: JobRecord): VerifyResult {
  requireSucceeded(record);
  const runDir = requireRunDir(record);

  let receipt;
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

  let structure = null;
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

  return {
    receipt,
    settle,
    structure,
    structureReason,
    artifactRef: runDir,
  };
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
