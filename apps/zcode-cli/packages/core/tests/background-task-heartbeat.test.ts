// owner 心跳接线（watchdog registry-stall 判活）：声明与 touch 同源 + 周期注入时钟。
// 锚：docs/architecture/super-agent-watchdog-spec.md §9 实施偏差 1/2/3——
//   1) 只有会起 1s 轮询（hasSnapshotProvider）的 runtime-background-task 行声明心跳并周期 touch；
//   2) dwf（workflow 行）不声明、不发心跳 touch，updatedAt 留给 20min cancel-stalled 独立时钟；
//   3) 周期到期前不 touch，到期才 touch（周期严格 < stalenessCapMs 的落地侧钉子）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionId, createTurnId } from "@zcode/contracts";
import {
  BACKGROUND_TASK_POLL_INTERVAL_MS,
  BackgroundTaskTracker,
  HEARTBEAT_TOUCH_PERIOD_MS,
} from "../src/tool/executor/background-tasks.js";
import {
  setBackgroundRunProjection,
  type BackgroundRunProjectionPort,
} from "../src/tool/executor/background-task-registry.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";

interface ProjectionCall {
  op: "register" | "settle" | "touch";
  row?: Record<string, unknown>;
  id?: string;
  owner?: string;
  state?: string;
}

function mountProjection(): ProjectionCall[] {
  const calls: ProjectionCall[] = [];
  const port: BackgroundRunProjectionPort = {
    register(row) {
      calls.push({ op: "register", row: { ...row } });
    },
    settle(id, owner, state) {
      calls.push({ op: "settle", id, owner, state });
    },
    touch(id, owner) {
      calls.push({ op: "touch", id, owner });
    },
  };
  setBackgroundRunProjection(port);
  return calls;
}

function touchCalls(calls: ProjectionCall[]): ProjectionCall[] {
  return calls.filter((c) => c.op === "touch");
}

function registerRow(calls: ProjectionCall[], id: string): Record<string, unknown> | undefined {
  return calls.find((c) => c.op === "register" && c.row?.id === id)?.row;
}

afterEach(() => {
  vi.useRealTimers();
  setBackgroundRunProjection(undefined);
});

describe("runtime-background-task 行的心跳周期（注入时钟）", () => {
  it("register 声明 heartbeat:true；周期到期前不 touch，到期即 touch（owner 同源）", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const calls = mountProjection();
    const sessionId = createSessionId("bash-heartbeat");
    const turnId = createTurnId("turn_bash_heartbeat");
    const tracker = new BackgroundTaskTracker({
      emitEvent: async () => {},
      executionPort: {
        async run() {
          throw new Error("run should not be called");
        },
        // 快照签名（pid/stderr/stdout）恒定：首 poll 一次进度 touch 之后不再有签名变化，
        // 此后的 touch 只可能来自心跳——两条路径因此可分。
        async getBackgroundTask(taskId: string) {
          return { taskId, status: "running", startedAt: new Date(0) };
        },
        // 终态等待者挂起：测试期间任务保持 running。
        async waitForBackgroundTask() {
          return new Promise(() => {});
        },
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(),
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      { id: "tool_bash_hb", input: { command: "sleep 999" }, name: "Bash" } as never,
      { backgroundTaskId: "bash-hb-1", status: "backgrounded" },
      { traceId: "trace_bash_hb", spanId: "span_bash_hb", sessionId, turnId },
      turnId,
    );

    // 声明与 touch 同源：有快照提供者的 runtime-background-task 行才声明。
    expect(registerRow(calls, "bash-hb-1")).toEqual({
      id: "bash-hb-1",
      kind: "background_task",
      owner: "runtime-background-task",
      heartbeat: true,
    });
    // 首 poll：签名 "" → "{}" 的进度 touch 一次。
    expect(touchCalls(calls)).toHaveLength(1);

    // 到期前（周期 - 1ms，含全部轮询 tick）：不打心跳。
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TOUCH_PERIOD_MS - BACKGROUND_TASK_POLL_INTERVAL_MS);
    expect(touchCalls(calls)).toHaveLength(1);

    // 跨过周期：恰好一次心跳 touch，owner 与 register 同源（非硬编码）。
    await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_POLL_INTERVAL_MS);
    expect(touchCalls(calls)).toHaveLength(2);
    expect(touchCalls(calls)[1]).toEqual({
      op: "touch",
      id: "bash-hb-1",
      owner: "runtime-background-task",
    });

    // 再推进一个周期：按周期复现，不随轮询次数放大。
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TOUCH_PERIOD_MS);
    expect(touchCalls(calls)).toHaveLength(3);
    expect(touchCalls(calls)[2]).toEqual({
      op: "touch",
      id: "bash-hb-1",
      owner: "runtime-background-task",
    });
  });

  it("仅 waitForTerminal 没有 getSnapshot 的行：不起轮询，不声明心跳", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const calls = mountProjection();
    const sessionId = createSessionId("bash-waiter-only");
    const turnId = createTurnId("turn_bash_waiter_only");
    const tracker = new BackgroundTaskTracker({
      emitEvent: async () => {},
      executionPort: {
        async run() {
          throw new Error("run should not be called");
        },
        // 没有 getBackgroundTask ⇒ hasSnapshotProvider=false ⇒ 轮询定时器不启动。
        async waitForBackgroundTask() {
          return new Promise(() => {});
        },
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(),
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      { id: "tool_bash_waiter", input: { command: "sleep 9" }, name: "Bash" } as never,
      { backgroundTaskId: "bash-waiter-1", status: "backgrounded" },
      { traceId: "trace_bash_waiter", spanId: "span_bash_waiter", sessionId, turnId },
      turnId,
    );

    // 声明了却等不到 touch 的行会被 registry-stall 误判——所以干脆不声明。
    expect(registerRow(calls, "bash-waiter-1")).not.toHaveProperty("heartbeat");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TOUCH_PERIOD_MS * 2);
    expect(touchCalls(calls)).toHaveLength(0);
  });
});

