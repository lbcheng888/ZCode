import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_PLANE_PROTOCOL_VERSION } from "../src/contracts.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import {
  createControlPlaneLauncher,
  createDefaultControlPlaneLauncher,
} from "../src/supervisor/controlPlaneLauncher.js";
import { Supervisor, type ControlPlaneOptions } from "../src/supervisor/supervisor.js";

class FakeCore extends EventEmitter {
  public readonly pid = 42;
  public shutdownRequested = false;
  public killRequested = false;

  public send(message: unknown): boolean {
    if (
      typeof message === "object" &&
      message !== null &&
      "command" in message &&
      message.command === "shutdown"
    ) {
      this.shutdownRequested = true;
      queueMicrotask(() => this.emit("exit", 0, null));
    }
    return true;
  }

  public kill(): boolean {
    this.killRequested = true;
    queueMicrotask(() => this.emit("exit", null, "SIGKILL"));
    return true;
  }

  public reportReady(generation: number): void {
    queueMicrotask(() =>
      this.emit("message", {
        type: "ready",
        host: "127.0.0.1",
        port: 43123,
        version: "test",
        generation,
      }),
    );
  }
}

const READY_CHILD_SCRIPT = `
const generation = Number(process.env.ZCODE_CONTROL_PLANE_GENERATION);
const protocolVersion = Number(process.env.ZCODE_CONTROL_PLANE_PROTOCOL_VERSION);
process.on("message", (message) => {
  if (message && message.command === "shutdown") {
    process.send({ type: "stopped", reason: "shutdown" }, () => process.exit(0));
  }
});
process.send({ type: "ready", protocolVersion, generation, version: "test" });
const healthTimer = setInterval(() => process.send({
  type: "health",
  at: Date.now(),
  pendingEventCount: 2,
  leaderWorkspaceCount: 1,
  pendingDispatchCount: 3,
  degraded: { reason: "test degraded", since: 1 },
  workspaceErrors: [{ workspaceIdentity: "ws-1", error: "test error" }],
  rejectedPeerCount: 4,
  protocolErrorCount: 1,
  followerIngestCount: 5,
  notEnsuredIngestCount: 6,
}), 25);
healthTimer.unref();
`;

const CRASHING_CHILD_SCRIPT = `
const generation = Number(process.env.ZCODE_CONTROL_PLANE_GENERATION);
const protocolVersion = Number(process.env.ZCODE_CONTROL_PLANE_PROTOCOL_VERSION);
process.send({ type: "ready", protocolVersion, generation, version: "test" });
setTimeout(() => process.exit(7), 0);
process.on("message", () => process.exit(0));
`;

const PROTOCOL_MISMATCH_CHILD_SCRIPT = `
const generation = Number(process.env.ZCODE_CONTROL_PLANE_GENERATION);
process.on("message", (message) => {
  if (message && message.command === "shutdown") process.exit(0);
});
process.send({ type: "ready", protocolVersion: 99, generation, version: "test" });
const healthTimer = setInterval(() => process.send({ type: "health", at: Date.now() }), 25);
healthTimer.unref();
`;

const FATAL_CHILD_SCRIPT = `
process.on("message", (message) => {
  if (message && message.command === "shutdown") process.exit(0);
});
process.send({ type: "fatal", message: "database path mismatch" });
// 保持存活：Supervisor 必须把 fatal 当一等失败并主动收口，而不是等 child 自己退出。
setInterval(() => {}, 1000);
`;

const NEVER_READY_CHILD_SCRIPT = `
process.on("message", (message) => {
  if (message && message.command === "shutdown") process.exit(0);
});
setInterval(() => {}, 1000);
`;

const STOPPED_CHILD_SCRIPT = `
const generation = Number(process.env.ZCODE_CONTROL_PLANE_GENERATION);
const protocolVersion = Number(process.env.ZCODE_CONTROL_PLANE_PROTOCOL_VERSION);
process.on("message", (message) => {
  if (message && message.command === "shutdown") process.exit(0);
});
process.send({ type: "ready", protocolVersion, generation, version: "test" });
process.send({ type: "stopped", reason: "configuration changed" });
setTimeout(() => process.exit(0), 0);
`;

