/**
 * daemon shutdown 中止在途裁决调用（milestone-b-spec §8-7 / §2.5）：
 * 真实 startControlPlaneDaemon（真 sqlite + 真 socket + 真 RPC）下，首个 pending
 * 候选批已进入 model-only 会话（hang），发 shutdown 必须：
 * 1) 先 abort 裁决会话信号，令在途调用 reject；
 * 2) 驱动器按 session_error 收尾，候选留 pending、零 decision_log 落行；
 * 3) child 正常收口（done=0），不把「关库后仍在途」变成会写库的半结算。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  CONTROL_PLANE_RPC_VERSION,
} from "@zcode/shared/super-agent-control-plane-protocol";

import { startControlPlaneDaemon } from "../../src/app/super-agent-daemon-entry.js";
import { getSuperAgentDatabasePath } from "../../src/app/paths.js";
import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import type { AdjudicationSessionAssembly } from "../../src/super-agent/daemon/adjudicationSession.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

interface RpcClient {
  socket: Socket;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

async function connectRpc(endpoint: string, authToken: string): Promise<RpcClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const client = new Socket();
    client.once("connect", () => resolve(client));
    client.once("error", reject);
    client.connect(endpoint);
  });
  socket.write(`${JSON.stringify({ v: CONTROL_PLANE_RPC_VERSION, auth: authToken })}\n`);
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
      // child→Core 反向请求：本测试只服务 workspace.ensure 的 backfill.seeds。
      if (typeof frame.id === "string" && typeof frame.method === "string") {
        if (frame.method !== "backfill.seeds") {
          throw new Error(`unexpected child→Core method: ${frame.method}`);
        }
        socket.write(
          `${JSON.stringify({ v: CONTROL_PLANE_RPC_VERSION, id: frame.id, ok: true, result: { seeds: [] } })}\n`,
        );
      }
    }
  });
  return {
    socket,
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

function seedPendingCandidate(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    const createdAt = Date.now() - 120_000;
    database
      .prepare(
        `insert into trigger_events (
          id, workspace_identity, source, thread_key, actor_kind, actor_id, payload,
          payload_digest, taint, provider, provider_message_id, fast_path,
          adjudication_status, final_disposition, settled_at, created_at, updated_at
        ) values ('cand-shutdown', 'ws-1', 'im', 'ws-1|bot:bot-1+u1', 'human', 'u1',
          '{"text":"shutdown probe"}', 'digest', 1, 'feishu', 'pm-cand-shutdown',
          'unowned_candidate', 'pending', null, null, ?, ?)`,
      )
      .run(createdAt, createdAt);
  } finally {
    database.close();
  }
}

describe("daemon shutdown 中止在途裁决", () => {
  it("abort 顺序：先取消模型调用再收口，候选留 pending 且零 decision_log", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-cp-adj-shutdown-"));
    roots.push(root);
    const dataBaseDir = join(root, "data");
    const serverRoot = join(root, "server");
    await mkdir(serverRoot, { recursive: true });
    const endpoint = join(root, "super-agent.sock");
    const authTokenFile = join(root, "auth-token");
    const authToken = "test-token-shutdown";
    await writeFile(authTokenFile, `${authToken}\n`, { encoding: "utf8", mode: 0o600 });

    // 预置 pending 候选：daemon 首次 workspace.ensure 后 driver.start() 立即补扫并起火。
    const databasePath = getSuperAgentDatabasePath(dataBaseDir);
    await mkdir(join(dataBaseDir, ".zcode", "v2"), { recursive: true });
    const bootstrap = await openSuperAgentDatabase({ databasePath });
    bootstrap.close();
    seedPendingCandidate(databasePath);

    let abortSignal: AbortSignal | undefined;
    let runCalled = false;
    let runRejected = false;
    const messages: Array<Record<string, unknown>> = [];
    const assemblyFactory = async (input: { abortSignal: AbortSignal }): Promise<AdjudicationSessionAssembly> => {
      abortSignal = input.abortSignal;
      return {
        session: {
          async run() {
            runCalled = true;
            return await new Promise<never>((_, reject) => {
              if (input.abortSignal.aborted) {
                runRejected = true;
                reject(input.abortSignal.reason);
                return;
              }
              input.abortSignal.addEventListener(
                "abort",
                () => {
                  runRejected = true;
                  reject(input.abortSignal.reason);
                },
                { once: true },
              );
            });
          },
          destroySession() {
            // 无会话。
          },
        },
        dispose() {
          // 无可释放资源。
        },
      };
    };

    const daemon = await startControlPlaneDaemon({
      config: {
        generation: 1,
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        dataBaseDir,
        serverRoot,
        mandateGate: false,
      },
      endpoint,
      authTokenFile,
      adjudicationSessionAssembly: assemblyFactory,
      send: (message) => {
        messages.push(message as Record<string, unknown>);
      },
      subscribeShutdownCommand: () => undefined,
      subscribeParentDisconnect: () => undefined,
      onError: () => undefined,
      healthIntervalMs: 1_000,
    });
    expect(messages.some((message) => message.type === "ready")).toBe(true);
    expect(abortSignal).toBeUndefined();

    const client = await connectRpc(endpoint, authToken);
    try {
      const ensured = (await client.request("workspace.ensure", {
        workspaceIdentity: "ws-1",
        workspacePath: join(root, "workspace"),
        tasksIndexReady: false,
      })) as { state: string };
      expect(ensured.state).toBe("leader");

      // 首个裁决批已进入注入会话：确认 run 正在等模型（hang）。
      await vi.waitFor(() => expect(runCalled).toBe(true), { timeout: 10_000 });
      expect(abortSignal?.aborted).toBe(false);

      await daemon.shutdown("shutdown command");
      expect(await daemon.done).toBe(0);
    } finally {
      client.close();
    }

    expect(abortSignal?.aborted).toBe(true);
    expect(runRejected).toBe(true);

    const database = new DatabaseSync(databasePath);
    try {
      const row = database
        .prepare(
          "select adjudication_status from trigger_events where id = 'cand-shutdown'",
        )
        .get() as { adjudication_status: string };
      expect(row.adjudication_status).toBe("pending");
      const decisions = database
        .prepare("select count(*) as n from decision_log where trigger_id = 'cand-shutdown'")
        .get() as { n: number };
      expect(Number(decisions.n)).toBe(0);
    } finally {
      database.close();
    }
  });
});
