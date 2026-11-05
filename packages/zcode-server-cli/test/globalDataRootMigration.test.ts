import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runServerCli } from "../src/cli.js";
import { resolveCanonicalServerLayout } from "../src/runtime/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("serve 在启动 Supervisor 前按 layout.dataBaseDir 迁移全局数据根，失败即终止", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-server-cli-migration-"));
  roots.push(root);
  const serverRoot = join(root, "server");
  const layout = await resolveCanonicalServerLayout(serverRoot);
  const failure = new Error("legacy copy failed");
  const migrate = vi.fn(async () => {
    throw failure;
  });
  let stderr = "";
  const exit = await runServerCli(["serve", "--daemon", "--server-root", serverRoot], {
    stderr: { write: (value: string) => (stderr += value) },
  }, {
    ensureGlobalDataRootMigrated: migrate,
  });
  expect(exit).toBe(1);
  expect(migrate).toHaveBeenCalledWith({ baseDir: layout.dataBaseDir });
  expect(stderr).toContain(failure.message);
});
