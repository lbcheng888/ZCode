import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHENG_EXPLAIN_TOOL_NAME,
  CHENG_INSPECT_TOOL_NAME,
  CHENG_VERIFY_TOOL_NAME,
  ChengExplainOutputSchema,
  ChengInspectOutputSchema,
  ChengVerifyOutputSchema,
} from "@zcode/contracts";
import { builtInTools, type ToolEntry, type ToolExecutionContext } from "@zcode/core";

import { resolveChengHostPortForApp } from "../src/app/cheng-host-config.js";
import { createChengReadPort } from "../src/app/workflow-cheng-read-port.js";

const REAL_ROOT = realpathSync(
  process.env.CHENG_HOST_REAL_ROOT ?? process.env.ZCODE_CHENG_ROOT ?? "/Users/mac/cheng-lang",
);
const ENABLED =
  process.env.CHENG_HOST_REAL === "1" &&
  existsSync(join(REAL_ROOT, "tools", "csg_spec_v2_cli_run"));
const HOST_ENTRY = fileURLToPath(new URL("../../cheng-host/dist/main.js", import.meta.url));
const SPEC = join(REAL_ROOT, "data", "spec_v2", "tasks", "p02_min2.spec.json");
const TASK = "p02_min2";

const realDescribe = ENABLED ? describe : describe.skip;

function tool(name: string): ToolEntry {
  const found = builtInTools.find((candidate) => candidate.metadata.name === name);
  if (found === undefined) {
    throw new Error(`tool not registered: ${name}`);
  }
  return found;
}

realDescribe("Cheng model tools over a real host", () => {
  it(
    "ChengInspect/ChengVerify/ChengExplain read a real p02 job",
    async () => {
      const dataBaseDir = await mkdtemp(join(tmpdir(), "cheng-tools-"));
      const resolution = resolveChengHostPortForApp({
        dataBaseDir,
        env: {
          ...process.env,
          ZCODE_CHENG_ROOT: REAL_ROOT,
          ZCODE_CHENG_HOST_ENTRY: HOST_ENTRY,
        },
      });
      if (resolution.kind !== "wired") {
        throw new Error(`Cheng assembly skipped: ${resolution.reason}`);
      }
      const host = resolution.port;
      try {
        const job = await host.generate({ specPath: SPEC, task: TASK, budget: 30_000 });
        expect(job.state).toBe("succeeded");
        expect(job.exitCode).toBe(41);

        const readPort = createChengReadPort(host);
        expect("generate" in readPort).toBe(false);
        const context = {
          chengReadPort: readPort,
          toolCallId: "call-cheng-tools",
        } as unknown as ToolExecutionContext;

        const inspect = ChengInspectOutputSchema.parse(
          await tool(CHENG_INSPECT_TOOL_NAME).handler({ jobId: job.jobId }, context),
        );
        expect(inspect).toMatchObject({
          status: "ok",
          state: "succeeded",
          runId: job.runId,
          exitCode: 41,
        });

        const verify = ChengVerifyOutputSchema.parse(
          await tool(CHENG_VERIFY_TOOL_NAME).handler({ jobId: job.jobId }, context),
        );
        expect(verify).toMatchObject({
          status: "ok",
          level: "DIAGNOSTIC_NOT_ACCEPTANCE",
          productionAcceptance: false,
          semanticPass: true,
          settlePassed: 2,
          settleTotal: 2,
          structureGateOk: null,
        });

        const explain = ChengExplainOutputSchema.parse(
          await tool(CHENG_EXPLAIN_TOOL_NAME).handler(
            { jobId: job.jobId, task: TASK, view: "decision" },
            context,
          ),
        );
        expect(explain).toMatchObject({
          status: "ok",
          available: true,
          nodes: 31,
        });
        if (explain.status === "ok") {
          expect(explain.digest).toMatch(/^[0-9a-f]{64}$/);
        }

        console.log(
          "CHENG_TOOL_EVIDENCE",
          JSON.stringify({ jobId: job.jobId, inspect, verify, explain }),
        );
      } finally {
        await host.close?.();
        await rm(dataBaseDir, { force: true, recursive: true });
      }
    },
    420_000,
  );
});
