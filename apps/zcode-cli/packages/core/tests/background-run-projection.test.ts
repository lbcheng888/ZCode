// M8 BackgroundRun registry 注册钩子（super-agent-watchdog 行级所有权投影）。
// 锚：docs/architecture/super-agent-watchdog-spec.md §1.3——core 两个钩子
// （background-task-registry / dynamic-workflow-run-track）经结构兼容投影端口写 registry；
// 接缝未挂载（undefined）时为 no-op，不阻塞业务路径。
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATE_WORKFLOW_TOOL_NAME, createRootTraceContext, createSessionId } from "@zcode/contracts";
import { AgentRuntime } from "../src/index.js";
import {
  getBackgroundRunProjection,
  registerRuntimeBackgroundTask,
  removeRuntimeBackgroundTask,
  setBackgroundRunProjection,
  touchRuntimeBackgroundTaskHeartbeat,
  updateRuntimeBackgroundTask,
  type BackgroundRunProjectionPort,
} from "../src/tool/executor/background-task-registry.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import type { ExecutableToolCall } from "../src/tool/types.js";
import { createTestSessionEventStore } from "./test-event-store.js";

interface ProjectionCall {
  op: "register" | "settle" | "touch";
  row?: Record<string, unknown>;
  id?: string;
  owner?: string;
  state?: string;
}

function mountProjection(): { calls: ProjectionCall[]; port: BackgroundRunProjectionPort } {
  const calls: ProjectionCall[] = [];
  const port: BackgroundRunProjectionPort = {
    register(row) {
      calls.push({ op: "register", row: { ...row } });
    },
    settle(id, owner, state, opts) {
      calls.push({ op: "settle", id, owner, state, row: opts ? { ...opts } : undefined });
    },
    touch(id, owner) {
      calls.push({ op: "touch", id, owner });
    },
  };
  setBackgroundRunProjection(port);
  return { calls, port };
}

function executorDeps(): ToolExecutorDeps {
  return { runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry() } as ToolExecutorDeps;
}

const workflowCall: ExecutableToolCall = {
  id: "call-1",
  name: CREATE_WORKFLOW_TOOL_NAME,
  input: { name: "nightly" },
};
const bashCall: ExecutableToolCall = { id: "call-2", name: "Bash", input: { command: "sleep 1" } };

afterEach(() => {
  setBackgroundRunProjection(undefined);
});

describe("background-task-registry 注册钩子", () => {
  it("workflow 任务登记为 dynamic-workflow owner 且携带 stall 时钟指针", () => {
    const { calls } = mountProjection();
    const deps = executorDeps();

    registerRuntimeBackgroundTask(deps, workflowCall, "run-1", {}, undefined);

    expect(calls).toEqual([
      {
        op: "register",
        row: {
          id: "run-1",
          kind: "workflow",
          owner: "dynamic-workflow",
          stallClockRef: "dwf-run:run-1",
        },
      },
    ]);
  });

  it("Bash 任务登记为 runtime-background-task owner", () => {
    const { calls } = mountProjection();
    const deps = executorDeps();

    registerRuntimeBackgroundTask(deps, bashCall, "bash-1", {}, undefined);

    expect(calls).toEqual([
      { op: "register", row: { id: "bash-1", kind: "background_task", owner: "runtime-background-task" } },
    ]);
  });

  it("running 触碰进度指针、终态由 owner 原子回写", () => {
    const { calls } = mountProjection();
    const deps = executorDeps();
    registerRuntimeBackgroundTask(deps, workflowCall, "run-1", {}, undefined);
    calls.length = 0;

    updateRuntimeBackgroundTask(deps, workflowCall, "run-1", "running");
    expect(calls).toEqual([{ op: "touch", id: "run-1", owner: "dynamic-workflow" }]);

    calls.length = 0;
    updateRuntimeBackgroundTask(deps, workflowCall, "run-1", "completed", {
      runId: "run-1",
      status: "completed",
      startedAt: new Date(),
      output: "done",
    } as never);
    expect(calls).toEqual([
      {
        op: "settle",
        id: "run-1",
        owner: "dynamic-workflow",
        state: "completed",
        row: expect.objectContaining({}),
      },
    ]);
  });

  it("注册失败回滚 = owner settle dropped", () => {
    const { calls } = mountProjection();
    const deps = executorDeps();
    registerRuntimeBackgroundTask(deps, bashCall, "bash-1", {}, undefined);
    calls.length = 0;

    removeRuntimeBackgroundTask(deps, bashCall, "bash-1");

    expect(calls).toEqual([
      { op: "settle", id: "bash-1", owner: "runtime-background-task", state: "dropped", row: undefined },
    ]);
  });

  it("接缝未挂载时钩子 no-op（不阻塞登记）", () => {
    expect(getBackgroundRunProjection()).toBeUndefined();
    const deps = executorDeps();
    expect(() => registerRuntimeBackgroundTask(deps, workflowCall, "run-1", {}, undefined)).not.toThrow();
    expect(deps.runtimeTaskRegistry.get("run-1")?.taskId).toBe("run-1");
  });
});

