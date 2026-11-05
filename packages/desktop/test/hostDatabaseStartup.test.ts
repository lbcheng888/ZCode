import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import {
  ensureGlobalDataRootMigrated,
  setDataBaseDir,
} from "../../services/src/paths.js";

const fixtures = vi.hoisted(() => ({
  host: vi.fn(),
  session: vi.fn(),
  mark: vi.fn(),
  migrate: vi.fn(),
}));
vi.mock("@zcode/services/storage-startup", () => ({
  getTasksIndexDatabasePath: () => "/isolated/tasks.sqlite",
  resolveZCodeAgentSpawnCwd: async (...args: unknown[]) =>
    (
      await import("../../services/src/zcode-agent/zcodeAgentSpawnCwd.js")
    ).resolveZCodeAgentSpawnCwd(...(args as [never])),
  markTasksStoragePrepared: fixtures.mark,
}));
vi.mock("../src/host/database-startup/storagePreparationProcesses.js", () => ({
  prepareHostStorage: fixtures.host,
  prepareSessionStorage: fixtures.session,
}));
import { createHostDatabaseStartup } from "../src/host/database-startup/hostDatabaseStartup.js";

beforeEach(() => {
  fixtures.host.mockReset();
  fixtures.session.mockReset();
  fixtures.mark.mockReset();
  fixtures.migrate.mockReset();
  fixtures.migrate.mockResolvedValue({ status: "fresh", targetDir: "/isolated/.chengcode" });
});

