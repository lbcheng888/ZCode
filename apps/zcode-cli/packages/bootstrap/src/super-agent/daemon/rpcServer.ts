/**
 * super-agent control-plane 数据面 RPC server（milestone-b-spec §3.1 / §3.8）。
 *
 * 端点：`<serverRoot>/run/super-agent.sock`（POSIX）或 Windows named pipe。每个连接
 * 先过 peer 门（§3.8），之后双向 JSONL：Core 发 `workspace.ensure` 等请求；child 用
 * 同一连接反向发 `host.command` / `host.worker.*` 回调请求。请求/响应按 `id` 相关，
 * 双方各自维护 pending 表。
 *
 * 帧上限 256 KiB；解析失败/超限立即断开并计错。所有 params/result 校验由调用方
 * （entry 的注册表）按 shared schema 执行——本模块只负责信封与传输。
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  CONTROL_PLANE_MAX_FRAME_BYTES,
  CONTROL_PLANE_RPC_ERROR_CODES,
  CONTROL_PLANE_RPC_TIMEOUTS_MS,
  CONTROL_PLANE_RPC_VERSION,
  controlPlaneAuthFrameSchema,
  controlPlaneRpcRequestSchema,
  controlPlaneRpcResponseSchema,
  type ControlPlaneRpcError,
} from "@zcode/shared/super-agent-control-plane-protocol";
import { z } from "zod";

import type { ControlPlanePeerGuard } from "./peerIdentity.js";

/** 结构化 RPC 错误：handler 抛它时原样映射到响应 error（不被通用化）。 */
export class ControlPlaneRpcCallError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retriable: boolean,
  ) {
    super(message);
    this.name = "ControlPlaneRpcCallError";
  }
}

export type ControlPlaneRpcRequestHandler = (
  method: string,
  params: unknown,
  context: { channel: ControlPlanePeerChannel; deadlineAt: number },
) => Promise<unknown> | unknown;

export interface ControlPlanePeerChannel {
  readonly peerPid: number | null;
  /**
   * 反向请求（child → Core）；超时/断连以 ControlPlaneRpcCallError 上浮。
   * `deadlineAt`（epoch ms）是父请求剩余预算：嵌套调用必须取 min(方法预算, 父剩余)，
   * 否则 Core 稍慢就会让父 RPC 先超时、反向请求成为孤儿（§3.1）。
   */
  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    deadlineAt?: number,
  ): Promise<unknown>;
  readonly closed: boolean;
}

export interface ControlPlaneRpcServer {
  readonly endpoint: string;
  readonly channelCount: number;
  readonly rejectedPeerCount: number;
  readonly protocolErrorCount: number;
  /** 当前 Core 通道（按首次 workspace.ensure 的来源绑定由 entry 完成；此处只暴露全部）。 */
  channels(): ControlPlanePeerChannel[];
  close(): Promise<void>;
}

/** 端点存活探测（bind 前区分陈旧 socket 与仍存活的 peer）超时。 */
export const CONTROL_PLANE_ENDPOINT_PROBE_TIMEOUT_MS = 1_000;

export interface CreateControlPlaneRpcServerOptions {
  endpoint: string;
  /**
   * 连接首帧凭据（§3.8 显式握手）。给出时以凭据认证，不再使用平台 peer resolver；
   * 未给出时退回 peerGuard（仅限测试/进程内场景，生产必须给 authToken）。
   */
  authToken?: string;
  peerGuard?: ControlPlanePeerGuard;
  handler: ControlPlaneRpcRequestHandler;
  onPeerRejected?: (reason: string) => void;
  onProtocolError?: (reason: string) => void;
  /** 平台开关（测试模拟 win32 端点时用）；监听本身仍交给 net。 */
  platform?: NodeJS.Platform;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: ControlPlaneRpcCallError) => void;
  timer: ReturnType<typeof setTimeout>;
}

class SocketChannel implements ControlPlanePeerChannel {
  private readonly pending = new Map<string, PendingCall>();
  private isClosed = false;
  public constructor(
    private readonly socket: Socket,
    public readonly peerPid: number | null,
  ) {}

  public get closed(): boolean {
    return this.isClosed;
  }

