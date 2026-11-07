import { randomBytes, createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HostError, toHostError } from "./errors.js";
import { JobEngine } from "./job-engine.js";
import { JobStore } from "./job-store.js";
import { artifactRootFor, ensureArtifactRoot, realpathDirectory, resolveDataBaseDir, resolveWorkspaceRoot, socketPathFor, workspaceHash } from "./paths.js";
import { assertExpectedPins, buildSessionEnv, probeRuntime, type ExpectedPins } from "./runtime.js";
import { currentProcStart } from "./runner.js";
import { createHostCore, serveConnection } from "./server.js";
import { CONTRACT_MAJOR, EXIT_RUNTIME_UNAVAILABLE, PROTOCOL_VERSION } from "./version.js";

export type HostScope = "stdio" | "workspace";

export interface HostArgs {
  readonly scope: HostScope;
  readonly workspaceRoot: string;
  readonly dataBaseDir?: string;
  readonly specRoots: readonly string[];
  readonly expectedPins: ExpectedPins;
}

export function parseHostArgs(argv: readonly string[]): HostArgs {
  let scope: HostScope | null = null;
  let workspaceRoot: string | null = null;
  let dataBaseDir: string | undefined;
  const specRoots: string[] = [];
  const expectedPins: { headSha?: string; runnerSha256?: string; driverSha256?: string } = {};

  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match === null) {
      throw new HostError("host.invalidParams", `unsupported argument: ${arg}`);
    }
    const key = match[1];
    const value = match[2] ?? "";
    switch (key) {
      case "scope":
        if (value !== "stdio" && value !== "workspace") {
          throw new HostError("host.invalidParams", `invalid scope: ${value}`);
        }
        scope = value;
        break;
      case "workspace-root":
        workspaceRoot = value;
        break;
      case "data-base-dir":
        dataBaseDir = value;
        break;
      case "spec-root":
        specRoots.push(value);
        break;
      case "expect-head-sha":
        if (!/^[0-9a-f]{40}$/.test(value)) {
          throw new HostError("host.invalidParams", `invalid --expect-head-sha: ${value}`);
        }
        expectedPins.headSha = value;
        break;
      case "expect-runner-sha":
        if (!/^[0-9a-f]{64}$/.test(value)) {
          throw new HostError("host.invalidParams", `invalid --expect-runner-sha: ${value}`);
        }
        expectedPins.runnerSha256 = value;
        break;
      case "expect-driver-sha":
        if (!/^[0-9a-f]{64}$/.test(value)) {
          throw new HostError("host.invalidParams", `invalid --expect-driver-sha: ${value}`);
        }
        expectedPins.driverSha256 = value;
        break;
      default:
        throw new HostError("host.invalidParams", `unknown argument: --${key}`);
    }
  }

  if (scope === null) {
    throw new HostError("host.invalidParams", "--scope=stdio|workspace is required");
  }
  if (workspaceRoot === null || workspaceRoot.length === 0) {
    throw new HostError("host.invalidParams", "--workspace-root=<dir> is required");
  }
  return {
    scope,
    workspaceRoot,
    ...(dataBaseDir === undefined ? {} : { dataBaseDir }),
    specRoots,
    expectedPins,
  };
}

export async function runHost(argv: readonly string[]): Promise<void> {
  const args = parseHostArgs(argv);
  if (args.scope === "stdio") {
    await runStdioScope(args);
    return;
  }
  await runWorkspaceScope(args);
}

async function runStdioScope(args: HostArgs): Promise<void> {
  const dataBaseDir = resolveDataBaseDir(args.dataBaseDir);
  const pin = probeRuntime();
  assertExpectedPins(pin, args.expectedPins);
  const workspaceRoot = resolveWorkspaceRoot(args.workspaceRoot);
  // A session host must not share the workspace job journal: recovery in one
  // host would otherwise fail jobs owned by another live host.
  const sessionRoot = artifactRootFor(dataBaseDir, workspaceHash(workspaceRoot));
  const scopedRoot = join(sessionRoot, "sessions", `${String(process.pid)}-${randomBytes(6).toString("hex")}`);
  const extraRoots = args.specRoots.map((path) => realpathDirectory(path, "spec root"));
  const specRoots = [pin.chengRoot, ...extraRoots].filter(
    (path, index, all) => all.indexOf(path) === index,
  );
  const root = ensureArtifactRoot(scopedRoot, workspaceRoot);
  const store = new JobStore(root);
  const engine = new JobEngine({ pin, store, env: buildSessionEnv() });
  engine.recover();
  const core = createHostCore({ pin, engine, workspaceRoot, specRoots });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await engine.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });

  await serveConnection({
    input: process.stdin,
    send: (frame) => {
      process.stdout.write(`${frame}\n`);
    },
    core,
    authToken: null,
    workspaceRoot,
  });
  // stdin closed: the owning session is gone, cancel everything.
  await shutdown();
}

