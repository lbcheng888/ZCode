import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import {
  assertWorkspaceBuildsFresh,
  assertZodBundleIdentity,
  createZodDedupePlugin,
  findStaleWorkspaceBuilds,
  readRootPackageVersion,
  resolveBuildAliases,
  resolveBuildOptions,
  resolveBuildExternal,
} from "../scripts/build.mjs";

async function withZodFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-zod-bundle-"));
  try {
    for (const [consumer, version] of [
      ["first", "4.6.5"],
      ["second", "4.6.5"],
      ["legacy", "3.25.76"],
    ]) {
      const packageRoot = join(directory, consumer, "node_modules", "zod");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "zod",
          version,
          type: "module",
          exports: {
            ".": { import: "./index.js", require: "./index.cjs" },
            "./v3": "./v3.js",
          },
        }),
      );
      await writeFile(
        join(packageRoot, "index.js"),
        `export const schema = {version: ${JSON.stringify(version)}, format: "esm"};`,
      );
      await writeFile(
        join(packageRoot, "index.cjs"),
        `exports.schema = {version: ${JSON.stringify(version)}, format: "cjs"};`,
      );
      await writeFile(join(packageRoot, "v3.js"), 'export const schema = {format: "compat-v3"};');
      await writeFile(
        join(directory, consumer, "entry.mjs"),
        'export {schema} from "zod"; export {schema as compat} from "zod/v3";',
      );
      await writeFile(join(directory, consumer, "entry.cjs"), 'module.exports = require("zod");');
    }
    const entry = join(directory, "entry.mjs");
    await writeFile(
      entry,
      `
      import {schema as first, compat as firstCompat} from "./first/entry.mjs";
      import {schema as second, compat as secondCompat} from "./second/entry.mjs";
      import {schema as legacy} from "./legacy/entry.mjs";
      import cjsFirst from "./first/entry.cjs";
      import cjsSecond from "./second/entry.cjs";
      export {first, second, legacy, firstCompat, secondCompat, cjsFirst, cjsSecond};
    `,
    );
    const options = {
      absWorkingDir: directory,
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
    };
    await run({ directory, options });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Zod dedupe shares equal versions while preserving majors, subpaths and export conditions", async () => {
  await withZodFixture(async ({ options }) => {
    const result = await build({
      ...options,
      plugins: [createZodDedupePlugin({ expectedV4Version: "4.6.5" })],
    });
    const context = { module: { exports: {} } };
    runInNewContext(result.outputFiles[0].text, context);
    const { first, second, legacy, firstCompat, secondCompat, cjsFirst, cjsSecond } =
      context.module.exports;
    assert.equal(first, second);
    assert.equal(firstCompat, secondCompat);
    assert.equal(firstCompat.format, "compat-v3");
    assert.notEqual(first, firstCompat);
    assert.notEqual(first, legacy);
    assert.equal(legacy.version, "3.25.76");
    assert.equal(cjsFirst.schema, cjsSecond.schema);
    assert.notEqual(first, cjsFirst.schema);
    assert.equal(first.format, "esm");
    assert.equal(cjsFirst.schema.format, "cjs");
  });
});

test("Zod metafile gate rejects duplicate physical packages even when versions match", async () => {
  await withZodFixture(async ({ directory, options }) => {
    const result = await build(options);
    await assert.rejects(
      assertZodBundleIdentity(result.metafile, {
        workingDirectory: directory,
        expectedV4Version: "4.6.5",
      }),
      /Duplicate Zod 4\.6\.5/,
    );
  });
});

test("Zod bundle rejects an unexpected v4 version without rewriting it across versions", async () => {
  await withZodFixture(async ({ options }) => {
    await assert.rejects(
      build({ ...options, plugins: [createZodDedupePlugin({ expectedV4Version: "4.4.3" })] }),
      /Expected Zod v4 4\.4\.3/,
    );
  });
});

test("Zod resolver preserves missing-export failures", async () => {
  await withZodFixture(async ({ directory, options }) => {
    await writeFile(join(directory, "first", "entry.mjs"), 'export * from "zod/not-exported";');
    await assert.rejects(
      build({ ...options, plugins: [createZodDedupePlugin({ expectedV4Version: "4.6.5" })] }),
      /zod\/not-exported/,
    );
  });
});