  public send(value: unknown): void {
    if (this.isClosed || this.socket.destroyed || this.socket.writableEnded) return;
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > CONTROL_PLANE_MAX_FRAME_BYTES) {
      throw new ControlPlaneRpcCallError(
        CONTROL_PLANE_RPC_ERROR_CODES.protocol,
        "outbound JSONL frame exceeds maximum size",
        false,
      );
    }
    this.socket.write(line);
  }

  public async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    deadlineAt?: number,
  ): Promise<unknown> {
    if (this.isClosed) {
      throw new ControlPlaneRpcCallError(
        CONTROL_PLANE_RPC_ERROR_CODES.hostUnreachable,
        `control-plane host channel is closed (${method})`,
        true,
      );
    }
    const effectiveTimeoutMs =
      deadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, deadlineAt - Date.now());
    if (effectiveTimeoutMs <= 0) {
      throw new ControlPlaneRpcCallError(
        CONTROL_PLANE_RPC_ERROR_CODES.hostUnreachable,
        `control-plane parent request deadline already elapsed (${method})`,
        true,
      );
    }
    const id = `cp-${randomUUID()}`;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ControlPlaneRpcCallError(
            CONTROL_PLANE_RPC_ERROR_CODES.hostUnreachable,
            `control-plane host request timed out after ${effectiveTimeoutMs}ms (${method})`,
            true,
          ),
        );
      }, effectiveTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ v: CONTROL_PLANE_RPC_VERSION, id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  public settle(id: string, response: { ok: true; result: unknown } | { ok: false; error: ControlPlaneRpcError }): boolean {
    const call = this.pending.get(id);
    if (!call) return false;
    this.pending.delete(id);
    clearTimeout(call.timer);
    if (response.ok) call.resolve(response.result);
    else {
      call.reject(
        new ControlPlaneRpcCallError(response.error.code, response.error.message, response.error.retriable),
      );
    }
    return true;
  }

  public close(reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      clearTimeout(call.timer);
      call.reject(
        new ControlPlaneRpcCallError(
          CONTROL_PLANE_RPC_ERROR_CODES.hostUnreachable,
          `${reason} (${id})`,
          true,
        ),
      );
    }
    this.socket.destroy();
  }
}

class JsonLineDecoder {
  private buffer = "";
  public push(chunk: string | Uint8Array): unknown[] {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    this.buffer += text;
    if (
      Buffer.byteLength(this.buffer, "utf8") > CONTROL_PLANE_MAX_FRAME_BYTES &&
      !this.buffer.includes("\n")
    ) {
      throw new Error("JSONL frame exceeds maximum size");
    }
    const frames: unknown[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > CONTROL_PLANE_MAX_FRAME_BYTES) {
        throw new Error("JSONL frame exceeds maximum size");
      }
      try {
        frames.push(JSON.parse(line) as unknown);
      } catch (error) {
        throw new Error("Invalid JSONL frame", { cause: error });
      }
    }
    return frames;
  }

  public finish(): void {
    if (this.buffer.trim()) throw new Error("Incomplete JSONL frame");
  }
}

function errorFromUnknown(error: unknown): ControlPlaneRpcError {
  if (error instanceof ControlPlaneRpcCallError) {
    return {
      code: error.code,
      message: error.message.slice(0, 500),
      retriable: error.retriable,
    };
  }
  // params 不符合 shared schema 属于调用方错误（proto.invalidParams），不是
  // per-workspace 执行异常；message 不回显原始参数内容。result schema 失败同样是
  // 协议错误，但服务端无法单靠 ZodError 区分两者，统一按 invalidParams 上报。
  if (error instanceof z.ZodError) {
    return {
      code: CONTROL_PLANE_RPC_ERROR_CODES.invalidParams,
      message: "control-plane RPC params failed schema validation",
      retriable: false,
    };
  }
  return {
    code: CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    retriable: false,
  };
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * bind 前探测端点：存活 listener = 拒绝启动；ECONNREFUSED/ENOENT/ENOTSOCK = 陈旧可清理；
 * 其它错误或超时 = 不可判定，同样 fail-closed（不得在不确定时夺走端点）。
 */
async function probeEndpointAvailability(
  endpoint: string,
): Promise<{ result: "absent" | "live" | "unknown"; reason?: string }> {
  return await new Promise((resolve) => {
    const socket = createConnection({ path: endpoint });
    let settled = false;
    const finish = (result: "absent" | "live" | "unknown", reason?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ result, ...(reason ? { reason } : {}) });
    };
    const timer = setTimeout(
      () => finish("unknown", `probe timed out after ${CONTROL_PLANE_ENDPOINT_PROBE_TIMEOUT_MS}ms`),
      CONTROL_PLANE_ENDPOINT_PROBE_TIMEOUT_MS,
    );
    timer.unref?.();
    socket.once("connect", () => finish("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ENOTSOCK") {
        finish("absent");
      } else {
        finish("unknown", `probe failed: ${error.code ?? "unknown"} ${error.message}`);
      }
    });
  });
}

