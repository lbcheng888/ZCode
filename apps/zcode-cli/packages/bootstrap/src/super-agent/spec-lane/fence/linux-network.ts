/**
 * Linux 围栏宿主侧连接面：AF_UNIX → TCP broker relay。
 *
 * 新的 rootless 设计里围栏 netns 与宿主 netns 网络隔离，宿主 loopback broker 在
 * 围栏内不可达；围栏内 Node relay 只能经同一 mount namespace 可见的 AF_UNIX
 * socket 回到宿主。本文件只承担这条字节中继与生命周期，便于单独审查；命令计划/
 * 命名空间编排在 command-plan/executor。
 *
 * socket 文件放在 fence 临时目录（mkdtemp 0700）内并强制 chmod 0600；目录与
 * socket 权限共同限制其他本地用户。relay 只搬字节，allowlist 仍由 egress broker
 * 裁决。
 */
import { chmod, unlink } from "node:fs/promises";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";

import { FenceStartupError } from "./contract.js";

export interface BrokerRelayTarget {
  host: string;
  port: number;
}

export interface UnixBrokerRelayHandle {
  socketPath: string;
  close(): Promise<void>;
}

/** socket 文件权限：仅属主可读写（目录本身已是 0700）。 */
const RELAY_SOCKET_MODE = 0o600;

function relayErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: string }).stderr;
  const stdout = (error as Error & { stdout?: string }).stdout;
  const text = (stderr ?? "").trim() || (stdout ?? "").trim() || error.message;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/**
 * 宿主 AF_UNIX relay：监听 socketPath，每条连接建立到 egress broker 的 TCP
 * 连接并双向 pipe。监听/权限失败抛 typed FenceStartupError（run 拒绝启动）。
 */
export async function startUnixBrokerRelay(input: {
  socketPath: string;
  target: BrokerRelayTarget;
  platform: NodeJS.Platform;
}): Promise<UnixBrokerRelayHandle> {
  const sockets = new Set<Socket>();
  const server = createNetServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    const upstream = netConnect(input.target.port, input.target.host);
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(input.socketPath);
    });
  } catch (error) {
    throw new FenceStartupError(
      "fence.startup_failed",
      input.platform,
      `宿主 AF_UNIX relay 监听 ${input.socketPath} 失败: ${relayErrorDetail(error)}`,
      { cause: error },
    );
  }
  try {
    await chmod(input.socketPath, RELAY_SOCKET_MODE);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new FenceStartupError(
      "fence.startup_failed",
      input.platform,
      `宿主 AF_UNIX relay socket 权限收紧失败: ${relayErrorDetail(error)}`,
      { cause: error },
    );
  }
  let closePromise: Promise<void> | undefined;
  return {
    socketPath: input.socketPath,
    // 幂等：teardown 重试与异常路径并发调用都安全；已关闭/已删除视为成功。
    close: () => {
      closePromise ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (error && code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
          });
        });
        try {
          await unlink(input.socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      })();
      return closePromise;
    },
  };
}
