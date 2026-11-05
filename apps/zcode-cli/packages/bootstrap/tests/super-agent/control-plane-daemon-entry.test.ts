/**
 * headless 入口参数/路径契约单测（B-SPEC §2.2/§2.3）：
 * env 与 argv 同义、argv 覆盖 env、未知参数响亮失败、存储同根断言。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertControlPlaneStorageRoot,
  CONTROL_PLANE_ENV,
  parseControlPlaneEntryConfig,
} from "../../src/app/super-agent-daemon-entry.js";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  controlPlaneCommandSchema,
  controlPlaneMessageSchema,
  controlPlaneTriggerIngestResultSchema,
  resolveControlPlaneSocketPath,
  stablePathId,
  workspaceEnsureParamsSchema,
} from "@zcode/shared/super-agent-control-plane-protocol";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ENV = {
  ZCODE_CONTROL_PLANE_GENERATION: "3",
  ZCODE_CONTROL_PLANE_PROTOCOL_VERSION: String(CONTROL_PLANE_PROTOCOL_VERSION),
  ZCODE_DATA_BASE_DIR: "/tmp/data",
  ZCODE_SERVER_ROOT: "/tmp/server",
  ZCODE_CONTROL_PLANE_MANDATE_GATE: "0",
};

describe("parseControlPlaneEntryConfig", () => {
  it("env 契约与 launcher 注入键同源", () => {
    const config = parseControlPlaneEntryConfig({ argv: [], env: ENV });
    expect(config).toEqual({
      generation: 3,
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      dataBaseDir: "/tmp/data",
      serverRoot: "/tmp/server",
      mandateGate: false,
    });
  });

  it("argv 覆盖 env，等价 `--key=value` 与 `--key value`", () => {
    const config = parseControlPlaneEntryConfig({
      argv: ["--data-base-dir=/tmp/argv", "--server-root", "/tmp/argv-server", "--mandate-gate=1"],
      env: ENV,
    });
    expect(config.dataBaseDir).toBe("/tmp/argv");
    expect(config.serverRoot).toBe("/tmp/argv-server");
    expect(config.mandateGate).toBe(true);
  });

  it("未知参数 / 缺值响亮失败", () => {
    expect(() =>
      parseControlPlaneEntryConfig({ argv: ["--unknown=1"], env: ENV }),
    ).toThrow(/unknown control-plane argument/);
    expect(() =>
      parseControlPlaneEntryConfig({ argv: ["--data-base-dir"], env: ENV }),
    ).toThrow(/requires a value/);
  });

  it("generation/数据目录缺失时拒绝启动", () => {
    expect(() =>
      parseControlPlaneEntryConfig({
        argv: [],
        env: { ...ENV, ZCODE_CONTROL_PLANE_GENERATION: "abc" },
      }),
    ).toThrow(/generation/);
    expect(() =>
      parseControlPlaneEntryConfig({
        argv: [],
        env: { ...ENV, ZCODE_DATA_BASE_DIR: " " },
      }),
    ).toThrow(/data-base-dir/);
  });
});

describe("control-plane 端点与生命周期 schema", () => {
  it("POSIX 端点为 runDir/super-agent.sock", () => {
    expect(resolveControlPlaneSocketPath("/srv/root", "linux")).toBe(
      "/srv/root/run/super-agent.sock",
    );
  });

  it("Windows named pipe 用稳定 hash，不含原始路径", () => {
    const endpoint = resolveControlPlaneSocketPath("C:\\Server Root", "win32");
    expect(endpoint).toBe(`\\\\.\\pipe\\zcode-super-agent-${stablePathId("C:\\Server Root")}`);
    expect(endpoint.includes("Server Root")).toBe(false);
  });

  it("生命周期消息/命令为严格闭集", () => {
    expect(
      controlPlaneMessageSchema.safeParse({ type: "ready", protocolVersion: 2, generation: 1 })
        .success,
    ).toBe(true);
    expect(
      controlPlaneMessageSchema.safeParse({
        type: "ready",
        protocolVersion: 2,
        generation: 1,
        extra: true,
      }).success,
    ).toBe(false);
    expect(controlPlaneCommandSchema.safeParse({ command: "shutdown" }).success).toBe(true);
    expect(controlPlaneCommandSchema.safeParse({ command: "restart" }).success).toBe(false);
  });

  it("health 扩展字段（§2.4）严格校验且未知字段拒绝", () => {
    const health = {
      type: "health" as const,
      at: 1,
      pendingEventCount: 3,
      leaderWorkspaceCount: 1,
      pendingDispatchCount: 2,
      degraded: { reason: "core channel closed", since: 2 },
      workspaceErrors: [{ workspaceIdentity: "ws-1", error: "db busy" }],
      rejectedPeerCount: 4,
      protocolErrorCount: 1,
      followerIngestCount: 5,
      notEnsuredIngestCount: 6,
    };
    expect(controlPlaneMessageSchema.safeParse(health).success).toBe(true);
    expect(
      controlPlaneMessageSchema.safeParse({ ...health, unexpected: true }).success,
    ).toBe(false);
    expect(
      controlPlaneMessageSchema.safeParse({
        ...health,
        workspaceErrors: Array.from({ length: 33 }, (_, index) => ({
          workspaceIdentity: `ws-${index}`,
          error: "x",
        })),
      }).success,
    ).toBe(false);
  });

  it("workspace.ensure 可带 Core 解析的 tasks-index 绝对路径用于跨进程同根校验", () => {
    expect(
      workspaceEnsureParamsSchema.safeParse({
        workspaceIdentity: "ws-1",
        tasksIndexDatabasePath: "/data/.zcode/v2/tasks-index.sqlite",
      }).success,
    ).toBe(true);
    expect(
      workspaceEnsureParamsSchema.safeParse({
        workspaceIdentity: "ws-1",
        tasksIndexDatabasePath: 42,
      }).success,
    ).toBe(false);
  });

  it("trigger.ingest ACK 按 handled 判别：缺 triggerId/route 或 false 带字段都拒绝", () => {
    expect(
      controlPlaneTriggerIngestResultSchema.safeParse({
        handled: true,
        triggerId: "t-1",
        route: "owned",
        delivery: "routed",
      }).success,
    ).toBe(true);
    expect(controlPlaneTriggerIngestResultSchema.safeParse({ handled: false }).success).toBe(true);
    // 畸形 ACK 会让 Core 按错误分支跳过 legacy 或双跑，必须 fail-closed。
    expect(
      controlPlaneTriggerIngestResultSchema.safeParse({ handled: true, route: "owned" }).success,
    ).toBe(false);
    expect(
      controlPlaneTriggerIngestResultSchema.safeParse({ handled: true, triggerId: "t-1" }).success,
    ).toBe(false);
    expect(
      controlPlaneTriggerIngestResultSchema.safeParse({ handled: false, triggerId: "t-1" }).success,
    ).toBe(false);
  });
});

describe("assertControlPlaneStorageRoot", () => {
  it("域库与 tasks-index 同根", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-cp-root-"));
    roots.push(root);
    const paths = assertControlPlaneStorageRoot(root);
    expect(paths.superAgentDatabasePath).toBe(join(root, ".zcode", "v2", "super-agent.sqlite"));
    expect(paths.tasksIndexDatabasePath).toBe(join(root, ".zcode", "v2", "tasks-index.sqlite"));
  });
});

describe("CONTROL_PLANE_ENV", () => {
  it("键名与 controlPlaneLauncher 注入一致", () => {
    expect(CONTROL_PLANE_ENV.generation).toBe("ZCODE_CONTROL_PLANE_GENERATION");
    expect(CONTROL_PLANE_ENV.protocolVersion).toBe("ZCODE_CONTROL_PLANE_PROTOCOL_VERSION");
    expect(CONTROL_PLANE_ENV.dataBaseDir).toBe("ZCODE_DATA_BASE_DIR");
    expect(CONTROL_PLANE_ENV.serverRoot).toBe("ZCODE_SERVER_ROOT");
  });
});
