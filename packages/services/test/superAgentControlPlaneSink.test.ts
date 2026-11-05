import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneTriggerIngestResult } from "@zcode/shared/super-agent-control-plane-protocol";
import {
  createSuperAgentControlPlaneScheduleAuditor,
  createSuperAgentControlPlaneTriggerSink,
  type SuperAgentControlPlaneRpcPort,
} from "../src/bots/superAgentControlPlaneSink.js";
import type { TriggerSinkEnvelope } from "../src/bots/triggerSink.js";

/**
 * milestone-b-spec §3.4/§4.4：RPC 端口 → services 端口的映射。
 * 真实 socket 链路在 superAgentControlPlaneSink.integration.test.ts。
 */

function envelope(): TriggerSinkEnvelope {
  return {
    workspaceIdentity: "ws-1",
    source: "im",
    provider: "webhook",
    providerMessageId: "message-1",
    threadKeyHint: "bot:bot-1+user-1",
    actor: { kind: "human", id: "user-1" },
    payload: { botId: "bot-1", text: "hello" },
    taint: true,
  };
}

function portWith(
  triggerIngest: SuperAgentControlPlaneRpcPort["triggerIngest"],
  scheduleAudit: SuperAgentControlPlaneRpcPort["scheduleAudit"] = async () => ({
    inserted: true,
  }),
): SuperAgentControlPlaneRpcPort {
  return { triggerIngest, scheduleAudit };
}

describe("createSuperAgentControlPlaneTriggerSink（§3.4 ACK 映射）", () => {
  it("handled=true 原样映射 triggerId/route + additive delivery", async () => {
    const triggerIngest = vi.fn(async (): Promise<ControlPlaneTriggerIngestResult> => ({
      handled: true,
      triggerId: "trigger-1",
      route: "owned",
      delivery: "delivery_failed",
    }));
    const sink = createSuperAgentControlPlaneTriggerSink(portWith(triggerIngest));

    await expect(sink.ingest(envelope())).resolves.toEqual({
      handled: true,
      triggerId: "trigger-1",
      route: "owned",
      delivery: "delivery_failed",
    });
    expect(triggerIngest).toHaveBeenCalledWith(envelope());
  });

  it("handled=false（follower/启动窗口）保持 legacy 直路语义", async () => {
    const sink = createSuperAgentControlPlaneTriggerSink(
      portWith(async () => ({ handled: false })),
    );
    await expect(sink.ingest(envelope())).resolves.toEqual({ handled: false });
  });

  it("rejected 终态仍 handled=true，且不携带 delivery", async () => {
    const sink = createSuperAgentControlPlaneTriggerSink(
      portWith(async () => ({ handled: true, triggerId: "trigger-1", route: "rejected" })),
    );
    await expect(sink.ingest(envelope())).resolves.toEqual({
      handled: true,
      triggerId: "trigger-1",
      route: "rejected",
    });
  });

  it("端口错误原样上浮（code/retriable 保留，供 webhook 映射 503）", async () => {
    const error = Object.assign(new Error("workspace.failed: db busy"), {
      code: "workspace.failed",
      retriable: true,
    });
    const sink = createSuperAgentControlPlaneTriggerSink(
      portWith(async () => {
        throw error;
      }),
    );

    await expect(sink.ingest(envelope())).rejects.toBe(error);
  });

  it("端口 rpc.timeout 错误原样上浮（超时只由传输层负责，适配器不另起 deadline）", async () => {
    const timeout = Object.assign(new Error("rpc.timeout: trigger.ingest"), {
      code: "rpc.timeout",
      retriable: true,
    });
    const sink = createSuperAgentControlPlaneTriggerSink(
      portWith(async () => {
        throw timeout;
      }),
    );

    await expect(sink.ingest(envelope())).rejects.toBe(timeout);
  });
});

describe("createSuperAgentControlPlaneScheduleAuditor（§4.4）", () => {
  it("映射审计入参并透传 inserted（幂等短路 false）", async () => {
    const scheduleAudit = vi
      .fn<SuperAgentControlPlaneRpcPort["scheduleAudit"]>()
      .mockResolvedValueOnce({ inserted: true })
      .mockResolvedValueOnce({ inserted: false });
    const auditor = createSuperAgentControlPlaneScheduleAuditor(
      portWith(async () => ({ handled: false }), scheduleAudit),
    );
    const input = {
      workspaceIdentity: "ws-1",
      domainKey: "automation-1",
      providerMessageId: "run-1",
      payloadSummary: { automationId: "automation-1", runId: "run-1" },
      now: 1_700_000_000_000,
    };

    await expect(auditor.audit(input)).resolves.toEqual({ inserted: true });
    await expect(auditor.audit(input)).resolves.toEqual({ inserted: false });
    expect(scheduleAudit).toHaveBeenNthCalledWith(1, {
      ...input,
      payloadSummary: input.payloadSummary,
    });
    expect(scheduleAudit).toHaveBeenCalledTimes(2);
  });

  it("审计失败原样上浮（调用方必须释放 claim）", async () => {
    const error = Object.assign(new Error("workspace.notEnsured"), {
      code: "workspace.notEnsured",
      retriable: false,
    });
    const auditor = createSuperAgentControlPlaneScheduleAuditor(
      portWith(async () => ({ handled: false }), async () => {
        throw error;
      }),
    );

    await expect(
      auditor.audit({
        workspaceIdentity: "ws-1",
        domainKey: "automation-1",
        providerMessageId: "run-1",
        payloadSummary: {},
        now: 1,
      }),
    ).rejects.toBe(error);
  });

  it("端口 rpc.timeout 原样上浮（无第二套 deadline）", async () => {
    const timeout = Object.assign(new Error("rpc.timeout: schedule.audit"), {
      code: "rpc.timeout",
      retriable: true,
    });
    const auditor = createSuperAgentControlPlaneScheduleAuditor(
      portWith(async () => ({ handled: false }), async () => {
        throw timeout;
      }),
    );

    await expect(
      auditor.audit({
        workspaceIdentity: "ws-1",
        domainKey: "automation-1",
        providerMessageId: "run-1",
        payloadSummary: {},
        now: 1,
      }),
    ).rejects.toBe(timeout);
  });
});
