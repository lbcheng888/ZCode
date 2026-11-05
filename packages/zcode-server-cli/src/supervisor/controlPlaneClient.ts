import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { createServiceLogger } from "@zcode/services/node";
import * as controlPlaneProtocol from "@zcode/shared/super-agent-control-plane-protocol";
import type { z } from "zod";

const log = createServiceLogger("super-agent-control-plane-client");

/**
 * Core ↔ control-plane child 数据面 RPC 薄客户端（milestone-b-spec §3.1/§3.2）。
 *
 * 契约源：`@zcode/shared/super-agent-control-plane-protocol`（Lane A 落地的唯一
 * shared schema）。本文件只负责传输与超时：
 * - 专用本地 socket（POSIX `<serverRoot>/run/super-agent.sock` / Windows named pipe，
 *   端点公式与 child 侧同一 shared 函数）；
 * - 每帧一行 JSON，单帧上限 256 KiB，超限断开并计错；
 * - 请求/响应按 id 关联，每方法超时取 §3.2 方法表；
 * - params/result 走 shared zod schema，反序列化失败即协议错误并断开，不猜字段。
 *
 * 范围：只覆盖 daemon/Core → child 方向。child → Core 回调（host.command 等，§3.3）
 * 与 peer 身份校验（§3.8，child 侧）不在本批次接线范围。
 */

/** §3.8 显式 peer 门模式开关（Supervisor 环境投影给 Core 与 child，两侧必须一致）。 */
export const CONTROL_PLANE_PEER_MODE_ENV = "ZCODE_CONTROL_PLANE_PEER_MODE";

export function isControlPlanePeerModeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[CONTROL_PLANE_PEER_MODE_ENV]?.trim();
  return raw === "1" || raw === "true";
}

export const CONTROL_PLANE_RPC_VERSION = controlPlaneProtocol.CONTROL_PLANE_RPC_VERSION;
export const CONTROL_PLANE_MAX_FRAME_BYTES = controlPlaneProtocol.CONTROL_PLANE_MAX_FRAME_BYTES;
export const CONTROL_PLANE_CONNECT_TIMEOUT_MS = 5_000;

/**
 * 本地 RPC 错误码：shared 闭集（proto.*）用于协议/参数错误，传输层错误码由客户端
 * 本层定义（socket 不可达/超时/断线不是 server 能返回的业务错误）。
 */
export const CONTROL_PLANE_RPC_ERROR_CODES = {
  ...controlPlaneProtocol.CONTROL_PLANE_RPC_ERROR_CODES,
  notConnected: "rpc.notConnected",
  connectFailed: "rpc.connectFailed",
  clientClosed: "rpc.clientClosed",
  disconnected: "rpc.disconnected",
  timeout: "rpc.timeout",
  authFailed: controlPlaneProtocol.CONTROL_PLANE_RPC_ERROR_CODES.authFailed,
  frameTooLarge: "proto.frameTooLarge",
  protocolError: controlPlaneProtocol.CONTROL_PLANE_RPC_ERROR_CODES.protocol,
  requestInvalid: controlPlaneProtocol.CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
} as const;

/** §3.2 每方法超时（毫秒，shared 单一来源）；调用点不得临时改写。 */
export const CONTROL_PLANE_METHOD_TIMEOUT_MS = controlPlaneProtocol.CONTROL_PLANE_RPC_TIMEOUTS_MS;

export function resolveControlPlaneEndpoint(
  serverRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return controlPlaneProtocol.resolveControlPlaneEndpoint(serverRoot, { platform });
}

