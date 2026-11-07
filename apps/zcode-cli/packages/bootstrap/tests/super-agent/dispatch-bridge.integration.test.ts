/**
 * 派发桥生产循环集成（B-SPEC §3.5 / §4.4 / T3；真实子进程 + 真实 socket + 真实 sqlite）。
 *
 * 覆盖：
 * 1. pending_dispatch → 桥 push（host.command）→ Core ACK → dispatched 终态；
 * 2. ACK 帧丢失 → 停滞 pushed 行用同 commandId 重推，Core duplicate 幂等吸收，不双跑；
 * 3. Core 通道断开 → pending 行不进 push，宽限 CAS 收敛 skipped(no_dispatcher)；
 * 4. push 后 child 被 kill -9 → 重启桥按 pushed 停滞行续推同 commandId，终态唯一。
 *
 * 用 `startControlPlaneDaemon` 真实入口 + esbuild 打包 fixture（与 daemon 集成测试同款）。
 * Core 侧是测试替身（真实 socket 帧、真实 admission 幂等语义），只存在于测试代码。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  CONTROL_PLANE_RPC_VERSION,
  resolveControlPlaneSocketPath,
} from "@zcode/shared/super-agent-control-plane-protocol";

const TEST_TIMEOUT_MS = 30_000;
const roots: string[] = [];
const children: ChildProcess[] = [];

const DISPATCH_REQUESTS_DDL = `
  CREATE TABLE IF NOT EXISTS dispatch_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    command_id TEXT NOT NULL UNIQUE,
    workspace_identity TEXT NOT NULL,
    session_id TEXT,
    payload TEXT,
    status TEXT NOT NULL,
    skip_reason TEXT,
    dispatch_policy TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    pushed_at INTEGER,
    acked_at INTEGER,
    settled_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dispatch_requests_status_updated
  ON dispatch_requests (status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_dispatch_requests_workspace_status
  ON dispatch_requests (workspace_identity, status);
`;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

interface ChildMessages {
  messages: Array<Record<string, unknown>>;
  waiting: Array<{ predicate: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }>;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

function collectMessages(child: ChildProcess): ChildMessages {
  const messages: Array<Record<string, unknown>> = [];
  const waiting: ChildMessages["waiting"] = [];
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.on("message", (raw: unknown) => {
    const message = raw as Record<string, unknown>;
    messages.push(message);
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      const entry = waiting[index]!;
      if (entry.predicate(message)) {
        waiting.splice(index, 1);
        entry.resolve(message);
      }
    }
  });
  return { messages, waiting, exited };
}

function waitForMessage(
  child: ChildMessages,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const existing = child.messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for IPC message; got ${JSON.stringify(child.messages)}`));
    }, timeoutMs);
    child.waiting.push({
      predicate,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
  });
}

async function bundleFixture(): Promise<string> {
  const fixture = fileURLToPath(
    new URL("./fixtures/control-plane-daemon-child.ts", import.meta.url),
  );
  const result = await build({
    entryPoints: [fixture],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("fixture bundle produced no output");
  return output.text;
}

let cachedBundle: string | undefined;

async function spawnDaemon(options: {
  dataBaseDir: string;
  serverRoot: string;
  dispatchIntervalMs: number;
  dispatchGraceMs: number;
}): Promise<{ child: ChildProcess; ipc: ChildMessages }> {
  const bundle = cachedBundle ?? (await bundleFixture());
  cachedBundle = bundle;
  const bundlePath = join(options.dataBaseDir, `fixture-${Date.now()}.cjs`);
  await mkdir(options.dataBaseDir, { recursive: true });
  await writeFile(bundlePath, bundle, "utf8");
  const child = spawn(process.execPath, [bundlePath], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      ZCODE_CONTROL_PLANE_GENERATION: "1",
      ZCODE_CONTROL_PLANE_PROTOCOL_VERSION: String(CONTROL_PLANE_PROTOCOL_VERSION),
      ZCODE_DATA_BASE_DIR: options.dataBaseDir,
      ZCODE_SERVER_ROOT: options.serverRoot,
      TEST_TRUSTED_PID: String(process.pid),
      TEST_DISPATCH_INTERVAL_MS: String(options.dispatchIntervalMs),
      TEST_DISPATCH_GRACE_MS: String(options.dispatchGraceMs),
    },
  });
  children.push(child);
  return { child, ipc: collectMessages(child) };
}

type InboundHandlerResult =
  | { kind: "result"; result: unknown }
  | { kind: "error"; message: string }
  | { kind: "lose-ack" };

type HostCommandParams = {
  workspaceIdentity: string;
  commandId: string;
  sessionId?: string | null;
  lane?: string;
};

interface CoreConnection {
  socket: Socket;
  calls: Array<{ method: string; params: unknown }>;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

/**
 * 测试 Core：连接 child 的 RPC socket，响应 child 反向请求。
 * `onHostCommand` 控制 admission 回执；`lose-ack` = 已准入但故意不回帧（模拟 ACK 丢失）。
 */
