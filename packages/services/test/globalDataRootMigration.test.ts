import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureGlobalDataRootMigrated,
  getGlobalDataRootMigrationBaseDirs,
  GLOBAL_DATA_DIR_NAME,
  GLOBAL_DATA_ROOT_MIGRATION_LOCK_FILE_NAME,
  GLOBAL_DATA_ROOT_MIGRATION_MARKER_FILE_NAME,
  LEGACY_GLOBAL_DATA_DIR_NAME,
  resolveUserHomeDir,
  setDataBaseDir,
} from "../src/paths.js";

const tempBases: string[] = [];

function makeTempBase(): string {
  const base = mkdtempSync(join(tmpdir(), "chengcode-migration-"));
  tempBases.push(base);
  return base;
}

function legacyRoot(base: string): string {
  return join(base, LEGACY_GLOBAL_DATA_DIR_NAME);
}

function targetRoot(base: string): string {
  return join(base, GLOBAL_DATA_DIR_NAME);
}

function lockPath(base: string): string {
  return join(base, GLOBAL_DATA_ROOT_MIGRATION_LOCK_FILE_NAME);
}

function stagingEntries(base: string): string[] {
  return readdirSync(base).filter((name) =>
    name.startsWith(`${GLOBAL_DATA_DIR_NAME}.migrating-`),
  );
}