// owner 心跳接线（watchdog registry-stall 判活）：声明与 touch 同源、owner 从 taskType
// 推导。锚：docs/architecture/super-agent-watchdog-spec.md §9 实施偏差 1/2。
describe("owner 心跳声明与 touch 同源", () => {
  it("register 声明：仅 runtime-background-task 行落 heartbeat:true，workflow 行被 owner 拦下", () => {
    const { calls } = mountProjection();
    const deps = executorDeps();

    registerRuntimeBackgroundTask(deps, bashCall, "bash-1", {}, undefined, { heartbeat: true });
    registerRuntimeBackgroundTask(deps, workflowCall, "run-1", {}, undefined, { heartbeat: true });

    const rows = calls.filter((c) => c.op === "register").map((c) => c.row);
    expect(rows[0]).toEqual({
      id: "bash-1",
      kind: "background_task",
      owner: "runtime-background-task",
      heartbeat: true,
    });
    // owner 门：dwf 即使调用方传 heartbeat:true 也不声明——它的 updatedAt 是 20min
    // cancel-stalled 独立时钟，心跳会把 liveness 双计成 progress（spec §9 实施偏差 2）。
    expect(rows[1]).toEqual({
      id: "run-1",
      kind: "workflow",
      owner: "dynamic-workflow",
      stallClockRef: "dwf-run:run-1",
    });
    expect(rows[1]).not.toHaveProperty("heartbeat");
  });

  it("touchRuntimeBackgroundTaskHeartbeat：owner 从 taskType 推导；dwf 行 no-op", () => {
    const { calls } = mountProjection();
    const deps = executorDeps();
    registerRuntimeBackgroundTask(deps, bashCall, "bash-1", {}, undefined, { heartbeat: true });
    registerRuntimeBackgroundTask(deps, workflowCall, "run-1", {}, undefined, { heartbeat: true });
    calls.length = 0;

    touchRuntimeBackgroundTaskHeartbeat(deps, bashCall, "bash-1");
    touchRuntimeBackgroundTaskHeartbeat(deps, workflowCall, "run-1");

    // 禁止硬编码 owner：bash 行 touch 落自己的 owner；workflow 行零写入（不刷 updatedAt）。
    expect(calls).toEqual([{ op: "touch", id: "bash-1", owner: "runtime-background-task" }]);
  });
});

describe("dynamic-workflow-run-track 注册钩子", () => {
  function makeRuntime(name: string): AgentRuntime {
    return new AgentRuntime(
      createSessionId(name),
      { agentName: "wd-projection-test", workingDirectory: "/tmp/zcode-wd-projection" },
      {
        eventStore: createTestSessionEventStore(),
        modelAdapter: {} as never,
        dynamicWorkflowRunPort: {
          async submit() {
            throw new Error("resume 不应触发 submit");
          },
          async getTask() {
            return { runId: "dwfrun-1", taskId: "dwfrun-1", startedAt: new Date(), status: "running" };
          },
          async waitForTask() {
            return new Promise(() => {});
          },
          async cancel() {
            return true;
          },
          async listEvents() {
            return [];
          },
        } as never,
      },
    );
  }

  it("resume 追踪后按 dynamic-workflow owner 登记 workflow 行（补 stall 指针）", async () => {
    const { calls } = mountProjection();
    const runtime = makeRuntime("wd-track-resume");

    await runtime.trackResumedDynamicWorkflowRun({ runId: "dwfrun-1", toolCallId: "call-origin" });

    // 两处钩子同 owner：executor 登记 + track 补 stallClockRef，均为 dynamic-workflow。
    const registers = calls.filter((c) => c.op === "register");
    expect(registers.length).toBeGreaterThanOrEqual(1);
    const trackRegister = registers.find(
      (c) => c.row?.id === "dwfrun-1" && c.row?.stallClockRef === "dwf-run:dwfrun-1",
    );
    expect(trackRegister).toBeDefined();
    expect(trackRegister?.row?.owner).toBe("dynamic-workflow");
    expect(trackRegister?.row?.kind).toBe("workflow");
    for (const call of calls) {
      expect(call.owner ?? call.row?.owner).toBe("dynamic-workflow");
    }
  });

  it("异 owner 不可能出现：全部钩子写入均自称 dynamic-workflow", async () => {
    const { calls } = mountProjection();
    const runtime = makeRuntime("wd-track-owner");
    await runtime.trackResumedDynamicWorkflowRun({ runId: "dwfrun-9" });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => (c.owner ?? c.row?.owner) === "dynamic-workflow")).toBe(true);
  });
});

describe("投影端口挂载生命周期", () => {
  it("set/get 往返；卸载后钩子静默", () => {
    const spy = vi.fn();
    setBackgroundRunProjection({
      register: spy,
      settle: spy,
      touch: spy,
    });
    expect(typeof getBackgroundRunProjection()?.register).toBe("function");
    setBackgroundRunProjection(undefined);
    expect(getBackgroundRunProjection()).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
