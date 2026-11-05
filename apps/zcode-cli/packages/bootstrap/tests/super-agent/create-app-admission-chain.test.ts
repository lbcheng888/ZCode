// 宿主准入接缝集成回归（a-services-host-seams findings）：
// 真 create-app 装配 → 真控制面 triggerSink → 真 handleCommand 包装（mandateGate 登记）
// → 宿主 sendText（带 triggerSource）→ input-facade 按 commandId 取出 resolution
// → Core prompt admission → 真工具权限门。
//
// 只替身测试域内的模型（脚本化生成，不联网）与会话存储；控制面/域库/权限管线全部真实。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ModelResult } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { PromptAdmissionOptions, PromptAdmissionReceipt } from "@zcode/core";
import { promptTriggerSourceOf } from "@zcode/core";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { afterEach, describe, expect, it } from "vitest";

import type { SendInputOptions, ZCodeApp } from "../../src/app/types.js";
import {
  createRegistryBackedTestApp as createZCodeApp,
  type RegistryBackedTestModelExecutor,
} from "../helpers/registry-backed-test-app.js";

const roots: string[] = [];
const apps: ZCodeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.close?.();
    } catch {
      // 断言后的关闭失败不掩盖用例失败。
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function stopResult(): ModelResult {
  return {
    finishReason: "stop",
    providerMetadata: undefined,
    text: "ok",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function writeCallResult(input: {
  filePath: string;
}): ModelResult {
  return {
    finishReason: "tool-calls",
    providerMetadata: undefined,
    text: "",
    toolCalls: [
      {
        id: "admission-chain-write",
        name: "Write",
        input: { content: "probe", file_path: input.filePath },
      },
    ],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function scriptedExecutor(steps: ModelResult[]): RegistryBackedTestModelExecutor {
  let index = 0;
  return {
    async generateText(): Promise<ModelResult> {
      const step = steps[index] ?? stopResult();
      index += 1;
      return step;
    },
  };
}

interface AdmissionCall {
  inputId?: string;
  triggerSource?: PromptAdmissionOptions["triggerSource"];
  mandateFacts?: PromptAdmissionOptions["mandateFacts"];
}

interface Harness {
  app: ZCodeApp;
  root: string;
  calls: AdmissionCall[];
  receipts: PromptAdmissionReceipt[];
  handleCommand: (raw: unknown) => Promise<CommandAck>;
  events: Array<{ type: string; payload?: unknown }>;
}

/** 等价 TUI/协议宿主的 sendText 入口：inputId=commandId，triggerId 推导 triggerSource。 */
function deliveryOptionsOf(
  requestedDelivery: unknown,
): Pick<SendInputOptions, "delivery" | "queueDelivery"> {
  if (requestedDelivery === "queue") return { delivery: "auto", queueDelivery: "queue" };
  if (requestedDelivery === "guide") {
    return { delivery: "steer_active_turn", queueDelivery: "guide" };
  }
  return { delivery: "start_turn" };
}

function rejectedAck(commandId: string, reason: string): CommandAck {
  return { commandId, reasonCode: reason, revisionAtDecision: 0, status: "rejected" };
}

async function createApp(options: {
  eventRouter: boolean;
  mandateGate: boolean;
  steps?: (root: string) => ModelResult[];
}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "zcode-sa-admission-chain-"));
  roots.push(root);
  const userConfigPath = join(root, "config.json");
  const features: Record<string, boolean> = {};
  if (options.eventRouter) features.eventRouter = true;
  if (options.mandateGate) features.mandateGate = true;
  await writeFile(userConfigPath, JSON.stringify({ features }));

  const calls: AdmissionCall[] = [];
  const receipts: PromptAdmissionReceipt[] = [];
  const events: Array<{ type: string; payload?: unknown }> = [];
  let appRef: ZCodeApp | undefined;

  const handleCommand = async (raw: unknown): Promise<CommandAck> => {
    const envelope = raw as CommandEnvelope;
    const app = appRef;
    if (!app) throw new Error("宿主 handleCommand 在 app 绑定前被调用");
    if (envelope.sessionId === null || envelope.sessionId !== app.sessionId) {
      return rejectedAck(envelope.commandId, "tui.sessionNotHosted");
    }
    const payload = envelope.payload as { text?: unknown; requestedDelivery?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      return rejectedAck(envelope.commandId, "proto.invalidPayload");
    }
    const result = await app.sendInput(payload.text, {
      inputId: envelope.commandId,
      // 生产宿主（TUI / 协议 gateway）同一接线：信封带 triggerId 时把来源交给 Core。
      ...(envelope.triggerId ? { triggerSource: promptTriggerSourceOf(envelope) } : {}),
      ...deliveryOptionsOf(payload.requestedDelivery),
    });
    if (result.kind === "rejected") {
      return rejectedAck(envelope.commandId, result.reason);
    }
    return { commandId: envelope.commandId, revisionAtDecision: 0, status: "accepted" };
  };

  const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
  const app = await createZCodeApp({
    env: {},
    modelExecutor: scriptedExecutor(options.steps?.(root) ?? []),
    runtimeConfig: { workingDirectory: root },
    sessionStore,
    superAgent: {
      handleCommand,
      autoReplyGuard: { admit: async () => true },
      superAgentDatabasePath: join(root, "super-agent.sqlite"),
    },
    userConfigPath,
  });
  appRef = app;
  apps.push(app);

  // 真 runtime 的 admission 观察点：不替身 admission，只截取 Core 实际收到的 options。
  const runtime = app.runtime as unknown as {
    admitPrompt: (
      input: string,
      attachments: unknown,
      options?: PromptAdmissionOptions,
    ) => Promise<PromptAdmissionReceipt>;
  };
  const originalAdmitPrompt = app.runtime.admitPrompt.bind(app.runtime);
  runtime.admitPrompt = async (input, attachments, admissionOptions) => {
    calls.push({
      inputId: admissionOptions?.inputId,
      triggerSource: admissionOptions?.triggerSource,
      mandateFacts: admissionOptions?.mandateFacts,
    });
    const receipt = await originalAdmitPrompt(
      input,
      attachments as never,
      admissionOptions,
    );
    receipts.push(receipt);
    return receipt;
  };
  app.runtime.subscribeEvents({
    onSessionEvent: (event) => {
      events.push(event as { type: string; payload?: unknown });
    },
  });

  return { app, calls, events, handleCommand, receipts, root };
}

async function awaitStartedReceipt(harness: Harness, index = 0): Promise<void> {
  const receipt = harness.receipts[index];
  if (!receipt) throw new Error("admission receipt 缺失（宿主投递未进入 Core）");
  if (receipt.kind !== "started") {
    throw new Error(`admission 未起步: ${receipt.kind}`);
  }
  await receipt.completion;
}

describe("create-app 装配链 × M4 mandateFacts", () => {
  it("human-explicit：免 Mandate，Core 收到 user-origin（无 facts / 无 triggerSource）", async () => {
    const harness = await createApp({ eventRouter: true, mandateGate: true });
    const plane = harness.app.superAgentControlPlane;
    if (!plane) throw new Error("eventRouter=true 未装配控制面");
    const outcome = await plane.triggerSink.ingest({
      actor: { id: "u1", kind: "human" },
      payload: { botId: "human-bot", chatType: "private", text: "人类显式消息" },
      provider: "feishu",
      providerMessageId: "pm-chain-human",
      source: "im",
      taint: true,
      threadKeyHint: "bot:human-bot+u1",
      workspaceIdentity: harness.root,
    });
    expect(outcome).toMatchObject({ handled: true, route: "human_explicit" });

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.mandateFacts).toBeUndefined();
    expect(harness.calls[0]?.triggerSource).toBeUndefined();
    await awaitStartedReceipt(harness);
  });

  it("owned 事件：隐式 record_only facts 进 Core，写工具被 mandate 门 deny", async () => {
    const harness = await createApp({
      eventRouter: true,
      mandateGate: true,
      steps: (root) => [writeCallResult({ filePath: join(root, "probe.txt") })],
    });
    const plane = harness.app.superAgentControlPlane;
    if (!plane) throw new Error("eventRouter=true 未装配控制面");
    const threadKey = `${harness.root}|bot:env-bot+u2`;
    plane.contracts.trigger.upsertSubscription({
      lane: "followup",
      ownerKind: "session",
      sessionId: harness.app.sessionId,
      threadKey,
      workspaceIdentity: harness.root,
    });
    const outcome = await plane.triggerSink.ingest({
      actor: { id: "u2", kind: "human" },
      payload: { botId: "env-bot", chatType: "private", text: "订阅线程事件" },
      provider: "feishu",
      providerMessageId: "pm-chain-owned",
      source: "im",
      taint: true,
      threadKeyHint: "bot:env-bot+u2",
      workspaceIdentity: harness.root,
    });
    expect(outcome).toMatchObject({ handled: true, route: "owned" });

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.mandateFacts).toMatchObject({
      tier: "record_only",
      triggerId: outcome.handled ? outcome.triggerId : "",
    });
    expect(harness.calls[0]?.triggerSource).toBe("trigger");

    await awaitStartedReceipt(harness);
    const denials = harness.events.filter(
      (event) => event.type === SessionEventType.PermissionDenied,
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]?.payload).toMatchObject({
      reason: expect.stringContaining("Record-only mandate"),
    });
  });

  it("flag 关（eventRouter=false）：Core 收到的 options 不含 mandateFacts / triggerSource", async () => {
    const harness = await createApp({ eventRouter: false, mandateGate: false });
    expect(harness.app.superAgentControlPlane).toBeUndefined();
    const ack = await harness.handleCommand({
      clientId: "cli",
      commandId: "cmd-user-flag-off",
      payload: { requestedDelivery: "startNow", text: "普通用户输入" },
      sessionId: harness.app.sessionId,
      type: "sendText",
    });
    expect(ack.status).toBe("accepted");
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.mandateFacts).toBeUndefined();
    expect(harness.calls[0]?.triggerSource).toBeUndefined();
    await awaitStartedReceipt(harness);
  });

  it("mandateGate 单独打开（eventRouter 关）：启动期响亮失败，不静默失效", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-sa-admission-gate-only-"));
    roots.push(root);
    const userConfigPath = join(root, "config.json");
    await writeFile(userConfigPath, JSON.stringify({ features: { mandateGate: true } }));
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    await expect(
      createZCodeApp({
        env: {},
        runtimeConfig: { workingDirectory: root },
        sessionStore,
        userConfigPath,
      }),
    ).rejects.toThrow(/features\.mandateGate=true 依赖 features\.eventRouter=true/);
    sessionStore.close();
  });
});