export async function createControlPlaneRpcServer(
  options: CreateControlPlaneRpcServerOptions,
): Promise<ControlPlaneRpcServer> {
  const platform = options.platform ?? process.platform;
  const channels = new Map<Socket, SocketChannel>();
  let rejectedPeerCount = 0;
  let protocolErrorCount = 0;
  if (!options.authToken && !options.peerGuard) {
    // fail-closed：没有凭据也没有 peer 门时不允许起一个任何本机进程都能写数据的端点。
    throw new Error("control-plane RPC server requires authToken or peerGuard");
  }

  // POSIX：先探测端点是否仍有存活 peer，再 unlink 陈旧 socket，建 0700 目录并 bind。
  // 无条件 rm 会让第二个 child / 直跑入口悄悄夺走端点（双 child 双 leader）。
  if (platform !== "win32") {
    const runDir = dirname(options.endpoint);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    // 目录可能已由别的组件（control.sock）创建为默认 0755；socket 目录权限是 §3.1
    // 的纵深防御。chmod 失败必须 fatal，不能静默留下 0755。
    await chmod(runDir, 0o700);
    const probe = await probeEndpointAvailability(options.endpoint);
    if (probe.result === "live") {
      throw new Error(
        `control-plane endpoint ${options.endpoint} 已被存活进程占用；拒绝 bind（data-root 锁应已排除第二实例）`,
      );
    }
    if (probe.result === "unknown") {
      throw new Error(
        `control-plane endpoint ${options.endpoint} 状态不可判定（${probe.reason ?? "unknown"}）；fail-closed，拒绝 bind`,
      );
    }
    await rm(options.endpoint, { force: true });
  }

  const server: Server = createServer((socket) => {
    void establish(socket).catch(() => socket.destroy());
  });

  async function establish(socket: Socket): Promise<void> {
    socket.on("error", () => socket.destroy());
    let peerPid: number | null = null;
    if (options.authToken === undefined) {
      const decision = await options.peerGuard!.verify(socket);
      if (!decision.trusted) {
        rejectedPeerCount += 1;
        options.onPeerRejected?.(decision.reason ?? "peer rejected");
        socket.destroy();
        return;
      }
      peerPid = decision.identity.kind === "resolved" ? decision.identity.pid : null;
    }
    if (socket.destroyed) return;
    const channel = new SocketChannel(socket, peerPid);
    channels.set(socket, channel);
    let authenticated = options.authToken === undefined;
    const decoder = new JsonLineDecoder();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        protocolErrorCount += 1;
        options.onProtocolError?.(error instanceof Error ? error.message : String(error));
        channel.close("protocol error");
        return;
      }
      for (const frame of frames) {
        if (!authenticated) {
          // §3.8：首帧必须携带 Supervisor 铸造的凭据；否则在收到任何业务帧前断开。
          const auth = controlPlaneAuthFrameSchema.safeParse(frame);
          if (!auth.success || !tokensEqual(auth.data.auth, options.authToken!)) {
            rejectedPeerCount += 1;
            options.onPeerRejected?.("invalid or missing control-plane auth frame");
            channel.close("auth rejected");
            return;
          }
          authenticated = true;
          continue;
        }
        void dispatch(channel, frame).catch(() => channel.close("dispatch failed"));
      }
    });
    socket.on("end", () => {
      try {
        decoder.finish();
      } catch (error) {
        protocolErrorCount += 1;
        options.onProtocolError?.(error instanceof Error ? error.message : String(error));
      }
      channel.close("peer ended");
    });
    socket.on("close", () => {
      channels.delete(socket);
      channel.close("peer closed");
    });
  }

  async function dispatch(channel: SocketChannel, raw: unknown): Promise<void> {
    // 响应帧（child 反向请求的 Core 回执）先按 id 交付；请求帧走注册表。
    const response = controlPlaneRpcResponseSchema.safeParse(raw);
    if (response.success) {
      // 迟到/未知 id 的响应（请求已超时）按协议正常噪音丢弃，不能升级成协议错误。
      channel.settle(response.data.id, response.data);
      return;
    }

    const request = controlPlaneRpcRequestSchema.safeParse(raw);
    if (!request.success) {
      // §3.1：反序列化失败即协议错误，必须断开连接并计错；不能保留连接再猜 id。
      protocolErrorCount += 1;
      options.onProtocolError?.("invalid control-plane RPC request frame");
      channel.close("invalid request frame");
      return;
    }
    const { id, method, params } = request.data;
    try {
      // §3.1：嵌套反向请求受本次父请求的超时预算约束。
      const deadlineAt = Date.now() + CONTROL_PLANE_RPC_TIMEOUTS_MS[method];
      const result = await options.handler(method, params, { channel, deadlineAt });
      channel.send({ v: CONTROL_PLANE_RPC_VERSION, id, ok: true, result });
    } catch (error) {
      channel.send({
        v: CONTROL_PLANE_RPC_VERSION,
        id,
        ok: false,
        error: errorFromUnknown(error),
      });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.endpoint, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (platform !== "win32") {
    // socket 0600 是 §3.1 纵深防御；失败必须 fatal，不能静默留下更宽权限。
    await chmod(options.endpoint, 0o600);
  }

  let closePromise: Promise<void> | undefined;
  return {
    endpoint: options.endpoint,
    get channelCount() {
      return channels.size;
    },
    get rejectedPeerCount() {
      return rejectedPeerCount;
    },
    get protocolErrorCount() {
      return protocolErrorCount;
    },
    channels() {
      return [...channels.values()];
    },
    async close() {
      if (closePromise) return await closePromise;
      closePromise = (async () => {
        const serverClosed = new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        for (const channel of channels.values()) channel.close("server shutdown");
        await serverClosed;
        if (platform !== "win32") await rm(options.endpoint, { force: true }).catch(() => undefined);
      })();
      return await closePromise;
    },
  };
}
