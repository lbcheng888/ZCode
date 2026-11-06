import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { HostError } from "../src/errors.js";
import { assertExpectedPins, buildSessionEnv, probeRuntime } from "../src/runtime.js";
import { parseHostArgs } from "../src/main.js";
import { fakePin, tempDir } from "./helpers.js";

function makeRepo(): string {
  const dir = tempDir("cheng-repo-");
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
  mkdirSync(join(dir, "tools"));
  mkdirSync(join(dir, "artifacts", "bootstrap"), { recursive: true });
  const runner = join(dir, "tools", "csg_spec_v2_cli_run");
  writeFileSync(runner, "#!/bin/sh\nexit 41\n");
  chmodSync(runner, 0o755);
  const driver = join(dir, "artifacts", "bootstrap", "cheng.stage3.bak.bd9a95ce");
  writeFileSync(driver, "#!/bin/sh\nexit 0\n");
  chmodSync(driver, 0o755);
  return dir;
}

describe("runtime probe", () => {
  it("fails closed when ZCODE_CHENG_ROOT is missing", () => {
    expect(() => probeRuntime({})).toThrow(HostError);
    try {
      probeRuntime({});
    } catch (error) {
      expect(error).toMatchObject({ code: "host.runtimeUnavailable" });
    }
  });

  it("refuses non-git directories", () => {
    const dir = tempDir("plain-");
    try {
      probeRuntime({ ZCODE_CHENG_ROOT: dir });
    } catch (error) {
      expect(error).toMatchObject({ code: "host.runtimeUnavailable" });
    }
  });

  it("accepts a pinned checkout and records the pins", () => {
    const repo = makeRepo();
    const pin = probeRuntime({ ZCODE_CHENG_ROOT: repo });
    expect(pin.chengRoot).toBe(repo);
    expect(pin.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.runnerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.driverSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a missing runner or driver", () => {
    const repo = makeRepo();
    const runner = join(repo, "tools", "csg_spec_v2_cli_run");
    chmodSync(runner, 0o644);
    try {
      probeRuntime({ ZCODE_CHENG_ROOT: repo });
    } catch (error) {
      expect(error).toMatchObject({ code: "host.runtimeUnavailable" });
    }
  });

  it("refuses non-POSIX platforms", () => {
    try {
      probeRuntime({ ZCODE_CHENG_ROOT: "/tmp" }, { platform: "win32" });
    } catch (error) {
      expect(error).toMatchObject({ code: "host.platformUnsupported" });
    }
  });
});

describe("runtime pins", () => {
  it("refuses a mismatched expected head, runner or driver sha", () => {
    const pin = fakePin();
    expect(() => assertExpectedPins(pin, { headSha: pin.headSha })).not.toThrow();
    for (const expected of [
      { headSha: "f".repeat(40) },
      { runnerSha256: "f".repeat(64) },
      { driverSha256: "f".repeat(64) },
    ]) {
      try {
        assertExpectedPins(pin, expected);
      } catch (error) {
        expect(error).toMatchObject({ code: "host.runtimeUnavailable" });
      }
    }
  });

  it("parses expected pin flags and rejects malformed ones", () => {
    const args = parseHostArgs([
      "--scope=stdio",
      "--workspace-root=/tmp/ws",
      `--expect-head-sha=${"a".repeat(40)}`,
      `--expect-runner-sha=${"b".repeat(64)}`,
    ]);
    expect(args.expectedPins).toEqual({
      headSha: "a".repeat(40),
      runnerSha256: "b".repeat(64),
    });
    expect(() =>
      parseHostArgs(["--scope=stdio", "--workspace-root=/tmp/ws", "--expect-head-sha=short"]),
    ).toThrow(HostError);
  });
});

describe("session env", () => {
  it("forwards only allowlisted keys and no credentials", () => {
    const env = buildSessionEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/home/test",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      ZCODE_TOKEN: "secret",
      NODE_OPTIONS: "--inspect",
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.PYTHONUNBUFFERED).toBe("1");
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/TOKEN|SECRET|API_KEY|ANTHROPIC|OPENAI|ZCODE_/);
    }
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});
