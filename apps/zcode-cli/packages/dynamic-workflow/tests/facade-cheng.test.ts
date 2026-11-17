import { describe, expect, it } from "vitest";

import {
  collectDiagnostics,
  collectSites,
  createWorkflowProgram,
  lowerWorkflow,
  SNIPPET_FACADE_DTS,
} from "../src/index.js";

const SCRIPT =
  `const job = await cheng.generate({ specPath: "/tmp/p02.spec.json", task: "p02_min2", mode: "production", moves: "macro", useLiblearn: true, budget: 30000 });\n` +
  `const verified = await cheng.verify(job.jobId);\n` +
  `const planned = await cheng.plan(job.jobId, "p02_min2");\n` +
  `const graph = await cheng.graph(job.jobId, "p02_min2", "decision");\n` +
  `const surface = await cheng.checkSurface("/tmp/leaf.cheng");\n` +
  `const probe = await cheng.probeLeaf("/tmp/leaf.cheng");\n` +
  `return { verified, planned, graph, surface, probe };`;

describe("cheng facade", () => {
  it("typechecks and lowers all cheng data-plane ops", () => {
    const workflow = createWorkflowProgram(SCRIPT);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.siteIds).toEqual([
      "world-read#1",
      "world-read#2",
      "world-read#3",
      "world-read#4",
      "world-read#5",
      "world-read#6",
    ]);
    expect(lowered.code).toContain(`__host.worldRead("world-read#1", "cheng-generate"`);
    expect(lowered.code).toContain(`__host.worldRead("world-read#2", "cheng-verify"`);
    expect(lowered.code).toContain(`__host.worldRead("world-read#3", "cheng-plan"`);
    expect(lowered.code).toContain(`__host.worldRead("world-read#4", "cheng-graph"`);
    expect(lowered.code).toContain(`__host.worldRead("world-read#5", "cheng-surface-check"`);
    expect(lowered.code).toContain(`__host.worldRead("world-read#6", "cheng-leaf-probe"`);
  });

  it("rejects cheng in the snippet facade at compile time", () => {
    const workflow = createWorkflowProgram(`await cheng.verify("job");`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'cheng'");
  });
});
