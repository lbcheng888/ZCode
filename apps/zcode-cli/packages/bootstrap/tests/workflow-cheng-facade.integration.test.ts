import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";
import type { JournalStorePort, NodeRecord, RunSettlement } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";

import { resolveDynamicWorkflowJournalStore } from "../src/app/dynamic-workflow-run-service.js";
import { resolveChengHostPortForApp } from "../src/app/cheng-host-config.js";
import { createAgentRuntimeWorkflowDriver } from "../src/app/workflow-driver.js";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";

const REAL_ROOT = realpathSync(
  process.env.CHENG_HOST_REAL_ROOT ?? process.env.ZCODE_CHENG_ROOT ?? "/Users/mac/cheng-lang",
);
const ENABLED =
  process.env.CHENG_HOST_REAL === "1" &&
  existsSync(join(REAL_ROOT, "tools", "csg_spec_v2_cli_run"));
const HOST_ENTRY = fileURLToPath(new URL("../../cheng-host/dist/main.js", import.meta.url));
const SPEC = join(REAL_ROOT, "data", "spec_v2", "tasks", "p02_min2.spec.json");
const realDescribe = ENABLED ? describe : describe.skip;

const SCRIPT = `
const job = await cheng.generate({
  specPath: ${JSON.stringify(SPEC)},
  task: "p02_min2",
  budget: 30000,
});
const verified = await cheng.verify(job.jobId);
const graph = await cheng.graph(job.jobId, "p02_min2", "decision");
return { jobId: job.jobId, state: job.state, level: verified.level, nodes: graph.nodes };
`;

realDescribe("CreateWorkflow production path: cheng facade", () => {
  it(
    "journals cheng.generate as world-run and verify/graph as world-read",
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), "cheng-facade-"));
      const store = await createSqliteSessionStore({
        dbPath: join(tempRoot, "sessions.sqlite"),
      });
      const journal = resolveDynamicWorkflowJournalStore(store as never) as
        | JournalStorePort
        | undefined;
      if (journal === undefined) {
        throw new Error("sqlite session store must expose the dwf journal");
      }

      const resolution = resolveChengHostPortForApp({
        dataBaseDir: join(tempRoot, "data"),
        env: {
          ...process.env,
          ZCODE_CHENG_ROOT: REAL_ROOT,
          ZCODE_CHENG_HOST_ENTRY: HOST_ENTRY,
        },
      });
      if (resolution.kind !== "wired") {
        throw new Error(`production Cheng assembly skipped: ${resolution.reason}`);
      }
      const port = resolution.port;
      const runId = "dwfrun-cheng-facade";
      const makeDriver = createAgentRuntimeWorkflowDriver({
        journal,
        emit: () => {},
        executionPort: {} as ExecutionPort,
        fileSystemPort: {} as FileSystemPort,
        escalationRegistry: createWorkflowEscalationRegistry(),
        cwd: REAL_ROOT,
        chengHostPort: port,
        runId,
        runtimeFactory: async () => {
          throw new Error("this script has no actor asks");
        },
      });

      try {
        const settlement: RunSettlement = await runWorkflowScript({
          scriptText: SCRIPT,
          cwd: REAL_ROOT,
          runId,
          caps: { maxConcurrency: 2 },
          askSpecs: new Map(),
          validate: () => true,
          makeDriver,
          timeoutMs: 300_000,
        });

        expect(settlement.artifact).toMatchObject({
          state: "succeeded",
          level: "DIAGNOSTIC_NOT_ACCEPTANCE",
        });
        expect(journal.getRun(runId)?.status).toBe("completed");

        const generateNode = journal.getNode(runId, "world-read#1", 1);
        const verifyNode = journal.getNode(runId, "world-read#2", 1);
        const graphNode = journal.getNode(runId, "world-read#3", 1);
        expect(generateNode?.kind).toBe("world-run");
        expect(verifyNode?.kind).toBe("world-read");
        expect(graphNode?.kind).toBe("world-read");
        expect(generateNode?.status).toBe("completed");

        expect(generateNode?.input?.op).toBe("cheng-generate");
        expect(verifyNode?.input?.op).toBe("cheng-verify");
        expect(graphNode?.input?.op).toBe("cheng-graph");

        const evidence = {
          runId,
          status: journal.getRun(runId)?.status,
          artifact: settlement.artifact,
          nodes: [generateNode, verifyNode, graphNode].map((node: NodeRecord | undefined) => ({
            siteId: node?.siteId,
            kind: node?.kind,
            op: node?.input?.op,
            status: node?.status,
            result: node?.result,
          })),
        };
        console.log("CHENG_FACADE_EVIDENCE", JSON.stringify(evidence));
      } finally {
        await port.close?.();
        await store.close?.();
        await rm(tempRoot, { force: true, recursive: true });
      }
    },
    420_000,
  );
});
