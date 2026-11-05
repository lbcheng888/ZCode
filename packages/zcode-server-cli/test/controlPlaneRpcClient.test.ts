import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_MAX_FRAME_BYTES,
  CONTROL_PLANE_RPC_ERROR_CODES,
  ControlPlaneRpcError,
  createControlPlaneClient,
  resolveControlPlaneEndpoint,
} from "../src/supervisor/controlPlaneClient.js";

const temporaryRoots: string[] = [];
const servers: Server[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-control-plane-rpc-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "run"), { recursive: true, mode: 0o700 });
  return root;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

interface TestServer {
  endpoint: string;
  requests: Array<Record<string, unknown>>;
}

function startJsonlServer(
  endpoint: string,
  onRequest: (request: Record<string, unknown>, socket: Socket) => void,
  onConnect?: (socket: Socket) => void,
  rawFrames?: Array<Record<string, unknown>>,
): Promise<TestServer> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((socket) => {
    onConnect?.(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (true) {
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex < 0) break;
        const line = buffer.subarray(0, newlineIndex).toString("utf8");
        buffer = buffer.subarray(newlineIndex + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        rawFrames?.push(request);
        requests.push(request);
        onRequest(request, socket);
      }
    });
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve({ endpoint, requests });
    });
  });
}

function sendResponse(
  socket: Socket,
  request: Record<string, unknown>,
  result: unknown,
): void {
  socket.write(`${JSON.stringify({ v: 1, id: request.id, ok: true, result })}\n`);
}

function sendError(
  socket: Socket,
  request: Record<string, unknown>,
  error: { code: string; message: string; retriable: boolean },
): void {
  socket.write(`${JSON.stringify({ v: 1, id: request.id, ok: false, error })}\n`);
}

async function waitForSocketClosed(clientRequest: () => Promise<unknown>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await clientRequest();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error("client socket did not disconnect");
}

