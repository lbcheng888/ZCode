import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_PLANE_CORE_ENABLED_ENV } from "../src/contracts.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

const createServerHostServices = vi.fn();
const materializeZCodeBuiltinProviderConfig = vi.fn();
const disposeServiceResourcesAndWait = vi.fn();
const createCoreHttpServer = vi.fn();
const createIngressToken = vi.fn();
const resolveCoreServerId = vi.fn();
const installParentDisconnectHandler = vi.fn();
const createTaskActivityTracker = vi.fn();
const createCoreDaemonScheduler = vi.fn();
const environmentConfigRoot = "/tmp/zcode-server-core-test/.zcode/v2";

vi.mock("@zcode/services/node", () => ({
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV: "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  createServerHostServices,
  createServiceLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  createTopicResourcePeers: () => ({ getChannel: vi.fn() }),
  disposeServiceResourcesAndWait,
  getAppConfigDir: () => environmentConfigRoot,
  materializeZCodeBuiltinProviderConfig,
}));
vi.mock("../src/server-core/http.js", () => ({ createCoreHttpServer }));
vi.mock("../src/server-core/ingressToken.js", () => ({ createIngressToken }));
vi.mock("../src/server-core/serverIdentity.js", () => ({ resolveCoreServerId }));
vi.mock("../src/server-core/parentDisconnect.js", () => ({ installParentDisconnectHandler }));
vi.mock("../src/server-core/taskActivityTracker.js", () => ({ createTaskActivityTracker }));
vi.mock("../src/server-core/scheduler/index.js", () => ({ createCoreDaemonScheduler }));

const { runServerCore } = await import("../src/server-core/core.js");

const ENV_KEYS = [
  "ZCODE_SERVER_ROOT",
  "ZCODE_SERVER_RUNTIME_ROOT",
  "ZCODE_SERVER_RELEASE_ID",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  CONTROL_PLANE_CORE_ENABLED_ENV,
] as const;
const PROCESS_EVENTS = ["message", "SIGTERM", "SIGINT"] as const;
// 以通用 EventEmitter 视角操作 process，绕开 process.on/listeners 针对具体事件名的重载。
const processEmitter: NodeJS.EventEmitter = process;

