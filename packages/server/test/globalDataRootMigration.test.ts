import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migrateServerGlobalDataRoots } from "../src/global-data-root-migration.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("迁移默认 home 根的 setting.json 与自定义 dataBaseDir 的数据，旧目录原样保留", async () => {
  const homeDir = await makeTempDir("zcode-server-home-");
  const dataBaseDir = await makeTempDir("zcode-server-data-");
  await mkdir(join(homeDir, ".zcode", "v2"), { recursive: true });
  await writeFile(join(homeDir, ".zcode", "v2", "setting.json"), '{"locale":"zh-CN"}', "utf8");
  await mkdir(join(dataBaseDir, ".zcode", "v2"), { recursive: true });
  await writeFile(join(dataBaseDir, ".zcode", "v2", "session.json"), "session", "utf8");

  await migrateServerGlobalDataRoots({ homeDir, dataBaseDir });

  expect(await readFile(join(homeDir, ".chengcode", "v2", "setting.json"), "utf8")).toBe(
    '{"locale":"zh-CN"}',
  );
  expect(await readFile(join(dataBaseDir, ".chengcode", "v2", "session.json"), "utf8")).toBe(
    "session",
  );
  // 旧目录只读备份：迁移不删除也不修改。
  expect(await readFile(join(homeDir, ".zcode", "v2", "setting.json"), "utf8")).toBe(
    '{"locale":"zh-CN"}',
  );
  expect(await readFile(join(dataBaseDir, ".zcode", "v2", "session.json"), "utf8")).toBe(
    "session",
  );
});

it("home 根等于 dataBaseDir 时只迁移一次", async () => {
  const homeDir = await makeTempDir("zcode-server-same-root-");
  const migrate = vi.fn(async () => ({ status: "fresh" as const, targetDir: homeDir }));

  await migrateServerGlobalDataRoots({
    homeDir,
    dataBaseDir: `${homeDir}/`,
    migrate,
  });

  expect(migrate).toHaveBeenCalledOnce();
  expect(migrate).toHaveBeenCalledWith({ baseDir: homeDir });
});

it("任一数据根复制失败都原样上抛，不继续迁移下一个根", async () => {
  const homeDir = await makeTempDir("zcode-server-fail-home-");
  const dataBaseDir = await makeTempDir("zcode-server-fail-data-");
  const failure = new Error("legacy copy failed");
  const migrate = vi.fn(async () => {
    throw failure;
  });

  await expect(
    migrateServerGlobalDataRoots({ homeDir, dataBaseDir, migrate }),
  ).rejects.toBe(failure);
  expect(migrate).toHaveBeenCalledOnce();
  expect(migrate).toHaveBeenCalledWith({ baseDir: homeDir });
});