const controlPlaneMethodTable = {
  "workspace.ensure": {
    params: controlPlaneProtocol.workspaceEnsureParamsSchema,
    result: controlPlaneProtocol.workspaceEnsureResultSchema,
    timeoutMs: CONTROL_PLANE_METHOD_TIMEOUT_MS["workspace.ensure"],
  },
  "trigger.ingest": {
    params: controlPlaneProtocol.controlPlaneTriggerIngestParamsSchema,
    result: controlPlaneProtocol.controlPlaneTriggerIngestResultSchema,
    timeoutMs: CONTROL_PLANE_METHOD_TIMEOUT_MS["trigger.ingest"],
  },
  "schedule.audit": {
    params: controlPlaneProtocol.scheduleAuditParamsSchema,
    result: controlPlaneProtocol.scheduleAuditResultSchema,
    timeoutMs: CONTROL_PLANE_METHOD_TIMEOUT_MS["schedule.audit"],
  },
  "lease.list": {
    params: controlPlaneProtocol.leaseListParamsSchema,
    result: controlPlaneProtocol.leaseListResultSchema,
    timeoutMs: CONTROL_PLANE_METHOD_TIMEOUT_MS["lease.list"],
  },
  "lease.get": {
    params: controlPlaneProtocol.leaseGetParamsSchema,
    result: controlPlaneProtocol.leaseGetResultSchema,
    timeoutMs: CONTROL_PLANE_METHOD_TIMEOUT_MS["lease.get"],
  },
  "mandate.resolve": {
    params: controlPlaneProtocol.mandateResolveParamsSchema,
    result: controlPlaneProtocol.controlPlaneMandateResolveResultSchema,
    timeoutMs: CONTROL_PLANE_METHOD_TIMEOUT_MS["mandate.resolve"],
  },
  "wouldAccept.list": {
    params: controlPlaneProtocol.wouldAcceptListParamsSchema,
    result: controlPlaneProtocol.wouldAcceptListResultSchema,
    timeoutMs: CONTROL_PLANE_METHOD_TIMEOUT_MS["wouldAccept.list"],
  },
  "wouldAccept.promote": {
    params: controlPlaneProtocol.wouldAcceptPromoteParamsSchema,
    result: controlPlaneProtocol.wouldAcceptPromoteResultSchema,
    timeoutMs: CONTROL_PLANE_METHOD_TIMEOUT_MS["wouldAccept.promote"],
  },
  "control.status": {
    params: controlPlaneProtocol.controlStatusParamsSchema,
    result: controlPlaneProtocol.controlStatusResultSchema,
    timeoutMs: CONTROL_PLANE_METHOD_TIMEOUT_MS["control.status"],
  },
} satisfies Record<string, { params: z.ZodType; result: z.ZodType; timeoutMs: number }>;

export type ControlPlaneMethodName = keyof typeof controlPlaneMethodTable;
export type ControlPlaneMethodParams<M extends ControlPlaneMethodName> = z.infer<
  (typeof controlPlaneMethodTable)[M]["params"]
>;
export type ControlPlaneMethodResult<M extends ControlPlaneMethodName> = z.infer<
  (typeof controlPlaneMethodTable)[M]["result"]
>;

export class ControlPlaneRpcError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retriable: boolean,
  ) {
    super(message);
    this.name = "ControlPlaneRpcError";
  }
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ControlPlaneClientOptions {
  /** 显式端点；与 serverRoot 二选一。 */
  endpoint?: string;
  /** 由 serverRoot 按 §3.1 公式推导端点（与显式 endpoint 二选一）。 */
  serverRoot?: string;
  platform?: NodeJS.Platform;
  maxFrameBytes?: number;
  connectTimeoutMs?: number;
  /**
   * 连接首帧认证凭据文件（§3.8 显式握手）。缺省：给出 serverRoot 时用 shared 公式
   * 推导 `<serverRoot>/run/super-agent.auth`；显式 endpoint（测试/进程内）不认证。
   */
  authTokenFile?: string;
  /**
   * §3.8 显式 peer 门模式：true 时不读取凭据文件、不发送 auth 首帧；身份由 child
   * 在连接建立时用内核 peer credential 校验。必须与 child 侧 env 开关一致。
   */
  peerMode?: boolean;
  /**
   * child → Core 反向请求处理器（§3.3）。未注册的方法必须回 `proto.unimplemented`
   * 结构化错误，**不得**把入站请求当协议错误断开连接（backfill.seeds 会让
   * workspace.ensure 必然失败）。
   */
  onInboundRequest?: (method: string, params: unknown) => Promise<unknown>;
  /**
   * 测试可注入缩短单方法超时；生产缺省必须走 §3.2 方法表，禁止调用点改写。
   * 键为方法名，未列出的方法沿用方法表。
   */
  timeoutMsByMethod?: Partial<Record<ControlPlaneMethodName, number>>;
}

