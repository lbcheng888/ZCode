import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { readChengSpecRef } from "@zcode/cheng-contract";

import { buildCapabilities } from "./capabilities.js";
import { HostError, toHostError } from "./errors.js";
import type { Emit, JobEngine } from "./job-engine.js";
import { resolveAllowedPath } from "./paths.js";
import { projectGraph, projectSettle, projectVerify } from "./projections.js";
import {
  GenerateParamsSchema,
  GraphParamsSchema,
  HelloFrameSchema,
  JobParamsSchema,
  METHOD_SCHEMAS,
  RequestFrameSchema,
  SettleParamsSchema,
  SpecValidateParamsSchema,
  isHostMethod,
  type Capabilities,
  type EventFrame,
  type HostMethod,
} from "./protocol.js";
import type { RuntimePin } from "./runtime.js";
import { MAX_EVENT_BYTES, MAX_FRAME_BYTES } from "./version.js";

const TASK_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface HostCore {
  readonly capabilities: Capabilities;
  readonly workspaceRoot: string;
  readonly specRoots: readonly string[];
  dispatch(method: HostMethod, params: unknown, emit: Emit): Promise<unknown>;
}

export interface HostCoreOptions {
  readonly pin: RuntimePin;
  readonly engine: JobEngine;
  readonly workspaceRoot: string;
  readonly specRoots: readonly string[];
}

