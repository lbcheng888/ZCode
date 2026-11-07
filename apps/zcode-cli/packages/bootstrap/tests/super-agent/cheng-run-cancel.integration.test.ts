import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";

import { resolveDynamicWorkflowJournalStore } from "../../src/app/dynamic-workflow-run-service.js";
import { createAgentRuntimeWorkflowDriver } from "../../src/app/workflow-driver.js";
import { createWorkflowEscalationRegistry } from "../../src/app/workflow-escalation-registry.js";
import { createChengHostPort } from "../../src/app/workflow-cheng-host-port.js";
import { createScopedChengHostPort } from "../../src/app/workflow-cheng-scoped-port.js";
import type { ChengJobObserver } from "../../src/super-agent/cheng-job-observer.js";

const REAL_ROOT = realpathSync(
  process.env.CHENG_HOST_REAL_ROOT ?? process.env.ZCODE_CHENG_ROOT ?? "/Users/mac/cheng-lang",
);
const HOST_ENTRY = fileURLToPath(new URL("../../../cheng-host/dist/main.js", import.meta.url));
const SPEC = join(REAL_ROOT, "data", "spec_v2", "tasks", "p02_min2.spec.json");
const TASK = "p02_min2";
const ENABLED =
  process.env.CHENG_HOST_REAL === "1" &&
  existsSync(join(REAL_ROOT, "tools", "csg_spec_v2_cli_run")) &&
  existsSync(HOST_ENTRY);

const realDescribe = ENABLED ? describe : describe.skip;

realDescribe("workflow run cancellation → host job cancelled", () => {
  it(
    "aborting the run cancels the in-flight cheng job via the scoped port",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cheng-run-cancel-"));
      const store = await createSqliteSessionStore({ dbPath: join(dir, "sessions.sqlite") });
      const journal = resolveDynamicWorkflowJournalStore(store as never) as
        | JournalStorePort
        | undefined;
      if (journal === undefined) throw new Error("sqlite store must expose the dwf journal");

      let startedJob: ((jobId: string) => void) | undefined;
      let terminalJob: ((state: string) => void) | undefined;
      const started = new Promise<string>((resolve) => {
        startedJob = resolve;
      });
      const terminal = new Promise<string>((resolve) => {
        terminalJob = resolve;
      });
      const observer: ChengJobObserver = {
        started: ({ jobId }) => startedJob?.(jobId),
        progress: () => {},
        terminal: ({ state }) => terminalJob?.(state),
      };
      const basePort = createChengHostPort({
        chengRoot: REAL_ROOT,
        dataBaseDir: join(dir, "cheng-data"),
        hostEntry: HOST_ENTRY,
        observer,
      });
      const scoped = createScopedChengHostPort(basePort);
      const runId = "dwfrun-cheng-cancel";
      const makeDriver = createAgentRuntimeWorkflowDriver({
        journal,
        emit: () => {},
        executionPort: {} as ExecutionPort,
        fileSystemPort: {} as FileSystemPort,
        escalationRegistry: createWorkflowEscalationRegistry(),
        cwd: REAL_ROOT,
        chengHostPort: scoped.port,
        runId,
        onDispose: () => {
          void scoped.cancelActive().finally(() => scoped.dispose());
        },
        runtimeFactory: async () => {
          throw new Error("this script has no actor asks");
        },
      });
      const controller = new AbortController();

      try {
        const runPromise = runWorkflowScript({
          scriptText:
            `const job = await cheng.generate({ specPath: ${JSON.stringify(SPEC)}, task: ${JSON.stringify(TASK)}, budget: 900000 });\n` +
            `return job.state;`,
          cwd: REAL_ROOT,
          runId,
          caps: { maxConcurrency: 2 },
          askSpecs: new Map(),
          validate: () => true,
          makeDriver,
          signal: controller.signal,
          timeoutMs: 300_000,
        });

        const jobId = await started;
        expect(scoped.activeJobIds()).toEqual([jobId]);
        controller.abort("user");

        const settlement = await runPromise;
        expect(settlement.status).toBe("stopped");

        // The host confirms cancellation only after the process tree is gone.
        await expect(
          Promise.race([
            terminal,
            new Promise<string>((_resolve, reject) =>
              setTimeout(() => reject(new Error("host job did not cancel")), 30_000),
            ),
          ]),
        ).resolves.toBe("cancelled");

        expect(await scoped.activeJobIds()).toEqual([]);
        const run = journal.getRun(runId);
        expect(run?.status).toBe("stopped");
        expect(run?.stopReason).toBe("user");
        const node = journal.getNode(runId, "world-read#1", 1);
        expect(node?.input?.op).toBe("cheng-generate");

        console.log(
          "CHENG_RUN_CANCEL_EVIDENCE",
          JSON.stringify({
            runId,
            jobId,
            runStatus: run?.status,
            stopReason: run?.stopReason,
            nodeOp: node?.input?.op,
            nodeStatus: node?.status,
          }),
        );
      } finally {
        await basePort.close?.();
        await store.close?.();
        await rm(dir, { force: true, recursive: true });
      }
    },
    180_000,
  );
});