export interface ControlPlaneClient {
  readonly endpoint: string;
  readonly connected: boolean;
  connect(): Promise<void>;
  request<M extends ControlPlaneMethodName>(
    method: M,
    params: ControlPlaneMethodParams<M>,
  ): Promise<ControlPlaneMethodResult<M>>;
  close(): Promise<void>;
}

class JsonlControlPlaneClient implements ControlPlaneClient {
  public readonly endpoint: string;
  private readonly maxFrameBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly timeoutMsByMethod: Partial<Record<ControlPlaneMethodName, number>>;
  private readonly authTokenFile: string | undefined;
  private readonly onInboundRequest:
    | ((method: string, params: unknown) => Promise<unknown>)
    | undefined;
  private socket: Socket | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 0;
  private connectPromise: Promise<void> | undefined;
  private closed = false;

  public constructor(options: ControlPlaneClientOptions) {
    if (options.endpoint?.trim()) {
      this.endpoint = options.endpoint;
    } else if (options.serverRoot?.trim()) {
      this.endpoint = resolveControlPlaneEndpoint(
        options.serverRoot,
        options.platform ?? process.platform,
      );
    } else {
      throw new Error("ControlPlaneClient requires endpoint or serverRoot");
    }
    this.maxFrameBytes = options.maxFrameBytes ?? CONTROL_PLANE_MAX_FRAME_BYTES;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONTROL_PLANE_CONNECT_TIMEOUT_MS;
    this.timeoutMsByMethod = options.timeoutMsByMethod ?? {};
    this.onInboundRequest = options.onInboundRequest;
    this.authTokenFile = options.peerMode
      ? undefined
      : options.authTokenFile ??
        (options.serverRoot?.trim()
          ? controlPlaneProtocol.resolveControlPlaneAuthTokenPath(options.serverRoot)
          : undefined);
  }

  public get connected(): boolean {
    return this.socket !== undefined && !this.closed;
  }

