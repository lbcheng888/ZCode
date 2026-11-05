import type { AttachmentRole } from "@zcode/shared";
import type { HostAttachmentAdmissionFacts } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeAgentV4ClientMode } from "@zcode/services";

/**
 * P6：Desktop attachment 在 v4 连接上的权威事实来源。角色每次从 registry 现取，
 * 不缓存 attach 时快照——宿主 setRole / detach 必须在下一命令 admission 前生效（spec §1.4）。
 */
export interface HostAttachmentProjectionSource {
  attachmentId: string;
  deviceScopeKey?: string;
  resolveRole: () => AttachmentRole | undefined;
}

/**
 * 构造连接级附件事实。`attachment` 是 getter：services facade 把该对象写进可信连接
 * carrier 后，每次命令序列化 / CLI 读取都会重新求值，因此角色变更立即可见；registry
 * 返回 undefined（吊销/已 detach）时省略 role，CLI 准入层据此直接 deny。
 */
export function createHostAttachmentAdmissionContext(
  source: HostAttachmentProjectionSource | undefined,
  clientMode: ZCodeAgentV4ClientMode,
): HostAttachmentAdmissionFacts | undefined {
  if (!source) return undefined;
  return {
    source: clientMode === "desktop-continuous" ? "local-host" : "remote",
    get attachment(): NonNullable<HostAttachmentAdmissionFacts["attachment"]> {
      const role = source.resolveRole();
      return {
        attachmentId: source.attachmentId,
        ...(role !== undefined ? { role } : {}),
        ...(source.deviceScopeKey !== undefined ? { deviceScopeKey: source.deviceScopeKey } : {}),
        deviceKind: clientMode === "desktop-continuous" ? "desktop" : "web",
      };
    },
  };
}
