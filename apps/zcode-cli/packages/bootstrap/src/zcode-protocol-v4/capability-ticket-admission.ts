import { z } from "zod";
import {
  capabilityTicketBindingSchema,
  capabilityTicketIdSchema,
  capabilityTicketScopeSchema,
} from "@zcode/shared";
import { TRUSTED_V4_CONNECTION_FIELD } from "@zcode/shared/zcode-protocol-v4";

/**
 * P6 能力票据授权域的 CLI 执行侧读取（spec §2.5 C1/C2）。
 *
 * 生产者在宿主侧：Desktop broker 在命令入口校验票据后，把公开授权域写进可信连接
 * carrier（`packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts` 的
 * `capabilityTicket` 字段）。**carrier 不含 secret**；secret 只走 attachment 受控通道。
 *
 * 本模块只做结构与语义读取，不信任客户端顶层字段：客户端伪造的同名字段会在宿主
 * facade 被清掉；CLI 只读 `__zcodeTrustedV4Connection` 内的宿主真值。
 */

/** carrier 内的票据授权域键；必须与 services facade 的字段名逐字一致（测试钉住）。 */
export const TRUSTED_V4_CAPABILITY_TICKET_FIELD = "capabilityTicket";

export const capabilityTicketAuthorizationSchema = z
  .object({
    ticketId: capabilityTicketIdSchema,
    binding: capabilityTicketBindingSchema,
    scope: capabilityTicketScopeSchema,
    expiresAt: z.number().int().nonnegative(),
    revocationEpoch: z.number().int().nonnegative(),
    /**
     * P6 C2：宿主 admission 时宣告的真实凭据注入通道（公开事实）。CLI 据此决定
     * MCP/plugin 凭据类工具是否允许执行；真正的 scope 校验在宿主 resolver 前执行。
     */
    credentialInjection: z.enum(["host-interaction"]).optional(),
  })
  .strict();

export type CapabilityTicketAuthorization = z.infer<
  typeof capabilityTicketAuthorizationSchema
>;

/**
 * 从 v4 command 入参的可信连接 carrier 读取授权域。
 * - carrier/域缺席 ⇒ undefined（无票据语义，旧路径字节兼容）。
 * - 域在场但结构非法 ⇒ undefined（调用方在“命令声明了 ticketId”时按缺失 fail-closed）。
 */
export function readHostCapabilityTicketAuthorization(
  value: unknown,
): CapabilityTicketAuthorization | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const carrier = (value as Record<string, unknown>)[TRUSTED_V4_CONNECTION_FIELD];
  if (typeof carrier !== "object" || carrier === null) return undefined;
  const raw = (carrier as Record<string, unknown>)[TRUSTED_V4_CAPABILITY_TICKET_FIELD];
  if (raw === undefined) return undefined;
  const parsed = capabilityTicketAuthorizationSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 命令信封声明的票据句柄（公开、additive-optional）。只做结构读取；完整信封校验仍由
 * `parseCommandEnvelope` 负责。非法类型按“未声明”处理，随后由信封 schema 拒绝整条命令。
 */
export function readDeclaredCapabilityTicketId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const declared = (value as Record<string, unknown>)["capabilityTicketId"];
  return typeof declared === "string" && declared.length > 0 ? declared : undefined;
}

/** 命令声明了票据语义，但可信 carrier 里没有对应授权域 = 宿主接线错误，必须 fail-closed。 */
export class V4CapabilityTicketAuthorizationError extends Error {
  readonly reasonCode = "ticket.authorization_missing";

  constructor(message: string) {
    super(message);
    this.name = "V4CapabilityTicketAuthorizationError";
  }
}
