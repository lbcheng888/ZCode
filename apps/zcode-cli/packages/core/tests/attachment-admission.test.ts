// P6：宿主附件事实从 prompt admission 绑定到回合事实，再到真实工具判定。
// 端到端证明远端 read_mostly 的命令执行工具在 build 模式下仍被 deny，本地会话不受影响。
import { describe, expect, it, vi } from "vitest";
import { createSessionId, SessionEventType, type PermissionBrokerPort } from "@zcode/contracts";
import type { HostAttachmentAdmissionFacts } from "@zcode/shared/zcode-protocol-v4";

import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import type { ToolEntry } from "../src/tool/types.js";

const alwaysAllowBroker: PermissionBrokerPort = {
  async requestPermission() {
    return { decision: "allow" };
  },
};

function bashProbeEntry(handler: () => Promise<unknown>): ToolEntry {
  return {
    ...bashToolEntry,
    metadata: {
      ...bashToolEntry.metadata,
      name: "Terminal",
      readOnly: false,
      destructive: true,
      concurrentSafe: false,
      sideEffectScope: "workspace",
      riskLevel: "high",
      needsApproval: true,
    },
    handler,
    // runtime 只读判定不能泄漏到测试：档位/矩阵只看 metadata 与工具名。
    resolvePermissionCapability: undefined,
    resolvePermissionRulePolicy: undefined,
  };
}

function createRuntime(input: {
  sessionId: ReturnType<typeof createSessionId>;
  handler: () => Promise<unknown>;
}) {
  const registry = createToolRegistry();
  registry.register(bashProbeEntry(input.handler));
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
          callIndex += 1;
          if (callIndex === 1) {
            return {
              finishReason: "tool-calls",
              providerMetadata: undefined,
              text: "",
              toolCalls: [{ id: "attachment-bash", name: "Terminal", input: { command: "echo x" } }],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never),
    },
  );
  return { runtime, eventStore };
}

function admissionOptions(inputId: string, attachment?: HostAttachmentAdmissionFacts) {
  return {
    inputId,
    queryId: inputId,
    ...(attachment ? { attachment } : {}),
    traceContext: {
      queryId: inputId,
      sessionId: createSessionId("attachment-admission-test"),
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

describe("P6 attachment admission → tool permission", () => {
  it("远端 read_mostly：admission 绑定后命令执行工具仍 deny，handler 不执行", async () => {
    const handler = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, interrupted: false }));
    const sessionId = createSessionId("attachment-admission-read-mostly");
    const { runtime, eventStore } = createRuntime({ sessionId, handler });

    const admission = await runtime.admitPrompt(
      "remote prompt",
      undefined,
      admissionOptions("cmd-remote", {
        source: "remote",
        attachment: { attachmentId: "mobile-1", role: "read_mostly" },
      }),
    );
    if (admission.kind !== "started") throw new Error("admission did not start");
    await admission.completion;

    expect(handler).not.toHaveBeenCalled();
    const denials = await permissionDenials(eventStore, sessionId);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.payload).toMatchObject({
      reason: expect.stringContaining("denies command_exec"),
    });
  });

  it("无 attachment 事实的本地会话：同一工具照常执行（字节兼容）", async () => {
    const handler = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, interrupted: false }));
    const sessionId = createSessionId("attachment-admission-local");
    const { runtime, eventStore } = createRuntime({ sessionId, handler });

    const admission = await runtime.admitPrompt(
      "local prompt",
      undefined,
      admissionOptions("cmd-local"),
    );
    if (admission.kind !== "started") throw new Error("admission did not start");
    await admission.completion;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await permissionDenials(eventStore, sessionId)).toHaveLength(0);
  });

  it("host 角色附件：沿用既有管线，工具照常执行", async () => {
    const handler = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, interrupted: false }));
    const sessionId = createSessionId("attachment-admission-host");
    const { runtime, eventStore } = createRuntime({ sessionId, handler });

    const admission = await runtime.admitPrompt(
      "desktop prompt",
      undefined,
      admissionOptions("cmd-host", {
        source: "local-host",
        attachment: { attachmentId: "desktop-1", role: "host" },
      }),
    );
    if (admission.kind !== "started") throw new Error("admission did not start");
    await admission.completion;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await permissionDenials(eventStore, sessionId)).toHaveLength(0);
  });
});
