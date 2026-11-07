// lane W：create-app 装配面的 flag 开关语义（spec super-agent-trigger-subsystem-spec
// §5.4 kill-switch + §7-7 里程碑 A）。flag 关 = 完全不构造控制面（零行为变化）；
// flag 开 = 控制面在场且 leader，app.close 对称 stop 后 sink 回纯转发。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createRootTraceContext, createToolCallId, createTurnId } from "@zcode/contracts";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

import { CommandInbox } from "../../src/zcode-protocol-v4/command-inbox.js";
import type { SuperAgentCommandHandle } from "../../src/app/super-agent-control-plane.js";
import type { ZCodeApp } from "../../src/app/types.js";
import type { SpecFenceContract } from "../../src/super-agent/spec-lane/index.js";
import { SqliteBackgroundRunStore } from "../../src/super-agent/storage/background-run-store.js";
import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";
import { buildSessionSnapshot } from "../../src/zcode-protocol/session-mapper.js";
import { createRegistryBackedTestApp as createZCodeApp } from "../helpers/registry-backed-test-app.js";

const roots: string[] = [];
const apps: ZCodeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.close?.();
    } catch {
      // 断言后的关闭失败不掩盖用例失败。
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function makeInboxHandle(): {
  handleCommand: SuperAgentCommandHandle;
  envelopes: CommandEnvelope[];
} {
  const envelopes: CommandEnvelope[] = [];
  const inbox = new CommandInbox({
    getRevision: () => 1,
    getLogEpoch: (): string => "epoch-create-app",
  });
  const handleCommand: SuperAgentCommandHandle = async (raw) => {
    envelopes.push(raw as CommandEnvelope);
    const outcome = await inbox.handle(raw);
    if (outcome.kind === "ack") return outcome.ack as CommandAck;
    outcome.settle({ status: "accepted" });
    return outcome.ack;
  };
  return { handleCommand, envelopes };
}

async function createApp(options: {
  eventRouter: boolean;
  specEgressFence?: boolean;
  specWriteLease?: boolean;
  mode?: "build" | "edit" | "yolo";
  specFenceFactory?: () => SpecFenceContract;
}): Promise<{ app: ZCodeApp; root: string; handleCommand: SuperAgentCommandHandle }> {
  const root = await mkdtemp(join(tmpdir(), "zcode-sa-app-"));
  roots.push(root);
  const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
  const { handleCommand } = makeInboxHandle();
  const userConfigPath = join(root, "config.json");
  const features = {
    ...(options.eventRouter ? { eventRouter: true } : {}),
    ...(options.specEgressFence ? { specEgressFence: true } : {}),
    ...(options.specWriteLease ? { specWriteLease: true } : {}),
  };
  if (Object.keys(features).length > 0) {
    await writeFile(userConfigPath, JSON.stringify({ features }));
  }
  const app = await createZCodeApp({
    env: {},
    runtimeConfig: {
      workingDirectory: root,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    },
    sessionStore,
    userConfigPath,
    ...(options.eventRouter
      ? {
          superAgent: {
            handleCommand,
            autoReplyGuard: { admit: async () => true },
            superAgentDatabasePath: join(root, "super-agent.sqlite"),
          },
        }
      : {}),
    ...(options.specFenceFactory ? { specFenceFactory: options.specFenceFactory } : {}),
  });
  apps.push(app);
  return { app, root, handleCommand };
}

describe("create-app × features.eventRouter（spec §5.4 kill-switch）", () => {
  it("flag 关（缺省）：不构造控制面，app.superAgentControlPlane 缺席 = legacy 直路", async () => {
    const { app } = await createApp({ eventRouter: false });
    expect(app.superAgentControlPlane).toBeUndefined();
  });

  it("flag 开 + 注入端口：控制面在场且 leader；close 对称 stop 后 sink 纯转发", async () => {
    const { app } = await createApp({ eventRouter: true });
    const plane = app.superAgentControlPlane;
    expect(plane).toBeDefined();
    expect(plane!.isLeader()).toBe(true);
    // flag 开时域库已按注入路径打开（装配证据，不是 mock）。
    const row = plane!.database
      .prepare("select count(*) as n from trigger_events")
      .get() as { n: number };
    expect(row.n).toBe(0);

    await app.close?.();
    // 已关一次：移出登记表，避免 afterEach 二次 close（close 幂等性不归本用例赌）。
    apps.splice(apps.indexOf(app), 1);
    // stop 后：域库已关、租约循环已停——sink 回 handled:false（纯转发，不触库）。
    const outcome = await plane!.triggerSink.ingest({
      workspaceIdentity: "ws",
      source: "im",
      provider: "feishu",
      providerMessageId: "pm-after-close",
      actor: { kind: "human", id: "u1" },
      payload: { text: "你好" },
      taint: true,
    });
    expect(outcome).toEqual({ handled: false });
  });

  it("快照投影：控制面在场 → pendingWouldAccept/backgroundRuns 键在场为数组；缺席 → 键不发布（unknown≠0）", async () => {
    // mapper 级接线回归（spec §5.5 / 00-tool-change-chain.md「验证见 control-plane-*」）：
    // 键缺席（旧发送端/flag 关）≠ 空数组（已发布零卡片），UI 不得把缺席渲染成空收件箱。
    const off = await createApp({ eventRouter: false });
    const offSnapshot = await buildSessionSnapshot({
      app: off.app,
      eventSeq: 0,
      messages: [],
      stateRevision: 1,
      workspace: { workspacePath: off.root, workspaceKey: off.root },
    });
    expect("pendingWouldAccept" in offSnapshot).toBe(false);
    expect("backgroundRuns" in offSnapshot).toBe(false);

    const on = await createApp({ eventRouter: true });
    const onSnapshot = await buildSessionSnapshot({
      app: on.app,
      eventSeq: 0,
      messages: [],
      stateRevision: 1,
      workspace: { workspacePath: on.root, workspaceKey: on.root },
    });
    expect(Array.isArray(onSnapshot.pendingWouldAccept)).toBe(true);
    // 数据源 = 控制面读面（本用例零卡片 → 显式空数组，键已发布）。
    expect(onSnapshot.pendingWouldAccept).toEqual(
      on.app.superAgentControlPlane!.listPendingWouldAccept(),
    );
    expect(onSnapshot.pendingWouldAccept).toEqual([]);
    expect(onSnapshot.backgroundRuns).toEqual([]);

    // 真实 registry 写入 → 同一控制面读面 → 下次快照（running cheng job 必须可见）。
    const registry = new BackgroundRunRegistry(
      500,
      new SqliteBackgroundRunStore(on.app.superAgentControlPlane!.database),
    );
    registry.register(
      { id: "cheng-ui-1", kind: "cheng-job", owner: "cheng-host", workspaceKey: "ws-ui" },
      1000,
    );
    expect(on.app.superAgentControlPlane!.listBackgroundRuns()).toMatchObject([
      { id: "cheng-ui-1", kind: "cheng-job", owner: "cheng-host", state: "running" },
    ]);
    const withRun = await buildSessionSnapshot({
      app: on.app,
      eventSeq: 0,
      messages: [],
      stateRevision: 1,
      workspace: { workspacePath: on.root, workspaceKey: on.root },
    });
    expect(withRun.backgroundRuns).toMatchObject([
      { id: "cheng-ui-1", kind: "cheng-job", owner: "cheng-host", state: "running" },
    ]);
  });

  it("features.specEgressFence=true 依赖 eventRouter=true：单独开启启动期拒绝", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-sa-app-fence-"));
    roots.push(root);
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const userConfigPath = join(root, "config.json");
    await writeFile(userConfigPath, JSON.stringify({ features: { specEgressFence: true } }));
    await expect(
      createZCodeApp({
        env: {},
        runtimeConfig: { workingDirectory: root },
        sessionStore,
        userConfigPath,
      }),
    ).rejects.toThrow(/features\.specEgressFence=true/);
    sessionStore.close();
  });

  it("repo specEgress.allowHosts 形状非法：启动期拒绝，不进入 runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-sa-app-egress-shape-"));
    roots.push(root);
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    await mkdir(join(root, ".zcode"), { recursive: true });
    await writeFile(
      join(root, ".zcode", "config.json"),
      JSON.stringify({ specEgress: { allowHosts: ["fe80::1"] } }),
    );
    await expect(
      createZCodeApp({
        env: {},
        runtimeConfig: { workingDirectory: root },
        sessionStore,
        skipUserConfig: true,
      }),
    ).rejects.toThrow(/specEgress\.allowHosts/);
    sessionStore.close();
  });

  it("features.specWriteLease=true 依赖 eventRouter=true；联合开启后控制面持有租约仓储", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-sa-app-lease-"));
    roots.push(root);
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const userConfigPath = join(root, "config.json");
    await writeFile(userConfigPath, JSON.stringify({ features: { specWriteLease: true } }));
    await expect(
      createZCodeApp({
        env: {},
        runtimeConfig: { workingDirectory: root },
        sessionStore,
        userConfigPath,
      }),
    ).rejects.toThrow(/features\.specWriteLease=true/);
    sessionStore.close();

    const on = await createApp({ eventRouter: true, specWriteLease: true });
    expect(on.app.superAgentControlPlane).toBeDefined();
    // dispatcher 的 late-bound 端口与 sweep 使用同一仓储实例。
    expect(on.app.superAgentControlPlane!.contracts.writeLeases.getActive("ws-none")).toEqual([]);
  });

  it("spec run 持租约时，手动 session 的 Write 在工具入口被拒绝", async () => {
    const { app, root } = await createApp({
      eventRouter: true,
      specWriteLease: true,
      mode: "yolo",
    });
    const leases = app.superAgentControlPlane!.contracts.writeLeases;
    const now = Date.now();
    leases.acquire({
      workspaceIdentity: root,
      ownerRunId: "run-spec-active",
      scope: JSON.stringify([root]),
      leaseExpiresAt: now + 30 * 60_000,
      now,
    });

    const sessionId = app.sessionId;
    const turnId = createTurnId("lease-write-blocked");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const call = {
      id: createToolCallId("lease-write-blocked"),
      name: "Write",
      input: { file_path: join(root, "blocked.txt"), content: "second writer" },
    };
    const schedule = await app.runtime.scheduleTools([call]);
    const result = await app.runtime.executeTools([call], schedule, { traceContext });
    expect(result.results[0]?.success).toBe(false);
    expect(result.results[0]?.error?.message).toContain("workspace write rejected");
    expect(result.results[0]?.error?.message).toContain("run-spec-active");

    // Bash 写路径：非只读命令在 spawn 前被同一 admission 拒绝；只读命令仍可执行。
    const bashWrite = {
      id: createToolCallId("lease-bash-write"),
      name: "Bash",
      input: { command: "echo second > blocked-bash.txt" },
    };
    const bashSchedule = await app.runtime.scheduleTools([bashWrite]);
    const bashResult = await app.runtime.executeTools([bashWrite], bashSchedule, {
      traceContext,
    });
    expect(bashResult.results[0]?.success).toBe(false);
    expect(bashResult.results[0]?.error?.message).toContain("workspace write rejected");

    const bashRead = {
      id: createToolCallId("lease-bash-read"),
      name: "Bash",
      input: { command: "ls" },
    };
    const readSchedule = await app.runtime.scheduleTools([bashRead]);
    const readResult = await app.runtime.executeTools([bashRead], readSchedule, {
      traceContext,
    });
    expect(readResult.results[0]?.success).toBe(true);
  });

  it("features.specEgressFence=true 经 create-app 构造 fence 并交给 dispatcher；flag 关不构造", async () => {
    let factoryCalls = 0;
    const fenceFactory = (): SpecFenceContract => {
      factoryCalls += 1;
      return {
        probeCapability: async () => ({
          available: false,
          platform: "darwin",
          mechanism: "unsupported",
          code: "fence.unsupported_platform",
          detail: "test-fence",
        }),
        prepare: async () => {
          throw new Error("test fence 不参与本用例");
        },
      };
    };
    // flag on：工厂仅在装配 dispatcher 的 fence dep 时调用（删掉接线行 => 断言失败）。
    const on = await createApp({
      eventRouter: true,
      specEgressFence: true,
      specFenceFactory: fenceFactory,
    });
    expect(on.app.superAgentControlPlane).toBeDefined();
    expect(factoryCalls).toBe(1);
    // flag off：dispatcher 不构造围栏，工厂零调用（flag-off 字节兼容）。
    const off = await createApp({
      eventRouter: true,
      specEgressFence: false,
      specFenceFactory: fenceFactory,
    });
    expect(off.app.superAgentControlPlane).toBeDefined();
    expect(factoryCalls).toBe(1);
  });

  it("flag 开但宿主未注入 superAgent：启动期响亮失败（不静默降级 legacy）", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-sa-app-missing-"));
    roots.push(root);
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const userConfigPath = join(root, "config.json");
    await writeFile(userConfigPath, JSON.stringify({ features: { eventRouter: true } }));
    await expect(
      createZCodeApp({
        env: {},
        runtimeConfig: { workingDirectory: root },
        sessionStore,
        userConfigPath,
      }),
    ).rejects.toThrow(/features\.eventRouter=true/);
    sessionStore.close();
  });
});