function controlPlaneLauncherFor(script: string): ControlPlaneOptions["launcher"] {
  return createControlPlaneLauncher({
    executable: process.execPath,
    args: ["-e", script],
  });
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForSupervisorReady(supervisor: Supervisor): Promise<void> {
  await waitFor(() => supervisor.status().state === "ready", "Core ready");
}

async function createSupervisor(
  root: string,
  controlPlane: ControlPlaneOptions,
  overrides: { coreReadyTimeoutMs?: number } = {},
): Promise<{ supervisor: Supervisor; core: FakeCore }> {
  const core = new FakeCore();
  const supervisor = new Supervisor({
    layout: resolveServerLayout(join(root, "server")),
    launcher: {
      launch: (generation) => {
        core.reportReady(generation);
        return core as unknown as ChildProcess;
      },
    },
    version: "test",
    controlPlane: {
      readyTimeoutMs: 2_000,
      stopGraceTimeoutMs: 200,
      killTimeoutMs: 200,
      crashBackoffMs: [20, 20],
      ...controlPlane,
    },
    ...overrides,
  });
  return { supervisor, core };
}

describe("Supervisor control-plane child", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "zcode-cp-"));
    roots.push(root);
    return root;
  }

  it("does not spawn a control-plane child when the feature flag is off", async () => {
    const root = await makeRoot();
    const core = new FakeCore();
    const supervisor = new Supervisor({
      layout: resolveServerLayout(join(root, "server")),
      launcher: {
        launch: (generation) => {
          core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });

    await supervisor.start();
    await waitForSupervisorReady(supervisor);
    expect(supervisor.controlPlaneStatus()).toBeNull();
    await supervisor.stop();
    expect(supervisor.status().state).toBe("stopped");
  });

  it("spawns a real child, gates readiness, consumes health, and stops it symmetrically with Core", async () => {
    const root = await makeRoot();
    const { supervisor, core } = await createSupervisor(root, {
      launcher: controlPlaneLauncherFor(READY_CHILD_SCRIPT),
    });

    await supervisor.start();
    await waitForSupervisorReady(supervisor);
    await waitFor(
      () => supervisor.controlPlaneStatus()?.state === "ready",
      "control plane ready",
    );
    const status = supervisor.controlPlaneStatus();
    expect(status).toMatchObject({
      state: "ready",
      generation: 1,
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      lastExitReason: null,
    });
    expect(status?.pid).toBeGreaterThan(0);

    await waitFor(
      () => supervisor.controlPlaneStatus()?.health !== null,
      "control plane health message",
    );
    expect(supervisor.controlPlaneStatus()?.health).toMatchObject({
      at: expect.any(Number),
      pendingEventCount: 2,
      leaderWorkspaceCount: 1,
      pendingDispatchCount: 3,
      degraded: { reason: "test degraded", since: 1 },
      workspaceErrors: [{ workspaceIdentity: "ws-1", error: "test error" }],
      rejectedPeerCount: 4,
      protocolErrorCount: 1,
      followerIngestCount: 5,
      notEnsuredIngestCount: 6,
    });

    const stopped = await supervisor.stop();
    expect(stopped).toMatchObject({ state: "stopped", pid: null });
    expect(core.shutdownRequested).toBe(true);
    expect(supervisor.controlPlaneStatus()).toMatchObject({
      state: "stopped",
      pid: null,
    });
  });

  it("restarts a crashed control-plane under its own budget without disturbing Core", async () => {
    const root = await makeRoot();
    const { supervisor } = await createSupervisor(root, {
      launcher: controlPlaneLauncherFor(CRASHING_CHILD_SCRIPT),
    });

    await supervisor.start();
    await waitForSupervisorReady(supervisor);
    await waitFor(
      () => (supervisor.controlPlaneStatus()?.generation ?? 0) >= 2,
      "control-plane crash restart",
    );
    expect(supervisor.status().state).toBe("ready");
    expect(supervisor.controlPlaneStatus()?.state).not.toBe("ready");

    // 退避序列 [20,20]：第三次崩溃超出预算，进入 control-plane 自己的 crash-loop-stopped。
    await waitFor(
      () => supervisor.controlPlaneStatus()?.state === "crash-loop-stopped",
      "control-plane crash budget exhaustion",
    );
    const exhausted = supervisor.controlPlaneStatus();
    expect(exhausted?.crashBudget.crashCount).toBe(3);
    expect(exhausted?.crashBudget.exhausted).toBe(true);
    // 本代际首次 ready 证据跨 child 重启保留（§3.6 rule 2/3 的判据）。
    expect(exhausted?.firstReadyAt).toBeGreaterThan(0);
    // 关键不变量：control-plane 熔断后 Core 仍 ready，daemon 本体不受牵连。
    expect(supervisor.status().state).toBe("ready");
    expect(supervisor.status().pid).toBe(42);

    await supervisor.stop();
  });

  it("fails closed on a protocol mismatch instead of accepting a foreign ready", async () => {
    const root = await makeRoot();
    const { supervisor } = await createSupervisor(root, {
      launcher: controlPlaneLauncherFor(PROTOCOL_MISMATCH_CHILD_SCRIPT),
    });

    await supervisor.start();
    await waitForSupervisorReady(supervisor);
    await waitFor(
      () => (supervisor.controlPlaneStatus()?.generation ?? 0) >= 1,
      "control-plane first launch",
    );
    // 不兼容 ready 不得把状态置为 ready：强杀后按崩溃路径重启，直到预算耗尽。
    await waitFor(
      () => supervisor.controlPlaneStatus()?.state === "crash-loop-stopped",
      "control-plane protocol mismatch exhaustion",
    );
    const status = supervisor.controlPlaneStatus();
    expect(status?.state).toBe("crash-loop-stopped");
    // 描述性原因不得被通用 exit 串覆盖（§2.4）。
    expect(status?.lastExitReason).toMatch(/protocol mismatch/);
    expect(supervisor.status().state).toBe("ready");

    await supervisor.stop();
  });

  it("treats a child fatal report as a first-class failure under its own crash budget", async () => {
    const root = await makeRoot();
    const { supervisor } = await createSupervisor(root, {
      launcher: controlPlaneLauncherFor(FATAL_CHILD_SCRIPT),
      killTimeoutMs: 500,
      crashBackoffMs: [20, 20],
    });

    await supervisor.start();
    await waitForSupervisorReady(supervisor);
    await waitFor(
      () => supervisor.controlPlaneStatus()?.state === "crash-loop-stopped",
      "control-plane fatal crash budget exhaustion",
      10_000,
    );
    const status = supervisor.controlPlaneStatus();
    expect(status?.state).toBe("crash-loop-stopped");
    expect(status?.crashBudget.crashCount).toBe(3);
    expect(status?.lastExitReason).toMatch(/reported fatal: database path mismatch/);
    expect(supervisor.status().state).toBe("ready");

    await supervisor.stop();
  });

  it("kills and budgets a child that never reports ready, keeping firstReadyAt null", async () => {
    const root = await makeRoot();
    const { supervisor } = await createSupervisor(root, {
      launcher: controlPlaneLauncherFor(NEVER_READY_CHILD_SCRIPT),
      readyTimeoutMs: 100,
      killTimeoutMs: 500,
      crashBackoffMs: [20, 20],
    });

    await supervisor.start();
    await waitForSupervisorReady(supervisor);
    await waitFor(
      () => supervisor.controlPlaneStatus()?.state === "crash-loop-stopped",
      "control-plane ready timeout crash budget exhaustion",
      10_000,
    );
    const status = supervisor.controlPlaneStatus();
    expect(status?.state).toBe("crash-loop-stopped");
    expect(status?.firstReadyAt).toBeNull();
    expect(status?.lastExitReason).toMatch(/did not report ready/);
    expect(supervisor.status().state).toBe("ready");

    await supervisor.stop();
  });

  it("preserves a child-reported stop reason instead of overwriting it with the exit string", async () => {
    const root = await makeRoot();
    const { supervisor } = await createSupervisor(root, {
      launcher: controlPlaneLauncherFor(STOPPED_CHILD_SCRIPT),
      crashBackoffMs: [3_000],
    });

    await supervisor.start();
    await waitForSupervisorReady(supervisor);
    await waitFor(
      () => supervisor.controlPlaneStatus()?.lastExitReason === "configuration changed",
      "control-plane stopped reason",
    );
    expect(supervisor.controlPlaneStatus()?.lastExitReason).toBe("configuration changed");

    await supervisor.stop();
  });

  it("relaunches the control-plane on restart with an independent generation", async () => {
    const root = await makeRoot();
    const { supervisor } = await createSupervisor(root, {
      launcher: controlPlaneLauncherFor(READY_CHILD_SCRIPT),
    });

    await supervisor.start();
    await waitForSupervisorReady(supervisor);
    await waitFor(() => supervisor.controlPlaneStatus()?.state === "ready", "first ready");
    expect(supervisor.controlPlaneStatus()?.generation).toBe(1);

    await supervisor.restart();
    await waitForSupervisorReady(supervisor);
    await waitFor(
      () => supervisor.controlPlaneStatus()?.state === "ready",
      "control plane ready after restart",
    );
    expect(supervisor.controlPlaneStatus()?.generation).toBe(2);
    expect(supervisor.status().generation).toBe(2);
    await supervisor.stop();
  });

  it("fails startup loudly and records the root cause when the headless entry is missing", async () => {
    const root = await makeRoot();
    const { supervisor } = await createSupervisor(root, {
      launcher: createDefaultControlPlaneLauncher({
        devSearchFrom: join(root, "missing"),
        platform: "darwin",
      }),
    });

    await expect(supervisor.start()).rejects.toThrow(/headless 入口不可解析/);
    // detached `serve --daemon` stdio=ignore：根因必须落持久化快照，而不是只留 exit code。
    expect(supervisor.status().lastExitReason).toContain("headless 入口不可解析");
    expect(supervisor.status().state).toBe("stopped");
  });

  it("turns a launcher throw during crash restart into a crash signal, not uncaughtException", async () => {
    const root = await makeRoot();
    const crashing = controlPlaneLauncherFor(CRASHING_CHILD_SCRIPT);
    let launches = 0;
    const { supervisor } = await createSupervisor(root, {
      launcher: {
        launch: (params) => {
          launches += 1;
          if (launches === 1) return crashing.launch(params);
          // 入口在崩溃后退化（release 文件消失/开发树被清理）。
          throw new Error("headless entry disappeared");
        },
      },
      crashBackoffMs: [20, 20],
    });

    await supervisor.start();
    await waitForSupervisorReady(supervisor);
    await waitFor(
      () => supervisor.controlPlaneStatus()?.state === "crash-loop-stopped",
      "launch failure crash budget exhaustion",
      10_000,
    );
    const status = supervisor.controlPlaneStatus();
    expect(status?.state).toBe("crash-loop-stopped");
    expect(status?.lastExitReason).toContain("headless entry disappeared");
    expect(launches).toBeGreaterThanOrEqual(2);
    expect(supervisor.status().state).toBe("ready");
    await supervisor.stop();
  });
});
