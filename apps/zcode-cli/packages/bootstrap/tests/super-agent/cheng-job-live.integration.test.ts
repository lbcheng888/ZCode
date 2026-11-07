import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ProjectId, SessionId } from "@zcode/contracts";

import { createChengJobNotificationLedger } from "../../src/super-agent/cheng-job-ledger.js";
import { createChengJobObserver, type ChengJobObserver } from "../../src/super-agent/cheng-job-observer.js";
import { runsList } from "../../src/super-agent/runs-list.js";
import { SqliteBackgroundRunStore } from "../../src/super-agent/storage/background-run-store.js";
import { openSuperAgentDatabase } from "../../src/super-agent/storage/database.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";
import { createChengHostPort } from "../../src/app/workflow-cheng-host-port.js";

const REAL_ROOT = realpathSync(
  process.env.CHENG_HOST_REAL_ROOT ?? process.env.ZCODE_CHENG_ROOT ?? "/Users/mac/cheng-lang",
);
const HOST_ENTRY = fileURLToPath(new URL("../../../cheng-host/dist/main.js", import.meta.url));
const SPEC = join(REAL_ROOT, "data", "spec_v2", "tasks", "p02_min2.spec.json");
const TASK = "p02_min2";
const SESSION_ID = "sess_cheng_live" as SessionId;
const ENABLED =
  process.env.CHENG_HOST_REAL === "1" &&
  existsSync(join(REAL_ROOT, "tools", "csg_spec_v2_cli_run")) &&
  existsSync(HOST_ENTRY);

const realDescribe = ENABLED ? describe : describe.skip;

realDescribe("S0 live cheng-job wiring", () => {
  it(
    "host events fill kind=cheng-job rows, claim once, and survive reconcile",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cheng-s0-live-"));
      const sessionStore = await createSqliteSessionStore({
        dbPath: join(dir, "sessions.sqlite"),
      });
      await sessionStore.createSession({
        id: SESSION_ID,
        taskType: "interactive",
        projectID: "project_cheng_live" as ProjectId,
        slug: "cheng-s0-live",
        directory: dir,
        path: dir,
        title: "Cheng S0 live",
        version: "test",
        time: { created: 1, updated: 1 },
      });
      const db = await openSuperAgentDatabase({
        databasePath: join(dir, "super-agent.sqlite"),
      });
      const store = new SqliteBackgroundRunStore(db);
      const registry = new BackgroundRunRegistry(500, store);
      registry.hydrate(store.loadAll());

      const deliveries: unknown[] = [];
      const ledger = createChengJobNotificationLedger({
        sessionStore,
        sessionID: SESSION_ID,
        enqueue: async (notification) => {
          deliveries.push(notification);
        },
      });
      const live = createChengJobObserver({
        registry,
        ledger,
        ownerSession: SESSION_ID,
        workspaceKey: dir,
      });
      const counts = { started: 0, progress: 0, terminal: 0 };
      const observer: ChengJobObserver = {
        started: (input) => {
          counts.started += 1;
          live.started(input);
        },
        progress: (input) => {
          counts.progress += 1;
          live.progress(input);
        },
        terminal: async (input) => {
          counts.terminal += 1;
          await live.terminal(input);
        },
      };
      const port = createChengHostPort({
        chengRoot: REAL_ROOT,
        dataBaseDir: join(dir, "cheng-data"),
        hostEntry: HOST_ENTRY,
        observer,
      });

      try {
        const job = await port.generate({ specPath: SPEC, task: TASK, budget: 30_000 });
        expect(job.state).toBe("succeeded");
        expect(job.exitCode).toBe(41);

        expect(counts.started).toBe(1);
        expect(counts.progress).toBeGreaterThan(0);
        expect(counts.terminal).toBe(1);

        expect(registry.get(job.jobId)).toMatchObject({
          kind: "cheng-job",
          owner: "cheng-host",
          state: "completed",
          narrowResultRef: `cheng-run://${String(job.runId)}`,
        });
        expect(deliveries).toHaveLength(1);
        const delivery = deliveries[0] as {
          originMeta: { backgroundSource?: string; chengJob?: { jobId?: string } };
        };
        expect(delivery.originMeta.backgroundSource).toBe("cheng-job");
        expect(delivery.originMeta.chengJob?.jobId).toBe(job.jobId);
        expect(await sessionStore.getSessionInputById?.(`cheng_${job.jobId}`)).not.toBeNull();

        const listed = runsList(db, { kind: "cheng-job" }) as {
          runs: Array<Record<string, unknown>>;
        };
        expect(listed.runs.map((row) => row.id)).toContain(job.jobId);

        // Restart: hydrate from the same table; the completed claim absorbs re-notification.
        const restartedStore = new SqliteBackgroundRunStore(db);
        const restartedRegistry = new BackgroundRunRegistry(500, restartedStore);
        restartedRegistry.hydrate(restartedStore.loadAll());
        const restartDeliveries: unknown[] = [];
        const restartedObserver = createChengJobObserver({
          registry: restartedRegistry,
          ledger: createChengJobNotificationLedger({
            sessionStore,
            sessionID: SESSION_ID,
            enqueue: async (notification) => {
              restartDeliveries.push(notification);
            },
          }),
          ownerSession: SESSION_ID,
          workspaceKey: dir,
        });
        const reconcile = await restartedObserver.owner.reconcileAfterRestart();
        expect(reconcile.failed).toBe(0);
        expect(reconcile.notified).toBe(0);
        expect(reconcile.alreadyClaimed).toBe(1);
        expect(restartDeliveries).toHaveLength(0);
        expect(restartedRegistry.get(job.jobId)?.state).toBe("completed");

        console.log(
          "CHENG_S0_LIVE_EVIDENCE",
          JSON.stringify({
            jobId: job.jobId,
            runId: job.runId,
            progressEvents: counts.progress,
            deliveries: deliveries.length,
            reconcile,
          }),
        );
      } finally {
        await port.close?.();
        db.close();
        await sessionStore.close?.();
        await rm(dir, { force: true, recursive: true });
      }
    },
    300_000,
  );
});
