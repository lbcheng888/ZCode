import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ProjectId, SessionId } from "@zcode/contracts";

import { createChengJobNotificationLedger } from "../../src/super-agent/cheng-job-ledger.js";
import { ChengJobRegistryOwner, chengClaimId } from "../../src/super-agent/cheng-job-registry.js";
import { SqliteBackgroundRunStore } from "../../src/super-agent/storage/background-run-store.js";
import { openSuperAgentDatabase } from "../../src/super-agent/storage/database.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";

const SRC = fileURLToPath(new URL("../../src/super-agent", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const SESSION_ID = "sess_cheng_s0" as SessionId;
const JOB_1 = "cheng-job-killed";
const JOB_2 = "cheng-job-terminal";

function childScript(dbPath: string, jobId: string): string {
  const url = (relative: string): string =>
    pathToFileURL(join(SRC, relative)).href;
  return `
(async () => {
  const { openSuperAgentDatabase } = await import(${JSON.stringify(url("storage/database.ts"))});
  const { BackgroundRunRegistry } = await import(${JSON.stringify(url("watchdog/registry.ts"))});
  const { SqliteBackgroundRunStore } = await import(${JSON.stringify(url("storage/background-run-store.ts"))});
  const db = await openSuperAgentDatabase({ databasePath: ${JSON.stringify(dbPath)} });
  const registry = new BackgroundRunRegistry(1000, new SqliteBackgroundRunStore(db));
  registry.register({
    id: ${JSON.stringify(jobId)},
    kind: "cheng-job",
    owner: "cheng-host",
    ownerSession: ${JSON.stringify(SESSION_ID)},
    stallClockRef: "cheng-job:" + ${JSON.stringify(jobId)},
    heartbeat: true,
  }, Date.now());
  process.stdout.write("READY\\n");
  setInterval(() => {}, 1000);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;
}

function waitReady(child: ReturnType<typeof spawn>, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`child not ready: ${stderr}`)), timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited before READY: code=${String(code)} ${stderr}`));
    });
  });
}

describe("S0 cheng-job registry recovery", () => {
  it(
    "kill -9 leaves running→failed (no fake PASS) and restart never double-delivers",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cheng-s0-"));
      const dbPath = join(dir, "super-agent.sqlite");
      const sessionPath = join(dir, "sessions.sqlite");
      const sessionStore = await createSqliteSessionStore({ dbPath: sessionPath });
      await sessionStore.createSession({
        id: SESSION_ID,
        taskType: "interactive",
        projectID: "project_cheng_s0" as ProjectId,
        slug: "cheng-s0",
        directory: dir,
        path: dir,
        title: "Cheng S0 recovery",
        version: "test",
        time: { created: 1, updated: 1 },
      });
      let db = await openSuperAgentDatabase({ databasePath: dbPath });

      try {
        // 1) A real child process registers a running cheng-job and is killed with SIGKILL.
        const child = spawn(process.execPath, ["--import", "tsx", "-e", childScript(dbPath, JOB_1)], {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        });
        await waitReady(child);
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));

        // 2) Reopen the same database: the running row survived WAL recovery.
        db.close();
        db = await openSuperAgentDatabase({ databasePath: dbPath });
        const store = new SqliteBackgroundRunStore(db);
        const registry = new BackgroundRunRegistry(1000, store);
        registry.hydrate(store.loadAll());

        const deliveries: unknown[] = [];
        const ledger = createChengJobNotificationLedger({
          sessionStore,
          sessionID: SESSION_ID,
          enqueue: async (notification) => {
            deliveries.push(notification);
          },
        });
        const owner = new ChengJobRegistryOwner({ registry, ledger });

        const reconciled = await owner.reconcileAfterRestart();
        expect(reconciled).toEqual({ failed: 1, suppressed: 1, notified: 0, alreadyClaimed: 0 });
        expect(registry.get(JOB_1)).toMatchObject({ state: "failed", kind: "cheng-job" });
        expect(registry.get(JOB_1)?.state).not.toBe("completed");
        expect(deliveries).toHaveLength(0);
        const suppressedRun = registry.get(JOB_1);
        expect(suppressedRun?.terminalReason).toBe("host_restarted");
        expect(await sessionStore.getSessionInputById?.(chengClaimId(JOB_1))).toBeNull();

        // 3) Owner settles a completed job: claim-first then exactly one enqueue.
        owner.register({ jobId: JOB_2, ownerSession: SESSION_ID, runId: "m5-s0" });
        await expect(
          owner.terminal({
            jobId: JOB_2,
            state: "completed",
            runId: "m5-s0",
            gateLevel: "DIAGNOSTIC_NOT_ACCEPTANCE",
          }),
        ).resolves.toBe("notified");
        expect(deliveries).toHaveLength(1);
        await expect(owner.terminal({ jobId: JOB_2, state: "completed" })).resolves.toBe(
          "already_terminal",
        );
        expect(deliveries).toHaveLength(1);

        // 4) Simulated second restart: both terminal rows are already claimed → zero new deliveries.
        const restartedRegistry = new BackgroundRunRegistry(1000, store);
        restartedRegistry.hydrate(store.loadAll());
        const restartDeliveries: unknown[] = [];
        const restartedOwner = new ChengJobRegistryOwner({
          registry: restartedRegistry,
          ledger: createChengJobNotificationLedger({
            sessionStore,
            sessionID: SESSION_ID,
            enqueue: async (notification) => {
              restartDeliveries.push(notification);
            },
          }),
        });
        const second = await restartedOwner.reconcileAfterRestart();
        expect(second.failed).toBe(0);
        expect(restartDeliveries).toHaveLength(0);
        expect(await sessionStore.getSessionInputById?.(chengClaimId(JOB_1))).toBeNull();
        expect(await sessionStore.getSessionInputById?.(chengClaimId(JOB_2))).not.toBeNull();
        expect(store.loadAll().map((row) => [row.id, row.state])).toEqual([
          [JOB_1, "failed"],
          [JOB_2, "completed"],
        ]);
      } finally {
        db.close();
        await sessionStore.close?.();
        await rm(dir, { force: true, recursive: true });
      }
    },
    120_000,
  );
});
