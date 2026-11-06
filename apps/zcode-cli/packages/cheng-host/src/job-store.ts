import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  EventFrameSchema,
  JobFailureSchema,
  JobIdSchema,
  JobStateSchema,
  NonNegativeIntSchema,
  type EventFrame,
  type JobFailure,
} from "./protocol.js";
import { HostError } from "./errors.js";

export const JobRecordSchema = z
  .object({
    version: z.literal(1),
    jobId: JobIdSchema,
    baseKey: z.string().min(1),
    attempt: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/).nullable(),
    state: JobStateSchema,
    phase: z.string().min(1),
    seq: NonNegativeIntSchema,
    createdAt: z.string().min(1),
    startedAt: z.string().min(1).nullable(),
    finishedAt: z.string().min(1).nullable(),
    specPath: z.string().min(1),
    specsDir: z.string().min(1),
    task: z.string().min(1),
    mode: z.literal("diagnostic"),
    budget: z.number().int().positive().max(900_000),
    cancelRequested: z.boolean(),
    pid: z.number().int().positive().nullable(),
    pgid: z.number().int().positive().nullable(),
    procStart: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
    runDir: z.string().min(1).nullable(),
    exitCode: z.number().int().nullable(),
    failure: JobFailureSchema.nullable(),
  })
  .strict();

export type JobRecord = z.infer<typeof JobRecordSchema>;
export type JobFailureValue = JobFailure;

const JOB_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Filesystem job journal. One directory per job; `job.json` is the authority. */
export class JobStore {
  readonly jobsDir: string;

  constructor(readonly root: string) {
    this.jobsDir = join(root, "jobs");
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
  }

  jobDir(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new HostError("host.invalidParams", `invalid job id: ${jobId}`);
    }
    return join(this.jobsDir, jobId);
  }

  eventLogPath(jobId: string): string {
    return join(this.jobDir(jobId), "events.jsonl");
  }

  has(jobId: string): boolean {
    return existsSync(join(this.jobDir(jobId), "job.json"));
  }

  create(record: JobRecord): JobRecord {
    const parsed = JobRecordSchema.parse(record);
    const dir = this.jobDir(record.jobId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.write(parsed);
    writeFileSync(this.eventLogPath(record.jobId), "", { flag: "a" });
    return parsed;
  }

  read(jobId: string): JobRecord {
    const path = join(this.jobDir(jobId), "job.json");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        throw new HostError("host.jobNotFound", `no such job: ${jobId}`);
      }
      throw new HostError("host.internal", `cannot read job journal: ${path}`, {
        evidence: [error instanceof Error ? error.message : String(error)],
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new HostError("host.internal", `job journal is not JSON: ${path}`, {
        evidence: [error instanceof Error ? error.message : String(error)],
      });
    }
    const parsed = JobRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HostError("host.internal", `job journal failed schema validation: ${path}`, {
        evidence: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
    return parsed.data;
  }

  write(record: JobRecord): void {
    const parsed = JobRecordSchema.parse(record);
    const dir = this.jobDir(record.jobId);
    const path = join(dir, "job.json");
    const tmp = `${path}.tmp-${String(process.pid)}`;
    writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  appendEvent(jobId: string, event: EventFrame): void {
    const parsed = EventFrameSchema.parse(event);
    appendFileSync(this.eventLogPath(jobId), `${JSON.stringify(parsed)}\n`);
  }

  readEvents(jobId: string): EventFrame[] {
    const path = this.eventLogPath(jobId);
    if (!existsSync(path)) {
      return [];
    }
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed = EventFrameSchema.safeParse(JSON.parse(line) as unknown);
        if (!parsed.success) {
          throw new HostError("host.internal", "event journal contains an invalid frame", {
            evidence: [line.slice(0, 256)],
          });
        }
        return parsed.data;
      });
  }

  /** All records, newest first. A malformed record fails the whole list. */
  list(): JobRecord[] {
    const records: JobRecord[] = [];
    for (const name of readdirSync(this.jobsDir)) {
      if (!JOB_ID_PATTERN.test(name)) {
        continue;
      }
      if (!existsSync(join(this.jobsDir, name, "job.json"))) {
        continue;
      }
      records.push(this.read(name));
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