describe("runServerCore startup wiring", () => {
  const layout = resolveServerLayout("/tmp/zcode-server-core-test/.zcode/server");
  const materializedPath = join(
    environmentConfigRoot,
    "runtime",
    "provider",
    "bundled",
    "zcode-builtin.json",
  );
  const savedEnv = new Map<string, string | undefined>();
  const listenersBefore = new Map<string, Function[]>();

  beforeEach(() => {
    vi.useFakeTimers();
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const event of PROCESS_EVENTS) {
      listenersBefore.set(event, processEmitter.listeners(event));
    }
    process.env.ZCODE_SERVER_ROOT = layout.serverRoot;
    vi.stubGlobal("__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__", '{"providers":{}}');
    materializeZCodeBuiltinProviderConfig.mockResolvedValue(materializedPath);
    createServerHostServices.mockResolvedValue({
      services: { getOptional: vi.fn(() => undefined) },
      workspaceIdentityMapper: {},
      migrationFailedPathCount: 0,
    });
    createCoreHttpServer.mockResolvedValue({
      host: "127.0.0.1",
      port: 4321,
      close: vi.fn(async () => undefined),
    });
    createIngressToken.mockResolvedValue("ingress-token");
    resolveCoreServerId.mockResolvedValue("server-installation-id");
    installParentDisconnectHandler.mockReturnValue(() => undefined);
    createTaskActivityTracker.mockReturnValue({
      readRunningTaskCount: () => 0,
      onDidChangeRunningTaskCount: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    });
    createCoreDaemonScheduler.mockReturnValue({
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      tick: vi.fn(async () => undefined),
      settleDispatchResult: vi.fn(async () => undefined),
      settleDispatchSkipped: vi.fn(async () => undefined),
      settleRunTerminal: vi.fn(async () => undefined),
      isHostCommandDeliverable: vi.fn(() => true),
      settleHostCommand: vi.fn(async () => null),
    });
  });

  afterEach(() => {
    // runServerCore 会注册 shutdown 监听并启动心跳 interval；测试不走 process.exit 路径，
    // 手工回收本用例新增的监听与定时器，避免污染同一 worker 内的其它用例。
    for (const event of PROCESS_EVENTS) {
      const before = new Set(listenersBefore.get(event) ?? []);
      for (const listener of processEmitter.listeners(event)) {
        if (!before.has(listener)) {
          processEmitter.removeListener(event, listener as (...args: unknown[]) => void);
        }
      }
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetAllMocks();
  });

  it("materializes the built-in provider config under the environment config root, not the release runtime", async () => {
    process.env.ZCODE_SERVER_RUNTIME_ROOT = join(layout.releasesDir, "release-1", "runtime");
    process.env.ZCODE_SERVER_RELEASE_ID = "release-1";

    await runServerCore(7);

    expect(materializeZCodeBuiltinProviderConfig).toHaveBeenCalledTimes(1);
    expect(materializeZCodeBuiltinProviderConfig).toHaveBeenCalledWith({
      environmentConfigRoot,
      content: '{"providers":{}}',
    });
    expect(createServerHostServices).toHaveBeenCalledWith({
      zcodeBuiltinProviderConfigFilePath: materializedPath,
      sourceServerId: "server-installation-id",
      providerProvisioningTargetEnabled: true,
      topicResourceRelayChannel: expect.any(Function),
    });
    expect(createIngressToken).toHaveBeenCalledWith(layout);
  });

  it("deployment gate on: injects the production RPC port and starts the daemon scheduler", async () => {
    process.env[CONTROL_PLANE_CORE_ENABLED_ENV] = "1";

    await runServerCore(1);

    expect(createServerHostServices).toHaveBeenCalledWith(
      expect.objectContaining({
        superAgentControlPlaneRpcPort: expect.objectContaining({
          triggerIngest: expect.any(Function),
          scheduleAudit: expect.any(Function),
        }),
      }),
    );
    // B-SPEC §4.4.3 原子切换：门禁打开即构造并启动 scheduler（pending + push/sweep +
    // host.command ACK 回灌同批）；启动失败原样上浮，不留「门禁开但 scheduler 不在跑」。
    expect(createCoreDaemonScheduler).toHaveBeenCalledTimes(1);
    expect(createCoreDaemonScheduler).toHaveBeenCalledWith(
      expect.objectContaining({
        controlPlane: expect.objectContaining({
          port: expect.objectContaining({
            triggerIngest: expect.any(Function),
            scheduleAudit: expect.any(Function),
          }),
        }),
        serverRoot: layout.serverRoot,
        tasksIndexDatabasePath: expect.any(String),
      }),
    );
    expect(createCoreDaemonScheduler.mock.results[0]?.value.start).toHaveBeenCalledTimes(1);
  });

  it("deployment gate off: does not inject the production RPC port", async () => {
    await runServerCore(1);

    expect(createServerHostServices).toHaveBeenCalledWith(
      expect.not.objectContaining({ superAgentControlPlaneRpcPort: expect.anything() }),
    );
    // 门禁关：不构造/不启动 scheduler，Desktop Main fork 保持全权（逐字节 legacy）。
    expect(createCoreDaemonScheduler).not.toHaveBeenCalled();
  });

  it("waits for owner host initialization before opening RPC", async () => {
    const result = {
      services: { getOptional: () => undefined },
      workspaceIdentityMapper: {},
      migrationFailedPathCount: 0,
    };
    let release!: () => void;
    createServerHostServices.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(result);
        }),
    );
    const starting = runServerCore(1);
    await vi.waitFor(() => expect(createServerHostServices).toHaveBeenCalledOnce());
    expect(createCoreHttpServer).not.toHaveBeenCalled();
    release();
    await starting;
    expect(createCoreHttpServer).toHaveBeenCalledWith(
      result.services,
      expect.objectContaining({
        serverId: "server-installation-id",
        workspaceIdentityMapper: result.workspaceIdentityMapper,
      }),
    );
  });

  it("keeps the server closed when migration fails", async () => {
    createServerHostServices.mockRejectedValue(new Error("migration failed"));
    await expect(runServerCore(1)).rejects.toThrow("migration failed");
    expect(createCoreHttpServer).not.toHaveBeenCalled();
  });

  it("prefers an explicitly configured built-in provider config file", async () => {
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = "/explicit/zcode-builtin.json";

    await runServerCore(1);

    expect(materializeZCodeBuiltinProviderConfig).not.toHaveBeenCalled();
    expect(createServerHostServices).toHaveBeenCalledWith(
      expect.objectContaining({
        zcodeBuiltinProviderConfigFilePath: "/explicit/zcode-builtin.json",
        providerProvisioningTargetEnabled: true,
      }),
    );
  });

  it("fails fast when neither an embedded nor an explicit built-in config is available", async () => {
    vi.stubGlobal("__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__", undefined);

    await expect(runServerCore(1)).rejects.toThrow(
      /ZCode Built-in Provider Config.*ZCODE_BUILTIN_PROVIDER_CONFIG_FILE/u,
    );
    expect(createServerHostServices).not.toHaveBeenCalled();
  });
});
