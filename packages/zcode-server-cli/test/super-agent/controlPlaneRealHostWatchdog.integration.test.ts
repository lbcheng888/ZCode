/**
 * real-host E2E（S2/S3 收口）：真实生产 daemon 子进程（`resolveDefaultControlPlaneCommand`
 * 的 dev tsx 入口，非测试 fixture）+ 真凭据握手 + 真实 `createControlPlaneClient` +
 * **真实 Core inbound handler**（`createSuperAgentControlPlaneInboundHandler`，生产
 * core.ts 装配的同一函数）应答反向 host.* 请求。
 *
 * 与 bootstrap 侧 E2E 的分工：那边 Core 缝 glue 是等价镜像、会话栈为真；这边 Core
 * handler 是生产本体（含 ControlPlaneRpcError/ack 映射），daemon 是生产入口本体，
 * V4 投递缝（IZCodeAgentService.sendConversationCommandV4）为唯一替身（真实执行端
 * 由 bootstrap 侧 v4/整机链用例覆盖）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_PLANE_PROTOCOL_VERSION } from "@zcode/shared/super-agent-control-plane-protocol";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

import { IZCodeAgentService } from "@zcode/services";
import { ensureControlPlaneAuthToken } from "../../src/supervisor/controlPlaneAuth.js";
import { resolveDefaultControlPlaneCommand } from "../../src/supervisor/controlPlaneLauncher.js";
import { createControlPlaneClient } from "../../src/supervisor/controlPlaneClient.js";
import { createSuperAgentControlPlaneInboundHandler } from "../../src/server-core/superAgentHostHandlers.js";

const MONOREPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TEST_TIMEOUT_MS = 90_000;
const SESSION_ID = "session-real-host";
const RUN_ID = "workflow-real-host-1";

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

/** 生产解析 + 生产 env 启动真实 daemon 子进程（与 Supervisor 拉起同一入口）。 */
async function startProductionDaemonChild(
  serverRoot: string,
  dataBaseDir: string,
): Promise<ChildProcess> {
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
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

/** daemon 起库后向 background_run_registry 写入 stalled workflow 行（真实表，无 DDL 复制）。 */
async function seedStalledWorkflowRow(dataBaseDir: string, workspaceKey: string): Promise<void> {
  const databasePath = join(dataBaseDir, ".chengcode", "v2", "super-agent.sqlite");
  const deadline = Date.now() + 15_000;
  while (!existsSync(databasePath) && Date.now() < deadline) await delay(200);
  if (!existsSync(databasePath)) throw new Error(`daemon database not created: ${databasePath}`);
  const staleAt = Date.now() - 40 * 60_000;
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(
      `insert into background_run_registry (
         id, kind, owner, owner_session, workspace_key, state, stall_clock_ref,
         registered_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set updated_at = excluded.updated_at`,
    ).run(
      RUN_ID,
      "workflow",
      "dynamic-workflow",
      SESSION_ID,
      workspaceKey,
      "running",
      `dwf-run:${RUN_ID}`,
      staleAt,
      staleAt,
    );
  } finally {
    db.close();
  }
}

describe("real-host：生产 daemon 子进程 × 真实 Core inbound handler", () => {
  it(
    "stalled workflow 行经生产 watchdog → 真 socket → 真 Core handler 合成 V4 cancelBackgroundWork",
    async () => {
      // 目录名要短：unix socket 路径上限约 104 字节。
      const root = await mkdtemp(join(tmpdir(), "zcrh-"));
      roots.push(root);
      const serverRoot = join(root, "server");
      const dataBaseDir = join(root, "data");
      const workspacePath = join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      await writeFile(join(workspacePath, "marker.txt"), "real-host", "utf8");
      await ensureControlPlaneAuthToken(serverRoot);

      // V4 投递缝唯一替身：捕获生产 handler 合成的真实 envelope，按 accepted 回执。
      const deliveredEnvelopes: CommandEnvelope[] = [];
      const sendConversationCommandV4 = vi.fn(
        async ({ envelope }: { envelope: CommandEnvelope }) => {
          deliveredEnvelopes.push(envelope);
          return {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: 1,
          };
        },
      );
      const services = {
        getOptional: (descriptor: unknown) =>
          descriptor === IZCodeAgentService ? { sendConversationCommandV4 } : undefined,
      };

      const child = await startProductionDaemonChild(serverRoot, dataBaseDir);
      await waitForChildMessage(child, (message) => message.type === "ready");

      // 生产 Core 的入站处理器：core.ts 装配的同一工厂（services 按调用时取）。
      const client = createControlPlaneClient({
        serverRoot,
        onInboundRequest: createSuperAgentControlPlaneInboundHandler({
          getServices: () => services,
        }),
      });
      try {
        await client.connect();
        const ensure = await client.request("workspace.ensure", {
          workspaceIdentity: workspacePath,
          workspacePath,
          tasksIndexReady: false,
        });
        expect(ensure.state).toBe("leader");

        // daemon 建库后种 stalled 行；生产 watchdog 首 tick（30s 间隔）经
        // refreshFromPersistence 可见并触发 cancel-stalled。
        await seedStalledWorkflowRow(dataBaseDir, workspacePath);

        const deadline = Date.now() + 45_000;
        while (deliveredEnvelopes.length === 0 && Date.now() < deadline) await delay(500);
        expect(deliveredEnvelopes.length).toBeGreaterThan(0);

        const envelope = deliveredEnvelopes[0]!;
        expect(envelope.type).toBe("cancelBackgroundWork");
        expect(envelope.sessionId).toBe(SESSION_ID);
        expect(envelope.clientId).toBe("super-agent-watchdog");
        expect(envelope.commandId).toMatch(/^watchdog-cancel-workflow:/);
        expect((envelope.payload as { workId?: string }).workId).toBe(RUN_ID);
      } finally {
        await client.close();
        await stopChild(child);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
