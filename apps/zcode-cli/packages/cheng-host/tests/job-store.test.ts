import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HostError } from "../src/errors.js";
import { JobStore } from "../src/job-store.js";
import { EventFrameSchema } from "../src/protocol.js";
import { tempDir, jobRecord } from "./helpers.js";

function event(jobId: string, seq: number) {
  return EventFrameSchema.parse({
    v: 1,
    t: "evt",
    id: jobId,
    method: "job.progress",
    params: {
      jobId,
      seq,
      state: "running",
      phase: "running",
      at: "2026-11-06T00:00:00.000Z",
      elapsedMs: 10,
    },
  });
}

describe("job store", () => {
  it("round-trips the journal and events", () => {
    const store = new JobStore(tempDir("store-"));
    const record = jobRecord();
    store.create(record);
    expect(store.read(record.jobId)).toEqual(record);

    store.write({ ...record, state: "running", phase: "running", startedAt: "2026-11-06T00:00:01.000Z" });
    expect(store.read(record.jobId).state).toBe("running");

    store.appendEvent(record.jobId, event(record.jobId, 1));
    store.appendEvent(record.jobId, event(record.jobId, 2));
    expect(store.readEvents(record.jobId)).toHaveLength(2);
  });

  it("returns jobNotFound for a missing or invalid id", () => {
    const store = new JobStore(tempDir("store-"));
    expect(() => store.read("f".repeat(64))).toThrow(HostError);
    try {
      store.read("f".repeat(64));
    } catch (error) {
      expect(error).toMatchObject({ code: "host.jobNotFound" });
    }
    expect(() => store.read("not-a-job")).toThrow(HostError);
  });

  it("fails closed on a corrupted journal", () => {
    const store = new JobStore(tempDir("store-"));
    const record = jobRecord();
    const dir = store.jobDir(record.jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "job.json"), "{\n");
    try {
      store.read(record.jobId);
    } catch (error) {
      expect(error).toMatchObject({ code: "host.internal" });
    }
  });

  it("lists newest first and skips unknown directories", () => {
    const store = new JobStore(tempDir("store-"));
    const older = jobRecord({ jobId: "1".repeat(64), createdAt: "2026-11-06T00:00:00.000Z" });
    const newer = jobRecord({ jobId: "2".repeat(64), createdAt: "2026-11-06T00:00:10.000Z" });
    store.create(older);
    store.create(newer);
    mkdirSync(join(store.jobsDir, "junk"));
    const list = store.list();
    expect(list.map((record) => record.jobId)).toEqual([newer.jobId, older.jobId]);
  });
});
