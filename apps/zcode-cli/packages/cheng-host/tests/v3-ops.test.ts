import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HostError } from "../src/errors.js";
import { JobEngine } from "../src/job-engine.js";
import { JobStore } from "../src/job-store.js";
import { prepareSpecBundle } from "../src/bundle-builder.js";
import { projectVerify } from "../src/projections.js";
import { buildRunnerArgs } from "../src/runner.js";
import { probeRuntime } from "../src/runtime.js";
import { createHostCore } from "../src/server.js";
import { fakePin, fakeRunner, jobRecord, sha256, tempDir } from "./helpers.js";

const REAL_PROD_RUN =
  "/Users/mac/cheng-lang/.c0run/four_layer_r2/csg_prod/prod_run/runs/m5-20261117T151901Z-40072";
const REAL_P02_SPEC = "/Users/mac/cheng-lang/data/spec_v2/tasks/p02_min2.spec.json";

function initGitDir(): string {
  const dir = tempDir("cheng-v3-repo-");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=test",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "init",
  ]);
  mkdirSync(join(dir, "tools"), { recursive: true });
  const runner = join(dir, "tools", "csg_spec_v2_cli_run");
  writeFileSync(runner, "#!/bin/sh\nexit 0\n");
  chmodSync(runner, 0o755);
  return dir;
}

function installFakeProductionSlot(dir: string, overrides: { coldExec?: string; badDonorSha?: boolean } = {}) {
  mkdirSync(join(dir, "artifacts", "bootstrap"), { recursive: true });
  mkdirSync(join(dir, "artifacts", "csg_donors", "donors"), { recursive: true });

  const driverPath = join(dir, "artifacts", "bootstrap", "cheng.stage3");
  writeFileSync(driverPath, "#!/bin/sh\nexit 0\n");
  chmodSync(driverPath, 0o755);
  const driverSha = sha256("#!/bin/sh\nexit 0\n");

  const linkerPath = join(dir, "artifacts", "bootstrap", "cheng.linker");
  writeFileSync(linkerPath, "#!/bin/sh\nexit 0\n");
  chmodSync(linkerPath, 0o755);

  writeFileSync(
    join(dir, "artifacts", "bootstrap", "cheng.stage3.provenance.txt"),
    `compiler_executable_sha256=${driverSha}\ncold_system_link_exec=${overrides.coldExec ?? "0"}\n`,
  );

  const donorContent = "fake-donor-obj";
  const donorObjPath = join(dir, "artifacts", "csg_donors", "donors", "d1.o");
  writeFileSync(donorObjPath, donorContent);
  const donorSha = overrides.badDonorSha ? "f".repeat(64) : sha256(donorContent);

  writeFileSync(
    join(dir, "artifacts", "csg_donors", "donors.list"),
    "artifacts/csg_donors/donors/d1.o\n",
  );
  writeFileSync(
    join(dir, "artifacts", "csg_donors", "donor_provenance.tsv"),
    `index\tkind\tobject_sha256\tsource\tsource_sha256\tcompiler_sha256\n1\tpure_cheng_donor\t${donorSha}\td1.cheng\t${"a".repeat(64)}\t${driverSha}\n`,
  );
}

