import type { IChannel } from "@zcode/rpc";
import {
  capabilityTicketAdmissionRelayPolicySchema,
  capabilityTicketAdmissionRelayRequestSchema,
  capabilityTicketAdmissionRelayResultSchema,
  type CapabilityTicketBinding,
  type CapabilityTicketFailureCode,
} from "@zcode/shared";
import type { ZCodeAgentOfficialMcpCapabilityTicketAuthority } from "./zcodeAgentService.js";

/**
 * P6 C2：desktop-attached remote host 的 admission 回连权威。
 *
 * broker 与角色权威只在 Desktop Host 进程；远端执行宿主（source server / remote
 * server）没有票据记录，也不能伪造授权域。宿主通过**已鉴权的 host 连接私有反向频道**
 * 把 `{ticketId, binding}` 原样回传 Desktop Host，由 broker 现场 admit。响应只含公开
 * 事实（scope/binding/expiry/epoch/credentialInjection），零 secret。
 *
 * 多连接语义：同一远端宿主可能同时连接多个 Desktop Host。每条 host 连接的 broker
 * 只知道自己签发的票据，因此这里对全部已挂载频道逐个 admit，任一成功即放行；全部
 * 拒绝时返回首个非 unknown 的 typed code（没有 peer 时为 broker_unavailable）。
 * 这不是“任取一个宽松答案”：频道只存在于通过 host capability 鉴权的 desktop
 * continuous 连接，属于同一信任边界。
 */

/**
 * 单个 admission 往返上限。远端 Desktop 已断连/卡死时不能把 agent 的身份头请求
 * 无限挂住；超时按该 peer 不可用处理，继续尝试其它 peer，全部失败即 fail-closed。
 */
const CAPABILITY_TICKET_ADMISSION_TIMEOUT_MS = 10_000;

interface AdmissionPeer {
  channel: IChannel;
  /**
   * Desktop Host 的 ticketPolicy 回答：
   * - `true`：已确认票据启用，永久保持（即使之后 RPC 失败也绝不退回放行）；
   * - `false`：已确认票据关闭（合法回答），缓存避免每次身份头请求都多一次 RPC；
   * - `undefined`：频道不存在/旧 Desktop/探测失败，下次请求再试（不能把“暂时不可达”
   *   永久当成票据关闭）。
   */
  ticketRequired: boolean | undefined;
}

async function probeTicketRequired(channel: IChannel): Promise<boolean | undefined> {
  try {
    const raw = await withTimeout(
      channel.call<unknown>("ticketPolicy"),
      CAPABILITY_TICKET_ADMISSION_TIMEOUT_MS,
    );
    const parsed = capabilityTicketAdmissionRelayPolicySchema.safeParse(raw);
    if (!parsed.success) return undefined;
    return parsed.data.ticketRequired;
  } catch {
    // 频道不存在/旧 Desktop/断连：无法证明票据已启用 ⇒ 不建票据门，下次再试。
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("capability ticket admission relay timed out"));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface CapabilityTicketAdmissionPeers {
  authority: ZCodeAgentOfficialMcpCapabilityTicketAuthority;
  /** 挂载一条 host 连接的反向频道；返回的 dispose 必须在连接关闭时调用。 */
  attach(channel: IChannel): { dispose(): void };
  /** 是否有至少一条 desktop host 连接可按票据回连 broker。 */
  hasPeers(): boolean;
}

export function createCapabilityTicketAdmissionPeers(): CapabilityTicketAdmissionPeers {
  const peers = new Set<AdmissionPeer>();

  const authority: ZCodeAgentOfficialMcpCapabilityTicketAuthority = {
    async admit(input: { ticketId: string; binding: CapabilityTicketBinding }) {
      if (peers.size === 0) {
        return { ok: false as const, code: "ticket.broker_unavailable" as const };
      }
      // 请求结构先由本进程 schema 校验；频道端还会再校验一次，不信任跨进程入参。
      const request = capabilityTicketAdmissionRelayRequestSchema.safeParse(input);
      if (!request.success) {
        return { ok: false as const, code: "ticket.binding_mismatch" as const };
      }
      let sawDenial: CapabilityTicketFailureCode | undefined;
      let sawResponse = false;
      for (const peer of peers) {
        try {
          const raw = await withTimeout(
            peer.channel.call<unknown>("admit", request.data),
            CAPABILITY_TICKET_ADMISSION_TIMEOUT_MS,
          );
          const parsed = capabilityTicketAdmissionRelayResultSchema.safeParse(raw);
          if (!parsed.success) {
            // 频道回复非法结构 = 该 peer 接线错误；按不可用处理，继续其它 peer。
            sawResponse = true;
            continue;
          }
          if (parsed.data.ok) {
            return parsed.data;
          }
          sawResponse = true;
          if (parsed.data.code !== "ticket.unknown") {
            sawDenial = parsed.data.code;
          } else if (sawDenial === undefined) {
            sawDenial = parsed.data.code;
          }
        } catch {
          // 断连/超时：该 peer 当前不可用；不把它当成放行，也不立刻终止其它 peer 的复核。
        }
      }
      return {
        ok: false as const,
        code: !sawResponse
          ? ("ticket.broker_unavailable" as const)
          : (sawDenial ?? ("ticket.unknown" as const)),
      };
    },
    // 只有 Desktop Host 明确回答 ticketPolicy=true 的执行面才拒绝漏带票据的请求；
    // 旧 Desktop / 票据关闭时探测返回 false，保留无票据旧路径。
    requireTicketForRequests: async () => {
      for (const peer of peers) {
        if (peer.ticketRequired === true) return true;
        if (peer.ticketRequired === false) continue;
        const required = await probeTicketRequired(peer.channel);
        if (required === undefined) continue;
        peer.ticketRequired = required;
        if (required) return true;
      }
      return false;
    },
  };

  return {
    authority,
    attach(channel: IChannel) {
      const peer: AdmissionPeer = { channel, ticketRequired: undefined };
      peers.add(peer);
      return {
        dispose() {
          peers.delete(peer);
        },
      };
    },
    hasPeers() {
      return peers.size > 0;
    },
  };
}
