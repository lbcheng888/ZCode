import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ChengJobObserver } from "../src/super-agent/cheng-job-observer.js";
import { createChengHostPort } from "../src/app/workflow-cheng-host-port.js";

const REAL_ROOT = realpathSync(
  process.env.CHENG_HOST_REAL_ROOT ?? process.env.ZCODE_CHENG_ROOT ?? "/Users/mac/cheng-lang",
);
const HOST_ENTRY = fileURLToPath(new URL("../../cheng-host/dist/main.js", import.meta.url));
const SPEC = join(REAL_ROOT, "data", "spec_v2", "tasks", "p02_min2.spec.json");
const TASK = "p02_min2";
const ENABLED =
  process.env.CHENG_HOST_REAL === "1" &&
  existsSync(join(REAL_ROOT, "tools", "csg_spec_v2_cli_run")) &&
  existsSync(HOST_ENTRY);

const realDescribe = ENABLED ? describe : describe.skip;

realDescribe("Cheng host cancellation", () => {
  it(
    "cancelActive stops an in-flight long-budget job (host confirms cancelled)",
    async () => {
      const dataBaseDir = await mkdtemp(join(tmpdir(), "cheng-cancel-"));
      let resolveStarted: ((jobId: string) => void) | undefined;
      const started = new Promise<string>((resolve) => {
        resolveStarted = resolve;
      });
      let terminalState: string | undefined;
      const observer: ChengJobObserver = {
        started: ({ jobId }) => {
          resolveStarted?.(jobId);
        },
        progress: () => {},
        terminal: ({ state }) => {
          terminalState = state;
        },
      };
      const port = createChengHostPort({
        chengRoot: REAL_ROOT,
        dataBaseDir,
        hostEntry: HOST_ENTRY,
        observer,
      });

      try {
        const generation = port.generate({ specPath: SPEC, task: TASK, budget: 900_000 });
        const jobId = await started;
        const requested = await port.cancelActive();
        expect(requested).toBe(1);
        const result = await generation;
        expect(result.jobId).toBe(jobId);
        expect(result.state).toBe("cancelled");
        expect(terminalState).toBe("cancelled");

        console.log("CHENG_CANCEL_EVIDENCE", JSON.stringify({ jobId, state: result.state }));
      } finally {
        await port.close?.();
        await rm(dataBaseDir, { force: true, recursive: true });
      }
    },
    120_000,
  );
});
