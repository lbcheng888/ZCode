import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";

import {
  CONTRACT_MAJOR,
  HostError,
  HostErrorPayloadSchema,
  MAX_FRAME_BYTES,
  METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  ResponseErrFrameSchema,
  ResponseOkFrameSchema,
  EventFrameSchema,
  StdioHostClient,
  artifactRootFor,
  socketPathFor,
  workspaceHash,
  type BundlePrepareResult,
  type Capabilities,
  type ChengPlanResult,
  type ChengSpecDraft,
  type EventFrame,
  type EvolveResult,
  type GraphDiffResult,
  type HostMethod,
  type MethodResult,
} from "@zcode/cheng-host";
import type {
  ChengLeafProbeReceipt,
  ChengSurfaceReport,
} from "@zcode/cheng-contract";
import { WorkflowError } from "@zcode/dynamic-workflow";

import {
  CHENG_DEFAULT_BUDGET,
  type ChengGenerateInput,
  type ChengGraphResult,
  type ChengHostPort,
  type ChengJobResult,
  type ChengJobSnapshot,
  type ChengVerifyResult,
} from "./workflow-cheng-world-read.js";
import type { ChengJobObserver } from "../super-agent/cheng-job-observer.js";

/**
 * 生产 ChengHostPort：
 * - macOS/Linux 前台会话与动态工作流默认复用 per-workspace Unix socket（`--scope=workspace`），
 *   消除每次调用重复拉起 Node 进程与重复 SHA-256 探针开销；
 * - Windows 或显式指定 `scope: "stdio"`（如 Spec Lane 隔离运行）使用 ephemeral stdio 子进程。
 * - 自动从 `capabilities().runtime.readyModes` 解锁 `mode: "production"`（不再硬编码 `"diagnostic"`
 *   或强行覆盖 `"DIAGNOSTIC_NOT_ACCEPTANCE"`）。
 */
export interface ChengHostPortConfig {
  /** cheng-lang checkout，同时作为 host 的 workspace root 与子进程 cwd。 */
  readonly chengRoot: string;
  /** ZCode 数据根；job journal 与 workspace socket 落 `<dataBaseDir>/.chengcode/v2/cheng/...`。 */
  readonly dataBaseDir: string;
  /** 当前会话工作区根（用于计算 deterministic workspaceIdentity）。 */
  readonly workspaceRoot?: string;
  /** 连接作用域：macOS/Linux 默认 `"workspace"`；Windows 或 Spec Lane 传 `"stdio"`。 */
  readonly scope?: "workspace" | "stdio";
  /** `cheng-host` 的入口文件（dist/main.js）；与 {@link cliCommand} 二选一。 */
  readonly hostEntry?: string;
  /**
   * CLI 自 re-exec 前缀（安装产物路径）：`["dist/zcode.cjs", "__zcode-cheng-host"]` 或
   * SEA 下的 `["__zcode-cheng-host"]`；与 {@link hostEntry} 二选一。
   */
  readonly cliCommand?: readonly string[];
  readonly jobTimeoutMs?: number;
  readonly pollMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** S0：job 生命周期观察者；生产装配传 createChengJobObserver(registry/ledger)。 */
  readonly observer?: ChengJobObserver;
}

