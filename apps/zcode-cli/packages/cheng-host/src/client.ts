import { spawn, type ChildProcess } from "node:child_process";
import type { z } from "zod";

import { HostError, HostErrorPayloadSchema } from "./errors.js";
import {
  EventFrameSchema,
  METHOD_SCHEMAS,
  ResponseErrFrameSchema,
  ResponseOkFrameSchema,
  type Capabilities,
  type EventFrame,
  type HostMethod,
} from "./protocol.js";
import { CONTRACT_MAJOR, MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./version.js";

type SchemaOf<M extends HostMethod> = (typeof METHOD_SCHEMAS)[M]["result"];
export type MethodResult<M extends HostMethod> = z.infer<SchemaOf<M>>;

export interface StdioClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly workspaceIdentity: string;
  readonly clientKind?: "cli" | "desktop" | "daemon" | "workflow";
  readonly sessionId?: string;
  readonly startupTimeoutMs?: number;
}

interface Pending {
  readonly method: HostMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Minimal fail-closed client for a stdio-scope host. It never retries and
 * never downgrades: a schema mismatch closes the connection.
 */
export class StdioHostClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: EventFrame) => void>();
  private buffer = "";
  private counter = 0;
  private stderrTail = "";
  private closed = false;
  private closeReason: Error | null = null;

  private constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.once("exit", () => {
      this.failAll(new HostError("host.shutdown", "host process exited", {
        evidence: [this.stderrTail.trim() || "no stderr"],
      }));
    });
    child.once("error", (error) => {
      this.failAll(new HostError("host.shutdown", `host process error: ${error.message}`));
    });
  }

  static async connect(options: StdioClientOptions): Promise<StdioHostClient> {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new StdioHostClient(child);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new HostError("host.responseTimeout", "host did not start in time"));
      }, options.startupTimeoutMs ?? 15_000);
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new HostError("host.shutdown", `cannot start host: ${error.message}`));
      });
    });

    client.write({
      v: PROTOCOL_VERSION,
      t: "hello",
      id: "hello",
      auth: null,
      workspaceRoot: options.workspaceRoot,
      workspaceIdentity: options.workspaceIdentity,
      contract: CONTRACT_MAJOR,
      client: {
        kind: options.clientKind ?? "cli",
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      },
    });
    await client.capabilities();
    return client;
  }

  capabilities(): Promise<Capabilities> {
    return this.request("capabilities", {});
  }

  request<M extends HostMethod>(method: M, params: unknown, deadlineMs?: number): Promise<MethodResult<M>> {
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new HostError("host.shutdown", "client is closed"));
    }
    if (!METHOD_SCHEMAS[method].available) {
      return Promise.reject(new HostError("host.opUnavailable", `${method} is not advertised`));
    }
    this.counter += 1;
    const id = `c${String(this.counter)}`;
    const promise = new Promise<MethodResult<M>>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => {
          resolve(value as MethodResult<M>);
        },
        reject,
      });
    });
    this.write({
      v: PROTOCOL_VERSION,
      t: "req",
      id,
      method,
      params,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
    return promise;
  }

  onEvent(listener: (event: EventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 5_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private write(frame: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) {
        this.onLine(line);
      }
      index = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) {
      this.failAll(new HostError("host.protocol", "outbound frame exceeds 1 MiB"));
      this.child.kill("SIGKILL");
    }
  }

  private onLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      this.failAll(new HostError("host.protocol", "host sent non-JSON output"));
      this.child.kill("SIGKILL");
      return;
    }

    const record = raw as { t?: unknown; id?: unknown };
    if (record.t === "res") {
      const ok = ResponseOkFrameSchema.safeParse(raw);
      const err = ResponseErrFrameSchema.safeParse(raw);
      const id = typeof record.id === "string" ? record.id : "";
      const pending = this.pending.get(id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(id);
      if (err.success) {
        const payload = HostErrorPayloadSchema.parse(err.data.error);
        const options =
          payload.evidence === undefined ? {} : { evidence: payload.evidence };
        pending.reject(new HostError(payload.code, payload.message, options));
        return;
      }
      if (!ok.success) {
        pending.reject(new HostError("host.protocol", "host sent an invalid response frame"));
        return;
      }
      const schema = METHOD_SCHEMAS[pending.method].result;
      const result = schema.safeParse(ok.data.result);
      if (!result.success) {
        pending.reject(
          new HostError("host.invalidResult", `result for ${pending.method} failed its schema`, {
            evidence: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          }),
        );
        return;
      }
      pending.resolve(result.data);
      return;
    }

    if (record.t === "evt") {
      const event = EventFrameSchema.safeParse(raw);
      if (!event.success) {
        this.failAll(new HostError("host.protocol", "host sent an invalid event frame"));
        this.child.kill("SIGKILL");
        return;
      }
      for (const listener of this.listeners) {
        listener(event.data);
      }
      return;
    }

    this.failAll(new HostError("host.protocol", "host sent an unknown frame type"));
    this.child.kill("SIGKILL");
  }

  private failAll(error: Error): void {
    if (this.closed && this.pending.size === 0) {
      return;
    }
    this.closed = true;
    this.closeReason = error;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