test("reads CLI build version from the repository root package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-root-version-"));

  try {
    await mkdir(join(directory, "packages", "cli"), {
      recursive: true,
    });
    await writeFile(join(directory, "package.json"), JSON.stringify({ version: "9.8.7" }));
    await writeFile(
      join(directory, "packages", "cli", "package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );

    assert.equal(
      await readRootPackageVersion({
        root: directory,
      }),
      "9.8.7",
    );
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("rejects missing root package versions during CLI builds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-root-version-"));

  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "zcode-cli" }));

    await assert.rejects(
      readRootPackageVersion({
        root: directory,
      }),
      /Root package\.json must define a non-empty string version/,
    );
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("desktop agent builds minify the app-facing JS bundle", () => {
  assert.deepEqual(resolveBuildOptions([]), {
    minify: false,
    sourcemap: true,
  });
  assert.deepEqual(resolveBuildOptions(["--desktop-agent"]), {
    minify: true,
    sourcemap: false,
  });
  assert.deepEqual(resolveBuildOptions(["--desktop-agent"], { ZCODE_E2E_COVERAGE: "1" }), {
    minify: false,
    sourcemap: true,
  });
});

test("CLI bundle externalizes native koffi so esbuild does not parse platform .node files", () => {
  assert.ok(resolveBuildExternal().includes("koffi"));
});

test("every shared package export has an exact build alias, including SQLite migrations", async () => {
  const shared = JSON.parse(
    await readFile(new URL("../../../../../packages/shared/package.json", import.meta.url), "utf8"),
  );
  const rootDirectory = resolve("/repo/apps/zcode-cli");
  const aliases = resolveBuildAliases({ rootDirectory });
  for (const [subpath, target] of Object.entries(shared.exports)) {
    const name = subpath === "." ? "@zcode/shared" : `@zcode/shared/${subpath.slice(2)}`;
    assert.equal(aliases[name], resolve(rootDirectory, "../../packages/shared", target));
    if (subpath !== ".")
      assert.ok(Object.keys(aliases).indexOf(name) < Object.keys(aliases).indexOf("@zcode/shared"));
  }
});

test("CLI bundles session migrations through the shared sqlite subpath", async () => {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../../adapters/src/storage/session-store/migration-runner.ts", import.meta.url),
      ),
    ],
    alias: resolveBuildAliases(),
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    metafile: true,
    logLevel: "silent",
  });

  assert.equal(
    Object.keys(result.metafile.inputs).filter((path) =>
      path.endsWith("/shared/src/sqlite-migrations/index.ts"),
    ).length,
    1,
  );
  assert.ok(
    Object.values(result.metafile.outputs).every((output) =>
      output.imports.every((entry) => entry.path !== "@zcode/shared/sqlite-migrations"),
    ),
  );
});