async function connectCore(
  endpoint: string,
  onHostCommand: (params: HostCommandParams) => InboundHandlerResult | Promise<InboundHandlerResult>,
): Promise<CoreConnection> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const client = new Socket();
    client.once("connect", () => resolve(client));
    client.once("error", reject);
    client.connect(endpoint);
  });
  const calls: CoreConnection["calls"] = [];
  let buffer = "";
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 0;

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (typeof frame.id === "string" && typeof frame.ok === "boolean") {
        const call = pending.get(frame.id);
        if (!call) continue;
        pending.delete(frame.id);
        clearTimeout(call.timer);
        if (frame.ok) call.resolve(frame.result);
        else call.reject(new Error(JSON.stringify(frame.error)));
        continue;
      }
      if (typeof frame.id === "string" && typeof frame.method === "string") {
        const id = frame.id;
        calls.push({ method: frame.method, params: frame.params });
        void (async () => {
          let outcome: InboundHandlerResult;
          if (frame.method === "host.command") {
            outcome = await onHostCommand(frame.params as HostCommandParams);
          } else if (frame.method === "backfill.seeds") {
            outcome = { kind: "result", result: { seeds: [] } };
          } else {
            outcome = { kind: "error", message: `unexpected inbound ${frame.method}` };
          }
          if (socket.destroyed) return;
          if (outcome.kind === "lose-ack") {
            // 模拟 ACK 帧丢失：不写回响应就断开连接（child 侧 push 抛错/超时，行保持 pushed）。
            socket.destroy();
            return;
          }
          if (outcome.kind === "result") {
            socket.write(`${JSON.stringify({ v: CONTROL_PLANE_RPC_VERSION, id, ok: true, result: outcome.result })}\n`);
            return;
          }
          socket.write(
            `${JSON.stringify({
              v: CONTROL_PLANE_RPC_VERSION,
              id,
              ok: false,
              error: { code: "workspace.failed", message: outcome.message, retriable: true },
            })}\n`,
          );
        })();
      }
    }
  });

  return {
    socket,
    calls,
    request(method, params, timeoutMs = 10_000) {
      const id = `t-${nextId++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`rpc request timeout: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.write(`${JSON.stringify({ v: CONTROL_PLANE_RPC_VERSION, id, method, params })}\n`);
      });
    },
    close() {
      socket.destroy();
    },
  };
}

function dispatchCommandId(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}

interface PendingRowInput {
  runId: string;
  workspaceIdentity: string;
  sessionId: string | null;
  payload: string | null;
  updatedAt: number;
  policy?: "in_window" | "durable_wait";
}

function openTasksIndex(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("pragma busy_timeout = 5000");
  db.exec(DISPATCH_REQUESTS_DDL);
  return db;
}

