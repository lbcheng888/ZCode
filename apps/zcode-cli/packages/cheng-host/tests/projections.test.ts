import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HostError } from "../src/errors.js";
import { projectGraph, projectSettle, projectVerify } from "../src/projections.js";
import { jobRecord, tempDir } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("../../cheng-contract/tests/fixtures", import.meta.url));
const P02_RUN = join(FIXTURES, "run-p02");
const P02_SPEC = join(FIXTURES, "specs", "p02_min2.spec.json");

function recordAt(runDir: string) {
  return jobRecord({
    state: "succeeded",
    phase: "done",
    runDir,
    task: "p02_min2",
    specPath: P02_SPEC,
    exitCode: 41,
  });
}

function runWithTrace(): string {
  const runDir = tempDir("run-");
  cpSync(P02_RUN, runDir, { recursive: true });
  const replay = join(runDir, "tasks", "p02_min2", "replay.run1");
  mkdirSync(replay, { recursive: true });
  copyFileSync(join(P02_RUN, "trace.jsonl"), join(replay, "trace.jsonl"));
  return runDir;
}

describe("projections", () => {
  it("projects the fixture run as diagnostic acceptance without inventing structure", () => {
    const result = projectVerify(recordAt(P02_RUN));
    expect(result.receipt.acceptance.level).toBe("DIAGNOSTIC_NOT_ACCEPTANCE");
    expect(result.receipt.acceptance.productionAcceptance).toBe(false);
    expect(result.settle).toBeNull();
    expect(result.structure).toBeNull();
    expect(result.structureReason).toContain("modules.tsv");
    expect(result.artifactRef).toBe(P02_RUN);
  });

  it("projects a real trace into settle and decision graph receipts", () => {
    const runDir = runWithTrace();
    const record = recordAt(runDir);

    const verify = projectVerify(record);
    expect(verify.settle).not.toBeNull();
    expect(verify.settle?.settles.length).toBeGreaterThan(0);
    expect(verify.settle?.traceDone.task).toBe("p02_min2");

    const settle = projectSettle(record, "p02_min2");
    expect(settle.settles.length).toBe(verify.settle?.settles.length);

    const graph = projectGraph(record, "p02_min2", "decision");
    expect(graph.available).toBe(true);
    expect(graph.summary?.nodes).toBeGreaterThan(0);
    expect(graph.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(graph.artifactRef).toContain("replay.run1/trace.jsonl");
  });

  it("reports structure unavailable for a single-module run", () => {
    const graph = projectGraph(recordAt(P02_RUN), "p02_min2", "structure");
    expect(graph.available).toBe(false);
    expect(graph.reason).toContain("modules.tsv");
    expect(graph.summary).toBeNull();
  });

  it("refuses projections on a job that did not succeed", () => {
    const failed = jobRecord({ state: "failed", runDir: P02_RUN, specPath: P02_SPEC });
    expect(() => projectVerify(failed)).toThrow(HostError);
    try {
      projectVerify(failed);
    } catch (error) {
      expect(error).toMatchObject({ code: "host.jobNotSucceeded" });
    }
  });

  it("refuses a task that does not belong to the job", () => {
    const record = recordAt(runWithTrace());
    expect(() => projectSettle(record, "p16_glue_len")).toThrow(HostError);
  });

  it("fails closed when a declared trace is missing", () => {
    const record = recordAt(P02_RUN);
    expect(() => projectGraph(record, "p02_min2", "decision")).toThrow(HostError);
  });
});