export function deriveChengWorkspaceIdentity(workspaceRoot: string): string {
  let canonical = workspaceRoot;
  try {
    canonical = realpathSync(workspaceRoot);
  } catch {
    canonical = resolve(workspaceRoot);
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** 构造 spawn 的 command/argv 前缀；纯函数便于在装配测试里断言两种入口。 */
export function chengHostSpawnArgs(
  config: Pick<ChengHostPortConfig, "hostEntry" | "cliCommand">,
  extraArgs: readonly string[],
): { command: string; args: string[] } {
  const prefix = config.hostEntry !== undefined ? [config.hostEntry] : config.cliCommand;
  if (prefix === undefined || prefix.length === 0) {
    throw new WorkflowError(
      "DriverError",
      "Cheng host launch is not configured: pass hostEntry or cliCommand.",
    );
  }
  return { command: process.execPath, args: [...prefix, ...extraArgs] };
}

interface ChengRpcClient {
  capabilities(): Promise<Capabilities>;
  request<M extends HostMethod>(
    method: M,
    params: unknown,
    deadlineMs?: number,
  ): Promise<MethodResult<M>>;
  onEvent(listener: (event: EventFrame) => void): () => void;
  close(): Promise<void>;
}

interface PendingRpc {
  readonly method: HostMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

class SocketHostClient implements ChengRpcClient {
  private readonly socket: Socket;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly listeners = new Set<(event: EventFrame) => void>();
  private buffer = "";
  private counter = 0;
  private closed = false;
  private closeReason: Error | null = null;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.once("close", () => {
      this.failAll(new HostError("host.shutdown", "workspace host socket closed"));
    });
    socket.once("error", (error) => {
      this.failAll(new HostError("host.shutdown", `workspace host socket error: ${error.message}`));
    });
  }

  static async connect(options: {
    socketPath: string;
    authToken: string;
    workspaceRoot: string;
    workspaceIdentity: string;
    startupTimeoutMs?: number;
  }): Promise<SocketHostClient> {
    const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
      const sock = connect(options.socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        rejectSocket(new HostError("host.responseTimeout", "workspace socket connect timeout"));
      }, startupTimeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        resolveSocket(sock);
      });
      sock.once("error", (error) => {
        clearTimeout(timer);
        rejectSocket(new HostError("host.shutdown", `socket connect failed: ${error.message}`));
      });
    });

    const client = new SocketHostClient(socket);
    client.write({
      v: PROTOCOL_VERSION,
      t: "hello",
      id: "hello",
      auth: options.authToken,
      workspaceRoot: options.workspaceRoot,
      workspaceIdentity: options.workspaceIdentity,
      contract: CONTRACT_MAJOR,
      client: { kind: "workflow" },
    });

    let handshakeTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.capabilities(),
        new Promise<never>((_, reject) => {
          handshakeTimer = setTimeout(() => {
            reject(
              new HostError("host.responseTimeout", "workspace host handshake did not complete in time"),
            );
          }, startupTimeoutMs);
        }),
      ]);
    } catch (error) {
      await client.close();
      throw error;
    } finally {
      if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
    }
    return client;
  }

  capabilities(): Promise<Capabilities> {
    return this.request("capabilities", {});
  }

  request<M extends HostMethod>(
    method: M,
    params: unknown,
    deadlineMs?: number,
  ): Promise<MethodResult<M>> {
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new HostError("host.shutdown", "client is closed"));
    }
    if (!METHOD_SCHEMAS[method].available) {
      return Promise.reject(new HostError("host.opUnavailable", `${method} is not advertised`));
    }
    this.counter += 1;
    const id = `s${String(this.counter)}`;
    const promise = new Promise<MethodResult<M>>((resolvePromise, rejectPromise) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolvePromise(value as MethodResult<M>),
        reject: rejectPromise,
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
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }

  private write(frame: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        this.onLine(line);
      }
      index = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) {
      this.failAll(new HostError("host.protocol", "outbound frame exceeds 1 MiB"));
      this.socket.destroy();
    }
  }

  private onLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      this.failAll(new HostError("host.protocol", "host sent non-JSON output"));
      this.socket.destroy();
      return;
    }
    const record = raw as { t?: unknown; id?: unknown };
    if (record.t === "res") {
      const ok = ResponseOkFrameSchema.safeParse(raw);
      const err = ResponseErrFrameSchema.safeParse(raw);
      const id = typeof record.id === "string" ? record.id : "";
      if (id === "hello" && err.success) {
        const payload = HostErrorPayloadSchema.parse(err.data.error);
        this.failAll(
          new HostError(
            payload.code,
            payload.message,
            payload.evidence === undefined ? {} : { evidence: payload.evidence },
          ),
        );
        return;
      }
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      if (err.success) {
        const payload = HostErrorPayloadSchema.parse(err.data.error);
        pending.reject(
          new HostError(
            payload.code,
            payload.message,
            payload.evidence === undefined ? {} : { evidence: payload.evidence },
          ),
        );
        return;
      }
      if (!ok.success) {
        pending.reject(new HostError("host.protocol", "host sent an invalid response frame"));
        return;
      }
      const result = METHOD_SCHEMAS[pending.method].result.safeParse(ok.data.result);
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
        this.socket.destroy();
        return;
      }
      for (const listener of this.listeners) {
        listener(event.data);
      }
      return;
    }
    this.failAll(new HostError("host.protocol", "host sent an unknown frame type"));
    this.socket.destroy();
  }

  private failAll(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    this.closeReason = error;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

async function connectOrSpawnWorkspaceHost(
  config: ChengHostPortConfig,
  workspaceIdentity: string,
  childEnv: NodeJS.ProcessEnv,
): Promise<ChengRpcClient> {
  const realChengRoot = realpathSync(config.chengRoot);
  const hash = workspaceHash(realChengRoot);
  const artifactRoot = artifactRootFor(config.dataBaseDir, hash);
  const socketPath = socketPathFor(artifactRoot, hash);
  const tokenPath = join(artifactRoot, "host.token");

  const tryConnectExisting = async (): Promise<SocketHostClient | null> => {
    if (!existsSync(socketPath) || !existsSync(tokenPath)) return null;
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token.length === 0) return null;
    try {
      return await SocketHostClient.connect({
        socketPath,
        authToken: token,
        workspaceRoot: realChengRoot,
        workspaceIdentity,
      });
    } catch {
      return null;
    }
  };

  const existing = await tryConnectExisting();
  if (existing !== null) return existing;

  const { command, args } = chengHostSpawnArgs(config, [
    "--scope=workspace",
    `--workspace-root=${realChengRoot}`,
    `--data-base-dir=${config.dataBaseDir}`,
  ]);

  await new Promise<void>((resolveReady, rejectReady) => {
    const child = spawn(command, args, {
      cwd: realChengRoot,
      env: childEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuf = "";
    let stderrTail = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectReady(new HostError("host.responseTimeout", "workspace host did not emit ready"));
    }, 15_000);

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      if (err) rejectReady(err);
      else resolveReady();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { event?: string };
          if (parsed.event === "ready") {
            finish();
            return;
          }
        } catch {
          // ignore non-json stdout
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", () => {
      // Another concurrent process may have won host.spawn.lock and emitted ready.
      if (!settled) {
        finish(
          existsSync(socketPath)
            ? undefined
            : new HostError("host.shutdown", `workspace host exited early: ${stderrTail}`),
        );
      }
    });
  });

  const connected = await tryConnectExisting();
  if (connected !== null) return connected;
  if (!existsSync(tokenPath)) {
    throw new HostError(
      "host.authFailed",
      `workspace host token missing at ${tokenPath} (socket ${socketPath} may belong to another dataBaseDir)`,
    );
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  return await SocketHostClient.connect({
    socketPath,
    authToken: token,
    workspaceRoot: realChengRoot,
    workspaceIdentity,
  });
}