afterEach(() => {
  while (tempBases.length > 0) {
    const base = tempBases.pop();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

describe("ensureGlobalDataRootMigrated", () => {
  it("returns fresh without creating either directory when the legacy root is absent", async () => {
    const base = makeTempBase();

    await expect(ensureGlobalDataRootMigrated({ baseDir: base })).resolves.toEqual({
      status: "fresh",
      targetDir: targetRoot(base),
    });

    expect(existsSync(legacyRoot(base))).toBe(false);
    expect(existsSync(targetRoot(base))).toBe(false);
    expect(existsSync(lockPath(base))).toBe(false);
  });

  it("atomically moves the legacy tree into the new root and leaves legacy as a symlink", async () => {
    const base = makeTempBase();
    const legacy = legacyRoot(base);
    mkdirSync(join(legacy, "v2", "nested"), { recursive: true });
    mkdirSync(join(legacy, "cli"), { recursive: true });
    writeFileSync(join(legacy, "v2", "setting.json"), '{"dataBaseDir":"/old"}', "utf8");
    writeFileSync(join(legacy, "v2", "nested", "deep.txt"), "deep", "utf8");
    writeFileSync(join(legacy, "cli", "config.json"), '{"model":"demo"}', "utf8");

    await expect(ensureGlobalDataRootMigrated({ baseDir: base })).resolves.toEqual({
      status: "migrated",
      targetDir: targetRoot(base),
      legacyDir: legacy,
    });

    expect(readFileSync(join(targetRoot(base), "v2", "setting.json"), "utf8")).toBe(
      '{"dataBaseDir":"/old"}',
    );
    expect(readFileSync(join(targetRoot(base), "v2", "nested", "deep.txt"), "utf8")).toBe("deep");
    expect(readFileSync(join(targetRoot(base), "cli", "config.json"), "utf8")).toBe(
      '{"model":"demo"}',
    );
    const marker = JSON.parse(
      readFileSync(join(targetRoot(base), ".migrated-from-zcode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(marker.formatVersion).toBe(1);
    expect(marker.mode).toBe("move-symlink");
    expect(marker.sourceDirName).toBe(LEGACY_GLOBAL_DATA_DIR_NAME);
    expect(marker.targetDirName).toBe(GLOBAL_DATA_DIR_NAME);
    expect(typeof marker.migratedAt).toBe("string");

    // 旧路径保留为指向新根的软链，旧工具/脚本仍能读到同一份数据。
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(legacy, "v2", "setting.json"), "utf8")).toBe(
      '{"dataBaseDir":"/old"}',
    );
    expect(existsSync(join(legacy, "cli", "config.json"))).toBe(true);
    expect(existsSync(lockPath(base))).toBe(false);
    expect(stagingEntries(base)).toEqual([]);
  });

  it("moves the tree unchanged, including transient files, symlinks and the server subtree", async () => {
    const base = makeTempBase();
    const legacy = legacyRoot(base);
    const linkedTarget = join(base, "outside-target");
    mkdirSync(join(legacy, "server", "run"), { recursive: true });
    mkdirSync(linkedTarget, { recursive: true });
    writeFileSync(join(legacy, "server", "install.json"), "{}", "utf8");
    writeFileSync(join(legacy, "keep.json"), "keep", "utf8");
    writeFileSync(join(legacy, "state.lock"), "lock", "utf8");
    writeFileSync(join(legacy, "state.tmp"), "tmp", "utf8");
    const linkType: "dir" | "junction" = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(linkedTarget, join(legacy, "linked-dir"), linkType);

    await ensureGlobalDataRootMigrated({ baseDir: base });

    // rename 保留全部内容（包括 lock/tmp、软链与 server 子树），不做复制过滤。
    expect(readFileSync(join(targetRoot(base), "keep.json"), "utf8")).toBe("keep");
    expect(existsSync(join(targetRoot(base), "state.lock"))).toBe(true);
    expect(existsSync(join(targetRoot(base), "state.tmp"))).toBe(true);
    expect(existsSync(join(targetRoot(base), "server", "install.json"))).toBe(true);
    expect(lstatSync(join(targetRoot(base), "linked-dir")).isSymbolicLink()).toBe(true);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(existsSync(lockPath(base))).toBe(false);
    expect(stagingEntries(base)).toEqual([]);
  });

  it("returns existing and never overwrites when the migrated target root already exists", async () => {
    const base = makeTempBase();
    mkdirSync(join(targetRoot(base), "v2"), { recursive: true });
    writeFileSync(join(targetRoot(base), "v2", "keep.json"), "target", "utf8");
    writeFileSync(
      join(targetRoot(base), GLOBAL_DATA_ROOT_MIGRATION_MARKER_FILE_NAME),
      '{"formatVersion":1}',
      "utf8",
    );
    mkdirSync(legacyRoot(base), { recursive: true });
    writeFileSync(join(legacyRoot(base), "v2-from-legacy.json"), "legacy", "utf8");

    await expect(ensureGlobalDataRootMigrated({ baseDir: base })).resolves.toEqual({
      status: "existing",
      targetDir: targetRoot(base),
    });

    expect(readFileSync(join(targetRoot(base), "v2", "keep.json"), "utf8")).toBe("target");
    expect(existsSync(join(targetRoot(base), "v2-from-legacy.json"))).toBe(false);
    expect(existsSync(lockPath(base))).toBe(false);
  });

  it("fails loud when the target root exists without a migration marker while legacy exists", async () => {
    const base = makeTempBase();
    mkdirSync(join(targetRoot(base), "v2"), { recursive: true });
    writeFileSync(join(targetRoot(base), "v2", "early.json"), "created-before-migration", "utf8");
    mkdirSync(join(legacyRoot(base), "v2", "sessions"), { recursive: true });
    writeFileSync(join(legacyRoot(base), "v2", "sessions", "seed.json"), "legacy", "utf8");

    await expect(ensureGlobalDataRootMigrated({ baseDir: base })).rejects.toThrow(
      /exists without \.migrated-from-zcode\.json while legacy/,
    );

    // 失败时不能删除或覆盖任何一边的数据。
    expect(readFileSync(join(targetRoot(base), "v2", "early.json"), "utf8")).toBe(
      "created-before-migration",
    );
    expect(
      readFileSync(join(legacyRoot(base), "v2", "sessions", "seed.json"), "utf8"),
    ).toBe("legacy");
    expect(existsSync(lockPath(base))).toBe(false);
    expect(stagingEntries(base)).toEqual([]);
  });

  it("returns existing for an app-created target when no legacy root exists", async () => {
    const base = makeTempBase();
    mkdirSync(join(targetRoot(base), "cache"), { recursive: true });
    writeFileSync(join(targetRoot(base), "cache", "seed.bin"), "cache", "utf8");

    await expect(ensureGlobalDataRootMigrated({ baseDir: base })).resolves.toEqual({
      status: "existing",
      targetDir: targetRoot(base),
    });
    expect(existsSync(lockPath(base))).toBe(false);
  });

  it("fails loud without copying when an active lock is present and the target stays missing", async () => {
    const base = makeTempBase();
    mkdirSync(legacyRoot(base), { recursive: true });
    writeFileSync(join(legacyRoot(base), "keep.json"), "legacy", "utf8");
    writeFileSync(lockPath(base), "{}", "utf8");

    await expect(
      ensureGlobalDataRootMigrated({
        baseDir: base,
        lockWaitTimeoutMs: 300,
        lockRetryIntervalMs: 20,
      }),
    ).rejects.toThrow(/timed out waiting for migration lock/);

    expect(existsSync(targetRoot(base))).toBe(false);
    expect(stagingEntries(base)).toEqual([]);
    // 我们没拿到锁，就不能删除别人的锁。
    expect(existsSync(lockPath(base))).toBe(true);
  });

  it("resolves concurrent migrations to exactly one move", async () => {
    const base = makeTempBase();
    mkdirSync(legacyRoot(base), { recursive: true });
    writeFileSync(join(legacyRoot(base), "keep.json"), "legacy", "utf8");

    const results = await Promise.all([
      ensureGlobalDataRootMigrated({ baseDir: base }),
      ensureGlobalDataRootMigrated({ baseDir: base }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["existing", "migrated"]);
    expect(readFileSync(join(targetRoot(base), "keep.json"), "utf8")).toBe("legacy");
    expect(existsSync(lockPath(base))).toBe(false);
    expect(stagingEntries(base)).toEqual([]);
    expect(lstatSync(legacyRoot(base)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(legacyRoot(base), "keep.json"))).toBe(true);
  });

  it("treats a stale lock as recoverable and migrates", async () => {
    const base = makeTempBase();
    mkdirSync(legacyRoot(base), { recursive: true });
    writeFileSync(join(legacyRoot(base), "keep.json"), "legacy", "utf8");
    writeFileSync(lockPath(base), "{}", "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath(base), staleTime, staleTime);

    await expect(
      ensureGlobalDataRootMigrated({ baseDir: base, lockStaleMs: 30_000 }),
    ).resolves.toMatchObject({ status: "migrated" });

    expect(readFileSync(join(targetRoot(base), "keep.json"), "utf8")).toBe("legacy");
    expect(existsSync(lockPath(base))).toBe(false);
  });

  it("supports a custom legacy directory name without touching the default legacy root", async () => {
    const base = makeTempBase();
    mkdirSync(join(legacyRoot(base)), { recursive: true });
    writeFileSync(join(legacyRoot(base), "default-legacy.json"), "keep", "utf8");
    mkdirSync(join(base, ".legacy-custom"), { recursive: true });
    writeFileSync(join(base, ".legacy-custom", "custom.json"), "custom", "utf8");

    await expect(
      ensureGlobalDataRootMigrated({ baseDir: base, legacyDirName: ".legacy-custom" }),
    ).resolves.toMatchObject({ status: "migrated", legacyDir: join(base, ".legacy-custom") });

    expect(existsSync(join(targetRoot(base), "custom.json"))).toBe(true);
    expect(existsSync(join(targetRoot(base), "default-legacy.json"))).toBe(false);
    expect(existsSync(join(legacyRoot(base), "default-legacy.json"))).toBe(true);
  });

  it("rejects a legacyDirName that collides with the target root", async () => {
    const base = makeTempBase();
    mkdirSync(targetRoot(base), { recursive: true });

    await expect(
      ensureGlobalDataRootMigrated({ baseDir: base, legacyDirName: GLOBAL_DATA_DIR_NAME }),
    ).rejects.toThrow(/legacyDirName must not equal/);
  });

  it("returns the home root and the custom dataBaseDir exactly once each", () => {
    const home = makeTempBase();
    const custom = makeTempBase();
    const originalDesktopHome = process.env.ZCODE_DESKTOP_HOME_DIR;
    try {
      process.env.ZCODE_DESKTOP_HOME_DIR = home;
      setDataBaseDir(custom);
      expect(resolveUserHomeDir()).toBe(home);
      expect(getGlobalDataRootMigrationBaseDirs()).toEqual([home, custom]);

      setDataBaseDir(home);
      expect(getGlobalDataRootMigrationBaseDirs()).toEqual([home]);
    } finally {
      setDataBaseDir(null);
      if (originalDesktopHome === undefined) {
        delete process.env.ZCODE_DESKTOP_HOME_DIR;
      } else {
        process.env.ZCODE_DESKTOP_HOME_DIR = originalDesktopHome;
      }
    }
  });
});
