import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_RPC_VERSION,
  controlPlaneAuthFrameSchema,
  controlPlaneRpcRequestSchema,
  controlPlaneTriggerIngestParamsSchema,
  controlPlaneTriggerIngestResultSchema,
  resolveControlPlaneAuthTokenPath,
  resolveControlPlaneEndpoint,
  scheduleAuditParamsSchema,
  scheduleAuditResultSchema,
  type ControlPlaneTriggerEnvelope,
  type ControlPlaneTriggerIngestResult,
  type ScheduleAuditParams,
} from "@zcode/shared/super-agent-control-plane-protocol";
import {
  createSuperAgentControlPlaneScheduleAuditor,
  createSuperAgentControlPlaneTriggerSink,
  type SuperAgentControlPlaneRpcPort,
} from "../src/bots/superAgentControlPlaneSink.js";
import type { TriggerSinkEnvelope } from "../src/bots/triggerSink.js";

/**
 * milestone-b-spec §3.4/§4.4 适配器接缝：校验过的 §3.1 JSONL 帧跑在真 unix socket 上，
 * 经 §3.8 首帧凭据握手，再映射到 TriggerSink / schedule.audit 端口。本文件的 client 是
 * 内联测试替身，只证明 services 适配器与 wire schema 的映射；生产 `createControlPlaneClient`
 * 的握手/schema/超时/错误保真由 `packages/zcode-server-cli/test/superAgentControlPlanePort.test.ts`
 * 覆盖（services 不能反向依赖 server-cli）。
 */

const AUTH_TOKEN = "test-control-plane-auth-token-0001";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface TestServer {
  close(): Promise<void>;
}

interface TestClient extends SuperAgentControlPlaneRpcPort {
  close(): Promise<void>;
}

