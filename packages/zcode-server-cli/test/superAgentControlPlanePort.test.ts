import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_RPC_VERSION,
  controlPlaneAuthFrameSchema,
  controlPlaneRpcRequestSchema,
  resolveControlPlaneAuthTokenPath,
  resolveControlPlaneEndpoint,
  type ControlPlaneTriggerEnvelope,
} from "@zcode/shared/super-agent-control-plane-protocol";
import {
  createControlPlaneClient,
  type ControlPlaneClient,
} from "../src/supervisor/controlPlaneClient.js";
import {
  createSuperAgentControlPlaneCorePort,
  handleSuperAgentControlPlaneInboundRequest,
  SuperAgentControlPlaneGenerationGate,
} from "../src/server-core/superAgentControlPlanePort.js";
import type { ControlPlaneState } from "../src/contracts.js";

const AUTH_TOKEN = "test-control-plane-auth-token-0001";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface TestServer {
  close(): Promise<void>;
  requests: Array<{ method: string; params: unknown }>;
}

function startTestRpcServer(endpoint: string, token: string): Promise<TestServer> {
  const sockets = new Set<Socket>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const triggerIds = new Map<string, string>();
  const audits = new Set<string>();
  let nextTriggerId = 1;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let authed = false;
    const write = (frame: unknown): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
    };
    const fail = (id: string, code: string, message: string, retriable: boolean): void => {
      write({ v: CONTROL_PLANE_RPC_VERSION, id, ok: false, error: { code, message, retriable } });
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (true) {
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex < 0) return;
        const raw = buffer.subarray(0, newlineIndex).toString("utf8");
        buffer = buffer.subarray(newlineIndex + 1);
        if (!raw.trim()) continue;
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw);
        } catch {
          socket.destroy();
          return;
        }
        if (!authed) {
          const auth = controlPlaneAuthFrameSchema.safeParse(decoded);
          if (!auth.success || auth.data.auth !== token) {
            socket.destroy();
            return;
          }
          authed = true;
          continue;
        }
        const request = controlPlaneRpcRequestSchema.safeParse(decoded);
        if (!request.success) {
          socket.destroy();
          return;
        }
        void (async () => {
          const { id, method, params } = request.data;
          requests.push({ method, params });
          if (method === "workspace.ensure") {
            const identity = (params as { workspaceIdentity?: unknown }).workspaceIdentity;
            write({
              v: CONTROL_PLANE_RPC_VERSION,
              id,
              ok: true,
              result: {
                state: identity === "ws-follower" ? "follower" : "leader",
                leaseExpiresAt: 1,
              },
            });
            return;
          }
          if (method === "trigger.ingest") {
            const envelope = params as ControlPlaneTriggerEnvelope;
            if (envelope.providerMessageId === "slow-1") {
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            if (envelope.providerMessageId === "err-1") {
              fail(id, "workspace.failed", "server ingest failed", true);
              return;
            }
            const key = `${envelope.provider}|${envelope.providerMessageId ?? ""}`;
            let triggerId = triggerIds.get(key);
            if (!triggerId) {
              triggerId = `trigger-${nextTriggerId++}`;
              triggerIds.set(key, triggerId);
            }
            write({
              v: CONTROL_PLANE_RPC_VERSION,
              id,
              ok: true,
              result: { handled: true, triggerId, route: "unowned_candidate" },
            });
            return;
          }
          if (method === "schedule.audit") {
            const paramsParsed = params as { workspaceIdentity: string; providerMessageId: string };
            const key = `${paramsParsed.workspaceIdentity}|${paramsParsed.providerMessageId}`;
            const inserted = !audits.has(key);
            audits.add(key);
            write({
              v: CONTROL_PLANE_RPC_VERSION,
              id,
              ok: true,
              result: { inserted },
            });
            return;
          }
          fail(id, "proto.methodNotSupported", `test server does not serve ${method}`, false);
        })().catch((error: unknown) => {
          fail(
            request.data.id,
            "workspace.failed",
            error instanceof Error ? error.message : String(error),
            true,
          );
        });
      }
    });
  });
  return new Promise<TestServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      resolve({
        requests,
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

async function startChain(
  clientOptions: { timeoutMsByMethod?: Partial<Record<string, number>> } = {},
): Promise<{
  root: string;
  client: ControlPlaneClient;
  server: TestServer;
  gate: SuperAgentControlPlaneGenerationGate;
  port: ReturnType<typeof createSuperAgentControlPlaneCorePort>["port"];
}> {
  const root = await mkdtemp(join(tmpdir(), "zcp-"));
  roots.push(root);
  const serverRoot = join(root, "server");
  await mkdir(join(serverRoot, "run"), { recursive: true, mode: 0o700 });
  await writeFile(resolveControlPlaneAuthTokenPath(serverRoot), AUTH_TOKEN, { mode: 0o600 });
  const server = await startTestRpcServer(resolveControlPlaneEndpoint(serverRoot), AUTH_TOKEN);
  const client = createControlPlaneClient({
    serverRoot,
    onInboundRequest: handleSuperAgentControlPlaneInboundRequest,
    ...(clientOptions.timeoutMsByMethod
      ? {
          timeoutMsByMethod:
            clientOptions.timeoutMsByMethod as Parameters<
              typeof createControlPlaneClient
            >[0]["timeoutMsByMethod"],
        }
      : {}),
  });
  const gate = new SuperAgentControlPlaneGenerationGate();
  const { port } = createSuperAgentControlPlaneCorePort({
    client,
    gate,
    tasksIndexReady: true,
    tasksIndexDatabasePath: join(root, "tasks-index.sqlite"),
  });
  return { root, client, server, gate, port };
}

function transition(
  gate: SuperAgentControlPlaneGenerationGate,
  state: ControlPlaneState,
  overrides: Partial<{
    generation: number;
    firstReadyAt: number | null;
    crashSignalObserved: boolean;
    crashBudgetExhausted: boolean;
  }> = {},
): void {
  gate.update({
    type: "control-plane-state",
    state,
    generation: overrides.generation ?? 1,
    firstReadyAt: overrides.firstReadyAt ?? null,
    crashSignalObserved: overrides.crashSignalObserved ?? false,
    crashBudgetExhausted: overrides.crashBudgetExhausted ?? false,
  });
}

function envelope(
  providerMessageId: string,
  workspaceIdentity = "ws-1",
): ControlPlaneTriggerEnvelope {
  return {
    workspaceIdentity,
    source: "im",
    provider: "webhook",
    providerMessageId,
    actor: { kind: "human", id: "user-1" },
    payload: { botId: "bot-1", text: "hello" },
    taint: true,
  };
}

describe("Core control-plane 端口代际门（§3.6）", () => {
  it("默认/未收到状态时 fail-closed，不假设 legacy 窗口", async () => {
    const { client, server, port } = await startChain();
    try {
      await expect(port.triggerIngest(envelope("msg-1"))).rejects.toMatchObject({
        code: "workspace.failed",
        retriable: true,
      });
      expect(server.requests).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("starting 且本代际无崩溃信号才返回 handled:false（legacy 唯一窗口）", async () => {
    const { client, server, gate, port } = await startChain();
    try {
      transition(gate, "starting");
      await expect(port.triggerIngest(envelope("msg-1"))).resolves.toEqual({ handled: false });
      expect(server.requests).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("首个崩溃信号后（即使 state 回到 starting）永久拒绝 legacy", async () => {
    const { client, server, gate, port } = await startChain();
    try {
      transition(gate, "starting", { firstReadyAt: 100, crashSignalObserved: true });
      await expect(port.triggerIngest(envelope("msg-1"))).rejects.toMatchObject({
        code: "workspace.failed",
        retriable: true,
      });
      transition(gate, "crashed", { firstReadyAt: 100, crashSignalObserved: true });
      await expect(port.triggerIngest(envelope("msg-2"))).rejects.toMatchObject({
        code: "workspace.failed",
        retriable: true,
      });
      transition(gate, "crash-loop-stopped", {
        firstReadyAt: 100,
        crashSignalObserved: true,
        crashBudgetExhausted: true,
      });
      await expect(port.triggerIngest(envelope("msg-3"))).rejects.toMatchObject({
        code: "workspace.failed",
        retriable: true,
      });
      expect(server.requests).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("ready + leader：ensure 一次后 trigger.ingest 进入新链路并吸收重投", async () => {
    const { client, server, gate, port } = await startChain();
    try {
      transition(gate, "ready", { firstReadyAt: 100, crashSignalObserved: true });
      const first = await port.triggerIngest(envelope("msg-1"));
      expect(first).toEqual({ handled: true, triggerId: "trigger-1", route: "unowned_candidate" });
      const replay = await port.triggerIngest(envelope("msg-1"));
      expect(replay).toEqual(first);
      expect(server.requests.filter((request) => request.method === "workspace.ensure")).toHaveLength(
        1,
      );
      expect(server.requests.filter((request) => request.method === "trigger.ingest")).toHaveLength(
        2,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("follower plane 返回 handled:false（§3.6 rule 4）", async () => {
    const { client, server, gate, port } = await startChain();
    try {
      transition(gate, "ready", { firstReadyAt: 100, crashSignalObserved: true });
      await expect(port.triggerIngest(envelope("msg-1", "ws-follower"))).resolves.toEqual({
        handled: false,
      });
      expect(server.requests.map((request) => request.method)).toEqual(["workspace.ensure"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("未绑定 workspace 时 fail-closed，不猜 plane 也不 legacy", async () => {
    const { client, server, gate, port } = await startChain();
    try {
      transition(gate, "ready", { firstReadyAt: 100, crashSignalObserved: true });
      await expect(port.triggerIngest(envelope("msg-1", "   "))).rejects.toMatchObject({
        code: "workspace.notEnsured",
        retriable: false,
      });
      expect(server.requests).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("RPC 错误原样上浮（code/retriable 保留）", async () => {
    const { client, server, gate, port } = await startChain();
    try {
      transition(gate, "ready", { firstReadyAt: 100, crashSignalObserved: true });
      await expect(port.triggerIngest(envelope("err-1"))).rejects.toMatchObject({
        code: "workspace.failed",
        retriable: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("生产客户端按 §3.2 方法表超时，错误为 retriable rpc.timeout", async () => {
    const { client, server, gate, port } = await startChain({
      timeoutMsByMethod: { "trigger.ingest": 30 },
    });
    try {
      transition(gate, "ready", { firstReadyAt: 100, crashSignalObserved: true });
      await expect(port.triggerIngest(envelope("slow-1"))).rejects.toMatchObject({
        code: "rpc.timeout",
        retriable: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("schedule.audit：starting 窗口释放 claim 重试，ready leader 才写审计", async () => {
    const { client, server, gate, port } = await startChain();
    const params = {
      workspaceIdentity: "ws-1",
      domainKey: "automation-1",
      providerMessageId: "run-1",
      payloadSummary: { automationId: "automation-1", runId: "run-1" },
      now: 1,
    };
    try {
      transition(gate, "starting");
      await expect(port.scheduleAudit(params)).rejects.toMatchObject({
        code: "workspace.failed",
        retriable: true,
      });
      transition(gate, "ready", { firstReadyAt: 100, crashSignalObserved: true });
      await expect(port.scheduleAudit(params)).resolves.toEqual({ inserted: true });
      await expect(port.scheduleAudit(params)).resolves.toEqual({ inserted: false });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("backfill.seeds 回空表（Core 尚无种子枚举，不伪造订阅）", async () => {
    await expect(
      handleSuperAgentControlPlaneInboundRequest("backfill.seeds", { workspaceIdentity: "ws-1" }),
    ).resolves.toEqual({ seeds: [] });
    await expect(
      handleSuperAgentControlPlaneInboundRequest("host.command", {}),
    ).rejects.toMatchObject({ code: "proto.unimplemented", retriable: false });
  });
});
