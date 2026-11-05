import {
  attachmentRoleSchema,
  deriveCapabilityTicketScopeForRole,
  resolveDeviceScopeKey,
  resolveHostAttachmentRole,
  type AttachmentRole,
  type CapabilityTicketBinding,
  type CapabilityTicketScope,
  type ClientKind,
  type WindowHostAttachmentScope,
} from "@zcode/shared";
import type { ZCodeAgentV4ClientMode } from "@zcode/services";
import type { CapabilityTicketBroker } from "./capabilityTicketBroker.js";

/**
 * 票据 secret 的受控通道。宿主必须在连接级受控面（例如专用兑换握手 / 凭据传输帧）投递，
 * **不得**把 secret 放进 expose 参数、协议 command payload、日志、SQLite 或模型上下文。
 */
export interface WindowHostCapabilityTicketDelivery {
  ticketId: string;
  ticketSecret: string;
  expiresAt: number;
  /** 签发时 broker 的吊销 epoch；兑换必须原样带回，旧值 broker 直接 deny。 */
  revocationEpoch: number;
  binding: CapabilityTicketBinding;
  scope: CapabilityTicketScope;
}

export interface WindowHostCapabilityTickets {
  broker: CapabilityTicketBroker;
  deliverSecret: (attachmentId: string, delivery: WindowHostCapabilityTicketDelivery) => void;
}

export interface WindowHostAttachmentPort {
  once(event: "close", listener: () => void): unknown;
}

export interface WindowHostAttachmentHandle {
  dispose(): void;
}

export interface WindowHostResolvedAttachmentScope<TServices, TCapabilities = never> {
  services: TServices;
  generation: number;
  capabilities?: TCapabilities;
}

export interface WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities = never> {
  requestId: string;
  attachmentId: string;
  clientMode: ZCodeAgentV4ClientMode;
  scope: WindowHostAttachmentScope;
  /**
   * 宿主派生的权威角色（P6 §1.3）。由 registry 在 attach 时写入；暴露层/准入层只能读它，
   * 不能接受客户端自报角色。
   */
  role: AttachmentRole;
  /** `workspaceIdentity\0surfaceKind`；local scope 没有 workspaceIdentity 时为 undefined。 */
  deviceScopeKey?: string;
  /** P6 能力票据的公开句柄；secret 走 deliverSecret 受控通道，绝不进入本参数。 */
  capabilityTicketId?: string;
  services: TServices;
  generation: number;
  capabilities?: TCapabilities;
  port: TPort;
}

interface TrackedAttachment<TServices, TPort, TCapabilities = never> {
  params: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities>;
  handle: WindowHostAttachmentHandle;
  disposed: boolean;
}

function surfaceKindForClientMode(clientMode: ZCodeAgentV4ClientMode): ClientKind {
  // 宿主无法从 clientMode 区分 mobileRemote / mobileApp，只按可信的连续 vs 可重放二分；
  // clientKind 若来自客户端仍是提示，不参与这里的权威计算。
  return clientMode === "desktop-continuous" ? "desktop" : "web";
}

export function createWindowHostAttachmentRegistry<
  TServices,
  TPort extends WindowHostAttachmentPort,
  TCapabilities = never,
