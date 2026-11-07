/**
 * daemon notify-user / cancel-stalled 进程级 E2E（S3 收口）：真实 daemon 子进程
 * （真实 sqlite 种子 + 真实 watchdog + 真实生产端口 + 真实 planeManager + 真实
 * control-plane socket）→ Core 缝（与真实 Core handler `handleHostWatchdogCommand`
 * 逐行等价的 envelope 构建/ack 映射，glue 真实覆盖在 server-cli 侧测试）→ 真实
 * `ConversationV4Gateway`（真实 CommandInbox 幂等 admission）→ 真实
 * `V4CommandExecutor` → 真实 `AgentRuntime`（真实 cancelBackgroundTask /
 * enqueueBackgroundTaskNotification；ledger 存储适配器为最外沿替身）。
 *
 * 与进程内整机链（daemon-notify-integration.test.ts）的区别：daemon 侧是真子进程、
 * 反向 RPC 走真 socket 帧、会话侧经真实 gateway admission（重投 duplicate 吸收）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  CONTROL_PLANE_RPC_VERSION,
  hostWatchdogCommandParamsSchema,
  resolveControlPlaneSocketPath,
} from "@zcode/shared/super-agent-control-plane-protocol";
import {
  commandEnvelopeSchema,
  type CommandAck,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { SqliteBackgroundRunStore } from "../../src/super-agent/storage/background-run-store.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";
import { getSuperAgentDatabasePath } from "../../src/app/paths.js";
import { ConversationV4Gateway } from "../../src/zcode-protocol-v4/v4-gateway.js";
import { V4CommandExecutor } from "../../src/zcode-protocol-v4/commands/executor.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../../src/zcode-protocol-v4/commands/types.js";

const TEST_TIMEOUT_MS = 60_000;
const WORKSPACE_KEY = "ws:e2e";
const SESSION_ID = "session-e2e";
const RUN_ID = "workflow-e2e-1";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

interface ChildMessages {
  messages: Array<Record<string, unknown>>;
  waiting: Array<{
    predicate: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }>;
}

function collectMessages(child: ChildProcess): ChildMessages {
  const messages: Array<Record<string, unknown>> = [];
  const waiting: ChildMessages["waiting"] = [];
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
  return { messages, waiting };
}

function waitForMessage(
  ipc: ChildMessages,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const existing = ipc.messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for IPC message; got ${JSON.stringify(ipc.messages)}`));
    }, timeoutMs);
    ipc.waiting.push({
      predicate: (message) => {
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

interface SpawnOptions {
  dataBaseDir: string;
  serverRoot: string;
  watchdogTickMs: number;
  escalationThreshold?: number;
  escalationCooldownMs?: number;
}

async function spawnDaemon(
  options: SpawnOptions,
): Promise<{ child: ChildProcess; ipc: ChildMessages }> {
  const bundle = await bundleFixture();
  await mkdir(options.dataBaseDir, { recursive: true });
  const bundlePath = join(options.dataBaseDir, `fixture-${Date.now()}.cjs`);
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
      TEST_WATCHDOG_TICK_MS: String(options.watchdogTickMs),
      ...(options.escalationThreshold
        ? { TEST_WATCHDOG_ESCALATION_THRESHOLD: String(options.escalationThreshold) }
        : {}),
      ...(options.escalationCooldownMs !== undefined
        ? { TEST_WATCHDOG_ESCALATION_COOLDOWN_MS: String(options.escalationCooldownMs) }
        : {}),
    },
  });
  children.push(child);
  return { child, ipc: collectMessages(child) };
}

/**
 * 以 Core 身份连上 daemon 的 control-plane socket：正向 request + 反向 host.* 应答。
 * 反向应答是异步的（真实 handler 要打会话栈），响应帧在 await 完成后写回。
 */
