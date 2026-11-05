/**
 * RPC-backed TriggerSink / schedule.audit 适配器（milestone-b-spec §3.2/§3.4/§4.4）。
 *
 * 本文件属于 `packages/services`，只定义窄端口与映射，**不** import bootstrap/server-cli，
 * 也不实现传输：真实 RPC 客户端由 server-core 装配层构造（`createControlPlaneClient`
 * 按 serverRoot 推导 socket 端点 + §3.8 凭据），再以 {@link SuperAgentControlPlaneRpcPort}
 * 注入。传输层负责 framing/zod/超时；本层只做：
 * - 通过 `trigger.ingest` 摄取事件，把 wire ACK 映射回 `TriggerSinkOutcome`（含 additive delivery）；
 * - 通过 `schedule.audit` 落调度审计行，失败原样上浮（调用方必须释放 claim，不得无审计直派）。
 *
 * 超时/传输错误只由端口实现负责（server-core 用 `createControlPlaneClient`，按 shared
 * §3.2 方法表计时）；本层不再保留第二套 deadline，避免同一请求两个计时器、两份预算。
 *
 * 失败语义：端口 reject 的错误原样上浮，调用方（botsService.processProviderCallback）
 * 会 `releaseInboundDelivery` 后由 provider 重投（§3.4/§3.6）。retriable 由传输层错误
 * （ControlPlaneRpcError）随 code 携带。
 */
import type {
  ControlPlaneTriggerEnvelope,
  ControlPlaneTriggerIngestResult,
  ScheduleAuditParams,
} from "@zcode/shared/super-agent-control-plane-protocol";
import type { TriggerSink, TriggerSinkEnvelope, TriggerSinkOutcome } from "./triggerSink.js";

/**
 * Core → child 数据面窄端口（§3.2 两个方法）。真实实现在 server-core 装配：
 * `triggerIngest` 委托 client.request("trigger.ingest", envelope)，
 * `scheduleAudit` 委托 client.request("schedule.audit", params)；返回值已由
 * `@zcode/shared` 的 zod schema 校验（controlPlaneClient 的 result 分支）。
 *
 * 端口实现**必须**承担 §3.6 代际判据：`handled:false` 只允许「starting 且本代际无任何
 * 崩溃信号」和 follower 两种窗口，crashed/crash-loop/曾 leader 后失效一律抛 retriable。
 * 本适配器只做 ACK 映射，不能靠单条结果猜测运行态；server-core 的端口实现负责该门禁。
 */
export interface SuperAgentControlPlaneRpcPort {
  triggerIngest(params: ControlPlaneTriggerEnvelope): Promise<ControlPlaneTriggerIngestResult>;
  scheduleAudit(params: ScheduleAuditParams): Promise<{ inserted: boolean }>;
}

/** trigger_events 审计入参（形状与 desktop scheduler `recordScheduleTriggerAudit` 同源）。 */
export interface SuperAgentScheduleAuditInput {
  workspaceIdentity: string;
  domainKey: string;
  providerMessageId: string;
  payloadSummary: Record<string, unknown>;
  now: number;
}

export interface SuperAgentScheduleAuditor {
  audit(input: SuperAgentScheduleAuditInput): Promise<{ inserted: boolean }>;
}

/** §3.2/§3.4 ACK → services 端口结果；wire 与 `TriggerSinkOutcome` 同构（delivery additive）。 */
export function createSuperAgentControlPlaneTriggerSink(
  port: SuperAgentControlPlaneRpcPort,
): TriggerSink {
  return {
    async ingest(envelope: TriggerSinkEnvelope): Promise<TriggerSinkOutcome> {
      const result = await port.triggerIngest(envelope);
      if (!result.handled) return { handled: false };
      return {
        handled: true,
        triggerId: result.triggerId,
        route: result.route,
        ...(result.delivery ? { delivery: result.delivery } : {}),
      };
    },
  };
}

/**
 * §4.4 scheduler 审计端口：claim 成功后调用；`inserted=false` = 同 providerMessageId
 * 已有行（幂等短路）。任何抛错都必须由调用方释放本轮 claim、下一 tick 重试，
 * 不得跳过审计继续直派。
 */
export function createSuperAgentControlPlaneScheduleAuditor(
  port: SuperAgentControlPlaneRpcPort,
): SuperAgentScheduleAuditor {
  return {
    async audit(input: SuperAgentScheduleAuditInput): Promise<{ inserted: boolean }> {
      return await port.scheduleAudit({
        workspaceIdentity: input.workspaceIdentity,
        domainKey: input.domainKey,
        providerMessageId: input.providerMessageId,
        payloadSummary: input.payloadSummary,
        now: input.now,
      });
    },
  };
}
