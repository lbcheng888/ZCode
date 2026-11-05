/**
 * Core ↔ child 真实接缝集成（B-SPEC §5.2 Core↔child 集成 / §3.1 / §3.8）。
 *
 * 用本 lane 的真实 JSONL 客户端连接真实 headless child（dev tsx 入口 + 真 sqlite +
 * 真 unix socket + 真凭据文件），覆盖固定合成 net server 测不到的两条接缝：
 * - 首帧凭据握手（服务端在认证前拒绝业务帧）；
 * - child 在 workspace.ensure 内反向请求 backfill.seeds，客户端必须回执而不是断开。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_PLANE_PROTOCOL_VERSION } from "@zcode/shared/super-agent-control-plane-protocol";

import { ensureControlPlaneAuthToken } from "../../src/supervisor/controlPlaneAuth.js";
import { resolveDefaultControlPlaneCommand } from "../../src/supervisor/controlPlaneLauncher.js";
import { createControlPlaneClient } from "../../src/supervisor/controlPlaneClient.js";

const MONOREPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TEST_TIMEOUT_MS = 60_000;
const roots: string[] = [];
const children: ChildProcess[] = [];
const childStderr = new WeakMap<ChildProcess, string>();

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function waitForChildMessage(
  child: ChildProcess,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(
        new Error(
          `timed out waiting for child IPC message; stderr=${childStderr.get(child) ?? ""}`,
        ),
      );
    }, 25_000);
    const onMessage = (raw: unknown): void => {
      if (typeof raw !== "object" || raw === null) return;
      const message = raw as Record<string, unknown>;
      if (message.type === "fatal") {
        clearTimeout(timer);
        child.off("message", onMessage);
        reject(
          new Error(
            `child reported fatal: ${String(message.message)}; stderr=${childStderr.get(child) ?? ""}`,
          ),
        );
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
}

async function startRealChild(serverRoot: string, dataBaseDir: string): Promise<ChildProcess> {
  const resolution = resolveDefaultControlPlaneCommand(
    { serverRoot, release: null },
    { devSearchFrom: MONOREPO_ROOT, platform: process.platform },
  );
  if (!resolution.ok) throw new Error(resolution.reason);
  const child = spawn(resolution.command.executable, [...(resolution.command.args ?? [])], {
    cwd: resolution.command.cwd,
    env: {
      ...process.env,
      ZCODE_CONTROL_PLANE_GENERATION: "1",
      ZCODE_CONTROL_PLANE_PROTOCOL_VERSION: String(CONTROL_PLANE_PROTOCOL_VERSION),
      ZCODE_DATA_BASE_DIR: dataBaseDir,
      ZCODE_SERVER_ROOT: serverRoot,
      ZCODE_CONTROL_PLANE_MANDATE_GATE: "0",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  children.push(child);
  childStderr.set(child, "");
  child.stderr?.on("data", (chunk: Buffer) => {
    childStderr.set(child, `${childStderr.get(child) ?? ""}${chunk.toString("utf8")}`);
  });
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.send?.({ command: "shutdown" });
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

describe("Core ↔ child real RPC seam", () => {
  it(
    "connects with the credential handshake, survives backfill reverse request, and runs ensure/lease/ingest",
    async () => {
      // 目录名要短：macOS/BSD 的 unix socket 路径上限约 104 字节，长前缀会让 connect
      // 返回 ENAMETOOLONG，被 fail-closed 探针误判为「状态不可判定」。
      const root = await mkdtemp(join(tmpdir(), "zcpc-"));
      roots.push(root);
      const serverRoot = join(root, "server");
      const dataBaseDir = join(root, "data");
      // Supervisor 在生产启动期铸造；本测试直接走同一函数，保证凭据路径/权限同源。
      const token = await ensureControlPlaneAuthToken(serverRoot);

      const child = await startRealChild(serverRoot, dataBaseDir);
      const ready = await waitForChildMessage(child, (message) => message.type === "ready");
      expect(ready.protocolVersion).toBe(CONTROL_PLANE_PROTOCOL_VERSION);

      const client = createControlPlaneClient({
        serverRoot,
        onInboundRequest: async (method) => {
          switch (method) {
            case "backfill.seeds":
              return { seeds: [] };
            case "host.worker.find":
              return null;
            case "host.worker.createTask":
              return { sessionId: "session-1" };
            case "host.worker.resume":
              return { sessionId: "session-1" };
            case "host.autoReplyGuard":
              return { admitted: true };
            case "host.command":
              return { commandId: "cmd-1", status: "accepted", revisionAtDecision: 1 };
            default:
              throw new Error(`unexpected child→Core method ${method}`);
          }
        },
      });
      try {
        await client.connect();
        // 反向 backfill.seeds 在 ensure 返回前发出；旧客户端会把它当协议错误断开。
        const ensure = await client.request("workspace.ensure", {
          workspaceIdentity: "ws-1",
          workspacePath: join(root, "workspace"),
          tasksIndexReady: false,
        });
        expect(ensure.state).toBe("leader");

        const leases = await client.request("lease.list", {});
        expect(leases.workspaces.map((row) => row.workspaceIdentity)).toEqual(["ws-1"]);

        const ack = await client.request("trigger.ingest", {
          workspaceIdentity: "ws-1",
          source: "im",
          provider: "test-provider",
          providerMessageId: "message-1",
          threadKeyHint: "bot:bot-1+user-1",
          actor: { kind: "human", id: "user-1" },
          payload: { botId: "bot-1", chatId: "user-1", text: "hello" },
          taint: true,
        });
        expect(ack).toMatchObject({ handled: true, route: "human_explicit" });
        const replay = await client.request("trigger.ingest", {
          workspaceIdentity: "ws-1",
          source: "im",
          provider: "test-provider",
          providerMessageId: "message-1",
          threadKeyHint: "bot:bot-1+user-1",
          actor: { kind: "human", id: "user-1" },
          payload: { botId: "bot-1", chatId: "user-1", text: "hello" },
          taint: true,
        });
        expect(replay).toMatchObject({ handled: true });
        if (!ack.handled || !replay.handled) throw new Error("expected handled ACK");
        expect(replay.triggerId).toBe(ack.triggerId);

        expect(token.length).toBeGreaterThan(16);
      } finally {
        await client.close();
        await stopChild(child);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
