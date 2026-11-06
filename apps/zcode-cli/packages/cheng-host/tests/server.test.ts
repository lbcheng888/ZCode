import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { JobEngine } from "../src/job-engine.js";
import { JobStore } from "../src/job-store.js";
import { createHostCore, serveConnection } from "../src/server.js";
import { fakePin, fakeRunner, tempDir } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("../../cheng-contract/tests/fixtures", import.meta.url));
const P02_SPEC = join(FIXTURES, "specs", "p02_min2.spec.json");

function makeCore() {
  const root = tempDir("root-");
  const spec = join(root, "p02_min2.spec.json");
  cpSync(P02_SPEC, spec);
  const store = new JobStore(tempDir("store-"));
  const engine = new JobEngine({
    pin: fakePin(),
    store,
    env: { PATH: "/usr/bin:/bin" },
    spawnRunner: () => fakeRunner().handle,
  });
  const workspaceRoot = tempDir("ws-");
  const core = createHostCore({ pin: fakePin(), engine, workspaceRoot, specRoots: [root] });
  return { core, engine, workspaceRoot, root, spec };
}

const noEmit = () => {};

describe("host core", () => {
  it("advertises unavailable ops and refuses them", async () => {
    const { core, engine } = makeCore();
    await expect(core.dispatch("parse", {}, noEmit)).rejects.toMatchObject({
      code: "host.opUnavailable",
    });
    await engine.close();
  });

  it("rejects spec paths outside the allowlist before any work", async () => {
    const { core, engine } = makeCore();
    const outside = join(tempDir("outside-"), "spec.json");
    cpSync(P02_SPEC, outside);
    await expect(
      core.dispatch("spec.validate", { specPath: outside }, noEmit),
    ).rejects.toMatchObject({ code: "host.specRootNotAllowed" });
    await engine.close();
  });

  it("validates an allowed spec and its task", async () => {
    const { core, engine, spec } = makeCore();
    const ref = (await core.dispatch(
      "spec.validate",
      { specPath: spec, task: "p02_min2" },
      noEmit,
    )) as { kind: string; task: string; specSha256: string };
    expect(ref.kind).toBe("cheng_spec_ref");
    expect(ref.task).toBe("p02_min2");
    expect(ref.specSha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      core.dispatch("spec.validate", { specPath: spec, task: "p16_glue_len" }, noEmit),
    ).rejects.toMatchObject({ code: "host.invalidParams" });
    await engine.close();
  });

  it("rejects invalid generate params and unknown jobs", async () => {
    const { core, engine, spec } = makeCore();
    await expect(
      core.dispatch(
        "generate",
        { specPath: spec, task: "p02_min2", mode: "diagnostic", budget: 0 },
        noEmit,
      ),
    ).rejects.toMatchObject({ code: "host.invalidParams" });
    await expect(
      core.dispatch("settle", { jobId: "f".repeat(64), task: "p02_min2" }, noEmit),
    ).rejects.toMatchObject({ code: "host.jobNotFound" });
    await engine.close();
  });

  it("queues a real generate call and exposes status", async () => {
    const { core, engine, spec } = makeCore();
    const started = (await core.dispatch(
      "generate",
      { specPath: spec, task: "p02_min2", mode: "diagnostic", budget: 30_000 },
      noEmit,
    )) as { jobId: string; state: string };
    expect(started.state).toBe("running");
    const status = (await core.dispatch("job.status", { jobId: started.jobId }, noEmit)) as {
      state: string;
      seq: number;
    };
    expect(status.state).toBe("running");
    expect(status.seq).toBeGreaterThan(0);
    await engine.close();
  });
});

function inputFrom(frames: readonly unknown[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) {
        yield `${JSON.stringify(frame)}\n`;
      }
    },
  };
}

function hello(workspaceRoot: string, auth: string | null = null) {
  return {
    v: 1,
    t: "hello",
    id: "hello",
    auth,
    workspaceRoot,
    workspaceIdentity: "test-workspace",
    contract: 1,
    client: { kind: "cli" },
  };
}

function decode(sends: string[]): Array<Record<string, unknown>> {
  return sends.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("wire connection", () => {
  it("requires capabilities before any other method", async () => {
    const { core, engine, workspaceRoot } = makeCore();
    const sends: string[] = [];
    await serveConnection({
      input: inputFrom([
        hello(workspaceRoot),
        { v: 1, t: "req", id: "r1", method: "parse", params: {} },
        { v: 1, t: "req", id: "r2", method: "capabilities", params: {} },
        { v: 1, t: "req", id: "r3", method: "parse", params: {} },
      ]),
      send: (frame) => sends.push(frame),
      core,
      authToken: null,
      workspaceRoot,
    });
    const frames = decode(sends);
    expect(frames.find((frame) => frame.id === "r1")).toMatchObject({
      ok: false,
      error: { code: "host.capabilitiesRequired" },
    });
    expect(frames.find((frame) => frame.id === "r2")).toMatchObject({ ok: true });
    expect(frames.find((frame) => frame.id === "r3")).toMatchObject({
      ok: false,
      error: { code: "host.opUnavailable" },
    });
    await engine.close();
  });

  it("rejects an unknown method without closing the connection", async () => {
    const { core, engine, workspaceRoot } = makeCore();
    const sends: string[] = [];
    await serveConnection({
      input: inputFrom([
        hello(workspaceRoot),
        { v: 1, t: "req", id: "c1", method: "capabilities", params: {} },
        { v: 1, t: "req", id: "c2", method: "nope", params: {} },
      ]),
      send: (frame) => sends.push(frame),
      core,
      authToken: null,
      workspaceRoot,
    });
    const frames = decode(sends);
    expect(frames.find((frame) => frame.id === "c2")).toMatchObject({
      ok: false,
      error: { code: "host.unsupportedMethod" },
    });
    await engine.close();
  });

  it("fails closed on a wrong workspace or a missing token", async () => {
    const { core, engine, workspaceRoot } = makeCore();
    const other = tempDir("other-ws-");
    await expect(
      serveConnection({
        input: inputFrom([hello(other)]),
        send: () => {},
        core,
        authToken: null,
        workspaceRoot,
      }),
    ).rejects.toMatchObject({ code: "host.authFailed" });

    await expect(
      serveConnection({
        input: inputFrom([hello(workspaceRoot, null)]),
        send: () => {},
        core,
        authToken: "secret-token",
        workspaceRoot,
      }),
    ).rejects.toMatchObject({ code: "host.authFailed" });
    await engine.close();
  });

  it("accepts a matching token", async () => {
    const { core, engine, workspaceRoot } = makeCore();
    const sends: string[] = [];
    await serveConnection({
      input: inputFrom([
        hello(workspaceRoot, "secret-token"),
        { v: 1, t: "req", id: "c1", method: "capabilities", params: {} },
      ]),
      send: (frame) => sends.push(frame),
      core,
      authToken: "secret-token",
      workspaceRoot,
    });
    expect(decode(sends)[0]).toMatchObject({ ok: true });
    await engine.close();
  });
});