>(options: {
  resolveScope: (
    scope: WindowHostAttachmentScope,
  ) => WindowHostResolvedAttachmentScope<TServices, TCapabilities>;
  expose: (
    params: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities>,
  ) => WindowHostAttachmentHandle;
  /**
   * P6 能力票据接线（可选）。未配置时 attach 行为与现状 bit-exact（无 ticket 字段）。
   * 配置后：remote attachment 建立即签发 sequential 票据（绑定 session subject），
   * detach/close/替换/角色变更即时吊销；签发或 secret 投递任一步失败都回滚并原样抛错。
   */
  capabilityTickets?: WindowHostCapabilityTickets;
}) {
  const attachments = new Map<string, TrackedAttachment<TServices, TPort, TCapabilities>>();

  function disposeTracked(tracked: TrackedAttachment<TServices, TPort, TCapabilities>): void {
    if (tracked.disposed) {
      return;
    }
    tracked.disposed = true;
    tracked.handle.dispose();
  }

  /**
   * 为 attachment 签发票据并只把公开 ticketId 写进 expose 参数。secret 只经
   * deliverSecret 受控通道投递，不在任何返回值/参数/日志里出现。
   *
   * 只有 remote attachment 有执行侧的 run/session 主体：绑定 subject 用所属
   * remoteSessionId（spec §2.3 要求 subject 必填）。local / source-settings 没有远端执行面
   * 主体，不签发票据（宿主本机沿用既有权限管线）。不得用合成 id 伪造 subject。
   *
   * 签名失败（issue 或 deliverSecret 抛错）必须回滚已签发票据，否则会留下 registry 查不到、
   * 却仍能在 TTL 内兑换的孤儿授权；失败原样上抛，不降级成“无票据继续 attach”。
   */
  function issueCapabilityTicketForAttachment(params: {
    attachmentId: string;
    clientMode: ZCodeAgentV4ClientMode;
    scope: WindowHostAttachmentScope;
    role: AttachmentRole;
  }): string | undefined {
    const tickets = options.capabilityTickets;
    if (!tickets) return undefined;
    if (params.scope.kind !== "remote") return undefined;
    const binding: CapabilityTicketBinding = {
      workspaceIdentity: params.scope.workspaceIdentity,
      attachmentId: params.attachmentId,
      surfaceKind: surfaceKindForClientMode(params.clientMode),
      subject: { kind: "session", id: params.scope.remoteSessionId },
    };
    const scope = deriveCapabilityTicketScopeForRole(params.role);
    let issued: ReturnType<CapabilityTicketBroker["issue"]> | undefined;
    try {
      issued = tickets.broker.issue({
        binding,
        scope,
        role: params.role,
        mode: "sequential",
      });
      tickets.deliverSecret(params.attachmentId, {
        ticketId: issued.ticket.ticketId,
        ticketSecret: issued.ticketSecret,
        expiresAt: issued.ticket.expiresAt,
        revocationEpoch: issued.ticket.revocationEpoch,
        binding,
        scope,
      });
    } catch (error) {
      if (issued !== undefined) {
        tickets.broker.revoke(issued.ticket.ticketId);
      }
      throw error;
    }
    if (issued === undefined) {
      throw new Error("Capability ticket issue returned no ticket");
    }
    return issued.ticket.ticketId;
  }

  function attach(params: {
    requestId: string;
    attachmentId: string;
    clientMode: ZCodeAgentV4ClientMode;
    scope: WindowHostAttachmentScope;
    port: TPort;
  }): void {
    if (params.clientMode === "web-remote-replayable" && params.scope.kind === "source-settings") {
      throw new Error("Source settings attachments are Desktop-only");
    }
    // scope 必须先由 Host registry 验证；验证失败时不能影响同 attachmentId 的现有端口。
    const resolved = options.resolveScope(params.scope);
    // 角色只从宿主注入的 clientMode 派生；客户端没有任何自报角色的入口。
    // interactive 只能由宿主随后经 setRole 显式授予。
    const role = resolveHostAttachmentRole({ clientMode: params.clientMode });
    if (role === undefined) {
      // 吊销的 attachment 不允许继续暴露服务；attach 入参当前不带 revoked，这里只是让
      // 未来调用方无法把“吊销”静默降级成 read_mostly。
      throw new Error("Revoked attachment cannot be attached");
    }
    const workspaceIdentity =
      params.scope.kind === "remote" ? params.scope.workspaceIdentity : undefined;
    const deviceScopeKey = workspaceIdentity
      ? resolveDeviceScopeKey({
          workspaceIdentity,
          surfaceKind: surfaceKindForClientMode(params.clientMode),
        })
      : undefined;
    // 机会式清理终态票据；不做定时轮询，避免 records Map 在宿主生命周期内无界增长。
    options.capabilityTickets?.broker.sweepExpired();
    const previous = attachments.get(params.attachmentId);
    if (previous) {
      // 替换同 attachmentId：先吊销旧票据，再签发新票据，避免旧 secret 在替换窗口继续兑换。
      options.capabilityTickets?.broker.revokeByAttachment(params.attachmentId);
    }
    const capabilityTicketId = issueCapabilityTicketForAttachment({
      attachmentId: params.attachmentId,
      clientMode: params.clientMode,
      scope: params.scope,
      role,
    });
    const exposedParams: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities> = {
      requestId: params.requestId,
      attachmentId: params.attachmentId,
      clientMode: params.clientMode,
      scope: params.scope,
      role,
      ...(deviceScopeKey !== undefined ? { deviceScopeKey } : {}),
      ...(capabilityTicketId !== undefined ? { capabilityTicketId } : {}),
      services: resolved.services,
      generation: resolved.generation,
      ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
      port: params.port,
    };
    let handle: WindowHostAttachmentHandle;
    try {
      handle = options.expose(exposedParams);
    } catch (error) {
      // expose 失败时不能留下无宿主的票据。
      if (capabilityTicketId !== undefined) {
        options.capabilityTickets?.broker.revoke(capabilityTicketId);
      }
      throw error;
    }
    const tracked: TrackedAttachment<TServices, TPort, TCapabilities> = {
      params: exposedParams,
      handle,
      disposed: false,
    };
    attachments.set(params.attachmentId, tracked);
    if (previous) {
      disposeTracked(previous);
    }
    params.port.once("close", () => {
      if (attachments.get(params.attachmentId) !== tracked) {
        return;
      }
      attachments.delete(params.attachmentId);
      options.capabilityTickets?.broker.revokeByAttachment(params.attachmentId);
      disposeTracked(tracked);
    });
  }

  function detach(attachmentId: string): void {
    const tracked = attachments.get(attachmentId);
    if (!tracked) {
      return;
    }
    attachments.delete(attachmentId);
    options.capabilityTickets?.broker.revokeByAttachment(attachmentId);
    disposeTracked(tracked);
  }

  function detachStaleRemoteSessionAttachments(
    remoteSessionId: string,
    currentGeneration: number,
  ): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "remote" ||
        tracked.params.scope.remoteSessionId !== remoteSessionId ||
        tracked.params.generation === currentGeneration
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      options.capabilityTickets?.broker.revokeByAttachment(attachmentId);
      disposeTracked(tracked);
    }
  }

  function detachRemoteSessionAttachments(remoteSessionId: string): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "remote" ||
        tracked.params.scope.remoteSessionId !== remoteSessionId
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      options.capabilityTickets?.broker.revokeByAttachment(attachmentId);
      disposeTracked(tracked);
    }
  }

  function detachSourceSettingsAttachments(sourceServerId: string): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "source-settings" ||
        tracked.params.scope.sourceServerId !== sourceServerId
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      options.capabilityTickets?.broker.revokeByAttachment(attachmentId);
      disposeTracked(tracked);
    }
  }

  /**
   * 宿主权威角色。attachment 不存在/已 detach/已吊销/port 已 close 时返回 undefined；
   * 准入层必须直接拒绝（spec §1.4 吊销即时生效 / D5），不能把 undefined 当 host，
   * 也不能当成 read_mostly 继续执行。每次 admission 都必须重新调用本方法，不得缓存
   * expose 时拿到的角色。
   */
  function getRole(attachmentId: string): AttachmentRole | undefined {
    const tracked = attachments.get(attachmentId);
    if (!tracked || tracked.disposed) return undefined;
    return tracked.params.role;
  }

  /**
   * 宿主显式调整角色（spec：只允许 host 授予/收回 interactive）；变更即时生效。
   * 原地更新同一个 params 对象：expose 回调拿到的引用也能看到新角色，避免出现两份
   * 互相矛盾的角色真值。准入层仍须每次调用 getRole，不得缓存。
   */
  function setRole(attachmentId: string, role: AttachmentRole): boolean {
    const tracked = attachments.get(attachmentId);
    if (!tracked || tracked.disposed) return false;
    const parsed = attachmentRoleSchema.safeParse(role);
    if (!parsed.success) {
      throw new Error(`Invalid attachment role: ${String(role)}`);
    }
    if (parsed.data === "host" && tracked.params.role !== "host") {
      throw new Error("host role can only be derived from a desktop-continuous attachment");
    }
    if (parsed.data !== tracked.params.role) {
      // 角色变更 = scope 变更。顺序关键：先吊销旧票据（推进 epoch），再签发新票据，让新票据
      // 的 epoch 快照等于 broker 当前值；反过来先签发再吊销会让新票据立刻带着旧 epoch、
      // 永远兑换失败。
      //
      // 失败语义：吊销旧的之后若签发/投递失败，helper 会回滚新票据并原样抛错；角色保持原值，
      // 但旧票据已被吊销 → 该 attachment 在重新 attach 前没有可用票据（fail-closed，绝不
      // 留旧 scope 的授权继续可兑换）。
      const previousTicketId = tracked.params.capabilityTicketId;
      if (previousTicketId !== undefined) {
        options.capabilityTickets?.broker.revoke(previousTicketId);
      }
      const nextTicketId = issueCapabilityTicketForAttachment({
        attachmentId: tracked.params.attachmentId,
        clientMode: tracked.params.clientMode,
        scope: tracked.params.scope,
        role: parsed.data,
      });
      tracked.params.role = parsed.data;
      if (nextTicketId !== undefined) {
        tracked.params.capabilityTicketId = nextTicketId;
      } else {
        delete tracked.params.capabilityTicketId;
      }
      return true;
    }
    tracked.params.role = parsed.data;
    return true;
  }

  return {
    attach,
    detach,
    detachRemoteSessionAttachments,
    detachSourceSettingsAttachments,
    detachStaleRemoteSessionAttachments,
    getRole,
    setRole,
    size: () => attachments.size,
    list: () =>
      Array.from(attachments.values(), (tracked) => ({
        requestId: tracked.params.requestId,
        attachmentId: tracked.params.attachmentId,
        clientMode: tracked.params.clientMode,
        scope: tracked.params.scope,
        role: tracked.params.role,
        ...(tracked.params.deviceScopeKey !== undefined
          ? { deviceScopeKey: tracked.params.deviceScopeKey }
          : {}),
        ...(tracked.params.capabilityTicketId !== undefined
          ? { capabilityTicketId: tracked.params.capabilityTicketId }
          : {}),
        generation: tracked.params.generation,
      })),
    dispose(): void {
      for (const tracked of attachments.values()) {
        options.capabilityTickets?.broker.revokeByAttachment(tracked.params.attachmentId);
        disposeTracked(tracked);
      }
      attachments.clear();
    },
  };
}
