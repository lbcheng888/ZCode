// M8 BackgroundRun registry 注册钩子（super-agent-watchdog 行级所有权投影）。
// 锚：docs/architecture/super-agent-watchdog-spec.md §1.3——automationService /
// offPeakTaskService 各自在 run 生命周期点调结构兼容投影端口；接缝未挂载时 no-op。
import { describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@zcode/provider";
import type { ZCodeAutomation, ZCodeAutomationRun, ZCodeOffPeakTask } from "@zcode/shared";
import {
  AutomationService,
  setAutomationRunProjection,
  type AutomationRunProjectionPort,
} from "../src/session/automationService.js";
import {
  OffPeakTaskService,
  type OffPeakRunProjectionPort,
} from "../src/session/offPeakTaskService.js";
import type { OffPeakTaskRepo } from "../src/session/offPeakTaskRepo.js";
import type { OffPeakServerClient } from "../src/session/offPeakServerClient.js";
import { createServiceLogger } from "../src/logger/serviceLogger.js";

const NOW = 1_700_000_000_000;
const logger = createServiceLogger("background-run-projection-test", { isDebugEnabled: false });

interface Call {
  op: "register" | "settle" | "touch";
  row?: Record<string, unknown>;
  id?: string;
  owner?: string;
  state?: string;
}

function recordCalls(): { calls: Call[]; port: AutomationRunProjectionPort & OffPeakRunProjectionPort } {
  const calls: Call[] = [];
  const port = {
    register(row: Record<string, unknown>) {
      calls.push({ op: "register", row: { ...row } });
    },
    settle(id: string, owner: string, state: string) {
      calls.push({ op: "settle", id, owner, state });
    },
    touch(id: string, owner: string) {
      calls.push({ op: "touch", id, owner });
    },
  } as AutomationRunProjectionPort & OffPeakRunProjectionPort;
  return { calls, port };
}

describe("automationService 注册钩子", () => {
  it("runNow 建 manual run 即按 owner=automation 注册", async () => {
    const { calls, port } = recordCalls();
    setAutomationRunProjection(port);
    try {
      const automation = { automationId: "a1" } as ZCodeAutomation;
      const run = {
        runId: "run-1",
        automationId: "a1",
        workspaceKey: "ws:/tmp/ws",
        sessionId: "sess-9",
      } as ZCodeAutomationRun;
      const repo = {
        get: vi.fn(async () => automation),
        runNow: vi.fn(async () => ({ automation, run })),
      };
      const service = new AutomationService(repo as never);

      const result = await service.runNow("a1", { workspacePath: "/tmp/ws" });

      expect(result?.run.runId).toBe("run-1");
      expect(calls).toEqual([
        {
          op: "register",
          row: {
            id: "run-1",
            kind: "automation",
            owner: "automation",
            ownerSession: "sess-9",
            workspaceKey: "ws:/tmp/ws",
          },
        },
      ]);
    } finally {
      setAutomationRunProjection(undefined);
    }
  });

  it("deleteRun = owner settle dropped；接缝未挂载时 no-op", async () => {
    const { calls, port } = recordCalls();
    const deleteRun = vi.fn(async () => {});
    const service = new AutomationService({ deleteRun } as never);

    setAutomationRunProjection(port);
    try {
      await service.deleteRun("run-x", { workspacePath: "/tmp/ws" });
      expect(calls).toEqual([{ op: "settle", id: "run-x", owner: "automation", state: "dropped" }]);
    } finally {
      setAutomationRunProjection(undefined);
    }
    calls.length = 0;
    await service.deleteRun("run-y", { workspacePath: "/tmp/ws" });
    expect(calls).toHaveLength(0); // 接缝卸载 = 钩子 no-op
    expect(deleteRun).toHaveBeenCalledTimes(2);
  });
});

describe("offPeakTaskService 注册钩子", () => {
  const createParams = {
    title: "夜间回归",
    prompt: "跑完整回归并汇总",
    permissionMode: "bypassPermissions",
    modelSelection: { providerId: "p", modelId: "m", options: {} } as ModelSelection,
    workspacePath: "/tmp/ws",
  };

  function makeService(options?: { runProjection?: OffPeakRunProjectionPort }) {
    const created = {
      offPeakTaskId: "offpeak-1",
      status: "queued",
    } as ZCodeOffPeakTask;
    const repo = {
      create: vi.fn(
        async (
          _params: unknown,
          opts: { offPeakTaskId?: string } = {},
        ): Promise<ZCodeOffPeakTask> => ({
          ...created,
          ...(opts.offPeakTaskId ? { offPeakTaskId: opts.offPeakTaskId } : {}),
        }),
      ),
      hasActiveBoundTask: vi.fn(async () => false),
      markTerminal: vi.fn(async () => ({ ...created, status: "cancelled" })),
      markSettled: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ ...created, status: "queued" })),
      updateSchedulingSnapshot: vi.fn(async () => undefined),
    } as unknown as OffPeakTaskRepo;
    const client = {
      getTakeNumberAvailability: vi.fn(async () => ({ canTakeNumber: true })),
      takeTicket: vi.fn(async () => ({
        ticketId: "t-1",
        state: "ready" as const,
        registeredAt: NOW,
      })),
      settle: vi.fn(async () => {}),
    } as unknown as OffPeakServerClient;
    const service = new OffPeakTaskService({
      repo,
      client,
      logger,
      resolveCodingPlanSupport: async () => ({ supported: false }) as never,
      resolveTelemetryProviderName: async () => "example.local",
      resolveModelSelection: async () =>
        ({ ok: true, selection: createParams.modelSelection }) as never,
      now: () => NOW,
      ...(options?.runProjection ? { runProjection: options.runProjection } : {}),
    });
    return { service, repo, client };
  }

  it("创建成功即按 owner=offpeak 注册（带 workspaceKey）", async () => {
    const { calls, port } = recordCalls();
    const { service } = makeService({ runProjection: port });

    const result = await service.createTask(createParams);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      op: "register",
      row: {
        id: expect.stringMatching(/^offpeak-/),
        kind: "offpeak",
        owner: "offpeak",
        workspaceKey: "/tmp/ws",
      },
    });
  });

  it("cancelTask = owner settle cancelled", async () => {
    const { calls, port } = recordCalls();
    const { service } = makeService({ runProjection: port });
    await service.createTask(createParams);
    calls.length = 0;

    await service.cancelTask("offpeak-1");

    expect(calls).toEqual([
      { op: "settle", id: "offpeak-1", owner: "offpeak", state: "cancelled" },
    ]);
  });

  it("接缝未挂载时钩子 no-op（创建/取消照常）", async () => {
    const { service, repo } = makeService();
    const result = await service.createTask(createParams);
    expect(result.ok).toBe(true);
    expect(repo.create).toHaveBeenCalledTimes(1);
    await service.cancelTask("offpeak-1");
    expect(repo.markTerminal).toHaveBeenCalledTimes(1);
  });
});