export function createHostCore(options: HostCoreOptions): HostCore {
  const capabilities = buildCapabilities(options.pin);

  return {
    capabilities,
    workspaceRoot: options.workspaceRoot,
    specRoots: options.specRoots,
    async dispatch(method, params, emit): Promise<unknown> {
      const schema = METHOD_SCHEMAS[method];
      if (!schema.available) {
        throw new HostError("host.opUnavailable", `${method} is not available in this runtime`, {
          evidence: [`op=${method}`, "available=false"],
        });
      }
      const parsedParams = schema.params.safeParse(params ?? {});
      if (!parsedParams.success) {
        throw new HostError("host.invalidParams", `invalid params for ${method}`, {
          evidence: parsedParams.error.issues.map(
            (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
          ),
        });
      }

      switch (method) {
        case "capabilities":
          return capabilities;
        case "spec.validate":
          return validateSpec(SpecValidateParamsSchema.parse(parsedParams.data), options.specRoots);
        case "generate": {
          const input = GenerateParamsSchema.parse(parsedParams.data);
          if (!TASK_PATTERN.test(input.task)) {
            throw new HostError("host.invalidParams", `invalid task name: ${input.task}`);
          }
          const specPath = resolveAllowedPath(input.specPath, options.specRoots, {
            kind: "file",
            code: "host.specRootNotAllowed",
          });
          const specsDir = resolveAllowedPath(dirname(specPath), options.specRoots, {
            kind: "directory",
            code: "host.specRootNotAllowed",
          });
          return options.engine.generate({
            specPath,
            specsDir,
            task: input.task,
            budget: input.budget,
            ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
            emit,
          });
        }
        case "job.status": {
          const input = JobParamsSchema.parse(parsedParams.data);
          return options.engine.status(input.jobId);
        }
        case "job.cancel": {
          const input = JobParamsSchema.parse(parsedParams.data);
          return options.engine.cancel(input.jobId);
        }
        case "verify": {
          const input = JobParamsSchema.parse(parsedParams.data);
          return projectVerify(options.engine.record(input.jobId));
        }
        case "settle": {
          const input = SettleParamsSchema.parse(parsedParams.data);
          return projectSettle(options.engine.record(input.jobId), input.task);
        }
        case "graph.query": {
          const input = GraphParamsSchema.parse(parsedParams.data);
          return projectGraph(options.engine.record(input.jobId), input.task, input.view);
        }
        default:
          throw new HostError("host.opUnavailable", `${method} is not available in this runtime`, {
            evidence: [`op=${method}`, "available=false"],
          });
      }
    },
  };
}

function validateSpec(
  input: { specPath: string; indexPath?: string; task?: string },
  roots: readonly string[],
) {
  const specPath = resolveAllowedPath(input.specPath, roots, {
    kind: "file",
    code: "host.specRootNotAllowed",
  });
  const indexPath =
    input.indexPath === undefined
      ? defaultIndexPath(specPath, roots)
      : resolveAllowedPath(input.indexPath, roots, {
          kind: "file",
          code: "host.specRootNotAllowed",
        });
  const ref = readChengSpecRef(specPath, indexPath ?? undefined);
  if (input.task !== undefined && ref.task !== input.task) {
    throw new HostError("host.invalidParams", `spec task ${ref.task} does not match ${input.task}`, {
      evidence: [`specTask=${ref.task}`, `requested=${input.task}`],
    });
  }
  return ref;
}

/** `data/spec_v2/tasks/<task>.spec.json` -> `data/spec_v2/index.json`. */
function defaultIndexPath(specPath: string, roots: readonly string[]): string | null {
  const candidate = join(dirname(specPath), "..", "index.json");
  if (!existsSync(candidate)) {
    return null;
  }
  return resolveAllowedPath(candidate, roots, {
    kind: "file",
    code: "host.specRootNotAllowed",
  });
}

export interface ServeConnectionOptions {
  readonly input: AsyncIterable<Buffer | string>;
  readonly send: (frame: string) => void;
  readonly core: HostCore;
  /** `null` means stdio/session scope: the parent pipe is the trust boundary. */
  readonly authToken: string | null;
  readonly workspaceRoot: string;
}

/**
 * Serve one wire connection. Envelope failure closes the connection; method
 * failure is a typed response. Outbound results are schema-checked and are
 * never sent truncated.
 */
export async function serveConnection(options: ServeConnectionOptions): Promise<void> {
  let negotiated = false;
  let helloSeen = false;
  const inflight = new Set<Promise<void>>();
  const inflightIds = new Set<string>();

  for await (const line of lines(options.input)) {
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      throw new HostError("host.protocol", "inbound frame exceeds 1 MiB");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new HostError("host.protocol", "inbound frame is not JSON");
    }

    if (!helloSeen) {
      helloSeen = true;
      const hello = HelloFrameSchema.safeParse(raw);
      if (!hello.success) {
        throw new HostError("host.authFailed", "invalid hello frame", {
          evidence: hello.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
      }
      assertHello(hello.data, options);
      continue;
    }

    const frame = RequestFrameSchema.safeParse(raw);
    if (!frame.success) {
      throw new HostError("host.protocol", "invalid request frame", {
        evidence: frame.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
    const task = handleRequest(frame.data, options, () => negotiated, () => {
      negotiated = true;
    }, inflightIds);
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  }

  await Promise.allSettled(inflight);
}

async function handleRequest(
  frame: { id: string; method: string; params?: unknown; deadlineMs?: number },
  options: ServeConnectionOptions,
  isNegotiated: () => boolean,
  markNegotiated: () => void,
  inflightIds: Set<string>,
): Promise<void> {
  if (!isHostMethod(frame.method)) {
    sendError(options, frame.id, new HostError("host.unsupportedMethod", `unknown method: ${frame.method}`));
    return;
  }
  if (frame.method !== "capabilities" && !isNegotiated()) {
    sendError(
      options,
      frame.id,
      new HostError("host.capabilitiesRequired", "call capabilities before any other method"),
    );
    return;
  }
  if (inflightIds.has(frame.id)) {
    sendError(options, frame.id, new HostError("host.duplicateRequestId", `request already in flight: ${frame.id}`));
    return;
  }
  inflightIds.add(frame.id);

  const emit: Emit = (event: EventFrame) => {
    const text = JSON.stringify(event);
    if (Buffer.byteLength(text, "utf8") > MAX_EVENT_BYTES) {
      // Status polling stays authoritative; an oversized event is dropped
      // rather than truncated into an invalid frame.
      return;
    }
    options.send(text);
  };

  try {
    const result = await withDeadline(
      options.core.dispatch(frame.method, frame.params ?? {}, emit),
      frame.deadlineMs,
    );
    const checked = METHOD_SCHEMAS[frame.method].result.safeParse(result);
    if (!checked.success) {
      throw new HostError("host.invalidResult", `result for ${frame.method} failed its schema`, {
        evidence: checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
    options.send(
      JSON.stringify({ v: 1, t: "res", id: frame.id, ok: true, result: checked.data }),
    );
    if (frame.method === "capabilities") {
      markNegotiated();
    }
  } catch (error) {
    sendError(options, frame.id, toHostError(error));
  } finally {
    inflightIds.delete(frame.id);
  }
}

function sendError(options: ServeConnectionOptions, id: string, error: HostError): void {
  options.send(
    JSON.stringify({ v: 1, t: "res", id, ok: false, error: error.toPayload() }),
  );
}

function assertHello(hello: { auth: string | null; workspaceRoot: string }, options: ServeConnectionOptions): void {
  let actualRoot: string;
  try {
    actualRoot = realpathSync(hello.workspaceRoot);
  } catch {
    throw new HostError("host.authFailed", "hello workspace root does not exist");
  }
  if (actualRoot !== options.workspaceRoot) {
    throw new HostError("host.authFailed", "hello workspace root does not match this host", {
      evidence: [`expected=${options.workspaceRoot}`, `actual=${actualRoot}`],
    });
  }
  if (options.authToken === null) {
    if (hello.auth !== null) {
      throw new HostError("host.authFailed", "session-scope connections must not send a token");
    }
    return;
  }
  if (hello.auth === null || !tokenMatches(options.authToken, hello.auth)) {
    throw new HostError("host.authFailed", "invalid host token");
  }
}

function tokenMatches(expected: string, actual: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(actual).digest();
  return timingSafeEqual(a, b);
}

async function* lines(input: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        yield line;
      }
      index = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
      throw new HostError("host.protocol", "inbound frame exceeds 1 MiB without a newline");
    }
  }
  if (buffer.trim().length > 0) {
    yield buffer;
  }
}

async function withDeadline<T>(promise: Promise<T>, deadlineMs: number | undefined): Promise<T> {
  if (deadlineMs === undefined) {
    return promise;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HostError("host.responseTimeout", `request exceeded ${String(deadlineMs)}ms`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