test("built CLI embeds the compact registry without a runtime Fig dependency", async (t) => {
  let bundle;
  try {
    bundle = await readFile(new URL("../dist/zcode.cjs", import.meta.url), "utf8");
  } catch {
    t.skip("build the CLI before running the bundle content gate");
    return;
  }

  assert.match(bundle, /"@commercelayer\/cli"\s*:/);
  assert.match(bundle, /(?:"git"|git)\s*:\s*\[\["git"\]/);
  assert.doesNotMatch(bundle, /node_modules\/@withfig\/autocomplete/);
  assert.doesNotMatch(bundle, /@withfig\/autocomplete\/build/);
});

test("request security subpath bundles through its edition entry", async () => {
  const result = await build({
    stdin: {
      contents: 'import * as security from "@zcode/shared/request-security"; export { security };',
      resolveDir: resolve(import.meta.dirname, ".."),
    },
    alias: resolveBuildAliases(),
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(result.metafile.inputs).some((path) =>
      path.endsWith("shared/src/request-security-edition/index.ts"),
    ),
  );
});

// goal-arm-bridge 缺陷回归：CLI bundle 经兄弟包 exports 消费其预构建 dist，只进
// packages/cli 跑 build 不会替它们重编译——桥改了 src、dist 还是旧版时，验收二进制
// 里就没有桥。守卫必须在打包前拒绝“src 比 dist 新”的依赖。
const BRIDGE_SOURCE_MS = new Date("2026-10-25T09:32:50.000Z");
const STALE_OUTPUT_MS = new Date("2026-10-25T08:48:59.000Z");
const FRESH_OUTPUT_MS = new Date("2026-10-25T12:47:00.000Z");

async function writeFreshnessFixture({ coreOutputMs, withCoreDist = true }) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-freshness-"));
  const cliDirectory = join(directory, "apps", "zcode-cli", "packages", "cli");
  const rootDirectory = join(directory, "apps", "zcode-cli");
  await mkdir(cliDirectory, { recursive: true });
  await writeFile(
    join(cliDirectory, "package.json"),
    JSON.stringify({
      dependencies: {
        "@zcode/assets": "workspace:*",
        "@zcode/core": "workspace:*",
        "@zcode/tui": "workspace:*",
      },
    }),
  );

  const coreRoot = join(rootDirectory, "packages", "core");
  await mkdir(join(coreRoot, "src"), { recursive: true });
  await writeFile(join(coreRoot, "package.json"), JSON.stringify({ name: "@zcode/core" }));
  const coreSource = join(coreRoot, "src", "runtime.ts");
  await writeFile(coreSource, "export {};");
  await utimes(coreSource, BRIDGE_SOURCE_MS, BRIDGE_SOURCE_MS);
  if (withCoreDist) {
    await mkdir(join(coreRoot, "dist"), { recursive: true });
    const coreOutput = join(coreRoot, "dist", "index.js");
    await writeFile(coreOutput, "export {};");
    await utimes(coreOutput, coreOutputMs, coreOutputMs);
  }

  // external 包（@zcode/tui）与无 src 的纯资产包不参与新鲜度比较。
  const tuiRoot = join(rootDirectory, "packages", "tui");
  await mkdir(join(tuiRoot, "src"), { recursive: true });
  await writeFile(join(tuiRoot, "package.json"), JSON.stringify({ name: "@zcode/tui" }));
  const tuiSource = join(tuiRoot, "src", "index.ts");
  await writeFile(tuiSource, "export {};");
  await utimes(tuiSource, BRIDGE_SOURCE_MS, BRIDGE_SOURCE_MS);
  const assetsRoot = join(rootDirectory, "packages", "assets");
  await mkdir(assetsRoot, { recursive: true });
  await writeFile(join(assetsRoot, "package.json"), JSON.stringify({ name: "@zcode/assets" }));

  return { directory, cliDirectory, rootDirectory };
}

test("freshness gate reports a sibling whose src is newer than its dist (goal-arm bridge root cause)", async () => {
  const { directory, cliDirectory, rootDirectory } = await writeFreshnessFixture({
    coreOutputMs: STALE_OUTPUT_MS,
  });
  try {
    const stale = await findStaleWorkspaceBuilds({ cliDirectory, rootDirectory });
    assert.deepEqual(
      stale.map((entry) => ({ name: entry.name, reason: entry.reason })),
      [{ name: "@zcode/core", reason: "source-newer" }],
    );
    await assert.rejects(
      assertWorkspaceBuildsFresh({ cliDirectory, rootDirectory }),
      (error) => {
        assert.match(error.message, /@zcode\/core/);
        assert.match(error.message, /pnpm --dir apps\/zcode-cli build/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("freshness gate passes when sibling dist is newer than src, and can be bypassed via env", async () => {
  const { directory, cliDirectory, rootDirectory } = await writeFreshnessFixture({
    coreOutputMs: FRESH_OUTPUT_MS,
  });
  try {
    assert.deepEqual(await findStaleWorkspaceBuilds({ cliDirectory, rootDirectory }), []);
    assert.deepEqual(
      await assertWorkspaceBuildsFresh({ cliDirectory, rootDirectory, env: {} }),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const staleFixture = await writeFreshnessFixture({ coreOutputMs: STALE_OUTPUT_MS });
  try {
    assert.deepEqual(
      await assertWorkspaceBuildsFresh({
        cliDirectory: staleFixture.cliDirectory,
        rootDirectory: staleFixture.rootDirectory,
        env: { ZCODE_SKIP_WORKSPACE_FRESHNESS_CHECK: "1" },
      }),
      [],
    );
  } finally {
    await rm(staleFixture.directory, { recursive: true, force: true });
  }
});

test("freshness gate reports a sibling with src but no dist, including repo-root packages", async () => {
  const { directory, cliDirectory, rootDirectory } = await writeFreshnessFixture({
    coreOutputMs: FRESH_OUTPUT_MS,
    withCoreDist: false,
  });
  try {
    // @zcode/shared lives at the repository root packages/ directory, not under zcode-cli.
    const sharedRoot = join(directory, "packages", "shared");
    await mkdir(join(sharedRoot, "src"), { recursive: true });
    await mkdir(join(sharedRoot, "dist"), { recursive: true });
    await writeFile(join(sharedRoot, "package.json"), JSON.stringify({ name: "@zcode/shared" }));
    const sharedSource = join(sharedRoot, "src", "index.ts");
    await writeFile(sharedSource, "export {};");
    await utimes(sharedSource, BRIDGE_SOURCE_MS, BRIDGE_SOURCE_MS);
    const sharedOutput = join(sharedRoot, "dist", "index.js");
    await writeFile(sharedOutput, "export {};");
    await utimes(sharedOutput, STALE_OUTPUT_MS, STALE_OUTPUT_MS);
    await writeFile(
      join(cliDirectory, "package.json"),
      JSON.stringify({ dependencies: { "@zcode/core": "workspace:*", "@zcode/shared": "workspace:*" } }),
    );

    const stale = await findStaleWorkspaceBuilds({ cliDirectory, rootDirectory });
    assert.deepEqual(
      stale.map((entry) => ({ name: entry.name, reason: entry.reason })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      [
        { name: "@zcode/core", reason: "missing-dist" },
        { name: "@zcode/shared", reason: "source-newer" },
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