function startTestRpcServer(endpoint: string, token: string): Promise<TestServer> {
  const triggerIds = new Map<string, string>();
  const audits = new Set<string>();
  const sockets = new Set<Socket>();
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
          if (method === "trigger.ingest") {
            const envelope = controlPlaneTriggerIngestParamsSchema.parse(params);
            if (envelope.workspaceIdentity === "ws-error") {
              fail(id, "workspace.failed", "server ingest failed", true);
              return;
            }
            if (envelope.providerMessageId === "slow-1") {
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            const key = `${envelope.provider}|${envelope.providerMessageId ?? ""}`;
            let triggerId = triggerIds.get(key);
            if (!triggerId) {
              triggerId = `trigger-${nextTriggerId++}`;
              triggerIds.set(key, triggerId);
            }
            const result: ControlPlaneTriggerIngestResult = {
              handled: true,
              triggerId,
              route: "human_explicit",
              delivery: "routed",
            };
            write({ v: CONTROL_PLANE_RPC_VERSION, id, ok: true, result });
            return;
          }
          if (method === "schedule.audit") {
            const paramsParsed = scheduleAuditParamsSchema.parse(params);
            if (paramsParsed.workspaceIdentity === "ws-error") {
              fail(id, "workspace.failed", "server audit failed", true);
              return;
            }
            const key = `${paramsParsed.workspaceIdentity}|${paramsParsed.providerMessageId}`;
            const inserted = !audits.has(key);
            audits.add(key);
            write({
              v: CONTROL_PLANE_RPC_VERSION,
              id,
              ok: true,
              result: scheduleAuditResultSchema.parse({ inserted }),
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

function connectTestRpcClient(endpoint: string, token: string): Promise<TestClient> {
  return new Promise<TestClient>((resolveConnect, rejectConnect) => {
    const socket = createConnection({ path: endpoint });
    const pending = new Map<
      string,
      {
        resolve: (result: unknown) => void;
        reject: (error: Error & { code?: string; retriable?: boolean }) => void;
      }
    >();
    let nextId = 0;
    let buffer = Buffer.alloc(0);
    const failPending = (error: Error & { code?: string; retriable?: boolean }): void => {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (true) {
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex < 0) return;
        const raw = buffer.subarray(0, newlineIndex).toString("utf8");
        buffer = buffer.subarray(newlineIndex + 1);
        if (!raw.trim()) continue;
        let response: {
          id: string;
          ok: boolean;
          result?: unknown;
          error?: { code: string; message: string; retriable: boolean };
        };
        try {
          response = JSON.parse(raw) as typeof response;
        } catch {
          socket.destroy();
          return;
        }
        const entry = pending.get(response.id);
        if (!entry) continue;
        pending.delete(response.id);
        if (response.ok) {
          entry.resolve(response.result);
        } else {
          const error = new Error(
            `${response.error?.code ?? "proto.unknown"}: ${response.error?.message ?? ""}`,
          ) as Error & { code?: string; retriable?: boolean };
          error.code = response.error?.code;
          error.retriable = response.error?.retriable;
          entry.reject(error);
        }
      }
    });
    socket.on("close", () => {
      const error = new Error("test RPC connection closed") as Error & {
        code?: string;
        retriable?: boolean;
      };
      error.code = "rpc.disconnected";
      error.retriable = true;
      failPending(error);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ v: CONTROL_PLANE_RPC_VERSION, auth: token })}\n`);
      const request = (method: string, params: unknown): Promise<unknown> => {
        const id = `${++nextId}`;
        return new Promise<unknown>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          socket.write(
            `${JSON.stringify({ v: CONTROL_PLANE_RPC_VERSION, id, method, params })}\n`,
            (error?: Error | null) => {
              if (!error) return;
              pending.delete(id);
              reject(
                Object.assign(new Error(`test RPC write failed: ${error.message}`), {
                  code: "rpc.disconnected",
                  retriable: true,
                }),
              );
            },
          );
        });
      };
      resolveConnect({
        async triggerIngest(params: ControlPlaneTriggerEnvelope) {
          return controlPlaneTriggerIngestResultSchema.parse(
            await request("trigger.ingest", params),
          );
        },
        async scheduleAudit(params: ScheduleAuditParams) {
          return scheduleAuditResultSchema.parse(await request("schedule.audit", params));
        },
        close() {
          return new Promise<void>((resolveClose) => {
            if (socket.destroyed) {
              resolveClose();
              return;
            }
            socket.once("close", () => resolveClose());
            socket.destroy();
          });
        },
      });
    });
    socket.once("error", rejectConnect);
  });
}

async function startChain(): Promise<{
  server: TestServer;
  client: TestClient;
  sink: ReturnType<typeof createSuperAgentControlPlaneTriggerSink>;
}> {
  const root = await mkdtemp(join(tmpdir(), "zs-"));
  roots.push(root);
  const serverRoot = join(root, "server");
  await mkdir(join(serverRoot, "run"), { recursive: true, mode: 0o700 });
  await writeFile(resolveControlPlaneAuthTokenPath(serverRoot), AUTH_TOKEN, { mode: 0o600 });
  const endpoint = resolveControlPlaneEndpoint(serverRoot);
  const server = await startTestRpcServer(endpoint, AUTH_TOKEN);
  const client = await connectTestRpcClient(endpoint, AUTH_TOKEN);
  return {
    server,
    client,
    sink: createSuperAgentControlPlaneTriggerSink(client),
  };
}

function envelope(providerMessageId: string): TriggerSinkEnvelope {
  return {
    workspaceIdentity: "ws-1",
    source: "im",
    provider: "webhook",
    providerMessageId,
    threadKeyHint: "bot:bot-1+user-1",
    actor: { kind: "human", id: "user-1" },
    payload: { botId: "bot-1", text: "hello" },
    taint: true,
  };
}

describe("services ↔ control-plane RPC 真 socket 链路", () => {
  it("trigger.ingest：握手、ACK 映射、UNIQUE 幂等重投同一 triggerId", async () => {
    const { server, client, sink } = await startChain();
    try {
      const first = await sink.ingest(envelope("message-1"));
      expect(first).toEqual({
        handled: true,
        triggerId: "trigger-1",
        route: "human_explicit",
        delivery: "routed",
      });
      const replay = await sink.ingest(envelope("message-1"));
      expect(replay).toEqual(first);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("schedule.audit：首行 inserted=true，同 providerMessageId 重放 inserted=false", async () => {
    const { server, client } = await startChain();
    const auditor = createSuperAgentControlPlaneScheduleAuditor(client, { timeoutMs: 1_000 });
    try {
      const input = {
        workspaceIdentity: "ws-1",
        domainKey: "automation-1",
        providerMessageId: "run-1",
        payloadSummary: { automationId: "automation-1", runId: "run-1" },
        now: 1,
      };
      await expect(auditor.audit(input)).resolves.toEqual({ inserted: true });
      await expect(auditor.audit(input)).resolves.toEqual({ inserted: false });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("RPC error 原样上浮并保留 retriable", async () => {
    const { server, client, sink } = await startChain();
    try {
      const bad = envelope("message-1");
      bad.workspaceIdentity = "ws-error";
      await expect(sink.ingest(bad)).rejects.toMatchObject({
        code: "workspace.failed",
        retriable: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  // 超时由生产传输层（server-core 的 createControlPlaneClient）按 §3.2 方法表负责；
  // 该用例由 packages/zcode-server-cli/test/superAgentControlPlanePort.test.ts 覆盖。
});