async function runWorkspaceScope(args: HostArgs): Promise<void> {
  const dataBaseDir = resolveDataBaseDir(args.dataBaseDir);
  const pin = probeRuntime();
  assertExpectedPins(pin, args.expectedPins);
  const workspaceRoot = resolveWorkspaceRoot(args.workspaceRoot);
  const baseRoot = artifactRootFor(dataBaseDir, workspaceHash(workspaceRoot));
  const root = ensureArtifactRoot(baseRoot, workspaceRoot);

  const lock = acquireSpawnLock(join(root, "host.spawn.lock"));
  const socketPath = socketPathFor(root, workspaceHash(workspaceRoot));
  const hostJsonPath = join(root, "host.json");
  const tokenPath = join(root, "host.token");

  try {
    if (existsSync(socketPath) && (await socketIsAlive(socketPath))) {
      throw new HostError("host.spawnBusy", "another cheng-host is already serving this workspace", {
        evidence: [`socket=${socketPath}`, `lock=${lock}`],
      });
    }
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    const token = randomBytes(32).toString("hex");
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    const tokenSha256 = createHash("sha256").update(token).digest("hex");

    const extraRoots = args.specRoots.map((path) => realpathDirectory(path, "spec root"));
    const specRoots = [pin.chengRoot, ...extraRoots].filter(
      (path, index, all) => all.indexOf(path) === index,
    );
    const store = new JobStore(root);
    const engine = new JobEngine({ pin, store, env: buildSessionEnv() });
    engine.recover();
    const core = createHostCore({ pin, engine, workspaceRoot, specRoots });

    let connections = 0;
    let lastActivity = Date.now();
    const server = createServer((socket) => {
      connections += 1;
      lastActivity = Date.now();
      socket.once("close", () => {
        connections -= 1;
        lastActivity = Date.now();
      });
      socket.on("error", () => {
        // A dropped connection must not crash the host.
      });
      void serveConnection({
        input: socket,
        send: (frame) => {
          socket.write(`${frame}\n`);
        },
        core,
        authToken: token,
        workspaceRoot,
      }).catch((error: unknown) => {
        const payload = toHostError(error).toPayload();
        if (!socket.destroyed) {
          socket.write(
            `${JSON.stringify({ v: PROTOCOL_VERSION, t: "res", id: "hello", ok: false, error: payload })}\n`,
          );
          socket.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600);
        resolve();
      });
    });

    writeFileSync(
      hostJsonPath,
      `${JSON.stringify(
        {
          v: PROTOCOL_VERSION,
          endpoint: socketPath,
          scope: "workspace",
          workspaceRoot,
          pid: process.pid,
          startedUtc: new Date().toISOString(),
          tokenPath,
          tokenSha256,
          contract: CONTRACT_MAJOR,
          fingerprint: core.capabilities.fingerprint,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    process.stdout.write(
      `${JSON.stringify({ event: "ready", endpoint: socketPath, hostJson: hostJsonPath, fingerprint: core.capabilities.fingerprint })}\n`,
    );

    let shuttingDown = false;
    const shutdown = async (code = 0): Promise<void> => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      clearInterval(idleTimer);
      server.close();
      await engine.close();
      for (const path of [socketPath, hostJsonPath, tokenPath]) {
        if (existsSync(path)) {
          unlinkSync(path);
        }
      }
      releaseSpawnLock(lock);
      process.exit(code);
    };
    const idleTimer = setInterval(() => {
      if (connections === 0 && !engine.hasActiveJobs() && Date.now() - lastActivity > 30 * 60 * 1000) {
        void shutdown(0);
      }
    }, 60_000);
    idleTimer.unref();

    process.once("SIGTERM", () => {
      void shutdown(0);
    });
    process.once("SIGINT", () => {
      void shutdown(0);
    });
  } catch (error) {
    releaseSpawnLock(lock);
    throw error;
  }
}

interface SpawnLock {
  readonly path: string;
  readonly pid: number;
}

function acquireSpawnLock(path: string): SpawnLock {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(
        path,
        `${JSON.stringify({ pid: process.pid, startedUtc: new Date().toISOString(), procStart: currentProcStart(process.pid) })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      return { path, pid: process.pid };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
      if (code !== "EEXIST") {
        throw error;
      }
      if (attempt === 1) {
        throw new HostError("host.spawnBusy", "cannot acquire host spawn lock", {
          evidence: [`lock=${path}`],
        });
      }
      const holder = readSpawnLock(path);
      if (holder !== null && holder.pid !== process.pid && currentProcStart(holder.pid) === holder.procStart) {
        throw new HostError("host.spawnBusy", "another cheng-host holds the spawn lock", {
          evidence: [`pid=${String(holder.pid)}`, `lock=${path}`],
        });
      }
      unlinkSync(path);
    }
  }
  throw new HostError("host.spawnBusy", "cannot acquire host spawn lock", { evidence: [`lock=${path}`] });
}

function readSpawnLock(path: string): { pid: number; procStart: string | null } | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; procStart?: unknown };
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) {
      return null;
    }
    return { pid: raw.pid, procStart: typeof raw.procStart === "string" ? raw.procStart : null };
  } catch {
    return null;
  }
}

function releaseSpawnLock(lock: SpawnLock): void {
  const holder = readSpawnLock(lock.path);
  if (holder !== null && holder.pid === lock.pid) {
    unlinkSync(lock.path);
  }
}

function socketIsAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

const isMain = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  // 修复：CLI 开发入口同样以 main.ts 结尾——按文件名匹配会让 cheng-host 在宿主
  // 进程 import 本包时误执行二进制路径（把宿主 argv 当 host 参数拒绝）。改为与本
  // 模块自身路径精确比对（两侧都 realpath，覆盖经符号链接调用与 pnpm workspace 链）。
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  runHost(process.argv.slice(2)).catch((error: unknown) => {
    const hostError = toHostError(error);
    process.stderr.write(`${JSON.stringify(hostError.toPayload())}\n`);
    process.exit(
      hostError.code === "host.runtimeUnavailable" || hostError.code === "host.platformUnsupported"
        ? EXIT_RUNTIME_UNAVAILABLE
        : 1,
    );
  });
}