function insertPending(db: DatabaseSync, input: PendingRowInput): void {
  db.prepare(
    `insert into dispatch_requests (
      id, run_id, command_id, workspace_identity, session_id, payload,
      status, skip_reason, dispatch_policy, attempts,
      claimed_at, pushed_at, acked_at, settled_at, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, 'pending_dispatch', NULL, ?, 0,
      ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    `req-${input.runId}`,
    input.runId,
    dispatchCommandId(input.runId),
    input.workspaceIdentity,
    input.sessionId,
    input.payload,
    input.policy ?? "in_window",
    input.updatedAt,
    input.updatedAt,
    input.updatedAt,
  );
}

function readDispatchRow(
  db: DatabaseSync,
  runId: string,
): { status: string; skip_reason: string | null; attempts: number; command_id: string } | undefined {
  return db
    .prepare("select status, skip_reason, attempts, command_id from dispatch_requests where run_id = ?")
    .get(runId) as
    | { status: string; skip_reason: string | null; attempts: number; command_id: string }
    | undefined;
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function startDaemonHarness(options: {
  root: string;
  dispatchIntervalMs?: number;
  dispatchGraceMs?: number;
}): Promise<{
  dataBaseDir: string;
  serverRoot: string;
  endpoint: string;
  tasksIndexPath: string;
  db: DatabaseSync;
  child: ChildProcess;
  ipc: ChildMessages;
}> {
  const dataBaseDir = join(options.root, "data");
  const serverRoot = join(options.root, "server");
  await mkdir(serverRoot, { recursive: true });
  // 30d725bc 迁移后数据根为 .chengcode（与 resolveTasksIndexDatabasePath 同源）。
  const tasksIndexDir = join(dataBaseDir, ".chengcode", "v2");
  await mkdir(tasksIndexDir, { recursive: true });
  const tasksIndexPath = join(tasksIndexDir, "tasks-index.sqlite");
  const db = openTasksIndex(tasksIndexPath);
  const { child, ipc } = await spawnDaemon({
    dataBaseDir,
    serverRoot,
    dispatchIntervalMs: options.dispatchIntervalMs ?? 50,
    dispatchGraceMs: options.dispatchGraceMs ?? 50,
  });
  await waitForMessage(ipc, (m) => m.type === "ready");
  return {
    dataBaseDir,
    serverRoot,
    endpoint: resolveControlPlaneSocketPath(serverRoot),
    tasksIndexPath,
    db,
    child,
    ipc,
  };
}

async function ensureLeader(core: CoreConnection, workspaceIdentity: string, tasksIndexReady: boolean): Promise<void> {
  const ensure = (await core.request("workspace.ensure", {
    workspaceIdentity,
    tasksIndexReady,
  })) as { state: string };
  expect(ensure.state).toBe("leader");
}

describe("dispatch bridge production loop", () => {
  it(
    "pending → child push host.command → Core ACK → dispatched 终态",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcp-a-"));
      roots.push(root);
      const harness = await startDaemonHarness({ root });
      const admitted = new Set<string>();
      const core = await connectCore(harness.endpoint, (params) => {
        const duplicate = admitted.has(params.commandId);
        admitted.add(params.commandId);
        return {
          kind: "result",
          result: {
            commandId: params.commandId,
            status: duplicate ? "duplicate" : "accepted",
            revisionAtDecision: 1,
          },
        };
      });
      try {
        insertPending(harness.db, {
          runId: "run-1",
          workspaceIdentity: "ws-1",
          sessionId: "session-1",
          payload: "hello from automation",
          updatedAt: Date.now(),
        });
        await ensureLeader(core, "ws-1", true);
        await waitUntil(
          () => readDispatchRow(harness.db, "run-1")?.status === "dispatched",
          "dispatch row dispatched",
        );
        const row = readDispatchRow(harness.db, "run-1");
        expect(row).toMatchObject({
          status: "dispatched",
          attempts: 1,
          command_id: dispatchCommandId("run-1"),
        });
        const commands = core.calls.filter((call) => call.method === "host.command");
        expect(commands).toHaveLength(1);
        expect(commands[0]!.params).toMatchObject({
          workspaceIdentity: "ws-1",
          commandId: dispatchCommandId("run-1"),
          lane: "followup",
          sessionId: "session-1",
        });
      } finally {
        core.close();
        harness.db.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ACK 丢失：停滞 pushed 行用同 commandId 重推，duplicate 幂等吸收",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcp-b-"));
      roots.push(root);
      const harness = await startDaemonHarness({ root });
      // Core admission 幂等表（测试替身）：commandId 首次 accepted，重投必须 duplicate。
      const admitted = new Set<string>();
      let commandCount = 0;
      let lostOnce = false;
      const core = await connectCore(harness.endpoint, (params) => {
        commandCount += 1;
        if (!lostOnce && commandCount === 1) {
          // 已准入但 ACK 帧丢失：断开连接，child 的 push 抛错，行保持 pushed。
          admitted.add(params.commandId);
          lostOnce = true;
          return { kind: "lose-ack" };
        }
        const duplicate = admitted.has(params.commandId);
        admitted.add(params.commandId);
        return {
          kind: "result",
          result: {
            commandId: params.commandId,
            status: duplicate ? "duplicate" : "accepted",
            revisionAtDecision: 1,
          },
        };
      });
      try {
        // 先 ensure 再写行：ensure 期间桥会立即跑一轮；空表时无副作用，确保 ensure
        // 响应不被「ACK 丢失即断连」的测试替身波及。
        await ensureLeader(core, "ws-1", true);
        insertPending(harness.db, {
          runId: "run-2",
          workspaceIdentity: "ws-1",
          sessionId: "session-1",
          payload: "wake text",
          updatedAt: Date.now(),
        });
        // ACK 丢失会断开本次连接；重连后重新 ensure 才能让桥再次拿到可达通道。
        await waitUntil(
          () => core.socket.destroyed,
          "first host.command connection dropped",
        ).catch(() => undefined);
        const core2 = await connectCore(harness.endpoint, (params) => {
          const duplicate = admitted.has(params.commandId);
          admitted.add(params.commandId);
          return {
            kind: "result",
            result: {
              commandId: params.commandId,
              status: duplicate ? "duplicate" : "accepted",
              revisionAtDecision: 1,
            },
          };
        });
        try {
          await ensureLeader(core2, "ws-1", true);
          await waitUntil(
            () => readDispatchRow(harness.db, "run-2")?.status === "dispatched",
            "row dispatched after ACK retry",
          );
          const row = readDispatchRow(harness.db, "run-2");
          expect(row?.attempts).toBeGreaterThanOrEqual(2);
          expect(row?.command_id).toBe(dispatchCommandId("run-2"));
          // 重投未产生第二个 admission key：同 commandId 被幂等吸收（不双跑）。
          expect(admitted.size).toBe(1);
          const commands = core2.calls.filter((call) => call.method === "host.command");
          expect(commands).toHaveLength(1);
          expect(commands[0]!.params).toMatchObject({
            commandId: dispatchCommandId("run-2"),
          });
        } finally {
          core2.close();
        }
      } finally {
        core.close();
        harness.db.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "Core 通道断开：pending 行不 push，宽限 CAS 收敛 skipped(no_dispatcher)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcp-c-"));
      roots.push(root);
      const harness = await startDaemonHarness({ root, dispatchGraceMs: 50 });
      const core = await connectCore(harness.endpoint, () => ({
        kind: "result",
        result: { commandId: "unused", status: "accepted", revisionAtDecision: 1 },
      }));
      try {
        await ensureLeader(core, "ws-1", true);
        core.close();
        // 等 child 观察到连接关闭：桥判定宿主不可达后不推 pending 行。
        await delay(100);
        insertPending(harness.db, {
          runId: "run-3",
          workspaceIdentity: "ws-1",
          sessionId: "session-1",
          payload: "no dispatcher",
          // 已超宽限：第一轮 sweep 即结算 skipped。
          updatedAt: Date.now() - 10_000,
        });
        await waitUntil(
          () => readDispatchRow(harness.db, "run-3")?.status === "skipped",
          "row skipped by grace",
        );
        expect(readDispatchRow(harness.db, "run-3")).toMatchObject({
          status: "skipped",
          skip_reason: "no_dispatcher",
          attempts: 0,
        });
      } finally {
        core.close();
        harness.db.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "push 后 child 被 kill -9：重启桥按 pushed 停滞行续推同 commandId，不双跑",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcp-d-"));
      roots.push(root);
      const harness = await startDaemonHarness({ root });
      let firstCallCommandId: string | undefined;
      const admitted = new Set<string>();
      const core = await connectCore(harness.endpoint, (params) => {
        if (!firstCallCommandId) {
          firstCallCommandId = params.commandId;
          admitted.add(params.commandId);
          // push 已到 Core，但 ACK 丢失且 child 随即被 kill：行停在 pushed。
          return { kind: "lose-ack" };
        }
        const duplicate = admitted.has(params.commandId);
        admitted.add(params.commandId);
        return {
          kind: "result",
          result: {
            commandId: params.commandId,
            status: duplicate ? "duplicate" : "accepted",
            revisionAtDecision: 1,
          },
        };
      });
      // 先 ensure（空表，避免 ensure 响应与「ACK 丢失即断连」竞态），再写行触发 push。
      await ensureLeader(core, "ws-1", true);
      insertPending(harness.db, {
        runId: "run-4",
        workspaceIdentity: "ws-1",
        sessionId: "session-1",
        payload: "restart resume",
        updatedAt: Date.now(),
      });
      // 等到第一帧 host.command 到达（此时 child 的 CAS 已把行置 pushed）。
      await waitUntil(() => firstCallCommandId !== undefined, "first push");
      await waitUntil(
        () => readDispatchRow(harness.db, "run-4")?.status === "pushed",
        "row stays pushed after lost ACK",
      );
      harness.child.kill("SIGKILL");
      await harness.ipc.exited;
      core.close();

      const restarted = await spawnDaemon({
        dataBaseDir: harness.dataBaseDir,
        serverRoot: harness.serverRoot,
        dispatchIntervalMs: 50,
        dispatchGraceMs: 50,
      });
      await waitForMessage(restarted.ipc, (m) => m.type === "ready");
      const endpoint = resolveControlPlaneSocketPath(harness.serverRoot);
      let secondCallCommandId: string | undefined;
      const core2 = await connectCore(endpoint, (params) => {
        secondCallCommandId = params.commandId;
        const duplicate = admitted.has(params.commandId);
        admitted.add(params.commandId);
        return {
          kind: "result",
          result: {
            commandId: params.commandId,
            status: duplicate ? "duplicate" : "accepted",
            revisionAtDecision: 1,
          },
        };
      });
      try {
        await ensureLeader(core2, "ws-1", true);
        await waitUntil(
          () => readDispatchRow(harness.db, "run-4")?.status === "dispatched",
          "restarted bridge settles dispatched",
        );
        const row = readDispatchRow(harness.db, "run-4");
        expect(row?.command_id).toBe(dispatchCommandId("run-4"));
        expect(row?.attempts).toBeGreaterThanOrEqual(2);
        expect(secondCallCommandId).toBe(firstCallCommandId);
        expect(secondCallCommandId).toBe(dispatchCommandId("run-4"));
        expect(admitted.size).toBe(1);
      } finally {
        core2.close();
        harness.db.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ensure 后超过 RPC 超时窗再插入 pending 行：后台 push 不继承已过期的父请求 deadline",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcp-e-"));
      roots.push(root);
      // 宽限放大到 1 分钟：旧实现里行会永久停在 pending/pushed（而非被宽限跳过），
      // 这样断言 dispatched 就精确暴露 deadline 继承缺陷。
      const harness = await startDaemonHarness({ root, dispatchGraceMs: 60_000 });
      let commandCount = 0;
      const core = await connectCore(harness.endpoint, (params) => {
        commandCount += 1;
        return {
          kind: "result",
          result: {
            commandId: params.commandId,
            status: "accepted",
            revisionAtDecision: 1,
          },
        };
      });
      try {
        await ensureLeader(core, "ws-1", true);
        // workspace.ensure 的父请求预算 = 10s（§3.2）。等它彻底过期后再写行：
        // 派发桥是后台循环，不属于任何父请求，必须用方法自身预算推送。
        await delay(11_000);
        insertPending(harness.db, {
          runId: "run-late",
          workspaceIdentity: "ws-1",
          sessionId: "session-1",
          payload: "late pending row",
          updatedAt: Date.now(),
        });
        await waitUntil(
          () => readDispatchRow(harness.db, "run-late")?.status === "dispatched",
          "late pending row pushed by background loop",
        );
        expect(commandCount).toBe(1);
        expect(readDispatchRow(harness.db, "run-late")).toMatchObject({
          status: "dispatched",
          attempts: 1,
          command_id: dispatchCommandId("run-late"),
        });
      } finally {
        core.close();
        harness.db.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "单 child 多 plane：各 workspace 只扫描/推送自己的行",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcp-f-"));
      roots.push(root);
      const harness = await startDaemonHarness({ root, dispatchGraceMs: 60_000 });
      const pushed: Array<{ commandId: string; workspaceIdentity: string }> = [];
      const core = await connectCore(harness.endpoint, (params) => {
        pushed.push({
          commandId: params.commandId,
          workspaceIdentity: params.workspaceIdentity,
        });
        return {
          kind: "result",
          result: { commandId: params.commandId, status: "accepted", revisionAtDecision: 1 },
        };
      });
      try {
        await ensureLeader(core, "ws-1", true);
        await ensureLeader(core, "ws-2", true);
        insertPending(harness.db, {
          runId: "run-ws1",
          workspaceIdentity: "ws-1",
          sessionId: "session-1",
          payload: "one",
          updatedAt: Date.now(),
        });
        insertPending(harness.db, {
          runId: "run-ws2",
          workspaceIdentity: "ws-2",
          sessionId: "session-2",
          payload: "two",
          updatedAt: Date.now(),
        });
        await waitUntil(
          () =>
            readDispatchRow(harness.db, "run-ws1")?.status === "dispatched" &&
            readDispatchRow(harness.db, "run-ws2")?.status === "dispatched",
          "both workspace rows dispatched",
        );
        expect(pushed).toHaveLength(2);
        const byCommand = new Map(pushed.map((entry) => [entry.commandId, entry.workspaceIdentity]));
        expect(byCommand.get(dispatchCommandId("run-ws1"))).toBe("ws-1");
        expect(byCommand.get(dispatchCommandId("run-ws2"))).toBe("ws-2");
      } finally {
        core.close();
        harness.db.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
