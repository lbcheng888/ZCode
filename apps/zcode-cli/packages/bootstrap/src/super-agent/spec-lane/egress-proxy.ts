/**
 * 本地 egress 正向代理（M5 spec lane，spec §4）。
 *
 * 协议面只有 HTTP 代理协议：absolute-form HTTP 请求 + CONNECT 隧道（HTTPS 走
 * CONNECT 是 HTTP 代理协议的一部分）。设计里「仅 HTTP 到用户配置的 host」按此
 * 解读：只放行 web 流量到 allowlist host，不开任意 TCP 转发。
 *
 * 门禁：host 或 host:port 精确匹配（大小写不敏感），命中才转发；未命中
 * HTTP ⇒ 403，CONNECT ⇒ 403 后断连。空 allowlist ⇒ 全拒（零 egress 缺省）。
 * 只绑 loopback，不监听外部接口。
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { SpecEgressStartupError } from "./contract.js";

export interface EgressAllowlistEntry {
  host: string;
  /** 缺席 = 该 host 任意端口都放行。 */
  port?: number;
}

export interface EgressProxyHandle {
  /** 形如 http://127.0.0.1:12345。 */
  url: string;
  port: number;
  allowHosts: readonly EgressAllowlistEntry[];
  close(): Promise<void>;
}

export interface StartEgressProxyRequest {
  allowHosts: readonly EgressAllowlistEntry[];
  /** 归属 workspace；仅用于启动失败错误的定位信息。 */
  workspaceRoot: string;
  host?: string;
  port?: number;
}

/**
 * 启动期 repo 配置校验入口：形状非法立即抛（同 normalize 的 fail-closed 语义）；
 * 返回 trim 后的原始字面量，交给 dispatcher `resolveAllowHosts`，prepare 时再归一化。
 */
export function resolveSpecEgressAllowHosts(raw: readonly string[]): string[] {
  normalizeSpecEgressAllowlist(raw);
  return raw.map((entry) => entry.trim());
}

/**
 * per-repo 白名单配置值收敛（spec §4.3）。非字符串/空串条目**抛错**——配置损坏
 * 必须暴露，不静默丢弃（fail-closed）。条目形如 "host"、"host:port" 或 IPv6
 * 方括号形态 "[::1]"、"[::1]:port"；host 大小写归一，port 必须是 1-65535 整数。
 * 裸 IPv6（多个冒号且无方括号）直接抛——host:port 切分会把它误解析成永不
 * 匹配的死条目（如 "fe80::1" → host "fe80:"），静默失效比报错更危险。
 */
export function normalizeSpecEgressAllowlist(raw: unknown): EgressAllowlistEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`specEgress.allowHosts 必须是字符串数组，收到 ${typeof raw}`);
  }
  return raw.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`specEgress.allowHosts[${index}] 必须是字符串，收到 ${typeof item}`);
    }
    const trimmed = item.trim();
    if (!trimmed) {
      throw new Error(`specEgress.allowHosts[${index}] 为空串`);
    }
    // IPv6 方括号形态："[::1]" / "[::1]:port"。host 存无方括号形式，与
    // CONNECT 解析（parseConnectTarget 剥括号）对齐。
    if (trimmed.startsWith("[")) {
      const close = trimmed.indexOf("]");
      const host = close < 0 ? "" : trimmed.slice(1, close).toLowerCase();
      if (!host) {
        throw new Error(`specEgress.allowHosts[${index}] 形状非法: ${item}`);
      }
      const rest = trimmed.slice(close + 1);
      if (!rest) {
        return { host };
      }
      if (!rest.startsWith(":") || rest.length === 1) {
        throw new Error(`specEgress.allowHosts[${index}] 形状非法: ${item}`);
      }
      return { host, port: parseStrictPort(rest.slice(1), index, item) };
    }
    const separator = trimmed.lastIndexOf(":");
    if (separator < 0) {
      return { host: trimmed.toLowerCase() };
    }
    // 有冒号就必须是 host:port：空 host、空端口都抛（配置损坏必须暴露）。
    if (separator === 0 || separator === trimmed.length - 1) {
      throw new Error(`specEgress.allowHosts[${index}] 形状非法: ${item}`);
    }
    // 裸 IPv6（多个冒号、无方括号）：host:port 切分会把它误解析成死条目，直接拒绝。
    if (trimmed.indexOf(":") !== separator) {
      throw new Error(
        `specEgress.allowHosts[${index}] 形状非法（裸 IPv6 须写成 [::1] 形态）: ${item}`,
      );
    }
    return {
      host: trimmed.slice(0, separator).toLowerCase(),
      port: parseStrictPort(trimmed.slice(separator + 1), index, item),
    };
  });
}

