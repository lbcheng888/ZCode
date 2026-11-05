import { MessagePortProtocol, ChannelClient } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import {
  createCapabilityTicketChannelConnection,
  type CapabilityTicketChannelConnection,
} from "./capabilityTicketChannel.js";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import { isRendererProductionBuild } from "./rendererLoggingEnv.js";

function logMessagePortDebug(message: string): void {
  // 生产构建下 renderer 连接日志不输出，避免窗口启动和重连路径产生同步 console 成本。
  if (isRendererProductionBuild()) {
    return;
  }
  console.log(message);
}

export interface MessagePortServiceConnection {
  services: IServiceAccessor;
  /**
   * P6 能力票据通道。被动监听：只在 attachment port 上识别宿主投递的受控帧，
   * 不影响 RPC 字节流。未收到 delivery 时 `ticket` 为 undefined（host 未启用票据 /
   * 该 attachment 是 local 来源）。
   */
  capabilityTickets: CapabilityTicketChannelConnection;
  dispose: (reason?: Error) => void;
}

/**
 * 创建一个带明确生命周期的 MessagePort service connection。
 *
 * scoped remote session 换代时必须同时释放 ChannelClient 和底层 port，
 * 否则旧 attachment 上的挂起 RPC 无法 settle，并会继续占用上层去重状态。
 */
export function createMessagePortServiceConnection(
  port: MessagePort,
  options: { sourceServerManagementService?: boolean } = {},
): MessagePortServiceConnection {
  logMessagePortDebug("[messageport] creating protocol and client...");
  // P6：必须在 MessagePortProtocol 构造前注册票据通道监听。宿主在 attach 时就把
  // delivery 帧 post 到另一端，port 未 start 时消息排队；协议构造会 start()，此时
  // 两个监听都已就位，不会丢帧。票据通道只消费非 Uint8Array 控制对象。
  const capabilityTickets = createCapabilityTicketChannelConnection({ port });
  const protocol = new MessagePortProtocol(port);
  const client = new ChannelClient(protocol);
  client.onDidInitialize(() => {
    logMessagePortDebug("[messageport] ChannelClient received Initialize from server");
  });
  logMessagePortDebug("[messageport] client created, waiting for Initialize...");

  const services = new RemoteServiceAccess(client, options);
  let disposed = false;
  return {
    services,
    capabilityTickets,
    dispose: (reason?: Error) => {
      if (disposed) {
        return;
      }
      disposed = true;
      capabilityTickets.dispose();
      client.dispose(reason);
      protocol.disconnect();
    },
  };
}

/**
 * 通过 MessagePort 连接服务。
 *
 * Desktop 模式下，utilityProcess（或 main 进程的远程代理）通过 MessagePort
 * 暴露 ChannelServer，renderer 用此函数建立 ChannelClient 连接。
 *
 * 注意：本便捷入口只返回 `services`，**丢弃** `capabilityTickets` 通道。P6 票据命令
 * 信封的客户端接线尚未落地：renderer 没有把 `protocolFields()` 写进命令，生产 UI 命令
 * 不携带 `capabilityTicketId`（见 P6 spec §2.5 已知残留与宿主启动告警）。需要票据语义的
 * 调用方必须改用 `createMessagePortServiceConnection` 并显式携带该公开字段。
 */
export function connectViaMessagePort(
  port: MessagePort,
  options: { sourceServerManagementService?: boolean } = {},
): IServiceAccessor {
  return createMessagePortServiceConnection(port, options).services;
}
