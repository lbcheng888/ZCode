import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { StdioHostClient } from "../src/client.js";
import { tempDir } from "./helpers.js";

const REAL_ROOT = realpathSync(
  resolve(process.env.CHENG_HOST_REAL_ROOT ?? process.env.ZCODE_CHENG_ROOT ?? "/Users/mac/cheng-lang"),
);
const ENABLED =
  process.env.CHENG_HOST_REAL === "1" &&
  existsSync(join(REAL_ROOT, "tools/csg_spec_v2_cli_run"));

const HOST_BIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const SPEC = join(REAL_ROOT, "data", "spec_v2", "tasks", "p02_min2.spec.json");
const SPECS_DIR = join(REAL_ROOT, "data", "spec_v2", "tasks");
const TASK = "p02_min2";
const realDescribe = ENABLED ? describe : describe.skip;

function shaFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function latestRunDir(outDir: string): string {
  const latest = join(outDir, "latest");
  const target = readlinkSync(latest);
  const match = /^runs\/(.+)$/.exec(target);
  if (match === null) {
    throw new Error(`unexpected latest target: ${target}`);
  }
  return join(outDir, "runs", match[1] as string);
}

async function waitTerminal(
  client: StdioHostClient,
  jobId: string,
  timeoutMs = 240_000,
): Promise<{ state: string; exitCode: number | null; runId: string | null; runDir: string | null; error: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.request("job.status", { jobId });
    if (status.state === "succeeded" || status.state === "failed" || status.state === "cancelled") {
      return status;
    }
    await sleep(400);
  }
  throw new Error(`job ${jobId} did not reach a terminal state`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

interface ReadyInfo {
  readonly endpoint: string;
  readonly hostJson: string;
}

function waitReady(child: ChildProcess, timeoutMs = 30_000): Promise<ReadyInfo> {
  return new Promise((resolveReady, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`host did not become ready: ${String(stderrTail)}`));
    }, timeoutMs);
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-3000);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) {
        return;
      }
      const line = buffer.slice(0, index);
      try {
        const parsed = JSON.parse(line) as { event?: unknown; endpoint?: unknown; hostJson?: unknown };
        if (parsed.event === "ready" && typeof parsed.endpoint === "string" && typeof parsed.hostJson === "string") {
          clearTimeout(timer);
          resolveReady({ endpoint: parsed.endpoint, hostJson: parsed.hostJson });
        }
      } catch {
        // Keep waiting for the ready line.
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited before ready: code=${String(code)} ${stderrTail}`));
    });
  });
}

function waitExit(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) {
      resolveExit();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

interface SocketRpc {
  (id: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

function socketRpc(socket: Socket): SocketRpc {
  const waiters = new Map<string, (frame: { ok: boolean; result?: unknown; error?: unknown }) => void>();
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        const frame = JSON.parse(line) as { t?: unknown; id?: unknown; ok?: boolean; result?: unknown; error?: unknown };
        if (frame.t === "res" && typeof frame.id === "string") {
          const waiter = waiters.get(frame.id);
          if (waiter !== undefined) {
            waiters.delete(frame.id);
            waiter(frame as { ok: boolean; result?: unknown; error?: unknown });
          }
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  return (id, method, params, timeoutMs = 60_000) =>
    new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        rejectRpc(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      waiters.set(id, (frame) => {
        clearTimeout(timer);
        if (frame.ok) {
          resolveRpc(frame.result);
        } else {
          rejectRpc(frame.error);
        }
      });
      socket.write(`${JSON.stringify({ v: 1, t: "req", id, method, params })}\n`);
    });
}

function helloFrame(token: string | null): string {
  return `${JSON.stringify({
    v: 1,
    t: "hello",
    id: "hello",
    auth: token,
    workspaceRoot: REAL_ROOT,
    workspaceIdentity: "cheng-lang",
    contract: 1,
    client: { kind: "cli" },
  })}\n`;
}

realDescribe("real cheng runtime", () => {
  it(
    "host generate matches the direct CLI and projects diagnostic receipts",
    async () => {
      const dataBase = tempDir("data-");
      const client = await StdioHostClient.connect({
        command: process.execPath,
        args: [
          HOST_BIN,
          "--scope=stdio",
          `--workspace-root=${REAL_ROOT}`,
          `--data-base-dir=${dataBase}`,
        ],
        env: { ...process.env, ZCODE_CHENG_ROOT: REAL_ROOT },
        workspaceRoot: REAL_ROOT,
        workspaceIdentity: "cheng-lang",
        clientKind: "cli",
      });

      try {
        const caps = await client.capabilities();
        expect(caps.runtime.headSha).toMatch(/^[0-9a-f]{40}$/);
        expect(caps.ops.parse?.available).toBe(false);
        expect(caps.ops.generate?.available).toBe(true);

        const spec = await client.request("spec.validate", { specPath: SPEC, task: TASK });
        expect(spec.kind).toBe("cheng_spec_ref");
        expect(spec.modules.length).toBeGreaterThan(0);

        const events: Array<{ method: string; jobId: string; state: string }> = [];
        client.onEvent((event) => {
          events.push({ method: event.method, jobId: event.params.jobId, state: event.params.state });
        });

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
        expect(terminal.runDir).not.toBeNull();

        const progress = events.filter(
          (event) => event.jobId === started.jobId && event.method === "job.progress",
        );
        const terminalEvents = events.filter(
          (event) => event.jobId === started.jobId && event.method === "job.state" && event.state === "succeeded",
        );
        expect(progress.length).toBeGreaterThan(0);
        expect(terminalEvents).toHaveLength(1);

        const runDir = terminal.runDir as string;
        const verify = await client.request("verify", { jobId: started.jobId });
        expect(verify.receipt.acceptance.level).toBe("DIAGNOSTIC_NOT_ACCEPTANCE");
        expect(verify.receipt.acceptance.productionAcceptance).toBe(false);
        expect(verify.settle?.settles.length).toBeGreaterThan(0);
        expect(verify.structure).toBeNull();
        expect(verify.structureReason).toContain("modules.tsv");

        const settle = await client.request("settle", { jobId: started.jobId, task: TASK });
        expect(settle.traceDone.task).toBe(TASK);
        expect(settle.settles.length).toBe(verify.settle?.settles.length);

        const decision = await client.request("graph.query", {
          jobId: started.jobId,
          task: TASK,
          view: "decision",
        });
        expect(decision.available).toBe(true);
        expect(decision.summary?.nodes).toBeGreaterThan(0);

        const structure = await client.request("graph.query", {
          jobId: started.jobId,
          task: TASK,
          view: "structure",
        });
        expect(structure.available).toBe(false);

        // Direct CLI run with identical inputs: deterministic artifacts must
        // match byte-for-byte (run.env/report carry run ids and are excluded).
        const directOut = join(dataBase, "direct-p02");
        mkdirSync(directOut, { recursive: true });
        const direct = spawnSync(
          join(REAL_ROOT, "tools", "csg_spec_v2_cli_run"),
          [
            `--out:${directOut}`,
            `--specs:${SPECS_DIR}`,
            `--tasks:${TASK}`,
            "--budget:30000",
            "--diagnostic",
          ],
          {
            cwd: REAL_ROOT,
            env: { ...process.env, ZCODE_CHENG_ROOT: REAL_ROOT },
            encoding: "utf8",
            timeout: 300_000,
          },
        );
        expect(direct.status).toBe(41);
        const directRun = latestRunDir(directOut);
        for (const relative of [
          "judge/judge.tsv",
          "judge_inputs.tsv",
          `tasks/${TASK}/replay.run1/trace.jsonl`,
        ]) {
          expect(shaFile(join(runDir, relative))).toBe(shaFile(join(directRun, relative)));
        }
        // `report_sha256` covers the compile report, which embeds the
        // `--out` absolute path; every other prog field must match.
        const hostProg = readFileSync(join(runDir, "prog_receipts.tsv"), "utf8").trim().split("\n");
        const directProg = readFileSync(join(directRun, "prog_receipts.tsv"), "utf8").trim().split("\n");
        expect(hostProg).toHaveLength(directProg.length);
        for (let row = 0; row < hostProg.length; row += 1) {
          const hostCells = (hostProg[row] as string).split("\t");
          const directCells = (directProg[row] as string).split("\t");
          expect(hostCells).toHaveLength(directCells.length);
          for (let cell = 0; cell < hostCells.length; cell += 1) {
            if (row > 0 && cell === 3) {
              continue;
            }
            expect(hostCells[cell]).toBe(directCells[cell]);
          }
        }

        // Cancel a second long-budget job; it must not remain running.
        const second = await client.request("generate", {
          specPath: SPEC,
          task: TASK,
          mode: "diagnostic",
          budget: 900_000,
        });
        const cancelled = await client.request("job.cancel", { jobId: second.jobId });
        expect(cancelled.cancelRequested).toBe(true);
        expect(["cancelled", "succeeded"]).toContain(cancelled.state);
        const after = await waitTerminal(client, second.jobId);
        expect(after.state).not.toBe("running");
        if (after.state === "cancelled") {
          expect(after.error).toBeNull();
        }
      } finally {
        await client.close();
      }
    },
    420_000,
  );
});

realDescribe("workspace host restart", () => {
  it(
    "marks an in-flight job failed(hostRestarted) and reaps its process group",
    async () => {
      const dataBase = tempDir("data-");
      const spawnHost = (): ChildProcess =>
        spawn(
          process.execPath,
          [
            HOST_BIN,
            "--scope=workspace",
            `--workspace-root=${REAL_ROOT}`,
            `--data-base-dir=${dataBase}`,
          ],
          {
            env: { ...process.env, ZCODE_CHENG_ROOT: REAL_ROOT },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

      const first = spawnHost();
      const ready = await waitReady(first);
      const info = JSON.parse(readFileSync(ready.hostJson, "utf8")) as {
        endpoint: string;
        tokenPath: string;
      };
      const token = readFileSync(info.tokenPath, "utf8").trim();

      const socket = connect(info.endpoint);
      await new Promise<void>((resolveConnect, rejectConnect) => {
        socket.once("connect", () => resolveConnect());
        socket.once("error", rejectConnect);
      });
      socket.write(helloFrame(token));
      const rpc = socketRpc(socket);
      await rpc("c1", "capabilities", {});
      const started = (await rpc("g1", "generate", {
        specPath: SPEC,
        task: TASK,
        mode: "diagnostic",
        budget: 900_000,
      })) as { jobId: string; state: string };
      expect(started.state).toBe("running");

      // Kill the host while the detached runner is still solving.
      first.kill("SIGKILL");
      await waitExit(first);
      socket.destroy();

      const second = spawnHost();
      const readyAgain = await waitReady(second);
      const infoAgain = JSON.parse(readFileSync(readyAgain.hostJson, "utf8")) as {
        endpoint: string;
        tokenPath: string;
      };
      const socketAgain = connect(infoAgain.endpoint);
      await new Promise<void>((resolveConnect, rejectConnect) => {
        socketAgain.once("connect", () => resolveConnect());
        socketAgain.once("error", rejectConnect);
      });
      socketAgain.write(helloFrame(readFileSync(infoAgain.tokenPath, "utf8").trim()));
      const rpcAgain = socketRpc(socketAgain);
      await rpcAgain("c1", "capabilities", {});
      const status = (await rpcAgain("s1", "job.status", { jobId: started.jobId })) as {
        state: string;
        error: { code?: string } | null;
      };
      expect(status.state).toBe("failed");
      expect(status.error?.code).toBe("host.hostRestarted");

      const jobDir = join(
        dataBase,
        ".chengcode",
        "v2",
        "cheng",
        workspaceHash(REAL_ROOT),
        "jobs",
        started.jobId,
      );
      const journal = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
        pgid: number | null;
      };
      if (journal.pgid !== null) {
        expect(isGroupAlive(journal.pgid)).toBe(false);
      }

      socketAgain.destroy();
      second.kill("SIGTERM");
      await waitExit(second);
    },
    240_000,
  );
});

function workspaceHash(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 32);
}

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    if (code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