it("prepares actual restored working directories before publishing services, without a fake workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-cwd-"));
  const sequence: string[] = [];
  fixtures.host.mockImplementation(async () => {
    sequence.push("host");
  });
  fixtures.session.mockImplementation(async ({ cwd }) => {
    sequence.push(cwd);
  });
  const startup = createHostDatabaseStartup({
    startupId: "host-startup-test",
    cwd: tmpdir(),
    workingDirectories: [dir, dir],
    initializeServices: async () => {
      sequence.push("services");
    },
    publish: () => {},
    onFailure: () => {},
    ensureGlobalDataRootMigrated: fixtures.migrate,
  });
  try {
    await startup.coordinator.start();
    expect(fixtures.migrate.mock.invocationCallOrder[0]).toBeLessThan(
      fixtures.host.mock.invocationCallOrder[0]!,
    );
    expect(sequence).toEqual(["host", dir, "services"]);
    expect(startup.coordinator.snapshot.startupId).toBe("host-startup-test");
    expect(startup.coordinator.snapshot.phase).toBe("ready");
  } finally {
    startup.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses the normal Agent fallback for ENOTDIR and preserves actual database failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-invalid-cwd-"));
  const parent = join(dir, "former-directory");
  await writeFile(parent, "now a file");
  const cwd = join(parent, "old-project");
  const initialized = vi.fn();
  const primary = Object.assign(new Error("real database full"), { code: "ENOSPC" });
  fixtures.host.mockResolvedValue(undefined);
  fixtures.session.mockRejectedValue(primary);
  const failure = vi.fn();
  const startup = createHostDatabaseStartup({
    cwd: dir,
    workingDirectories: [cwd],
    initializeServices: initialized,
    publish: () => {},
    onFailure: failure,
    ensureGlobalDataRootMigrated: fixtures.migrate,
  });
  try {
    await startup.coordinator.start();
    expect(fixtures.session).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: dir }));
    expect(failure).toHaveBeenCalledWith(primary);
    expect(startup.coordinator.snapshot).toMatchObject({
      phase: "failed",
      errorCode: "storage_full",
    });
    expect(initialized).not.toHaveBeenCalled();
    const oldPaths = fixtures.session.mock.calls.at(-1)?.[0].preparedPaths as Set<string>;
    oldPaths.add("previous-attempt-only");
    fixtures.session.mockResolvedValue(undefined);
    await startup.coordinator.retry(startup.coordinator.snapshot.attemptId);
    expect(initialized).toHaveBeenCalledOnce();
    expect(fixtures.session.mock.calls.at(-1)?.[0].preparedPaths).not.toBe(oldPaths);
    expect(fixtures.session.mock.calls.at(-1)?.[0].preparedPaths.size).toBe(0);
    expect(startup.coordinator.snapshot.phase).toBe("ready");
  } finally {
    startup.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("在打开任何数据库之前完成旧数据根迁移，旧目录保留", async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-startup-migration-"));
  await mkdir(join(base, ".zcode", "v2"), { recursive: true });
  await writeFile(join(base, ".zcode", "v2", "seed.txt"), "legacy");
  const sequence: string[] = [];
  fixtures.host.mockImplementation(async () => {
    sequence.push("host");
  });
  fixtures.session.mockImplementation(async () => {
    sequence.push("session");
  });
  const startup = createHostDatabaseStartup({
    cwd: base,
    workingDirectories: [base],
    initializeServices: async () => {
      sequence.push("services");
    },
    publish: () => {},
    onFailure: () => {},
    ensureGlobalDataRootMigrated: async () => await ensureGlobalDataRootMigrated({ baseDir: base }),
  });
  try {
    await startup.coordinator.start();
    expect(sequence).toEqual(["host", "session", "services"]);
    expect(existsSync(join(base, ".chengcode", "v2", "seed.txt"))).toBe(true);
    expect(existsSync(join(base, ".zcode", "v2", "seed.txt"))).toBe(true);
    expect(startup.coordinator.snapshot.phase).toBe("ready");
  } finally {
    startup.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

it("迁移失败时直接失败启动，不打开数据库也不初始化服务", async () => {
  const failure = new Error("migration copy failed");
  fixtures.migrate.mockRejectedValue(failure);
  const initialized = vi.fn();
  const onFailure = vi.fn();
  const states: import("@zcode/shared").DatabaseStartupState[] = [];
  const startup = createHostDatabaseStartup({
    cwd: tmpdir(),
    initializeServices: initialized,
    publish: (state) => states.push(state),
    onFailure,
    ensureGlobalDataRootMigrated: fixtures.migrate,
  });
  try {
    await startup.coordinator.start();
    expect(fixtures.host).not.toHaveBeenCalled();
    expect(fixtures.session).not.toHaveBeenCalled();
    expect(initialized).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(failure);
    expect(states.at(-1)).toMatchObject({ phase: "failed", failedPhase: "starting" });
  } finally {
    startup.dispose();
  }
});

it("迁移 home 根与自定义 dataBaseDir 两个数据根，避免 setting.json 落在旧根", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-startup-home-"));
  const custom = await mkdtemp(join(tmpdir(), "zcode-startup-custom-"));
  const originalDesktopHome = process.env.ZCODE_DESKTOP_HOME_DIR;
  const calls: Array<string | undefined> = [];
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  setDataBaseDir(custom);
  const startup = createHostDatabaseStartup({
    cwd: home,
    workingDirectories: [home],
    initializeServices: async () => {},
    publish: () => {},
    onFailure: () => {},
    ensureGlobalDataRootMigrated: async (options) => {
      calls.push(options?.baseDir);
      return { status: "fresh", targetDir: join(options?.baseDir ?? "", ".chengcode") };
    },
  });
  try {
    await startup.coordinator.start();
    expect(calls).toEqual([home, custom]);
  } finally {
    startup.dispose();
    setDataBaseDir(null);
    if (originalDesktopHome === undefined) {
      delete process.env.ZCODE_DESKTOP_HOME_DIR;
    } else {
      process.env.ZCODE_DESKTOP_HOME_DIR = originalDesktopHome;
    }
    await rm(home, { recursive: true, force: true });
    await rm(custom, { recursive: true, force: true });
  }
});

it("only marks the last session database as eligible for global saving/finishing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-final-db-"));
  const states: import("@zcode/shared").DatabaseStartupState[] = [];
  const migration = { kind: "upgrade", executedCount: 1, committedCount: 0 };
  fixtures.host.mockImplementation(async (_path, report) => report("committing", migration));
  fixtures.session.mockImplementation(async ({ cwd, report }) => {
    report("committing", { databaseId: cwd, migration });
    report("ready", { databaseId: cwd, migration: { ...migration, committedCount: 1 } });
  });
  const startup = createHostDatabaseStartup({
    cwd: dir,
    workingDirectories: [dir, tmpdir()],
    initializeServices: async () => {},
    publish: (state) => states.push(state),
    onFailure: () => {},
    ensureGlobalDataRootMigrated: fixtures.migrate,
  });
  try {
    await startup.coordinator.start();
    const commits = states.filter((state) => state.databasePhase === "committing");
    expect(commits.map((state) => state.finalDatabase)).toEqual([undefined, false, true]);
    expect(states.at(-1)?.phase).toBe("ready");
  } finally {
    startup.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