describe("dynamic-workflow 行不发心跳（spec §9 实施偏差 2）", () => {
  it("dwf 行不声明 heartbeat；周期推进零心跳 touch，updatedAt 留给 20min cancel-stalled 时钟", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const calls = mountProjection();
    const sessionId = createSessionId("dwf-heartbeat");
    const turnId = createTurnId("turn_dwf_heartbeat");
    const tracker = new BackgroundTaskTracker({
      emitEvent: async () => {},
      dynamicWorkflowRunPort: {
        async submit() {
          throw new Error("submit should not be called");
        },
        // 快照签名（pid/stderr/stdout 对 DynamicWorkflowRunSnapshot 恒缺席）恒定：
        // 首 poll 一次进度 touch 之后签名不再变化——此后若出现 touch，只可能是心跳违规。
        async getTask(taskId: string) {
          return { taskId, runId: taskId, startedAt: new Date(0), status: "running" };
        },
        waitForTask: () => new Promise(() => {}),
        async cancel() {
          return true;
        },
        async listEvents() {
          return [];
        },
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(),
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      { id: "tool_create_workflow_hb", input: { script: "" }, name: "CreateWorkflow" } as never,
      { backgroundTaskId: "dwfrun-hb-1", status: "backgrounded" },
      { traceId: "trace_dwf_hb", spanId: "span_dwf_hb", sessionId, turnId },
      turnId,
    );

    // 即使调用方按 hasSnapshotProvider=true 传了声明，owner 门也在 register 内拦下。
    const row = registerRow(calls, "dwfrun-hb-1");
    expect(row).toEqual({
      id: "dwfrun-hb-1",
      kind: "workflow",
      owner: "dynamic-workflow",
      stallClockRef: "dwf-run:dwfrun-hb-1",
    });
    expect(row).not.toHaveProperty("heartbeat");

    // 首 poll 的进度 touch（签名 "" → "{}"）是 running 期唯一允许的 touch。
    expect(touchCalls(calls)).toHaveLength(1);
    expect(touchCalls(calls)[0].owner).toBe("dynamic-workflow");

    // 三个心跳周期内零新增 touch：不给 workflow 行的 updatedAt 注入 liveness。
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TOUCH_PERIOD_MS * 3);
    expect(touchCalls(calls)).toHaveLength(1);
    expect(touchCalls(calls).every((c) => c.owner === "dynamic-workflow")).toBe(true);
  });
});
