// v4 命令的准入事实访问器。
//
// 独立成文件的原因：所有 native handler 都需要读取 __v4Admission（附件/票据/队列事实），
// 而 executor 又依赖 handlers 注册表。把访问器留在 executor 会形成
// executor → handlers → executor 的运行时环，ESM 循环在不同导入顺序下会让 handler
// 组 spread 到 undefined（resolveInteraction 等整组静默消失）。本模块只依赖 shared
// 类型，不反向依赖 executor/handlers，环由此断开。
import type { CommandEnvelope, HostAttachmentAdmissionFacts } from "@zcode/shared/zcode-protocol-v4";
import type { CapabilityTicketAuthorization } from "../capability-ticket-admission.js";

export interface V4CommandAdmission {
  admissionSeq: number;
  admittedAt: number;
  queueItemId: string;
  /**
   * P6：本次命令所属连接的宿主附件事实（gateway 从 Host 覆写字段读取）。
   * 缺失 = 无 attachment 语义，保持 host 现状。
   */
  attachment?: HostAttachmentAdmissionFacts;
  /**
   * P6：本次命令的宿主 broker 已验证票据授权域（公开事实，无 secret）。
   * 缺失 = 本命令未声明 ticketId（旧路径）；在场则本 turn 的工具准入按 scope 只收紧。
   */
  capabilityTicket?: CapabilityTicketAuthorization;
}

export interface V4CommandExecutionContext {
  /** 内部 auto-drain 必须在 reserve 前由 handler 原子校验 Core idle。 */
  autoDrainPromotion?: true;
}

export type V4AdmittedCommandEnvelope = CommandEnvelope & {
  __v4Admission?: V4CommandAdmission;
  __v4ExecutionContext?: V4CommandExecutionContext;
};

export function commandAdmissionOf(envelope: CommandEnvelope): V4CommandAdmission {
  return (
    (envelope as V4AdmittedCommandEnvelope).__v4Admission ?? {
      admissionSeq: 0,
      admittedAt: Date.now(),
      queueItemId: `queue_${envelope.commandId}`,
    }
  );
}

export function commandExecutionContextOf(
  envelope: CommandEnvelope,
): V4CommandExecutionContext | undefined {
  return (envelope as V4AdmittedCommandEnvelope).__v4ExecutionContext;
}

/** 本次命令的宿主附件事实；所有会启动 turn 的 handler 必须原样传给 prompt admission。 */
export function commandAttachmentOf(
  envelope: CommandEnvelope,
): HostAttachmentAdmissionFacts | undefined {
  return commandAdmissionOf(envelope).attachment;
}

/** 本次命令的票据授权域；所有会启动 turn 的 handler 必须原样传给 prompt admission。 */
export function commandCapabilityTicketOf(
  envelope: CommandEnvelope,
): CapabilityTicketAuthorization | undefined {
  return commandAdmissionOf(envelope).capabilityTicket;
}
