// M4 mandate×permission 排序矩阵的「生产者→消费」端到端：
// 真 prompt admission（bindTurnPermissionFacts）→ 真 runtime 回合 → 真工具执行 →
// PermissionService 同步 fail-closed 门。模型只做脚本化应答，不联网。
import { describe, expect, it, vi } from "vitest";
import { createSessionId, SessionEventType, type PermissionBrokerPort } from "@zcode/contracts";

import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import type { ToolEntry } from "../src/tool/types.js";
import type { PromptAdmissionMandateFacts } from "../src/runtime/types.js";

const PROBE_TOOL_NAME = "MandateProbeWrite";

const alwaysAllowBroker: PermissionBrokerPort = {
  async requestPermission() {
    return { decision: "allow" };
  },
};

function probeToolEntry(handler: () => Promise<unknown>): ToolEntry {
  return {
    ...bashToolEntry,
    metadata: {
      ...bashToolEntry.metadata,
      name: PROBE_TOOL_NAME,
      description: "Test-only write tool used to exercise the mandate permission gate",
      readOnly: false,
      destructive: false,
      concurrentSafe: false,
      sideEffectScope: "workspace",
      riskLevel: "medium",
      needsApproval: true,
    },
    permission: {
      ...bashToolEntry.permission,
      permission: "mandateProbeWrite",
      reason: "Test-only workspace write",
      riskLevel: "medium",
      sideEffectScope: "workspace",
      needsApproval: true,
    },
    handler,
    // Bash 的运行时只读判定/规则策略不能泄漏到测试工具：档位判定只认 metadata。
    resolvePermissionCapability: undefined,
    resolvePermissionRulePolicy: undefined,
  };
}

type ScriptedTurn =
  | { kind: "tool_call" }
  | { kind: "stop"; text: string };

