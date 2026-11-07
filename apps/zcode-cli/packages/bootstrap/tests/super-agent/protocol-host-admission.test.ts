// lane B：里程碑 A 协议宿主准入接线（spec super-agent-trigger-subsystem-spec
// §8-10① / §8-2）。flag-on：server-operations 把 gateway.handleCommand 等注入
// options.superAgent，session/create 过 create-app 构造门不再响亮失败，控制面在场；
// flag-off：同一注入被 create-app 忽略，零行为变化（控制面缺席）。缺注入的响亮失败
// 契约保留在 control-plane-create-app.test.ts（create-app 侧原测试）。
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { zcodeProtocolMethods } from "@zcode/shared";

import { ZCodeProtocolAgentServer } from "../../src/zcode-protocol/server.js";
import type { ZCodeApp, ZCodeAppOptions } from "../../src/app/types.js";
import { createRegistryBackedTestApp } from "../helpers/registry-backed-test-app.js";

const EVENT_ROUTER_CONFIG_SEGMENTS = [".chengcode", "cli", "config.json"] as const;
const ZCODE_V2_SEGMENTS = [".chengcode", "v2"] as const;

let home = "";
let cwd = "";
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
const apps: ZCodeApp[] = [];
const stores: Array<{ close(): void }> = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "zcode-protocol-admission-home-"));
  cwd = await mkdtemp(join(tmpdir(), "zcode-protocol-admission-ws-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  // createConfig 的用户配置缺省路径 = ~/.chengcode/cli/config.json（homedir() 取 $HOME），
  // super-agent/tasks-index 库同理；隔离 HOME 才能让 flag 与库路径落在临时目录。
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  await mkdir(join(home, ...ZCODE_V2_SEGMENTS), { recursive: true });
  // tasks-index 迁移 0007 同文（spec §1.6；bootstrap 测试不能 import services，
  // 结构变更需与 packages/services tasksDatabase/migrations.ts 同步）。
  const tasks = new DatabaseSync(join(home, ...ZCODE_V2_SEGMENTS, "tasks-index.sqlite"));
  tasks.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      command_id TEXT NOT NULL UNIQUE,
      workspace_identity TEXT NOT NULL,
      session_id TEXT,
      payload TEXT,
      status TEXT NOT NULL,
      skip_reason TEXT,
      dispatch_policy TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      pushed_at INTEGER,
      acked_at INTEGER,
      settled_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_requests_status_updated
      ON dispatch_requests (status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_dispatch_requests_workspace_status
      ON dispatch_requests (workspace_identity, status);
  `);
  tasks.close();
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.close?.();
    } catch {
      // 断言后的关闭失败不掩盖用例失败。
    }
  }
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // 同上。
    }
  }
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    await rm(home, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const leftovers: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, entry.name);
        leftovers.push(full);
        if (entry.isDirectory()) await walk(full);
      }
    };
    await walk(home);
    throw new Error(`cleanup failed: ${JSON.stringify(leftovers)} (${String(error)})`);
  }
  await rm(cwd, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
});

type AppCreateOptions = Omit<ZCodeAppOptions, "providerRegistry">;

interface Harness {
  server: ZCodeProtocolAgentServer;
  /** 最近一次 createZCodeApp 收到的 options 与产出的 app（准入接线断言用）。 */
  last: { options?: AppCreateOptions; app?: ZCodeApp };
}

async function makeServer(options: { eventRouter: boolean }): Promise<Harness> {
  if (options.eventRouter) {
    await mkdir(join(home, ...EVENT_ROUTER_CONFIG_SEGMENTS.slice(0, 2)), { recursive: true });
    await writeFile(
      join(home, ...EVENT_ROUTER_CONFIG_SEGMENTS),
      JSON.stringify({ features: { eventRouter: true } }),
      "utf8",
    );
  }
  const store = await createSqliteSessionStore({ dbPath: ":memory:" });
  stores.push(store);
  const last: Harness["last"] = {};
  const server = new ZCodeProtocolAgentServer({
    cwd,
    env: {},
    sessionStore: store,
    createZCodeApp: async (appOptions) => {
      last.options = appOptions;
      const app = await createRegistryBackedTestApp(appOptions);
      last.app = app;
      apps.push(app);
      return app;
    },
  });
  return { server, last };
}

async function createSession(server: ZCodeProtocolAgentServer) {
  const response = await server.handleMessage({
    id: 1,
    method: zcodeProtocolMethods.sessionCreate,
    params: { workspace: { workspacePath: cwd, workspaceKey: cwd } },
  });
  if (!response || !("result" in response)) {
    throw new Error(`session/create 失败: ${JSON.stringify(response)}`);
  }
  return response.result;
}

describe("协议宿主 super-agent 准入接线（spec §8-10①）", () => {
  it("flag-on：session/create 启动成功，options.superAgent 注入两缝与库路径，控制面在场且 leader", async () => {
    const { server, last } = await makeServer({ eventRouter: true });

    await createSession(server);

    // 接线证据：宿主注入面在场（缺注入时 create-app 会在本用例响亮失败）。
    const hostPorts = last.options?.superAgent;
    expect(hostPorts).toBeDefined();
    expect(typeof hostPorts?.handleCommand).toBe("function");
    expect(typeof hostPorts?.autoReplyGuard?.admit).toBe("function");
    // 库路径与 super-agent 同根解析到隔离 HOME（services 同式 {dataBaseDir}/.chengcode/v2）。
    expect(hostPorts?.superAgentDatabasePath).toBe(
      join(home, ...ZCODE_V2_SEGMENTS, "super-agent.sqlite"),
    );
    expect(hostPorts?.tasksIndexDatabasePath).toBe(
      join(home, ...ZCODE_V2_SEGMENTS, "tasks-index.sqlite"),
    );
    // 控制面真域库已打开（非 mock 装配证据）；读面为空收件箱。
    const plane = last.app?.superAgentControlPlane;
    expect(plane).toBeDefined();
    expect(plane?.isLeader()).toBe(true);
    expect(plane?.listPendingWouldAccept()).toEqual([]);
    const row = plane?.database.prepare("select count(*) as n from trigger_events").get() as
      | { n: number }
      | undefined;
    expect(row?.n).toBe(0);
  });

  it("flag-off：session/create 照常成功且控制面缺席（注入字段被忽略，零行为变化）", async () => {
    const { server, last } = await makeServer({ eventRouter: false });

    await createSession(server);

    expect(last.app).toBeDefined();
    expect(last.app?.superAgentControlPlane).toBeUndefined();
    // 注入本身零 I/O、flag-off 不被读取；字段在场不影响装配结果。
    expect(typeof last.options?.superAgent?.handleCommand).toBe("function");
  });
});
