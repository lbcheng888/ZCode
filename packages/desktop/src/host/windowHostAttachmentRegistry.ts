import {
  attachmentRoleSchema,
  resolveDeviceScopeKey,
  resolveHostAttachmentRole,
  type AttachmentRole,
  type ClientKind,
  type WindowHostAttachmentScope,
} from "@zcode/shared";
import type { ZCodeAgentV4ClientMode } from "@zcode/services";

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
}) {
  const attachments = new Map<string, TrackedAttachment<TServices, TPort, TCapabilities>>();

  function disposeTracked(tracked: TrackedAttachment<TServices, TPort, TCapabilities>): void {
    if (tracked.disposed) {
      return;
    }
    tracked.disposed = true;
    tracked.handle.dispose();
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
    const exposedParams: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities> = {
      requestId: params.requestId,
      attachmentId: params.attachmentId,
      clientMode: params.clientMode,
      scope: params.scope,
      role,
      ...(deviceScopeKey !== undefined ? { deviceScopeKey } : {}),
      services: resolved.services,
      generation: resolved.generation,
      ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
      port: params.port,
    };
    const handle = options.expose(exposedParams);
    const tracked: TrackedAttachment<TServices, TPort, TCapabilities> = {
      params: exposedParams,
      handle,
      disposed: false,
    };
    const previous = attachments.get(params.attachmentId);
    attachments.set(params.attachmentId, tracked);
    if (previous) {
      disposeTracked(previous);
    }
    params.port.once("close", () => {
      if (attachments.get(params.attachmentId) !== tracked) {
        return;
      }
      attachments.delete(params.attachmentId);
      disposeTracked(tracked);
    });
  }

  function detach(attachmentId: string): void {
    const tracked = attachments.get(attachmentId);
    if (!tracked) {
      return;
    }
    attachments.delete(attachmentId);
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
        generation: tracked.params.generation,
      })),
    dispose(): void {
      for (const tracked of attachments.values()) {
        disposeTracked(tracked);
      }
      attachments.clear();
    },
  };
}