  public connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        new ControlPlaneRpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.clientClosed,
          "control plane RPC client is closed",
          false,
        ),
      );
    }
    if (this.socket) return Promise.resolve();
    if (!this.connectPromise) {
      this.connectPromise = this.openSocket().catch((error: unknown) => {
        this.connectPromise = undefined;
        throw error;
      });
    }
    return this.connectPromise;
  }

  private async openSocket(): Promise<void> {
    const authToken = await this.readAuthToken();
    return await new Promise<void>((resolvePromise, rejectPromise) => {
      const socket = createConnection({ path: this.endpoint });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        const message = `control plane RPC connect timed out after ${this.connectTimeoutMs}ms (${this.endpoint})`;
        log.error("super-agent control plane RPC connect failed", {
          endpoint: this.endpoint,
          code: "ETIMEDOUT",
          message,
        });
        rejectPromise(
          new ControlPlaneRpcError(CONTROL_PLANE_RPC_ERROR_CODES.connectFailed, message, true),
        );
      }, this.connectTimeoutMs);
      timer.unref();

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // close() 发生在 connect 进行中时 socket 已关闭：不能再把这条无主连接
        // attach 进客户端并 resolve connect（会泄漏 socket、server 侧留下无主连接）。
        if (this.closed) {
          socket.destroy();
          rejectPromise(
            new ControlPlaneRpcError(
              CONTROL_PLANE_RPC_ERROR_CODES.clientClosed,
              "control plane RPC client was closed while connecting",
              false,
            ),
          );
          return;
        }
        this.attachSocket(socket);
        if (authToken !== undefined) {
          // §3.8：首帧必须是凭据，先于任何业务帧。
          try {
            socket.write(
              `${JSON.stringify({
                v: CONTROL_PLANE_RPC_VERSION,
                auth: authToken,
              })}\n`,
            );
          } catch (error) {
            socket.destroy();
            rejectPromise(
              new ControlPlaneRpcError(
                CONTROL_PLANE_RPC_ERROR_CODES.authFailed,
                `control plane RPC auth frame write failed: ${error instanceof Error ? error.message : String(error)}`,
                false,
              ),
            );
            return;
          }
        }
        resolvePromise();
      };
      const onError = (error: Error & { code?: string }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        const message = `control plane RPC connect failed (${this.endpoint}): ${error.message}`;
        log.error("super-agent control plane RPC connect failed", {
          endpoint: this.endpoint,
          code: error.code ?? "UNKNOWN",
          message: error.message,
        });
        rejectPromise(
          new ControlPlaneRpcError(CONTROL_PLANE_RPC_ERROR_CODES.connectFailed, message, true),
        );
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  /**
   * 读取 §3.8 认证凭据。配置了 authTokenFile 即要求认证：文件缺失/为空时连接失败
   * （fail-closed），不得静默按无认证连接。
   */
  private async readAuthToken(): Promise<string | undefined> {
    if (this.authTokenFile === undefined) return undefined;
    let raw: string;
    try {
      raw = await readFile(this.authTokenFile, "utf8");
    } catch (error) {
      throw new ControlPlaneRpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.authFailed,
        `control plane RPC auth token file unreadable (${this.authTokenFile}): ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    const token = raw.trim();
    if (!token) {
      throw new ControlPlaneRpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.authFailed,
        `control plane RPC auth token file is empty (${this.authTokenFile})`,
        false,
      );
    }
    return token;
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", (error: Error & { code?: string }) => {
      log.warn("super-agent control plane RPC socket error", {
        endpoint: this.endpoint,
        code: error.code ?? "UNKNOWN",
        message: error.message,
      });
    });
    socket.once("close", () => {
      const wasIntentionallyClosed = this.closed;
      this.socket = undefined;
      this.buffer = Buffer.alloc(0);
      this.connectPromise = undefined;
      const pendingCount = this.pending.size;
      this.failPending(
        new ControlPlaneRpcError(
          wasIntentionallyClosed
            ? CONTROL_PLANE_RPC_ERROR_CODES.clientClosed
            : CONTROL_PLANE_RPC_ERROR_CODES.disconnected,
          wasIntentionallyClosed
            ? "control plane RPC client closed"
            : `control plane RPC connection closed (${this.endpoint})`,
          !wasIntentionallyClosed,
        ),
      );
      if (!wasIntentionallyClosed) {
        log.warn("super-agent control plane RPC disconnected", {
          endpoint: this.endpoint,
          pendingRequests: pendingCount,
        });
      }
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newlineIndex = this.buffer.indexOf(0x0a);
      if (newlineIndex < 0) {
        if (this.buffer.length > this.maxFrameBytes) {
          this.failProtocol(
            CONTROL_PLANE_RPC_ERROR_CODES.frameTooLarge,
            `control plane RPC frame exceeds ${this.maxFrameBytes} bytes without a newline`,
          );
        }
        return;
      }
      const frameBytes = this.buffer.subarray(0, newlineIndex);
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (frameBytes.length > this.maxFrameBytes) {
        this.failProtocol(
          CONTROL_PLANE_RPC_ERROR_CODES.frameTooLarge,
          `control plane RPC frame ${frameBytes.length} bytes exceeds ${this.maxFrameBytes}`,
        );
        return;
      }
      if (frameBytes.length === 0) continue;
      this.handleFrame(frameBytes);
      if (!this.socket) return;
    }
  }

  private handleFrame(frameBytes: Buffer): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(frameBytes.toString("utf8"));
    } catch {
      this.failProtocol(
        CONTROL_PLANE_RPC_ERROR_CODES.protocolError,
        "control plane RPC frame is not valid JSON",
      );
      return;
    }
    const parsed = controlPlaneProtocol.controlPlaneRpcResponseSchema.safeParse(decoded);
    if (parsed.success) {
      const response = parsed.data;
      const pending = this.pending.get(response.id);
      if (!pending) {
        // 已超时/已断开的请求迟到响应属于正常竞态；不属于协议错误，忽略并保留连接。
        log.debug("ignoring control plane RPC response for unknown id", {
          id: response.id,
        });
        return;
      }
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (!response.ok) {
        pending.reject(
          new ControlPlaneRpcError(
            response.error.code,
            `${response.error.code}: ${response.error.message}`,
            response.error.retriable,
          ),
        );
        return;
      }
      const method = pending.method;
      if (!isControlPlaneMethodName(method)) {
        pending.reject(
          new ControlPlaneRpcError(
            CONTROL_PLANE_RPC_ERROR_CODES.protocolError,
            `control plane RPC response for unknown method ${method}`,
            false,
          ),
        );
        this.failProtocol(
          CONTROL_PLANE_RPC_ERROR_CODES.protocolError,
          `control plane RPC response for unknown method ${method}`,
        );
        return;
      }
      const result = controlPlaneMethodTable[method].result.safeParse(response.result);
      if (!result.success) {
        pending.reject(
          new ControlPlaneRpcError(
            CONTROL_PLANE_RPC_ERROR_CODES.protocolError,
            `control plane RPC result for ${method} failed schema validation`,
            false,
          ),
        );
        this.failProtocol(
          CONTROL_PLANE_RPC_ERROR_CODES.protocolError,
          `control plane RPC result for ${method} failed schema validation`,
        );
        return;
      }
      pending.resolve(result.data);
      return;
    }

    // child → Core 反向请求（§3.3）：不能当协议错误断开——child 的 workspace.ensure
    // 返回前必然发 backfill.seeds，误判会让首次 ensure 永久失败。
    const inbound = controlPlaneProtocol.controlPlaneRpcRequestSchema.safeParse(decoded);
    if (inbound.success) {
      void this.handleInboundRequest(inbound.data);
      return;
    }
    this.failProtocol(
      CONTROL_PLANE_RPC_ERROR_CODES.protocolError,
      "control plane RPC frame is neither a valid response nor a valid request",
    );
  }

  private async handleInboundRequest(
    request: controlPlaneProtocol.ControlPlaneRpcRequest,
  ): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed || socket.writableEnded) return;
    let response:
      | { v: 1; id: string; ok: true; result: unknown }
      | {
          v: 1;
          id: string;
          ok: false;
          error: { code: string; message: string; retriable: boolean };
        };
    try {
      if (!this.onInboundRequest) {
        throw new ControlPlaneRpcError(
          controlPlaneProtocol.CONTROL_PLANE_RPC_ERROR_CODES.unimplemented,
          `control plane client has no handler for inbound method ${request.method}`,
          false,
        );
      }
      response = {
        v: CONTROL_PLANE_RPC_VERSION,
        id: request.id,
        ok: true,
        result: await this.onInboundRequest(request.method, request.params),
      };
    } catch (error) {
      response = {
        v: CONTROL_PLANE_RPC_VERSION,
        id: request.id,
        ok: false,
        error:
          error instanceof ControlPlaneRpcError
            ? {
                code: error.code,
                message: error.message.slice(0, 500),
                retriable: error.retriable,
              }
            : {
                code: controlPlaneProtocol.CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
                message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
                retriable: false,
              },
      };
    }
    try {
      socket.write(`${JSON.stringify(response)}\n`);
    } catch {
      socket.destroy();
    }
  }

  public request<M extends ControlPlaneMethodName>(
    method: M,
    params: ControlPlaneMethodParams<M>,
  ): Promise<ControlPlaneMethodResult<M>> {
    if (this.closed) {
      return Promise.reject(
        new ControlPlaneRpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.clientClosed,
          "control plane RPC client is closed",
          false,
        ),
      );
    }
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(
        new ControlPlaneRpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.notConnected,
          `control plane RPC client is not connected (${this.endpoint})`,
          true,
        ),
      );
    }
    const entry = controlPlaneMethodTable[method];
    const validatedParams = entry.params.safeParse(params);
    if (!validatedParams.success) {
      return Promise.reject(
        new ControlPlaneRpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.requestInvalid,
          `control plane RPC request ${method} failed schema validation: ${validatedParams.error.message}`,
          false,
        ),
      );
    }

    const id = `${++this.nextRequestId}`;
    const frame = `${JSON.stringify({
      v: CONTROL_PLANE_RPC_VERSION,
      id,
      method,
      params: validatedParams.data,
    })}\n`;
    const frameBytes = Buffer.byteLength(frame);
    if (frameBytes > this.maxFrameBytes) {
      log.error("super-agent control plane RPC request frame too large", {
        method,
        frameBytes,
        maxFrameBytes: this.maxFrameBytes,
      });
      return Promise.reject(
        new ControlPlaneRpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.frameTooLarge,
          `control plane RPC request ${method} frame ${frameBytes} bytes exceeds ${this.maxFrameBytes}`,
          false,
        ),
      );
    }

    return new Promise<ControlPlaneMethodResult<M>>((resolvePromise, rejectPromise) => {
      const timeoutMs = this.timeoutMsByMethod[method] ?? entry.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(
          new ControlPlaneRpcError(
            CONTROL_PLANE_RPC_ERROR_CODES.timeout,
            `control plane RPC ${method} timed out after ${timeoutMs}ms`,
            true,
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        resolve: (result) => resolvePromise(result as ControlPlaneMethodResult<M>),
        reject: rejectPromise,
        timer,
      });
      socket.write(frame, (error?: Error | null) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(
          new ControlPlaneRpcError(
            CONTROL_PLANE_RPC_ERROR_CODES.disconnected,
            `control plane RPC write failed (${this.endpoint}): ${error.message}`,
            true,
          ),
        );
      });
    });
  }

  private failProtocol(code: string, message: string): void {
    // 协议的非法形状（非法 JSON / 帧超限 / result schema 失败）不可重试；只有
    // connectFailed/disconnected/timeout/notConnected 才是可重试 503（§3.6）。
    log.error("super-agent control plane RPC protocol error", {
      endpoint: this.endpoint,
      code,
      message,
    });
    this.socket?.destroy();
    this.failPending(new ControlPlaneRpcError(code, message, false));
  }

  private failPending(error: ControlPlaneRpcError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.failPending(
      new ControlPlaneRpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.clientClosed,
        "control plane RPC client closed",
        false,
      ),
    );
    const socket = this.socket;
    this.socket = undefined;
    this.connectPromise = undefined;
    if (socket) socket.destroy();
  }
}

function isControlPlaneMethodName(value: string): value is ControlPlaneMethodName {
  return value in controlPlaneMethodTable;
}

export function createControlPlaneClient(
  options: ControlPlaneClientOptions,
): ControlPlaneClient {
  return new JsonlControlPlaneClient(options);
}

export {
  controlPlaneRpcRequestSchema,
  controlPlaneRpcResponseSchema,
} from "@zcode/shared/super-agent-control-plane-protocol";
