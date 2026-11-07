import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CHENG_HOST_COMMAND, CHENG_HOST_VIA_CLI_ENV } from "@zcode/contracts";
import { StdioHostClient } from "@zcode/cheng-host";

const REAL_ROOT = realpathSync(
  process.env.CHENG_HOST_REAL_ROOT ?? process.env.ZCODE_CHENG_ROOT ?? "/Users/mac/cheng-lang",
);
const CLI_ROOT = fileURLToPath(new URL("../../cli", import.meta.url));
const SEA_BIN = join(CLI_ROOT, "dist", `zcode-${process.platform}-${process.arch}`);
const SPEC = join(REAL_ROOT, "data", "spec_v2", "tasks", "p02_min2.spec.json");
const TASK = "p02_min2";
const ENABLED =
  process.env.CHENG_HOST_REAL === "1" &&
  existsSync(join(REAL_ROOT, "tools", "csg_spec_v2_cli_run")) &&
  existsSync(SEA_BIN);

const realDescribe = ENABLED ? describe : describe.skip;

async function waitTerminal(client: StdioHostClient, jobId: string, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.request("job.status", { jobId });
    if (status.state === "succeeded" || status.state === "failed" || status.state === "cancelled") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`job ${jobId} did not settle`);
}

realDescribe("SEA install artifact: __zcode-cheng-host", () => {
  it(
    "serves typed RPC and runs p02 from the single-file binary",
    async () => {
      const dataBaseDir = await mkdtemp(join(tmpdir(), "cheng-sea-data-"));
      const homeDir = await mkdtemp(join(tmpdir(), "cheng-sea-home-"));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ZCODE_CHENG_ROOT: REAL_ROOT,
        ZCODE_DATA_BASE_DIR: dataBaseDir,
        HOME: homeDir,
      };
      delete env.ZCODE_CHENG_HOST_ENTRY;
      delete env[CHENG_HOST_VIA_CLI_ENV];

      const client = await StdioHostClient.connect({
        command: SEA_BIN,
        args: [
          CHENG_HOST_COMMAND,
          "--scope=stdio",
          `--workspace-root=${REAL_ROOT}`,
          `--data-base-dir=${dataBaseDir}`,
        ],
        cwd: REAL_ROOT,
        env,
        workspaceRoot: REAL_ROOT,
        workspaceIdentity: "cheng-lang",
        clientKind: "workflow",
        startupTimeoutMs: 30_000,
      });

      try {
        const caps = await client.capabilities();
        expect(caps.ops.generate?.available).toBe(true);
        expect(caps.runtime.headSha).toMatch(/^[0-9a-f]{40}$/);

        const started = await client.request("generate", {
          specPath: SPEC,
          task: TASK,
          mode: "diagnostic",
          budget: 30_000,
        });
        const terminal = await waitTerminal(client, started.jobId);
        expect(terminal.state).toBe("succeeded");
        expect(terminal.exitCode).toBe(41);
        expect(terminal.runId).not.toBeNull();

        console.log(
          "CHENG_SEA_ENTRY_EVIDENCE",
          JSON.stringify({
            binary: SEA_BIN,
            command: CHENG_HOST_COMMAND,
            headSha: caps.runtime.headSha,
            fingerprint: caps.fingerprint,
            jobId: started.jobId,
            runId: terminal.runId,
            exitCode: terminal.exitCode,
          }),
        );
      } finally {
        await client.close();
        await rm(dataBaseDir, { force: true, recursive: true });
        await rm(homeDir, { force: true, recursive: true });
      }
    },
    300_000,
  );
});