describe("control plane JSONL RPC client", () => {
  it("correlates concurrent requests by id and validates results", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveControlPlaneEndpoint(root, "darwin");
    const server = await startJsonlServer(endpoint, (request, socket) => {
      if (request.method === "lease.get") {
        setTimeout(() => sendResponse(socket, request, { ownerId: "owner", expiresAt: 100 }), 25);
        return;
      }
      if (request.method === "lease.list") {
        sendResponse(socket, request, {
          workspaces: [{ workspaceIdentity: "ws", ownerId: "owner", expiresAt: 100 }],
        });
        return;
      }
      throw new Error(`unexpected method ${String(request.method)}`);
    });
    const client = createControlPlaneClient({ endpoint });
    try {
      await client.connect();
      const [lease, list] = await Promise.all([
        client.request("lease.get", { workspaceIdentity: "ws" }),
        client.request("lease.list", {}),
      ]);
      expect(lease).toEqual({ ownerId: "owner", expiresAt: 100 });
      expect(list).toEqual({
        workspaces: [{ workspaceIdentity: "ws", ownerId: "owner", expiresAt: 100 }],
      });
      expect(server.requests[0]).toMatchObject({
        v: 1,
        method: "lease.get",
        params: { workspaceIdentity: "ws" },
      });
      expect(server.requests[1]).toMatchObject({
        v: 1,
        method: "lease.list",
        params: {},
      });
    } finally {
      await client.close();
    }
  });

  it("rejects on the per-method timeout when no response arrives", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveControlPlaneEndpoint(root, "darwin");
    await startJsonlServer(endpoint, () => undefined);
    const client = createControlPlaneClient({
      endpoint,
      timeoutMsByMethod: { "lease.get": 40 },
    });
    try {
      await client.connect();
      await expect(
        client.request("lease.get", { workspaceIdentity: "ws" }),
      ).rejects.toMatchObject({
        code: CONTROL_PLANE_RPC_ERROR_CODES.timeout,
        retriable: true,
      });
    } finally {
      await client.close();
    }
  });

  it("disconnects and fails the request when a frame exceeds 256 KiB", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveControlPlaneEndpoint(root, "darwin");
    await startJsonlServer(endpoint, (request, socket) => {
      sendResponse(socket, request, "x".repeat(CONTROL_PLANE_MAX_FRAME_BYTES + 1));
    });
    const client = createControlPlaneClient({ endpoint });
    try {
      await client.connect();
      await expect(client.request("lease.list", {})).rejects.toMatchObject({
        code: CONTROL_PLANE_RPC_ERROR_CODES.frameTooLarge,
        retriable: false,
      });
      await waitForSocketClosed(() => client.request("lease.list", {}));
      const deadline = Date.now() + 1_000;
      while (client.connected && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(client.connected).toBe(false);
      await expect(client.request("lease.list", {})).rejects.toMatchObject({
        code: CONTROL_PLANE_RPC_ERROR_CODES.notConnected,
      });
    } finally {
      await client.close();
    }
  });

  it("treats malformed responses as protocol errors and disconnects", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveControlPlaneEndpoint(root, "darwin");
    await startJsonlServer(endpoint, (_request, socket) => {
      socket.write("not-json\n");
    });
    const client = createControlPlaneClient({ endpoint });
    try {
      await client.connect();
      await expect(client.request("lease.list", {})).rejects.toMatchObject({
        code: CONTROL_PLANE_RPC_ERROR_CODES.protocolError,
        retriable: false,
      });
    } finally {
      await client.close();
    }
  });

  it("rejects the request and disconnects when the result schema is invalid", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveControlPlaneEndpoint(root, "darwin");
    await startJsonlServer(endpoint, (request, socket) => {
      sendResponse(socket, request, { unexpected: true });
    });
    const client = createControlPlaneClient({ endpoint });
    try {
      await client.connect();
      await expect(client.request("lease.list", {})).rejects.toMatchObject({
        code: CONTROL_PLANE_RPC_ERROR_CODES.protocolError,
        retriable: false,
      });
    } finally {
      await client.close();
    }
  });

  it("answers child→Core reverse requests instead of treating them as protocol errors", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveControlPlaneEndpoint(root, "darwin");
    const frames: Array<Record<string, unknown>> = [];
    await startJsonlServer(
      endpoint,
      (request, socket) => {
        if (request.method === undefined) {
          // 反向请求的客户端回执帧（无 method）：由 frames 数组断言，不在这里处理。
          return;
        }
        if (request.method === "lease.list") {
          // child 在 ensure 返回前必然反向请求 backfill.seeds；等客户端首个业务帧后
          // 再发，确保客户端已 attach 数据监听。
          socket.write(
            `${JSON.stringify({
              v: 1,
              id: "reverse-1",
              method: "backfill.seeds",
              params: { workspaceIdentity: "ws" },
            })}\n`,
          );
          sendResponse(socket, request, { workspaces: [] });
          return;
        }
        throw new Error(`unexpected method ${String(request.method)}`);
      },
      undefined,
      frames,
    );
    const client = createControlPlaneClient({
      endpoint,
      onInboundRequest: async (method) => {
        if (method !== "backfill.seeds") throw new Error(`unexpected ${method}`);
        return { seeds: [] };
      },
    });
    try {
      await client.connect();
      await expect(
        client.request("lease.list", {}),
      ).resolves.toEqual({ workspaces: [] });
      // 反向请求的回执帧应写到同一条连接，且连接保持可用。
      const deadline = Date.now() + 1_000;
      while (!frames.some((frame) => frame.id === "reverse-1") && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(frames.find((frame) => frame.id === "reverse-1")).toMatchObject({
        v: 1,
        id: "reverse-1",
        ok: true,
        result: { seeds: [] },
      });
    } finally {
      await client.close();
    }
  });

  it("fails closed when the auth token file is missing and sends the auth first frame when present", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveControlPlaneEndpoint(root, "darwin");
    const tokenPath = join(root, "run", "super-agent.auth");
    const frames: Array<Record<string, unknown>> = [];
    await startJsonlServer(
      endpoint,
      (request, socket) => {
        if (request.method === "lease.list") {
          sendResponse(socket, request, { workspaces: [] });
        }
      },
      undefined,
      frames,
    );
    // 文件不存在时连接失败（fail-closed），不得静默按无认证连接。
    const unauthenticated = createControlPlaneClient({ endpoint, authTokenFile: tokenPath });
    await expect(unauthenticated.connect()).rejects.toMatchObject({
      code: CONTROL_PLANE_RPC_ERROR_CODES.authFailed,
      retriable: false,
    });
    await unauthenticated.close();

    await writeFile(tokenPath, "token-0123456789abcdef");
    const client = createControlPlaneClient({ endpoint, authTokenFile: tokenPath });
    try {
      await client.connect();
      // 第一条出站帧必须是凭据，不能先发业务请求。
      const deadline = Date.now() + 1_000;
      while (frames.length === 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(frames[0]).toEqual({ v: 1, auth: "token-0123456789abcdef" });
      await expect(
        client.request("lease.list", {}),
      ).resolves.toEqual({ workspaces: [] });
    } finally {
      await client.close();
    }
  });

  it("maps ok:false responses to typed RPC errors", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveControlPlaneEndpoint(root, "darwin");
    await startJsonlServer(endpoint, (request, socket) => {
      sendError(socket, request, {
        code: "lease.workspaceUnknown",
        message: "workspace is unknown",
        retriable: true,
      });
    });
    const client = createControlPlaneClient({ endpoint });
    try {
      await client.connect();
      await expect(
        client.request("lease.get", { workspaceIdentity: "ws" }),
      ).rejects.toMatchObject({
        code: "lease.workspaceUnknown",
        retriable: true,
      });
    } finally {
      await client.close();
    }
  });

  it("rejects invalid params without touching the wire", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveControlPlaneEndpoint(root, "darwin");
    const server = await startJsonlServer(endpoint, () => undefined);
    const client = createControlPlaneClient({ endpoint });
    try {
      await client.connect();
      await expect(
        client.request("trigger.ingest", {
          workspaceIdentity: "ws",
          source: "im",
          provider: "feishu",
          actor: { kind: "human" },
          payload: {},
          // taint 必须由可信出口铸造为 true；false 属于非法形。
          taint: false as true,
        }),
      ).rejects.toMatchObject({ code: CONTROL_PLANE_RPC_ERROR_CODES.requestInvalid });
      expect(server.requests).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("rejects requests before connect and surfaces connect failure", async () => {
    const root = await temporaryRoot();
    const endpoint = resolveControlPlaneEndpoint(root, "darwin");
    const client = createControlPlaneClient({ endpoint, connectTimeoutMs: 1_000 });
    await expect(client.request("lease.list", {})).rejects.toMatchObject({
      code: CONTROL_PLANE_RPC_ERROR_CODES.notConnected,
    });
    await expect(client.connect()).rejects.toBeInstanceOf(ControlPlaneRpcError);
    await client.close();
  });
});