function createRuntime(input: {
  sessionId: ReturnType<typeof createSessionId>;
  script: ScriptedTurn[];
  handler: () => Promise<unknown>;
}) {
  const registry = createToolRegistry();
  registry.register(probeToolEntry(input.handler));
  const eventStore = createTestSessionEventStore();
  let callIndex = 0;
  const runtime = createTestAgentRuntime(
    input.sessionId,
    { mode: "build" },
    {
      eventStore,
      toolRegistry: registry,
      permissionBroker: alwaysAllowBroker,
      modelFactory: createTestModelFactory({
        async generateText() {
          const step = input.script[callIndex] ?? { kind: "stop", text: "done" };
          callIndex += 1;
          if (step.kind === "tool_call") {
            return {
              finishReason: "tool-calls",
              providerMetadata: undefined,
              text: "",
              toolCalls: [
                {
                  id: "mandate-probe-call",
                  name: PROBE_TOOL_NAME,
                  input: { command: "echo probe" },
                },
              ],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            text: step.text,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never),
    },
  );
  return { runtime, eventStore };
}

function admissionOptions(inputId: string, facts?: PromptAdmissionMandateFacts) {
  return {
    inputId,
    queryId: inputId,
    ...(facts
      ? {
          triggerSource: "trigger" as const,
          mandateFacts: facts,
        }
      : {}),
    traceContext: {
      queryId: inputId,
      sessionId: createSessionId("mandate-admission-test"),
      traceId: `trace-${inputId}`,
    },
  } as never;
}

async function permissionDenials(
  eventStore: ReturnType<typeof createTestSessionEventStore>,
  sessionId: ReturnType<typeof createSessionId>,
) {
  return (await eventStore.getEvents(sessionId)).filter(
    (event) => event.type === SessionEventType.PermissionDenied,
  );
}

describe("M4 mandate producer → permission consumer（admission 端到端）", () => {
  it("event 回合 auto 档带 mandateId：写工具放行到既有管线（broker 允许后执行）", async () => {
    const handler = vi.fn(async () => ({
      stdout: "probe",
      stderr: "",
      exitCode: 0,
      interrupted: false,
    }));
    const sessionId = createSessionId("mandate-admission-auto");
    const { runtime, eventStore } = createRuntime({
      sessionId,
      script: [{ kind: "tool_call" }, { kind: "stop", text: "done" }],
      handler,
    });

    const admission = await runtime.admitPrompt(
      "event write",
      undefined,
      admissionOptions("cmd-auto", {
        triggerId: "trigger-auto",
        tier: "auto",
        mandateId: "m-auto",
        expiresAt: Date.now() + 60_000,
      }),
    );
    expect(admission.kind).toBe("started");
    if (admission.kind !== "started") return;
    await admission.completion;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await permissionDenials(eventStore, sessionId)).toHaveLength(0);
  });

  it("record_only 档撞写操作：门在最前端 deny，handler 不执行", async () => {
    const handler = vi.fn(async () => ({
      stdout: "probe",
      stderr: "",
      exitCode: 0,
      interrupted: false,
    }));
    const sessionId = createSessionId("mandate-admission-record-only");
    const { runtime, eventStore } = createRuntime({
      sessionId,
      script: [{ kind: "tool_call" }, { kind: "stop", text: "denied" }],
      handler,
    });

    const admission = await runtime.admitPrompt(
      "event write",
      undefined,
      admissionOptions("cmd-record", {
        triggerId: "trigger-record",
        tier: "record_only",
        mandateId: "m-record",
      }),
    );
    if (admission.kind !== "started") throw new Error("admission did not start");
    await admission.completion;

    expect(handler).not.toHaveBeenCalled();
    const denials = await permissionDenials(eventStore, sessionId);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.payload).toMatchObject({
      reason: expect.stringContaining("Record-only mandate"),
    });
  });

  it("auto 档缺 mandateId：deny（例外③）", async () => {
    const handler = vi.fn(async () => ({
      stdout: "probe",
      stderr: "",
      exitCode: 0,
      interrupted: false,
    }));
    const sessionId = createSessionId("mandate-admission-missing-id");
    const { runtime, eventStore } = createRuntime({
      sessionId,
      script: [{ kind: "tool_call" }, { kind: "stop", text: "denied" }],
      handler,
    });

    const admission = await runtime.admitPrompt(
      "event write",
      undefined,
      admissionOptions("cmd-no-id", {
        triggerId: "trigger-no-id",
        tier: "auto",
      }),
    );
    if (admission.kind !== "started") throw new Error("admission did not start");
    await admission.completion;

    expect(handler).not.toHaveBeenCalled();
    const denials = await permissionDenials(eventStore, sessionId);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.payload).toMatchObject({
      reason: expect.stringContaining("must carry a mandateId"),
    });
  });

  it("过期 mandate：deny；turn 内不重新解析，下一 admission 边界才变化", async () => {
    const handler = vi.fn(async () => ({
      stdout: "probe",
      stderr: "",
      exitCode: 0,
      interrupted: false,
    }));
    const sessionId = createSessionId("mandate-admission-expired");
    const { runtime, eventStore } = createRuntime({
      sessionId,
      script: [{ kind: "tool_call" }, { kind: "stop", text: "denied" }],
      handler,
    });

    const admission = await runtime.admitPrompt(
      "event write",
      undefined,
      admissionOptions("cmd-expired", {
        triggerId: "trigger-expired",
        tier: "auto",
        mandateId: "m-expired",
        expiresAt: Date.now() - 1,
      }),
    );
    if (admission.kind !== "started") throw new Error("admission did not start");
    await admission.completion;

    expect(handler).not.toHaveBeenCalled();
    const denials = await permissionDenials(eventStore, sessionId);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.payload).toMatchObject({
      reason: expect.stringContaining("Mandate expired"),
    });
  });

  it("无 facts 的 user 回合：既有判定不变（build ask → broker allow → 执行）", async () => {
    const handler = vi.fn(async () => ({
      stdout: "probe",
      stderr: "",
      exitCode: 0,
      interrupted: false,
    }));
    const sessionId = createSessionId("mandate-admission-user");
    const { runtime, eventStore } = createRuntime({
      sessionId,
      script: [{ kind: "tool_call" }, { kind: "stop", text: "done" }],
      handler,
    });

    const admission = await runtime.admitPrompt(
      "user write",
      undefined,
      admissionOptions("cmd-user"),
    );
    if (admission.kind !== "started") throw new Error("admission did not start");
    await admission.completion;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await permissionDenials(eventStore, sessionId)).toHaveLength(0);
  });

  it("复用同一 queryId 的后续 user 回合不得继承上一个事件回合的绑定", async () => {
    // 客户端可重复使用 commandId(queryId)；事件回合结束后绑定必须按 turnId 失配，
    // 否则一个 user 回合会被旧 record_only/auto 结论误判。
    const handler = vi.fn(async () => ({
      stdout: "probe",
      stderr: "",
      exitCode: 0,
      interrupted: false,
    }));
    const sessionId = createSessionId("mandate-admission-reuse");
    const { runtime, eventStore } = createRuntime({
      sessionId,
      script: [
        // 第一轮（事件、record_only）：工具调用被 deny，随后收尾。
        { kind: "tool_call" },
        { kind: "stop", text: "denied" },
        // 第二轮（user）：工具调用应放行并执行，随后收尾。
        { kind: "tool_call" },
        { kind: "stop", text: "done" },
      ],
      handler,
    });

    const eventAdmission = await runtime.admitPrompt(
      "event write",
      undefined,
      admissionOptions("cmd-reuse", {
        triggerId: "trigger-reuse",
        tier: "record_only",
        mandateId: "m-reuse",
      }),
    );
    if (eventAdmission.kind !== "started") throw new Error("event admission did not start");
    await eventAdmission.completion;
    // completion resolve 发生在 turn finally 之后，但 runtime drain 收口还要一个宏任务。
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handler).not.toHaveBeenCalled();

    // 同一 commandId/queryId 的后续 user 输入（无 facts）：不得命中旧绑定。
    const userAdmission = await runtime.admitPrompt(
      "user write",
      undefined,
      admissionOptions("cmd-reuse"),
    );
    expect(userAdmission.kind).toBe("started");
    if (userAdmission.kind !== "started") return;
    await userAdmission.completion;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await permissionDenials(eventStore, sessionId)).toHaveLength(1);
  });

  it("trigger 来源但缺 mandateFacts：admission 响亮失败，不静默按 user 放行", async () => {
    const { runtime } = createRuntime({
      sessionId: createSessionId("mandate-admission-missing-facts"),
      script: [{ kind: "stop", text: "unreachable" }],
      handler: vi.fn(),
    });

    await expect(
      runtime.admitPrompt("event write", undefined, {
        ...admissionOptions("cmd-missing-facts"),
        triggerSource: "trigger",
      } as never),
    ).rejects.toThrow(/缺少 mandateFacts/);
  });

  it("生产形态：只传 inputId（不传 queryId/triggerSource），由 facts 自行推导回合身份", async () => {
    // 生产路径 input-facade 只交 inputId + mandateFacts（来源由信封推导后随 sendInput
    // 传入，测试这里再省掉 triggerSource，验证 Core 自身推导仍然成立）。
    const handler = vi.fn(async () => ({
      stdout: "probe",
      stderr: "",
      exitCode: 0,
      interrupted: false,
    }));
    const sessionId = createSessionId("mandate-admission-input-id-only");
    const { runtime, eventStore } = createRuntime({
      sessionId,
      script: [{ kind: "tool_call" }, { kind: "stop", text: "done" }],
      handler,
    });

    const admission = await runtime.admitPrompt("event write", undefined, {
      inputId: "cmd-input-id-only",
      mandateFacts: {
        triggerId: "trigger-input-id-only",
        tier: "auto",
        mandateId: "m-input-id-only",
        expiresAt: Date.now() + 60_000,
      },
    } as never);
    expect(admission.kind).toBe("started");
    if (admission.kind !== "started") return;
    await admission.completion;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await permissionDenials(eventStore, sessionId)).toHaveLength(0);
  });
});
