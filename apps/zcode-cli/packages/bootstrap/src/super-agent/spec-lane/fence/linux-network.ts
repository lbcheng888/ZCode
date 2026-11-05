/**
 * Linux 围栏网络连接面：veth 宿主端 broker relay + ip/nft 命令执行/清理。
 *
 * 与 executor 分离的原因：executor 负责任命周期/探测编排，本文件只承担
 * 「宿主 broker 在新 netns 不可达」的网络桥接与命令收敛，便于单独审查。
 */
import { execFile } from "node:child_process";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import { promisify } from "node:util";

import { FenceStartupError, type FenceChildBroker } from "./contract.js";
import {
  buildLinuxFenceTeardownCommands,
  type LinuxFenceNetworkPlan,
} from "./command-plan.js";

const execFileAsync = promisify(execFile);
const NETWORK_COMMAND_TIMEOUT_MS = 30_000;

export function networkErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: string }).stderr;
  const stdout = (error as Error & { stdout?: string }).stdout;
  const text = (stderr ?? "").trim() || (stdout ?? "").trim() || error.message;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export interface BrokerRelayHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * veth 宿主端 broker relay：原始 TCP 转发到宿主 loopback egress 代理。
 * 只转发 TCP 字节，不解释协议；allowlist 仍由 egress 代理裁决。监听地址必须是
 * veth 宿主地址（由 Linux 围栏 prepare 创建），不是 0.0.0.0。
 */
export async function startBrokerRelay(input: {
  listenHost: string;
  target: FenceChildBroker;
  platform: NodeJS.Platform;
}): Promise<BrokerRelayHandle> {
  const sockets = new Set<Socket>();
  const server = createNetServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    const upstream = netConnect(input.target.port, input.target.host);
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
      server.listen(0, input.listenHost);
    });
  } catch (error) {
    throw new FenceStartupError(
      "fence.startup_failed",
      input.platform,
      `broker relay 监听 ${input.listenHost} 失败: ${networkErrorDetail(error)}`,
      { cause: error },
    );
  }
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new FenceStartupError(
      "fence.startup_failed",
      input.platform,
      "broker relay 端口解析失败",
    );
  }
  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    // 幂等：teardown 在网络清理失败后重试时必须能再次调用且不因 server 已关闭而拒绝。
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
      })();
      return closePromise;
    },
  };
}

export async function execNetworkCommand(command: readonly string[]): Promise<void> {
  const file = command[0];
  if (!file) throw new Error("围栏命令为空");
  await execFileAsync(file, command.slice(1), {
    timeout: NETWORK_COMMAND_TIMEOUT_MS,
    encoding: "utf8",
  });
}

export async function execNetworkCommands(
  commands: readonly (readonly string[])[],
): Promise<void> {
  for (const command of commands) await execNetworkCommand(command);
}

/** 已消失的 namespace/接口是幂等成功；其它删除失败原样上报。 */
function isMissingNetworkResource(error: unknown): boolean {
  const detail = networkErrorDetail(error);
  return (
    /No such file or directory/i.test(detail) ||
    /No such device/i.test(detail) ||
    /Cannot find device/i.test(detail) ||
    /Cannot remove namespace file/i.test(detail)
  );
}

export async function cleanupLinuxNetwork(
  network: LinuxFenceNetworkPlan,
  ipPath: string,
): Promise<string | undefined> {
  for (const command of buildLinuxFenceTeardownCommands(network, { ipPath })) {
    try {
      await execNetworkCommand(command);
    } catch (error) {
      if (isMissingNetworkResource(error)) continue;
      return networkErrorDetail(error);
    }
  }
  return undefined;
}
