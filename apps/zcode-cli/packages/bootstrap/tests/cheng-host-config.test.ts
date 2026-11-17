import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CHENG_HOST_COMMAND, CHENG_HOST_VIA_CLI_ENV } from "@zcode/contracts";

import { inspectChengToolchainHealth, resolveChengHostPortForApp } from "../src/app/cheng-host-config.js";
import { chengHostSpawnArgs } from "../src/app/workflow-cheng-host-port.js";
import { resolveDataBaseDir } from "../src/app/paths.js";

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function fixtures() {
  const chengRoot = tempDir("cheng-root-");
  const dataBaseDir = tempDir("cheng-data-");
  const hostEntry = join(chengRoot, "main.js");
  writeFileSync(hostEntry, "// host entry fixture\n");
  return { chengRoot, dataBaseDir, hostEntry };
}

describe("Cheng production assembly", () => {
  it("wires a port only when root, host entry and data base dir are all present", async () => {
    const { chengRoot, dataBaseDir, hostEntry } = fixtures();
    const result = resolveChengHostPortForApp({
      dataBaseDir,
      env: {
        ZCODE_CHENG_ROOT: chengRoot,
        ZCODE_CHENG_HOST_ENTRY: hostEntry,
      },
    });
    expect(result.kind).toBe("wired");
    if (result.kind !== "wired") {
      return;
    }
    expect(result.chengRoot).toBe(chengRoot);
    expect(result.hostEntry).toBe(hostEntry);
    expect(typeof result.port.generate).toBe("function");
    expect(typeof result.port.verify).toBe("function");
    expect(typeof result.port.graph).toBe("function");
    // Nothing spawns until the first RPC; close is therefore a no-op here.
    await result.port.close?.();
  });

  it("lets the host option override the environment entry", () => {
    const { chengRoot, dataBaseDir, hostEntry } = fixtures();
    const result = resolveChengHostPortForApp({
      dataBaseDir,
      hostEntry,
      env: {
        ZCODE_CHENG_ROOT: chengRoot,
        ZCODE_CHENG_HOST_ENTRY: join(chengRoot, "missing.js"),
      },
    });
    expect(result.kind).toBe("wired");
  });

  it("skips with a named reason instead of silently degrading", () => {
    const { chengRoot, dataBaseDir, hostEntry } = fixtures();
    const emptyHome = tempDir("empty-home-");
    const cases: Array<[Parameters<typeof resolveChengHostPortForApp>[0], RegExp]> = [
      [{ dataBaseDir, homeDir: emptyHome, env: { ZCODE_CHENG_HOST_ENTRY: hostEntry } }, /ZCODE_CHENG_ROOT \/ CHENGCODE_CHENG_ROOT is unset/],
      [{ dataBaseDir, env: { ZCODE_CHENG_DISABLE: "1", ZCODE_CHENG_ROOT: chengRoot, ZCODE_CHENG_HOST_ENTRY: hostEntry } }, /ZCODE_CHENG_DISABLE=1/],
      [
        { dataBaseDir, env: { ZCODE_CHENG_ROOT: join(chengRoot, "nope"), ZCODE_CHENG_HOST_ENTRY: hostEntry } },
        /ZCODE_CHENG_ROOT does not exist/,
      ],
      [{ dataBaseDir, env: { ZCODE_CHENG_ROOT: chengRoot } }, /host entry is unset/],
      [
        {
          dataBaseDir,
          env: { ZCODE_CHENG_ROOT: chengRoot, ZCODE_CHENG_HOST_ENTRY: join(chengRoot, "missing.js") },
        },
        /host entry does not exist/,
      ],
      [{ dataBaseDir: "  ", env: { ZCODE_CHENG_ROOT: chengRoot, ZCODE_CHENG_HOST_ENTRY: hostEntry } }, /data base dir is empty/],
    ];
    for (const [input, reason] of cases) {
      const result = resolveChengHostPortForApp(input);
      expect(result.kind).toBe("skipped");
      if (result.kind === "skipped") {
        expect(result.reason).toMatch(reason);
      }
    }
  });

  it("supports CHENGCODE_CHENG_ROOT and deterministic local auto-discovery", () => {
    const { chengRoot, dataBaseDir, hostEntry } = fixtures();
    const emptyHome = tempDir("empty-home-");

    // 1. CHENGCODE_CHENG_ROOT
    const fromChengCodeEnv = resolveChengHostPortForApp({
      dataBaseDir,
      homeDir: emptyHome,
      hostEntry,
      env: { CHENGCODE_CHENG_ROOT: chengRoot },
    });
    expect(fromChengCodeEnv.kind).toBe("wired");
    expect(fromChengCodeEnv.health.configured).toBe(true);
    expect(fromChengCodeEnv.health.chengRoot).toBe(chengRoot);

    // 2. workspaceRoot with tools/csg_spec_v2_cli_run
    const wsRoot = tempDir("ws-cheng-");
    mkdirSync(join(wsRoot, "tools"), { recursive: true });
    writeFileSync(join(wsRoot, "tools", "csg_spec_v2_cli_run"), "#!/bin/sh\n");
    const fromWorkspace = resolveChengHostPortForApp({
      dataBaseDir,
      workspaceRoot: wsRoot,
      homeDir: emptyHome,
      hostEntry,
      env: {},
    });
    expect(fromWorkspace.kind).toBe("wired");
    if (fromWorkspace.kind === "wired") {
      expect(fromWorkspace.chengRoot).toBe(wsRoot);
      expect(fromWorkspace.health.readyModes).toEqual(["diagnostic"]);
    }

    // 3. fallback to homeDir/cheng-lang when workspaceRoot lacks tools/csg_spec_v2_cli_run
    const fakeHome = tempDir("fake-home-");
    const homeCheng = join(fakeHome, "cheng-lang");
    mkdirSync(join(homeCheng, "tools"), { recursive: true });
    writeFileSync(join(homeCheng, "tools", "csg_spec_v2_cli_run"), "#!/bin/sh\n");
    const fromHome = resolveChengHostPortForApp({
      dataBaseDir,
      workspaceRoot: chengRoot, // lacks tools/csg_spec_v2_cli_run
      homeDir: fakeHome,
      hostEntry,
      env: {},
    });
    expect(fromHome.kind).toBe("wired");
    if (fromHome.kind === "wired") {
      expect(fromHome.chengRoot).toBe(homeCheng);
    }
  });

  it("summarizes toolchain health including production slot sha256 and donorCount", () => {
    const { chengRoot } = fixtures();
    mkdirSync(join(chengRoot, "tools"), { recursive: true });
    mkdirSync(join(chengRoot, "artifacts", "bootstrap"), { recursive: true });
    mkdirSync(join(chengRoot, "artifacts", "csg_donors"), { recursive: true });
    writeFileSync(join(chengRoot, "tools", "csg_spec_v2_cli_run"), "#!/bin/sh\n");
    writeFileSync(join(chengRoot, "artifacts", "bootstrap", "cheng.stage3"), "bin");
    writeFileSync(join(chengRoot, "artifacts", "bootstrap", "cheng.linker"), "bin");
    const sha = "a".repeat(64);
    writeFileSync(
      join(chengRoot, "artifacts", "bootstrap", "cheng.stage3.provenance.txt"),
      `compiler_executable_sha256=${sha}\n`,
    );
    writeFileSync(
      join(chengRoot, "artifacts", "csg_donors", "donors.list"),
      "artifacts/csg_donors/donors/a.o\nartifacts/csg_donors/donors/b.o\n",
    );
    writeFileSync(join(chengRoot, "artifacts", "csg_donors", "donor_provenance.tsv"), "1\tpure\n");

    const health = inspectChengToolchainHealth({ chengRoot });
    expect(health).toEqual({
      configured: true,
      chengRoot,
      readyModes: ["diagnostic", "production"],
      driverSha256: sha,
      donorCount: 2,
    });
  });

  it("resolves the global data root with ZCODE_DATA_BASE_DIR before HOME", () => {
    expect(resolveDataBaseDir({ ZCODE_DATA_BASE_DIR: "/data", HOME: "/home" })).toBe("/data");
    expect(resolveDataBaseDir({ HOME: "/home" })).toBe("/home");
  });

  it("defaults to the CLI self re-exec subcommand when the CLI advertises it", () => {
    const { chengRoot, dataBaseDir } = fixtures();
    const env = { ZCODE_CHENG_ROOT: chengRoot, [CHENG_HOST_VIA_CLI_ENV]: "1" };

    const sea = resolveChengHostPortForApp({
      dataBaseDir,
      env,
      runtime: { isSea: true, execPath: "/bin/chengcode", argv: ["/bin/chengcode"] },
    });
    expect(sea.kind).toBe("wired");
    if (sea.kind === "wired") {
      expect(sea.mode).toBe("cli");
      expect(sea.cliCommand).toEqual([CHENG_HOST_COMMAND]);
      expect(sea.port).toBeDefined();
    }

    const script = join(chengRoot, "zcode.cjs");
    writeFileSync(script, "// cli fixture\n");
    const cjs = resolveChengHostPortForApp({
      dataBaseDir,
      env,
      runtime: { isSea: false, execPath: "/usr/bin/node", argv: ["node", script] },
    });
    expect(cjs.kind).toBe("wired");
    if (cjs.kind === "wired") {
      expect(cjs.mode).toBe("cli");
      expect(cjs.cliCommand).toEqual([script, CHENG_HOST_COMMAND]);
    }
  });

  it("refuses the CLI default when it cannot re-exec (dev tsx / missing script)", () => {
    const { chengRoot, dataBaseDir } = fixtures();
    const env = { ZCODE_CHENG_ROOT: chengRoot, [CHENG_HOST_VIA_CLI_ENV]: "1" };
    const dev = resolveChengHostPortForApp({
      dataBaseDir,
      env,
      runtime: { isSea: false, execPath: "/usr/bin/node", argv: ["node", "/repo/src/main.ts"] },
    });
    expect(dev.kind).toBe("skipped");
    if (dev.kind === "skipped") {
      expect(dev.reason).toMatch(/CLI re-exec is unavailable/);
    }
  });

  it("prefers an explicit entry over the CLI default", () => {
    const { chengRoot, dataBaseDir, hostEntry } = fixtures();
    const result = resolveChengHostPortForApp({
      dataBaseDir,
      hostEntry,
      env: { ZCODE_CHENG_ROOT: chengRoot, [CHENG_HOST_VIA_CLI_ENV]: "1" },
      runtime: { isSea: true },
    });
    expect(result.kind).toBe("wired");
    if (result.kind === "wired") {
      expect(result.mode).toBe("file");
      expect(result.hostEntry).toBe(hostEntry);
    }
  });

  it("builds the exact spawn argv for both launch modes", () => {
    const extra = ["--scope=stdio", "--workspace-root=/cheng"];
    expect(
      chengHostSpawnArgs({ hostEntry: "/host/main.js" }, extra).args,
    ).toEqual(["/host/main.js", ...extra]);
    expect(
      chengHostSpawnArgs({ cliCommand: ["/cli/zcode.cjs", CHENG_HOST_COMMAND] }, extra).args,
    ).toEqual(["/cli/zcode.cjs", CHENG_HOST_COMMAND, ...extra]);
    expect(() => chengHostSpawnArgs({}, extra)).toThrow();
  });

  it("is wired into create-app's run-service deps by construction", () => {
    // 整棵 app 的构造依赖很重；这里钉住装配面本身：create-app 必须调用解析器，并把端口放进
    // createDynamicWorkflowRunService 的 deps 块。解析器单测负责行为，这一条负责“真的接上”。
    const source = readFileSync(
      fileURLToPath(new URL("../src/app/create-app.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("resolveChengHostPortForApp(");
    expect(source).toContain("resolveDataBaseDir(options.env)");
    const start = source.indexOf("createDynamicWorkflowRunService({");
    const end = source.indexOf("dynamicWorkflowSnippetPort", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("chengHostPort");

    // 模型工具端口也必须真的接进 AgentRuntime：只读 adapter 与 runtime deps 各出现一次。
    expect(source).toContain("createChengReadPort(");
    const runtimeStart = source.indexOf("runtime = new AgentRuntime(");
    const runtimeEnd = source.indexOf("markRuntimeConstructed", runtimeStart);
    expect(runtimeStart).toBeGreaterThan(-1);
    expect(runtimeEnd).toBeGreaterThan(runtimeStart);
    expect(source.slice(runtimeStart, runtimeEnd)).toContain("chengReadPort");

    // S0 live：观察者写 registry，终态必须经 runtime 的唯一 task-notification 方法。
    expect(source).toContain("createChengJobObserver(");
    expect(source).toContain("enqueueBackgroundTaskNotification({");
  });
});