describe("v3 cheng-host features", () => {
  it("probes production-only slot cleanly and rejects tampered donor/provenance", () => {
    const repo = initGitDir();
    installFakeProductionSlot(repo);
    const pin = probeRuntime({ ZCODE_CHENG_ROOT: repo });
    expect(pin.readyModes).toEqual(["production"]);
    expect(pin.productionSlot?.donorCount).toBe(1);
    expect(pin.diagnosticSlot).toBeNull();

    const badRepo = initGitDir();
    installFakeProductionSlot(badRepo, { badDonorSha: true });
    expect(() => probeRuntime({ ZCODE_CHENG_ROOT: badRepo })).toThrow(HostError);

    const coldRepo = initGitDir();
    installFakeProductionSlot(coldRepo, { coldExec: "1" });
    expect(() => probeRuntime({ ZCODE_CHENG_ROOT: coldRepo })).toThrow(HostError);
  });

  it("builds production runner args with driver, donors, bundle-root, moves, and liblearn", () => {
    const repo = initGitDir();
    installFakeProductionSlot(repo);
    mkdirSync(join(repo, ".c0run", "four_layer_r2", "sleep_prior"), { recursive: true });
    const seedPath = join(repo, ".c0run", "four_layer_r2", "sleep_prior", "m5_prior.seed");
    writeFileSync(seedPath, "seed-v1\n");

    const pin = probeRuntime({ ZCODE_CHENG_ROOT: repo });
    const args = buildRunnerArgs({
      pin,
      outDir: "/tmp/out",
      specsDir: "/tmp/bundle/tasks",
      bundleDir: "/tmp/bundle",
      task: "clamp_i32",
      mode: "production",
      budget: 5000,
      allowDraftUnowned: true,
      moves: "macro",
      useLiblearn: true,
    });
    expect(args).toContain(`--core0-driver:${pin.productionSlot!.driverPath}`);
    expect(args).toContain(`--core0-driver-sha:${pin.productionSlot!.driverSha256}`);
    expect(args).toContain(`--link-donor:${pin.productionSlot!.donorPaths[0]}`);
    expect(args).toContain(`--link-donor-provenance:${pin.productionSlot!.donorProvenancePath}`);
    expect(args).toContain("--bundle-root:/tmp/bundle");
    expect(args).toContain("--allow-draft-unowned");
    expect(args).toContain("--moves:macro");
    expect(args).toContain(`--liblearn:${seedPath}`);
    expect(args).not.toContain("--diagnostic");
  });

  it("prepares content-addressed bundles with O(1) cache hit and rejects invalid drafts before disk writes", async () => {
    const artifactRoot = tempDir("artifact-");
    const validDraft = {
      task: "clamp_i32",
      domain: "pure_scalar",
      modules: [
        {
          id: "clamp_i32",
          role: "entry" as const,
          interface: {
            fn: "clamp_i32",
            params: [
              { name: "x", type: "int32" },
              { name: "lo", type: "int32" },
              { name: "hi", type: "int32" },
            ],
            returnType: "int32",
          },
        },
      ],
      links: [],
      settleCases: [
        { args: [5, 0, 10], expected: 5 },
        { args: [-1, 0, 10], expected: 0 },
      ],
    };

    const first = prepareSpecBundle({ artifactRoot, draft: validDraft });
    expect(first.cached).toBe(false);
    expect(existsSync(first.specPath)).toBe(true);
    expect(existsSync(join(first.bundleDir, "index.json"))).toBe(true);

    const second = prepareSpecBundle({ artifactRoot, draft: validDraft });
    expect(second.cached).toBe(true);
    expect(second.bundleSha256).toBe(first.bundleSha256);

    // Negative drafts: zero disk pollution in a fresh artifactRoot
    const cleanRoot = tempDir("clean-artifact-");
    expect(() =>
      prepareSpecBundle({
        artifactRoot: cleanRoot,
        draft: { ...validDraft, task: "bad-hyphen" },
      }),
    ).toThrow(HostError);
    expect(() =>
      prepareSpecBundle({
        artifactRoot: cleanRoot,
        draft: {
          ...validDraft,
          modules: [
            {
              ...validDraft.modules[0]!,
              interface: { fn: "f", params: [{ name: "s", type: "str" }], returnType: "str" },
            },
          ],
        },
      }),
    ).toThrow(HostError);
    expect(() =>
      prepareSpecBundle({
        artifactRoot: cleanRoot,
        draft: {
          ...validDraft,
          modules: [
            validDraft.modules[0]!,
            {
              id: "helper",
              role: "helper",
              interface: { fn: "h", params: [{ name: "x", type: "int32" }], returnType: "int32" },
            },
          ],
          links: [
            { from: "clamp_i32", to: "helper", type: "composes" },
            { from: "helper", to: "clamp_i32", type: "composes" },
          ],
        },
      }),
    ).toThrow(/cyclic composes/u);
    expect(readdirSync(cleanRoot)).toEqual([]);

    // Verify server.ts automatically permits <artifactRoot>/bundles in specRoots
    const store = new JobStore(artifactRoot);
    const engine = new JobEngine({
      pin: fakePin(),
      store,
      env: { PATH: "/usr/bin:/bin" },
      spawnRunner: () => fakeRunner().handle,
    });
    const core = createHostCore({
      pin: fakePin(),
      engine,
      workspaceRoot: tempDir("ws-"),
      specRoots: [tempDir("other-root-")],
      artifactRoot,
    });
    const prepared = (await core.dispatch("bundle.prepare", { draft: validDraft }, () => {})) as {
      bundleDir: string;
      specPath: string;
    };
    const started = (await core.dispatch(
      "generate",
      {
        specPath: prepared.specPath,
        bundleDir: prepared.bundleDir,
        task: "clamp_i32",
        mode: "diagnostic",
        budget: 1000,
        allowDraftUnowned: true,
      },
      () => {},
    )) as { jobId: string; state: string; mode: string };
    expect(started.state).toBe("running");
    expect(started.mode).toBe("diagnostic");
    await engine.close();
  });

  it("rejects closure roots in leaf.probe when allowClosureProbe is false", async () => {
    const repo = initGitDir();
    installFakeProductionSlot(repo);
    mkdirSync(join(repo, "kernel", "driver"), { recursive: true });
    const closureFile = join(repo, "kernel", "driver", "selfhost_main.cheng");
    writeFileSync(closureFile, "fn main(): int32 =\n  return 0\n");

    const pin = probeRuntime({ ZCODE_CHENG_ROOT: repo });
    const store = new JobStore(tempDir("store-"));
    const engine = new JobEngine({ pin, store, env: { PATH: "/usr/bin:/bin" } });
    const core = createHostCore({
      pin,
      engine,
      workspaceRoot: repo,
      specRoots: [repo],
    });
    await expect(
      core.dispatch("leaf.probe", { filePath: closureFile }, () => {}),
    ).rejects.toMatchObject({ code: "host.invalidParams" });
    await engine.close();
  });

  it.skipIf(!existsSync(REAL_PROD_RUN))(
    "projects real Stage 3 zero-C production run m5-20261117T151901Z-40072 as PRODUCTION",
    () => {
      const record = jobRecord({
        state: "succeeded",
        phase: "done",
        mode: "production",
        runDir: REAL_PROD_RUN,
        specPath: REAL_P02_SPEC,
        task: "p02_min2",
        exitCode: 0,
      });
      const result = projectVerify(record, { chengRoot: "/Users/mac/cheng-lang" });
      expect(result.runtimeManifest?.checks.manifestComplete).toBe(true);
      expect(result.zeroC?.checks.zeroCProductionOk).toBe(true);
      expect(result.gate).toEqual({ ok: true, level: "PRODUCTION", reasons: [] });
    },
  );
});