interface CoreConnection {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

async function connectCore(
  endpoint: string,
  hostHandler: (method: string, params: unknown) => Promise<unknown>,
): Promise<CoreConnection> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const client = new Socket();
    client.once("connect", () => resolve(client));
    client.once("error", reject);
    client.connect(endpoint);
  });
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 0;
  let buffer = "";
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
        void (async () => {
          try {
            const result = await hostHandler(frame.method, frame.params);
            socket.write(
              `${JSON.stringify({ v: CONTROL_PLANE_RPC_VERSION, id: frame.id, ok: true, result })}\n`,
            );
          } catch (error) {
            socket.write(
              `${JSON.stringify({
                v: CONTROL_PLANE_RPC_VERSION,
                id: frame.id,
                ok: false,
                error: {
                  code: -32000,
                  message: error instanceof Error ? error.message : String(error),
                },
              })}\n`,
            );
          }
        })();
      }
    }
  });
  return {
    request(method: string, params: unknown, timeoutMs = 10_000) {
      const id = `core-${nextId++}`;
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

/** 真实 owner session 栈：AgentRuntime + V4CommandExecutor + ConversationV4Gateway + 真实 sqlite 会话库。 */
interface RealSessionStack {
  gateway: ConversationV4Gateway;
  /** 真实 dynamicWorkflowRunPort.cancel 收到的 runId（owner 侧最外沿）。 */
  dwfCancels: string[];
  /** 真实 session_input 账本行（生产 sqlite 会话库直查；commandId 即幂等键主键）。 */
  /** 真实会话行 id（createSessionId 的 branded 形式，与 wire sessionId 差 sess_ 前缀）。 */
  readonly sessionRowId: string;
  readLedgerRows(): Promise<
    Array<{
      id: string;
      session_id: string;
      kind: string;
      delivery: string;
      status: string;
      payload: string;
    }>
  >;
  close(): Promise<void>;
  registerDwfTask(taskId: string): void;
}

async function makeRealSession(root: string): Promise<RealSessionStack> {
  const { AgentRuntime, InMemoryRuntimeTaskRegistry } = await import("@zcode/core");
  const { createProjectId, createSessionId } = await import("@zcode/contracts");
  const { createInMemorySessionEventStore, createSqliteSessionStore } =
    await import("@zcode/adapters/storage");

  const dwfCancels: string[] = [];
  // 真实 sqlite 会话库（生产 SessionStorePort 实现）：真实迁移 + 真实 session_input 账本。
  const sessionDbPath = join(root, "session.sqlite");
  const sessionStore = await createSqliteSessionStore({ dbPath: sessionDbPath });
  const sessionRowId = String(createSessionId(SESSION_ID));
  await sessionStore.createSession({
    id: createSessionId(SESSION_ID),
    projectID: createProjectId("daemon-watchdog-e2e"),
    slug: "daemon-watchdog-e2e",
    directory: root,
    title: "daemon watchdog e2e",
    version: "1",
  });
  const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
  const runtime = new AgentRuntime(createSessionId(SESSION_ID), { mode: "build" }, {
    dynamicWorkflowRunPort: {
      async submit() {
        throw new Error("submit should not be called");
      },
      async getTask(taskId: string) {
        return {
          taskId,
          runId: taskId,
          startedAt: new Date(0),
          status: dwfCancels.includes(taskId) ? "cancelled" : "running",
        };
      },
      async waitForTask(taskId: string) {
        return { taskId, runId: taskId, startedAt: new Date(0), status: "cancelled" };
      },
      async cancel(runId: string) {
        dwfCancels.push(runId);
        return true;
      },
      async listEvents() {
        return [];
      },
    },
    eventStore: createInMemorySessionEventStore(),
    runtimeTaskRegistry,
    sessionStore,
  } as never);

  const record = {
    app: {
      sessionId: SESSION_ID,
      runtime,
      cancelBackgroundTask: (taskId: string) => runtime.cancelBackgroundTask(taskId),
    },
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
    traceContext: { traceId: "trace-e2e" },
  } as unknown as V4SessionRecordView;
  const executorHost: V4CommandCoreHost = {
    getRecord: (id: string) => (id === SESSION_ID ? record : undefined),
  };

  const gateway = new ConversationV4Gateway({
    sessionExists: (id: string) => id === SESSION_ID,
    emitWireFrame: () => {},
    executeCommand: (envelope: CommandEnvelope) =>
      new V4CommandExecutor(executorHost).execute(envelope),
  });

  return {
    gateway,
    dwfCancels,
    sessionRowId,
    async readLedgerRows() {
      const db = new DatabaseSync(sessionDbPath);
      try {
        return db
          .prepare(
            "select id, session_id, kind, delivery, status, payload from session_input order by time_created",
          )
          .all() as Awaited<ReturnType<RealSessionStack["readLedgerRows"]>>;
      } finally {
        db.close();
      }
    },
    close: () => sessionStore.close(),
    registerDwfTask(taskId: string) {
      runtimeTaskRegistry.register({
        agentId: taskId,
        agentType: "local_dynamic_workflow",
        description: "workflow run",
        isBackgrounded: true,
        startedAt: new Date(0),
        status: "running",
        taskId,
        taskType: "local_dynamic_workflow",
        type: "local_dynamic_workflow",
      } as never);
    },
  };
}

/** Core 缝：与真实 Core handler notify-user/cancel-workflow 分支逐行等价的投递与映射。 */
async function deliverWatchdogCommand(
  session: RealSessionStack,
  params: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = hostWatchdogCommandParamsSchema.parse(params);
  const envelope =
    parsed.action === "notify-user"
      ? commandEnvelopeSchema.parse({
          commandId: parsed.commandId,
          clientId: "super-agent-watchdog",
          sessionId: parsed.sessionId,
          type: "notifyUser",
          payload: { text: parsed.message },
          issuedAt: Date.now(),
        })
      : commandEnvelopeSchema.parse({
          commandId: `watchdog-cancel-workflow:${randomUUID()}`,
          clientId: "super-agent-watchdog",
          sessionId: parsed.sessionId,
          type: "cancelBackgroundWork",
          payload: { workId: parsed.runId },
          issuedAt: Date.now(),
        });
  const ack = (await session.gateway.handleCommand(envelope)) as CommandAck;
  if (ack.status === "accepted" || ack.status === "duplicate") {
    return { ok: true };
  }
  return {
    ok: false,
    error: String(ack.message ?? ack.reasonCode ?? `watchdog command ${ack.status}`),
  };
}

/** 在 daemon 启动前把 stalled workflow 行写进共享 super-agent 库（真实存储路径）。 */
async function seedStalledWorkflowRow(dataBaseDir: string): Promise<void> {
  const databasePath = getSuperAgentDatabasePath(dataBaseDir);
  const database = await openSuperAgentDatabase({ databasePath });
  try {
    const store = new SqliteBackgroundRunStore(database);
    const registry = new BackgroundRunRegistry(500, store);
    registry.register(
      {
        id: RUN_ID,
        kind: "workflow",
        owner: "dynamic-workflow",
        ownerSession: SESSION_ID,
        workspaceKey: WORKSPACE_KEY,
        stallClockRef: `dwf-run:${RUN_ID}`,
      },
      // 40 分钟前的进度回写：> workflowStallMs(20min)，首 tick 即判 stalled。
      Date.now() - 40 * 60_000,
    );
  } finally {
    database.close();
  }
}

async function startDaemonWithCore(options: {
  root: string;
  session: RealSessionStack;
  watchdogTickMs: number;
  escalationThreshold?: number;
  escalationCooldownMs?: number;
  hostHandler: (method: string, params: unknown) => Promise<unknown>;
}): Promise<{ core: CoreConnection }> {
  const dataBaseDir = join(options.root, "data");
  const serverRoot = join(options.root, "server");
  await mkdir(serverRoot, { recursive: true });
  await seedStalledWorkflowRow(dataBaseDir);
  const endpoint = resolveControlPlaneSocketPath(serverRoot);
  const { ipc } = await spawnDaemon({
    dataBaseDir,
    serverRoot,
    watchdogTickMs: options.watchdogTickMs,
    ...(options.escalationThreshold === undefined
      ? {}
      : { escalationThreshold: options.escalationThreshold }),
    ...(options.escalationCooldownMs === undefined
      ? {}
      : { escalationCooldownMs: options.escalationCooldownMs }),
  });
  await waitForMessage(ipc, (m) => m.type === "ready");
  const core = await connectCore(endpoint, options.hostHandler);
  // 反向 host.* 请求依赖 plane 的 coreChannel：必须先 ensure 建面再等 tick。
  const ensure = (await core.request("workspace.ensure", {
    workspaceIdentity: WORKSPACE_KEY,
    workspacePath: join(options.root, "workspace"),
    tasksIndexReady: false,
  })) as { state: string };
  if (ensure.state !== "leader") throw new Error(`workspace.ensure state=${ensure.state}`);
  return { core };
}

describe("daemon watchdog 跨进程 E2E（真子进程 + 真 socket + 真会话栈）", () => {
  it(
    "cancel-stalled：真实 cancel RPC 到达 owner session，真实 runtime 打到 dwf port，且不升级",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-wd-e2e-"));
      roots.push(root);
      const session = await makeRealSession(root);
      session.registerDwfTask(RUN_ID);

      const cancelRequests: unknown[] = [];
      const notifyRequests: unknown[] = [];
      const { core } = await startDaemonWithCore({
        root,
        session,
        watchdogTickMs: 1_000,
        hostHandler: async (method, params) => {
          if (method === "backfill.seeds") return { seeds: [] };
          if (method !== "host.watchdogCommand")
            throw new Error(`unexpected host method: ${method}`);
          const action = (params as { action?: string } | null)?.action;
          if (action === "cancel-workflow") {
            cancelRequests.push(params);
            return deliverWatchdogCommand(session, params);
          }
          if (action === "notify-user") {
            notifyRequests.push(params);
            return { ok: false, error: "unexpected escalation" };
          }
          throw new Error(`unexpected watchdog action: ${action}`);
        },
      });

      // 等 daemon 首 tick 的真实跨进程 cancel：schema 形状 + 路由事实都来自种子行。
      const deadline = Date.now() + 20_000;
      while (cancelRequests.length === 0 && Date.now() < deadline) await delay(200);
      expect(cancelRequests.length).toBeGreaterThan(0);
      const cancelParams = hostWatchdogCommandParamsSchema.parse(cancelRequests[0]);
      expect(cancelParams).toMatchObject({
        action: "cancel-workflow",
        workspaceIdentity: WORKSPACE_KEY,
        runId: RUN_ID,
        sessionId: SESSION_ID,
      });

      // 真实 gateway admission → 真实 executor → 真实 runtime.cancelBackgroundTask →
      // dwf port 收到 workId（≡ runId，无任何身份映射表）。
      expect(session.dwfCancels).toEqual([RUN_ID]);

      // cancel repair 成功 ⇒ 熔断计数不涨 ⇒ 三个 tick 窗口内零升级 notify。
      await delay(3_500);
      expect(notifyRequests).toEqual([]);
      // repairCooldownMs(5min) 抑制重复 cancel；窗口内只有首投。
      expect(cancelRequests).toHaveLength(1);
      await session.close();
      core.close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "notify-user 升级：真实 notify RPC 经真会话栈入唯一 task-notification 队列，commandId 幂等键透传",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-wd-e2e-"));
      roots.push(root);
      const session = await makeRealSession(root);
      // 不注册 dwf 任务：真实 runtime 返回 background_task_not_found ⇒ cancel repair
      // 失败一轮即达熔断阈值（threshold=1），升级走真实 notify 通道。

      const notifyRequests: unknown[] = [];
      const { core } = await startDaemonWithCore({
        root,
        session,
        watchdogTickMs: 1_000,
        escalationThreshold: 1,
        escalationCooldownMs: 0,
        hostHandler: async (method, params) => {
          if (method === "backfill.seeds") return { seeds: [] };
          if (method !== "host.watchdogCommand")
            throw new Error(`unexpected host method: ${method}`);
          const action = (params as { action?: string } | null)?.action;
          if (action === "cancel-workflow") return deliverWatchdogCommand(session, params);
          if (action === "notify-user") {
            notifyRequests.push(params);
            return deliverWatchdogCommand(session, params);
          }
          throw new Error(`unexpected watchdog action: ${action}`);
        },
      });

      const deadline = Date.now() + 20_000;
      while (notifyRequests.length === 0 && Date.now() < deadline) await delay(200);
      expect(notifyRequests.length).toBeGreaterThan(0);
      const notifyParsed = hostWatchdogCommandParamsSchema.parse(notifyRequests[0]);
      if (notifyParsed.action !== "notify-user") {
        throw new Error(`expected notify-user, got ${notifyParsed.action}`);
      }
      expect(notifyParsed).toMatchObject({
        action: "notify-user",
        workspaceIdentity: WORKSPACE_KEY,
        sessionId: SESSION_ID,
      });
      expect(notifyParsed.message).toContain("连续");
      expect(notifyParsed.commandId).toMatch(/^daemon-notify:/);

      // 真实 runtime 唯一 task-notification 队列落账（生产 sqlite session_input 表）：
      // 幂等键 = daemon commandId（表主键），payload 逐字等于升级文案，状态 admitted。
      // 账本写入是 fire-and-forget 微任务（enqueue 后台落库），轮询等行出现。
      const matches = (rows: Awaited<ReturnType<typeof session.readLedgerRows>>) =>
        rows.filter(
          (row) =>
            row.id === notifyParsed.commandId &&
            row.session_id === session.sessionRowId &&
            row.kind === "backgroundNotification" &&
            row.delivery === "queue" &&
            // 账本生命周期：入列 admitted，runtime 消费后提升 promoted——幂等键断言
            // 不依赖生命周期态，两态都算落账。
            (row.status === "admitted" || row.status === "promoted") &&
            JSON.parse(row.payload).text === notifyParsed.message,
        );
      const ledgerDeadline = Date.now() + 5_000;
      let notificationRows: ReturnType<typeof matches> = [];
      while (Date.now() < ledgerDeadline) {
        notificationRows = matches(await session.readLedgerRows());
        if (notificationRows.length > 0) break;
        await delay(100);
      }
      expect(notificationRows.length).toBeGreaterThanOrEqual(1);

      // 重投同一 envelope：真实 CommandInbox 吸收为 duplicate（Core 转发重试安全）。
      const retryAck = (await session.gateway.handleCommand(
        commandEnvelopeSchema.parse({
          commandId: notifyParsed.commandId,
          clientId: "super-agent-watchdog",
          sessionId: notifyParsed.sessionId,
          type: "notifyUser",
          payload: { text: notifyParsed.message },
          issuedAt: Date.now(),
        }),
      )) as CommandAck;
      expect(retryAck.status).toBe("duplicate");
      // 账本层面同样幂等：同 commandId 主键 upsert，重投后仍只有一行。
      const rowsAfterRetry = await session.readLedgerRows();
      expect(rowsAfterRetry.filter((row) => row.id === notifyParsed.commandId)).toHaveLength(1); // 同 commandId 主键 upsert：重投后仍只有一行
      await session.close();
      core.close();
    },
    TEST_TIMEOUT_MS,
  );
});
