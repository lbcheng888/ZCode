import { describe, expect, it } from "vitest";

import { buildCapabilities } from "../src/capabilities.js";
import {
  CapabilitiesSchema,
  EventFrameSchema,
  HelloFrameSchema,
  JobStatusSchema,
  METHOD_SCHEMAS,
  RequestFrameSchema,
} from "../src/protocol.js";
import { fakePin } from "./helpers.js";

const IMPLEMENTED = [
  "capabilities",
  "generate",
  "graph.query",
  "job.cancel",
  "job.status",
  "settle",
  "spec.validate",
  "verify",
].sort();

describe("protocol", () => {
  it("freezes exactly the P2 surface", () => {
    const caps = buildCapabilities(fakePin());
    expect(CapabilitiesSchema.parse(caps)).toEqual(caps);
    const implemented = Object.entries(caps.ops)
      .filter(([, op]) => op.available)
      .map(([name]) => name)
      .sort();
    expect(implemented).toEqual(IMPLEMENTED);
    expect(caps.ops.parse?.available).toBe(false);
    expect(caps.ops.typecheck?.available).toBe(false);
    expect(caps.ops.plan?.available).toBe(false);
    expect(caps.ops.decide?.available).toBe(false);
    expect(caps.ops["graph.diff"]?.available).toBe(false);
    expect(Object.keys(METHOD_SCHEMAS)).toHaveLength(13);
    expect(caps.ops.verify).toEqual({ available: true, sync: true, cancellable: false });
    expect(caps.ops.generate).toEqual({ available: true, sync: false, cancellable: false });
  });

  it("binds the fingerprint to the runtime pin", () => {
    const one = buildCapabilities(fakePin());
    const two = buildCapabilities(fakePin());
    const other = buildCapabilities(fakePin({ headSha: "f".repeat(40) }));
    expect(one.fingerprint).toBe(two.fingerprint);
    expect(other.fingerprint).not.toBe(one.fingerprint);
    expect(one.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects hello frames that are not exact", () => {
    const hello = {
      v: 1,
      t: "hello",
      id: "hello",
      auth: null,
      workspaceRoot: "/tmp/ws",
      workspaceIdentity: "ws-1",
      contract: 1,
      client: { kind: "cli" },
    };
    expect(HelloFrameSchema.safeParse(hello).success).toBe(true);
    expect(HelloFrameSchema.safeParse({ ...hello, contract: 2 }).success).toBe(false);
    expect(HelloFrameSchema.safeParse({ ...hello, extra: true }).success).toBe(false);
  });

  it("rejects malformed request ids and event params", () => {
    expect(
      RequestFrameSchema.safeParse({ v: 1, t: "req", id: "ok.1", method: "capabilities" }).success,
    ).toBe(true);
    expect(
      RequestFrameSchema.safeParse({ v: 1, t: "req", id: "space id", method: "capabilities" }).success,
    ).toBe(false);
    const event = {
      v: 1,
      t: "evt",
      id: "d".repeat(64),
      method: "job.progress",
      params: {
        jobId: "d".repeat(64),
        seq: 1,
        state: "running",
        phase: "running",
        at: "2026-11-06T00:00:00.000Z",
        elapsedMs: 10,
      },
    };
    expect(EventFrameSchema.safeParse(event).success).toBe(true);
    expect(
      EventFrameSchema.safeParse({ ...event, params: { ...event.params, seq: -1 } }).success,
    ).toBe(false);
    expect(
      EventFrameSchema.safeParse({ ...event, method: "job.done" }).success,
    ).toBe(false);
  });

  it("keeps job status strict", () => {
    const status = {
      jobId: "d".repeat(64),
      baseKey: "e".repeat(64),
      attempt: null,
      state: "succeeded",
      phase: "done",
      seq: 3,
      createdAt: "2026-11-06T00:00:00.000Z",
      startedAt: "2026-11-06T00:00:01.000Z",
      finishedAt: "2026-11-06T00:00:02.000Z",
      cancelRequested: false,
      runId: "m5-1",
      runDir: "/tmp/run",
      exitCode: 41,
      error: null,
    };
    expect(JobStatusSchema.safeParse(status).success).toBe(true);
    expect(JobStatusSchema.safeParse({ ...status, extra: 1 }).success).toBe(false);
  });
});