export function createChengHostPort(config: ChengHostPortConfig): ChengHostPort {
  let clientPromise: Promise<ChengRpcClient> | null = null;
  let cachedCapabilities: Capabilities | null = null;
  const activeJobs = new Set<string>();
  const lifecycleListeners = new Set<
    (event: { type: "started" | "terminal"; jobId: string }) => void
  >();
  const emitLifecycle = (event: { type: "started" | "terminal"; jobId: string }): void => {
    for (const listener of lifecycleListeners) {
      listener(event);
    }
  };

  const effectiveWorkspaceRoot = config.workspaceRoot ?? config.chengRoot;
  const workspaceIdentity = deriveChengWorkspaceIdentity(effectiveWorkspaceRoot);
  const effectiveScope =
    config.scope ?? (process.platform === "win32" ? "stdio" : "workspace");

  // 桌面 agent 由 Electron Helper 运行（execPath 指向 Helper），而 CLI 启动时会把
  // ELECTRON_RUN_AS_NODE 从 env sanitize 掉。不显式带回，子进程会按完整 Electron
  // 启动而不执行 zcode.cjs；纯 Node 下该变量无效。
  const childEnv: NodeJS.ProcessEnv = {
    ...(config.env ?? process.env),
    ELECTRON_RUN_AS_NODE: "1",
    ZCODE_CHENG_ROOT: config.chengRoot,
  };

  const client = (): Promise<ChengRpcClient> => {
    clientPromise ??= (
      effectiveScope === "workspace"
        ? connectOrSpawnWorkspaceHost(config, workspaceIdentity, childEnv)
        : StdioHostClient.connect({
            ...chengHostSpawnArgs(config, [
              "--scope=stdio",
              `--workspace-root=${config.chengRoot}`,
              `--data-base-dir=${config.dataBaseDir}`,
            ]),
            cwd: config.chengRoot,
            env: childEnv,
            workspaceRoot: config.chengRoot,
            workspaceIdentity,
            clientKind: "workflow",
          })
    ).catch((error: unknown) => {
      clientPromise = null;
      cachedCapabilities = null;
      throw asWorkflowError("connect", error);
    });
    return clientPromise;
  };

  const getCapabilities = async (host: ChengRpcClient): Promise<Capabilities> => {
    cachedCapabilities ??= await request(host, "capabilities", {});
    return cachedCapabilities;
  };

  const cancelJob = async (
    jobId: string,
  ): Promise<"queued" | "running" | "succeeded" | "failed" | "cancelled"> => {
    const host = await client();
    const result = await request(host, "job.cancel", { jobId }, 30_000);
    return result.state;
  };

  return {
    async capabilities(): Promise<Capabilities> {
      const host = await client();
      return await getCapabilities(host);
    },

    async bundlePrepare(draft: ChengSpecDraft): Promise<BundlePrepareResult> {
      const host = await client();
      return await request(host, "bundle.prepare", { draft });
    },

    async checkSurface(filePath: string): Promise<ChengSurfaceReport> {
      const host = await client();
      return await request(host, "surface.check", { filePath }, 15_000);
    },

    async probeLeaf(filePath: string, allowClosureProbe = false): Promise<ChengLeafProbeReceipt> {
      const host = await client();
      return await request(host, "leaf.probe", { filePath, allowClosureProbe }, 180_000);
    },

    async graphDiff(runDirA: string, runDirB: string): Promise<GraphDiffResult> {
      const host = await client();
      return await request(host, "graph.diff", { runDirA, runDirB });
    },

    async evolveCounterexample(
      runDirs: readonly string[] = [],
      dryRun = false,
    ): Promise<EvolveResult> {
      const host = await client();
      return await request(host, "evolve.counterexample", { runDirs: [...runDirs], dryRun }, 180_000);
    },

    async evolveSleep(runDirs: readonly string[] = [], dryRun = false): Promise<EvolveResult> {
      const host = await client();
      return await request(host, "evolve.sleep", { runDirs: [...runDirs], dryRun }, 180_000);
    },

    async inspect(jobId: string): Promise<ChengJobSnapshot> {
      const host = await client();
      const status = await request(host, "job.status", { jobId }, 10_000);
      return {
        jobId: status.jobId,
        state: status.state,
        runId: status.runId,
        runDir: status.runDir,
        exitCode: status.exitCode,
        cancelRequested: status.cancelRequested,
      };
    },

    async generate(
      input: ChengGenerateInput,
      onStarted?: (jobId: string) => void,
    ): Promise<ChengJobResult> {
      const host = await client();
      const caps = await getCapabilities(host);
      const mode: "production" | "diagnostic" =
        input.mode ??
        (caps.runtime.readyModes.includes("production") ? "production" : "diagnostic");
      const started = await request(host, "generate", {
        specPath: input.specPath,
        task: input.task,
        mode,
        budget: input.budget,
        ...(input.moves === undefined ? {} : { moves: input.moves }),
        ...(input.useLiblearn === undefined ? {} : { useLiblearn: input.useLiblearn }),
        ...(input.allowDraftUnowned === undefined
          ? {}
          : { allowDraftUnowned: input.allowDraftUnowned }),
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      });
      // 归属先于观测登记：observer 写库失败时 job 已经被 host 受理，必须先进
      // activeJobs/onStarted，否则异常路径会留下无人跟踪、无人取消的孤儿 job。
      activeJobs.add(started.jobId);
      emitLifecycle({ type: "started", jobId: started.jobId });
      onStarted?.(started.jobId);
      const unsubscribe =
        config.observer === undefined
          ? undefined
          : host.onEvent((event) => {
              if (event.params.jobId !== started.jobId) return;
              if (event.method === "job.progress") {
                config.observer?.progress({ jobId: started.jobId });
              }
            });
      let status: MethodResult<"job.status">;
      try {
        config.observer?.started({
          jobId: started.jobId,
          // S4 内化：task 随生命周期透传，终态 succeeded 时供 goal 自动绑定。
          task: input.task,
        });
        status = await waitTerminal(host, started.jobId, config);
      } catch (error) {
        // observer 失败不能让 host job 继续裸跑；取消失败与原始错误一起上浮。
        try {
          await request(host, "job.cancel", { jobId: started.jobId }, 30_000);
        } catch (cancelError) {
          throw new AggregateError(
            [error, cancelError],
            `Cheng job ${started.jobId} failed its observer and could not be cancelled.`,
          );
        }
        throw error;
      } finally {
        activeJobs.delete(started.jobId);
        emitLifecycle({ type: "terminal", jobId: started.jobId });
        unsubscribe?.();
      }
      if (
        status.state !== "succeeded" &&
        status.state !== "failed" &&
        status.state !== "cancelled"
      ) {
        throw new WorkflowError("DriverError", `Cheng job ${started.jobId} did not settle.`);
      }
      await config.observer?.terminal({
        jobId: started.jobId,
        state: status.state,
        ...(status.runId === null ? {} : { runId: status.runId }),
      });
      return {
        jobId: started.jobId,
        runId: status.runId,
        state: status.state,
        exitCode: status.exitCode,
        verdict: verdictOf(status.state, mode),
      };
    },

    async verify(jobId: string): Promise<ChengVerifyResult> {
      const host = await client();
      const result = await request(host, "verify", { jobId });
      const settles = result.settle?.settles ?? [];
      return {
        level: result.receipt.acceptance.level,
        productionAcceptance: result.receipt.acceptance.productionAcceptance,
        verdict: result.receipt.acceptance.verdict ?? "UNKNOWN",
        semanticPass: result.receipt.judge.every((judge) => judge.status === "semantic_pass"),
        settlePassed: settles.filter((settle) => settle.verdict === "pass").length,
        settleTotal: settles.length,
        structureGateOk: result.structure?.checks.structureGateOk ?? null,
        gate: result.gate,
        artifactRef: result.artifactRef,
      };
    },

    async plan(jobId: string, task: string): Promise<ChengPlanResult> {
      const host = await client();
      return await request(host, "plan", { jobId, task });
    },

    async graph(
      jobId: string,
      task: string,
      view: "structure" | "decision",
    ): Promise<ChengGraphResult> {
      const host = await client();
      const result = await request(host, "graph.query", { jobId, task, view });
      return {
        available: result.available,
        reason: result.reason,
        nodes: result.summary?.nodes ?? 0,
        edges: result.summary?.edges ?? 0,
        roots: result.summary?.roots ?? 0,
        gateOk: result.summary?.gateOk ?? null,
        artifactRef: result.artifactRef,
        digest: result.digest,
      };
    },

    cancel: cancelJob,

    async cancelActive(): Promise<number> {
      const ids = [...activeJobs];
      await Promise.allSettled(ids.map((jobId) => cancelJob(jobId)));
      return ids.length;
    },

    onJobLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => {
        lifecycleListeners.delete(listener);
      };
    },

    async close(): Promise<void> {
      const pending = clientPromise;
      clientPromise = null;
      cachedCapabilities = null;
      if (pending !== null) {
        const host = await pending.catch(() => null);
        await host?.close();
      }
    },
  };
}

