/**
 * 里程碑 B child 集成：真实子进程 + 真实 socket + 真实 sqlite + 真实 IPC。
 *
 * 覆盖 B-SPEC §5.2「child 集成」核心路径：
 * ready → workspace.ensure（Core ready 后抢租约）→ trigger.ingest 落行/幂等 →
 * lease.list → shutdown 对称收口（释放租约 + unlink socket）。
 * 另外覆盖协议版本不匹配 fatal、陈旧 socket 清理、不可信 peer 断连。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function spawnDaemon(options: {
  dataBaseDir: string;
  serverRoot: string;
  trustedPid?: number;
  rejectPeer?: boolean;
  authTokenFile?: string;
  noAuth?: boolean;
  healthIntervalMs?: number;
  protocolVersion?: number;
}): Promise<{ child: ChildProcess; ipc: ChildMessages }> {
  const bundle = await bundleFixture();
  const bundlePath = join(options.dataBaseDir, `fixture-${Date.now()}.cjs`);
  await mkdir(options.dataBaseDir, { recursive: true });
  await writeFile(bundlePath, bundle, "utf8");
  const child = spawn(process.execPath, [bundlePath], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      ZCODE_CONTROL_PLANE_GENERATION: "1",
      ZCODE_CONTROL_PLANE_PROTOCOL_VERSION: String(
        options.protocolVersion ?? CONTROL_PLANE_PROTOCOL_VERSION,
      ),
      ZCODE_DATA_BASE_DIR: options.dataBaseDir,
      ZCODE_SERVER_ROOT: options.serverRoot,
      TEST_TRUSTED_PID: String(options.trustedPid ?? process.pid),
      ...(options.rejectPeer ? { TEST_REJECT_PEER: "1" } : {}),
      ...(options.authTokenFile ? { TEST_AUTH_TOKEN_FILE: options.authTokenFile } : {}),
      ...(options.noAuth ? { TEST_NO_AUTH: "1" } : {}),
      ...(options.healthIntervalMs
        ? { TEST_HEALTH_INTERVAL_MS: String(options.healthIntervalMs) }
        : {}),
    },
  });
  children.push(child);
  return { child, ipc: collectMessages(child) };
}

interface RpcClient {
  socket: Socket;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  closed: Promise<void>;
  close(): void;
}

async function connectRpc(
  endpoint: string,
  authToken?: string,
  hostResult: (method: string, params: unknown) => unknown = cannedHostResult,
): Promise<RpcClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const client = new Socket();
    client.once("connect", () => resolve(client));
    client.once("error", reject);
    client.connect(endpoint);
  });
  if (authToken !== undefined) {
    socket.write(`${JSON.stringify({ v: CONTROL_PLANE_RPC_VERSION, auth: authToken })}\n`);
  }
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
      // child 反向请求（host.* / backfill.seeds）：测试作为 Core 侧回执。
      if (typeof frame.id === "string" && typeof frame.method === "string") {
        const result = hostResult(frame.method, frame.params);
        socket.write(`${JSON.stringify({ v: CONTROL_PLANE_RPC_VERSION, id: frame.id, ok: true, result })}\n`);
      }
    }
  });

  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return {
    socket,
    closed,
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

function cannedHostResult(method: string, params: unknown): unknown {
  switch (method) {
    case "backfill.seeds":
      return { seeds: [] };
    case "host.autoReplyGuard":
      return { admitted: true };
    case "host.worker.find":
      return { sessionId: "session-1", terminal: false, stoppedByHuman: false };
    case "host.worker.resume":
    case "host.worker.createTask":
      return { sessionId: "session-1" };
    case "host.command": {
      const commandId = (params as { commandId?: string } | null)?.commandId;
      return { commandId, status: "accepted", revisionAtDecision: 1 };
    }
    default:
      throw new Error(`unexpected child→Core method: ${method}`);
  }
}

function triggerEnvelope(providerMessageId: string) {
  return {
    workspaceIdentity: "ws-1",
    source: "im" as const,
    provider: "test-provider",
    providerMessageId,
    threadKeyHint: "bot:bot-1+user-1",
    actor: { kind: "human" as const, id: "user-1" },
    payload: {
      botId: "bot-1",
      chatType: "private",
      chatId: "user-1",
      senderType: "user",
      text: `hello ${providerMessageId}`,
    },
    taint: true as const,
  };
}

describe("super-agent control-plane child", () => {
  it(
    "ready → workspace.ensure leader → trigger.ingest 落行/幂等 → lease.list → shutdown 释放租约",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-daemon-"));
      roots.push(root);
      const dataBaseDir = join(root, "data");
      const serverRoot = join(root, "server");
      await mkdir(serverRoot, { recursive: true });
      const endpoint = resolveControlPlaneSocketPath(serverRoot);
      // 陈旧 socket 清理：先放一个普通文件在端点路径，child 必须 unlink 后 bind。
      if (process.platform !== "win32") {
        await mkdir(join(serverRoot, "run"), { recursive: true });
        await writeFile(endpoint, "stale", "utf8");
      }

      const { child, ipc } = await spawnDaemon({ dataBaseDir, serverRoot, trustedPid: process.pid });
      const ready = await waitForMessage(ipc, (m) => m.type === "ready");
      expect(ready.protocolVersion).toBe(CONTROL_PLANE_PROTOCOL_VERSION);
      if (process.platform !== "win32") {
        expect(existsSync(endpoint)).toBe(true);
        expect((await stat(endpoint)).mode & 0o777).toBe(0o600);
      }
      if (process.platform !== "win32") {
        expect((await stat(join(serverRoot, "run"))).mode & 0o777).toBe(0o700);
      }

      const client = await connectRpc(endpoint);
      const ensure = (await client.request("workspace.ensure", {
        workspaceIdentity: "ws-1",
        workspacePath: join(root, "workspace"),
        tasksIndexReady: false,
      })) as { state: string; leaseExpiresAt: number };
      expect(ensure.state).toBe("leader");
      expect(ensure.leaseExpiresAt).toBeGreaterThan(0);

      const leases = (await client.request("lease.list", {})) as {
        workspaces: Array<{ workspaceIdentity: string; ownerId: string; expiresAt: number }>;
      };
      expect(leases.workspaces.map((row) => row.workspaceIdentity)).toEqual(["ws-1"]);
      expect(leases.workspaces[0]!.ownerId.startsWith("control-plane:")).toBe(true);

      const first = (await client.request("trigger.ingest", triggerEnvelope("m-1"))) as {
        handled: boolean;
        triggerId: string;
        route: string;
        delivery?: string;
      };
      expect(first).toMatchObject({
        handled: true,
        route: "human_explicit",
        delivery: "routed",
      });
      const second = (await client.request("trigger.ingest", triggerEnvelope("m-1"))) as {
        triggerId: string;
      };
      expect(second.triggerId).toBe(first.triggerId);

      const status = (await client.request("control.status", {})) as {
        planes: Array<{ workspaceIdentity: string; leader: boolean; pendingEventCount: number }>;
      };
      expect(status.planes).toContainEqual({
        workspaceIdentity: "ws-1",
        leader: true,
        pendingEventCount: 1,
      });

      const lease = (await client.request("lease.get", { workspaceIdentity: "ws-1" })) as {
        ownerId: string;
        expiresAt: number;
      } | null;
      expect(lease).not.toBeNull();
      expect(lease!.expiresAt).toBeGreaterThan(0);

      // mandateGate=false（P2 兼容）：只读解析返回 null，不伪造档位结论。
      const mandate = await client.request("mandate.resolve", {
        triggerId: first.triggerId,
        purpose: "delivery_precheck",
      });
      expect(mandate).toBeNull();

      const cards = (await client.request("wouldAccept.list", { workspaceIdentity: "ws-1" })) as {
        cards: unknown[];
      };
      expect(cards.cards).toEqual([]);

      // §4.4：scheduler 只对已 leader 的 workspace claim 并请求审计；audit 前先 ensure。
      const auditEnsure = (await client.request("workspace.ensure", {
        workspaceIdentity: "ws-audit",
        tasksIndexReady: false,
      })) as { state: string };
      expect(auditEnsure.state).toBe("leader");
      const audit = (await client.request("schedule.audit", {
        workspaceIdentity: "ws-audit",
        domainKey: "automation-1",
        providerMessageId: "run-1",
        payloadSummary: { automationId: "automation-1" },
        now: 1_700_000_000_000,
      })) as { inserted: boolean };
      expect(audit.inserted).toBe(true);
      const auditRepeat = (await client.request("schedule.audit", {
        workspaceIdentity: "ws-audit",
        domainKey: "automation-1",
        providerMessageId: "run-1",
        payloadSummary: { automationId: "automation-1" },
        now: 1_700_000_000_001,
      })) as { inserted: boolean };
      expect(auditRepeat.inserted).toBe(false);

      client.close();
      child.send({ command: "shutdown" });
      const stopped = await waitForMessage(ipc, (m) => m.type === "stopped");
      expect(stopped.reason).toBe("shutdown command");
      const exit = await ipc.exited;
      expect(exit.code).toBe(0);

      if (process.platform !== "win32") {
        expect(existsSync(endpoint)).toBe(false);
      }

      const dbPath = join(dataBaseDir, ".zcode", "v2", "super-agent.sqlite");
      const db = new DatabaseSync(dbPath);
      try {
        const events = db
          .prepare("select count(*) as n from trigger_events where workspace_identity = 'ws-1'")
          .get() as { n: number };
        expect(Number(events.n)).toBe(1);
        const leaseRows = db.prepare("select count(*) as n from control_plane_leases").get() as {
          n: number;
        };
        expect(Number(leaseRows.n)).toBe(0);
      } finally {
        db.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === "win32")(
    "端点仍有存活 listener 时拒绝 bind，不夺走端点",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-live-"));
      roots.push(root);
      const dataBaseDir = join(root, "data");
      const serverRoot = join(root, "server");
      await mkdir(join(serverRoot, "run"), { recursive: true });
      const endpoint = resolveControlPlaneSocketPath(serverRoot);
      const live = createServer((socket) => socket.end());
      await new Promise<void>((resolve, reject) => {
        live.once("error", reject);
        live.listen(endpoint, () => {
          live.off("error", reject);
          resolve();
        });
      });
      try {
        const { ipc } = await spawnDaemon({ dataBaseDir, serverRoot, trustedPid: process.pid });
        const fatal = await waitForMessage(ipc, (m) => m.type === "fatal");
        expect(String(fatal.message)).toContain("已被存活进程占用");
        const exit = await ipc.exited;
        expect(exit.code).toBe(1);
        expect(ipc.messages.some((m) => m.type === "ready")).toBe(false);
      } finally {
        await new Promise<void>((resolve) => live.close(() => resolve()));
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "协议版本不匹配 → fatal 且不进入 ready",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-protocol-"));
      roots.push(root);
      const { ipc } = await spawnDaemon({
        dataBaseDir: join(root, "data"),
        serverRoot: join(root, "server"),
        trustedPid: process.pid,
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION + 1,
      });
      const fatal = await waitForMessage(ipc, (m) => m.type === "fatal");
      expect(String(fatal.message)).toContain("protocol mismatch");
      const exit = await ipc.exited;
      expect(exit.code).toBe(1);
      expect(ipc.messages.some((m) => m.type === "ready")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "不可信 peer 连接被立即断开，child 仍 ready",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-peer-"));
      roots.push(root);
      const dataBaseDir = join(root, "data");
      const serverRoot = join(root, "server");
      const endpoint = resolveControlPlaneSocketPath(serverRoot);
      const { child, ipc } = await spawnDaemon({
        dataBaseDir,
        serverRoot,
        trustedPid: process.pid,
        rejectPeer: true,
      });
      await waitForMessage(ipc, (m) => m.type === "ready");
      const client = await connectRpc(endpoint);
      await Promise.race([
        client.closed,
        delay(2_000).then(() => {
          throw new Error("untrusted peer connection was not closed");
        }),
      ]);
      expect(ipc.messages.some((m) => m.type === "test-error")).toBe(true);
      child.send({ command: "shutdown" });
      await waitForMessage(ipc, (m) => m.type === "stopped");
      const exit = await ipc.exited;
      expect(exit.code).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "凭据握手：未认证/错凭据连接被拒，正确凭据可用",
    async () => {
      const TOKEN = "control-plane-test-token-0123456789";
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-auth-"));
      roots.push(root);
      const dataBaseDir = join(root, "data");
      const serverRoot = join(root, "server");
      await mkdir(serverRoot, { recursive: true });
      const authTokenFile = join(root, "auth.token");
      await writeFile(authTokenFile, TOKEN, { encoding: "utf8", mode: 0o600 });
      const endpoint = resolveControlPlaneSocketPath(serverRoot);
      const { child, ipc } = await spawnDaemon({ dataBaseDir, serverRoot, authTokenFile });
      await waitForMessage(ipc, (m) => m.type === "ready");

      const unauthenticated = await connectRpc(endpoint);
      // 未发凭据就直接发业务帧：server 必须在处理业务前断开。
      unauthenticated.request("lease.list", {}).catch(() => undefined);
      await Promise.race([
        unauthenticated.closed,
        delay(2_000).then(() => {
          throw new Error("unauthenticated peer was not closed");
        }),
      ]);

      const wrongToken = await connectRpc(endpoint, "wrong-token-0123456789abcdef");
      await Promise.race([
        wrongToken.closed,
        delay(2_000).then(() => {
          throw new Error("wrong-token peer was not closed");
        }),
      ]);

      const client = await connectRpc(endpoint, TOKEN);
      const leases = (await client.request("lease.list", {})) as { workspaces: unknown[] };
      expect(leases.workspaces).toEqual([]);

      // params 不符合 shared schema 必须映射为 proto.invalidParams（不是 workspace.failed），
      // 且只回错误、不断开连接。
      await expect(client.request("lease.get", {})).rejects.toThrow(
        /proto\.invalidParams/,
      );
      const afterInvalidParams = (await client.request("lease.list", {})) as {
        workspaces: unknown[];
      };
      expect(afterInvalidParams.workspaces).toEqual([]);
      client.close();
      child.send({ command: "shutdown" });
      await waitForMessage(ipc, (m) => m.type === "stopped");
      const exit = await ipc.exited;
      expect(exit.code).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "workspace.ensure 之前 ingest → handled:false（启动窗口纯转发，非可重试错误）",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-window-"));
      roots.push(root);
      const dataBaseDir = join(root, "data");
      const serverRoot = join(root, "server");
      const endpoint = resolveControlPlaneSocketPath(serverRoot);
      const { child, ipc } = await spawnDaemon({ dataBaseDir, serverRoot, trustedPid: process.pid });
      await waitForMessage(ipc, (m) => m.type === "ready");
      const client = await connectRpc(endpoint);

      const beforeEnsure = await client.request("trigger.ingest", triggerEnvelope("window-1"));
      expect(beforeEnsure).toEqual({ handled: false });

      // 同一 workspace 随后 ensure 成功并成为 leader。
      const ensure = (await client.request("workspace.ensure", {
        workspaceIdentity: "ws-1",
        tasksIndexReady: false,
      })) as { state: string };
      expect(ensure.state).toBe("leader");

      client.close();
      child.send({ command: "shutdown" });
      await waitForMessage(ipc, (m) => m.type === "stopped");
      await ipc.exited;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "health 心跳携带 leader/计数字段（§2.4）",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-health-"));
      roots.push(root);
      const dataBaseDir = join(root, "data");
      const serverRoot = join(root, "server");
      const endpoint = resolveControlPlaneSocketPath(serverRoot);
      const { child, ipc } = await spawnDaemon({
        dataBaseDir,
        serverRoot,
        trustedPid: process.pid,
        healthIntervalMs: 50,
      });
      await waitForMessage(ipc, (m) => m.type === "ready");
      const client = await connectRpc(endpoint);
      const ensure = (await client.request("workspace.ensure", {
        workspaceIdentity: "ws-1",
        tasksIndexReady: false,
      })) as { state: string };
      expect(ensure.state).toBe("leader");

      const health = await waitForMessage(
        ipc,
        (m) => m.type === "health" && m.leaderWorkspaceCount === 1,
      );
      expect(health.pendingEventCount).toBe(0);
      // tasksIndexReady=false → 未接桥，字段必须缺席而不是假 0。
      expect(health.pendingDispatchCount).toBeUndefined();
      expect(typeof health.rejectedPeerCount).toBe("number");
      expect(typeof health.protocolErrorCount).toBe("number");
      expect(health.followerIngestCount).toBe(0);
      expect(health.notEnsuredIngestCount).toBe(0);

      client.close();
      child.send({ command: "shutdown" });
      await waitForMessage(ipc, (m) => m.type === "stopped");
      await ipc.exited;
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "Core 上报的 tasks-index 路径与 child 推导不一致 → fatal 且拒绝服务（§2.3）",
    async () => {
      // POSIX unix socket 路径上限（macOS 104 字节）——前缀过长会让 bind/probe 直接 EINVAL。
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-mismatch-"));
      roots.push(root);
      const dataBaseDir = join(root, "data");
      const serverRoot = join(root, "server");
      const endpoint = resolveControlPlaneSocketPath(serverRoot);
      const { ipc } = await spawnDaemon({ dataBaseDir, serverRoot, trustedPid: process.pid });
      await waitForMessage(ipc, (m) => m.type === "ready");
      const client = await connectRpc(endpoint);
      // 模拟 Core 因 setDataBaseDir 覆盖而写另一个根：不带 pending 直接发帧，
      // child 必须 fatal 并收口，响应是否送达不重要。
      client.socket.write(
        `${JSON.stringify({
          v: CONTROL_PLANE_RPC_VERSION,
          id: "storage-mismatch",
          method: "workspace.ensure",
          params: {
            workspaceIdentity: "ws-1",
            tasksIndexDatabasePath: join(root, "other", ".zcode", "v2", "tasks-index.sqlite"),
          },
        })}\n`,
      );
      const fatal = await waitForMessage(ipc, (m) => m.type === "fatal");
      expect(String(fatal.message)).toContain("库路径不一致");
      const exit = await ipc.exited;
      expect(exit.code).toBe(1);
      expect(ipc.messages.some((m) => m.type === "ready")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "既无凭据也无 peer 门 → 启动期 fatal，绝不绑定未认证端点",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-noauth-"));
      roots.push(root);
      const { ipc } = await spawnDaemon({
        dataBaseDir: join(root, "data"),
        serverRoot: join(root, "server"),
        noAuth: true,
      });
      const fatal = await waitForMessage(ipc, (m) => m.type === "fatal");
      expect(String(fatal.message)).toMatch(/auth token|peer guard/);
      const exit = await ipc.exited;
      expect(exit.code).toBe(1);
      expect(ipc.messages.some((m) => m.type === "ready")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "human-explicit resume：唤醒文本必须经 host.command 投递，不能只打开会话就回成功",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-cp-resume-"));
      roots.push(root);
      const dataBaseDir = join(root, "data");
      const serverRoot = join(root, "server");
      await mkdir(serverRoot, { recursive: true });
      const endpoint = resolveControlPlaneSocketPath(serverRoot);
      const { child, ipc } = await spawnDaemon({
        dataBaseDir,
        serverRoot,
        trustedPid: process.pid,
      });
      await waitForMessage(ipc, (m) => m.type === "ready");

      const calls: Array<{ method: string; params: unknown }> = [];
      const hostResult = (method: string, params: unknown): unknown => {
        calls.push({ method, params });
        switch (method) {
          case "backfill.seeds":
            return { seeds: [] };
          case "host.worker.find":
            // 终态且非人为停止 → human-explicit 走 resume 分支。
            return { sessionId: "session-terminal", terminal: true, stoppedByHuman: false };
          case "host.worker.resume":
            return { sessionId: "session-terminal" };
          case "host.autoReplyGuard":
            return { admitted: true };
          case "host.command": {
            const commandId = (params as { commandId?: string }).commandId;
            return { commandId, status: "accepted", revisionAtDecision: 1 };
          }
          default:
            throw new Error(`unexpected child→Core method: ${method}`);
        }
      };
      const client = await connectRpc(endpoint, undefined, hostResult);
      try {
        const ensure = (await client.request("workspace.ensure", {
          workspaceIdentity: "ws-resume",
          tasksIndexReady: false,
        })) as { state: string };
        expect(ensure.state).toBe("leader");

        const result = (await client.request("trigger.ingest", {
          workspaceIdentity: "ws-resume",
          source: "im",
          provider: "test-provider",
          providerMessageId: "m-resume",
          threadKeyHint: "bot:bot-1+user-1",
          actor: { kind: "human", id: "user-1" },
          payload: { botId: "bot-1", chatType: "private", chatId: "user-1", text: "hello m-resume" },
          taint: true,
        })) as { handled: boolean; triggerId: string; route: string; delivery?: string };
        expect(result).toMatchObject({
          handled: true,
          route: "human_explicit",
          delivery: "routed",
        });

        const resume = calls.find((call) => call.method === "host.worker.resume");
        expect(resume).toBeDefined();
        const command = calls.find((call) => call.method === "host.command");
        expect(command).toBeDefined();
        // OLD 实现只 resume 会话、丢弃文本；这里断言唤醒输入真正进入 CommandInbox，
        // 幂等键 = triggerId+sessionId（与 owned 直通同键）。
        expect(command!.params).toMatchObject({
          workspaceIdentity: "ws-resume",
          commandId: `${result.triggerId}:session-terminal`,
          sessionId: "session-terminal",
          lane: "followup",
          envelope: {
            triggerId: result.triggerId,
            payload: { text: "hello m-resume" },
          },
        });
      } finally {
        client.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
