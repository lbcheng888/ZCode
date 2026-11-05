import { z } from "zod";
import {
  attachmentRoleSchema,
  clientKindSchema,
  type AttachmentRole,
} from "../attachment-role.js";

/**
 * P6 设备权限矩阵的协议面（docs/architecture/super-agent-p6-capabilities-spec.md §1.3）。
 *
 * 两种面严格分开：
 * - `attachmentHelloProjectionSchema` 是 **host → client** 的只读投影，只为 UI 展示附件角色；
 *   客户端拿它做任何准入判断都是越权。
 * - `HostAttachmentAdmissionFacts` 只存在于 Host 写入的 v4 command params 里，是 Desktop
 *   attachment registry 的权威角色快照。客户端自报的字段在 Host 侧被覆盖，不能提权。
 *
 * 角色缺失（registry 已吊销/查不到）不是 read_mostly：调用方必须直接 deny。远端连接连
 * attachment 元数据都没有时才是 read_mostly fail-closed。
 */

/** host → client hello 的 additive-optional 附件投影（协议 bump；旧客户端需同步 schema）。 */
export const attachmentHelloProjectionSchema = z.object({
  attachmentId: z.string().min(1),
  role: attachmentRoleSchema,
  /** `workspaceIdentity\0surfaceKind`；local scope 没有 workspace 时缺席。 */
  deviceScopeKey: z.string().min(1).optional(),
  deviceKind: clientKindSchema.optional(),
});
export type AttachmentHelloProjection = z.infer<typeof attachmentHelloProjectionSchema>;

/**
 * v4 可信连接 carrier 键（与 `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`
 * 的 `TRUSTED_CONNECTION_FIELD` 必须同值）。CLI 侧不依赖 services 包，因此在这里用共享
 * 常量读取；services facade 会删除调用方传入的同名键并写入 Host 真值，客户端无法伪造。
 * 修改任一侧必须同步，另一侧有测试钉住字面值。
 */
export const TRUSTED_V4_CONNECTION_FIELD = "__zcodeTrustedV4Connection";

export const hostAttachmentAdmissionSchema = z
  .object({
    /**
     * 连接来源。`local-host` = Desktop 本机连续连接/进程内会话；`remote` = web/mobile/远端
     * attachment。来源必须由 Host 显式给出，不能靠字段是否存在推断（spec §1.3 规则 4）。
     */
    source: z.enum(["local-host", "remote"]),
    attachment: z
      .object({
        attachmentId: z.string().min(1),
        /**
         * 宿主 registry 派生的权威角色。**缺席 = 已吊销/查不到**，准入直接 deny；
         * 不是 read_mostly，也不能落到 host。
         */
        role: attachmentRoleSchema.optional(),
        deviceScopeKey: z.string().min(1).optional(),
        deviceKind: clientKindSchema.optional(),
        deviceId: z.string().min(1).optional(),
        workspaceIdentity: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict();
export type HostAttachmentAdmissionFacts = z.infer<typeof hostAttachmentAdmissionSchema>;

/**
 * 从 v4 command params 的**可信连接 carrier**读取 Host 权威附件事实。
 *
 * - carrier/attachment 缺席 = 无 attachment 语义（CLI/TUI/旧宿主）：返回 undefined，
 *   调用方按 host 保持现状。
 * - attachment 在场但解析失败 = Host 接线错误：按 `remote` 最受限来源 fail-closed，
 *   绝不静默落到 host。
 */
export function readHostAttachmentAdmissionFacts(
  value: unknown,
): HostAttachmentAdmissionFacts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const carrier = (value as Record<string, unknown>)[TRUSTED_V4_CONNECTION_FIELD];
  if (typeof carrier !== "object" || carrier === null) return undefined;
  const carrierRecord = carrier as Record<string, unknown>;
  const raw = carrierRecord.attachment;
  if (raw === undefined) {
    // 远端可重放连接但宿主没登记 attachment 记录：按 read_mostly fail-closed（D4）。
    // clientMode 是 Host 写入可信 carrier 的事实；本地进程内会话没有 carrier，保持现状。
    return carrierRecord.clientMode === "web-remote-replayable" ? { source: "remote" } : undefined;
  }
  const parsed = hostAttachmentAdmissionSchema.safeParse(raw);
  return parsed.success ? parsed.data : { source: "remote" };
}

/**
 * 附件事实的有效角色。`undefined` 有两种含义，调用方必须用 `attachmentFactsRevoked`
 * 区分：事实整体缺失 = 无 attachment 语义（host 现状）；attachment 在场但 role 缺失 =
 * 已吊销（必须 deny，不能降成 read_mostly）。
 */
export function effectiveAttachmentAdmissionRole(
  facts: HostAttachmentAdmissionFacts | undefined,
): AttachmentRole | undefined {
  if (facts === undefined) return undefined;
  if (facts.attachment === undefined) {
    return facts.source === "remote" ? "read_mostly" : undefined;
  }
  return facts.attachment.role;
}

export function attachmentFactsRevoked(facts: HostAttachmentAdmissionFacts | undefined): boolean {
  return facts?.attachment !== undefined && facts.attachment.role === undefined;
}

const ATTACHMENT_ROLE_STRICTNESS: Record<AttachmentRole, number> = {
  host: 0,
  interactive: 1,
  read_mostly: 2,
};

/**
 * 取两份附件事实中更严的一份（deny/吊销 > read_mostly > interactive > host；无事实 =
 * host 语义）。排队输入提升时用 `compose(入队来源事实, 当前连接事实)`：远端入队的文本
 * 不能因为被宿主连接提升就继承 host 角色（spec §1.4「提升边界也要复核」）。
 */
export function composeAttachmentAdmissionFacts(
  origin: HostAttachmentAdmissionFacts | undefined,
  current: HostAttachmentAdmissionFacts | undefined,
): HostAttachmentAdmissionFacts | undefined {
  if (origin === undefined) return current;
  if (current === undefined) return origin;
  if (attachmentFactsRevoked(origin)) return origin;
  if (attachmentFactsRevoked(current)) return current;
  const originRole = effectiveAttachmentAdmissionRole(origin);
  const currentRole = effectiveAttachmentAdmissionRole(current);
  const originStrictness =
    originRole === undefined ? ATTACHMENT_ROLE_STRICTNESS.host : ATTACHMENT_ROLE_STRICTNESS[originRole];
  const currentStrictness =
    currentRole === undefined
      ? ATTACHMENT_ROLE_STRICTNESS.host
      : ATTACHMENT_ROLE_STRICTNESS[currentRole];
  return originStrictness >= currentStrictness ? origin : current;
}