async function request<M extends HostMethod>(
  host: ChengRpcClient,
  method: M,
  params: unknown,
  deadlineMs = 30_000,
): Promise<MethodResult<M>> {
  try {
    return await host.request(method, params, deadlineMs);
  } catch (error) {
    throw asWorkflowError(method, error);
  }
}

async function waitTerminal(
  host: ChengRpcClient,
  jobId: string,
  config: ChengHostPortConfig,
): Promise<MethodResult<"job.status">> {
  const timeoutMs = config.jobTimeoutMs ?? 15 * 60 * 1000;
  const pollMs = config.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await request(host, "job.status", { jobId }, 10_000);
    if (status.state === "succeeded" || status.state === "failed" || status.state === "cancelled") {
      return status;
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new WorkflowError(
    "DriverError",
    `Cheng job ${jobId} did not settle within ${String(timeoutMs)}ms.`,
  );
}

function verdictOf(
  state: "succeeded" | "failed" | "cancelled",
  mode: "production" | "diagnostic",
): string {
  switch (state) {
    case "succeeded":
      return mode === "production" ? "PRODUCTION" : "DIAGNOSTIC_NOT_ACCEPTANCE";
    case "cancelled":
      return "CANCELLED";
    case "failed":
      return "FAILED";
  }
}

function asWorkflowError(op: string, error: unknown): WorkflowError {
  if (error instanceof WorkflowError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : null;
  return new WorkflowError(
    "DriverError",
    `Cheng ${op} failed${code === null ? "" : ` (${code})`}: ${message}`,
    { cause: error },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/** 供装配方统一口径；与 facade 注释里的缺省值同源。 */
export const CHENG_HOST_DEFAULT_BUDGET = CHENG_DEFAULT_BUDGET;