function parseStrictPort(portText: string, index: number, item: string): number {
  if (!/^\d+$/.test(portText)) {
    // host 侧形状对但后缀不是纯数字端口：当裸 host 处理会把畸形配置当合法，宁可抛。
    throw new Error(`specEgress.allowHosts[${index}] 形状非法: ${item}`);
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`specEgress.allowHosts[${index}] 端口越界: ${item}`);
  }
  return port;
}

function isHostAllowed(
  host: string,
  port: number,
  allowHosts: readonly EgressAllowlistEntry[],
): boolean {
  // URL.hostname 对 IPv6 保留方括号（"[::1]"），CONNECT 解析剥了括号（"::1"）；
  // 两侧统一剥括号再比较，否则方括号形态的白名单条目永远匹配不上。
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const normalized = bare.toLowerCase();
  return allowHosts.some(
    (entry) => entry.host === normalized && (entry.port === undefined || entry.port === port),
  );
}

/** 从 CONNECT 的 req.url（"host:port" 或 "[v6]:port"）拆 host/port；畸形返回 null。 */
function parseConnectTarget(url: string): { host: string; port: number } | null {
  if (url.startsWith("[")) {
    const close = url.indexOf("]");
    if (close < 0 || url[close + 1] !== ":") return null;
    const host = url.slice(1, close);
    const port = Number(url.slice(close + 2));
    return host && Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
  }
  const separator = url.lastIndexOf(":");
  if (separator <= 0) return null;
  const host = url.slice(0, separator);
  const port = Number(url.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

function rejectHttpResponse(res: ServerResponse, statusCode: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

/**
 * 启动 per-workspace egress 代理。listen 失败（端口占用等）抛
 * SpecEgressStartupError——fail-closed，调用方据此拒绝 spec run 启动。
 */
export async function startEgressProxy(request: StartEgressProxyRequest): Promise<EgressProxyHandle> {
  const host = request.host ?? "127.0.0.1";
  const allowHosts = request.allowHosts;

  const server = createServer((req, res) => {
    handleProxyRequest(req, res, allowHosts);
  });
  server.on("connect", (req, socket, head) => {
    handleConnect(req, socket, head, allowHosts);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(
        new SpecEgressStartupError(request.workspaceRoot, error.message, { cause: error }),
      );
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(request.port ?? 0, host);
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  if (!port) {
    await closeServer(server);
    throw new SpecEgressStartupError(request.workspaceRoot, "无法解析监听端口");
  }

  return {
    url: `http://${host}:${port}`,
    port,
    allowHosts,
    close: () => closeServer(server),
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  // closeAllConnections：Node ≥18.2，回收 keep-alive/隧道连接，保证 close 立即可等。
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  allowHosts: readonly EgressAllowlistEntry[],
): void {
  const rawUrl = req.url ?? "";
  // absolute-form 才是代理请求；origin-form（有人把代理当普通服务器打）一律拒。
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    rejectHttpResponse(res, 400, "spec-egress: 需要 absolute-form 代理请求");
    return;
  }
  if (target.protocol !== "http:") {
    rejectHttpResponse(res, 400, "spec-egress: 仅支持 http: absolute-form（https 走 CONNECT）");
    return;
  }
  const port = target.port ? Number(target.port) : 80;
  if (!isHostAllowed(target.hostname, port, allowHosts)) {
    rejectHttpResponse(res, 403, `spec-egress: host 不在 allowlist: ${target.hostname}:${port}`);
    return;
  }

  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    rejectHttpResponse(res, 502, `spec-egress: 上游连接失败: ${error.message}`);
  });
  req.pipe(upstream);
}

function handleConnect(
  req: IncomingMessage,
  // http.Server 的 connect 事件 socket 是 stream.Duplex（net.Socket 的上位类型）；
  // 本函数只用 end/write/pipe/destroy 级 API，按 Duplex 消费即可。
  socket: Duplex,
  head: Buffer,
  allowHosts: readonly EgressAllowlistEntry[],
): void {
  const target = parseConnectTarget(req.url ?? "");
  if (!target || !isHostAllowed(target.host, target.port, allowHosts)) {
    // 未命中：403 后断连——不建立任何到目标的 TCP。
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const tunnel = netConnect(target.port, target.host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) tunnel.write(head);
    tunnel.pipe(socket);
    socket.pipe(tunnel);
  });
  tunnel.on("error", () => socket.destroy());
  socket.on("error", () => tunnel.destroy());
}
