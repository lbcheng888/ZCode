import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import type { CapabilityTicketAuthorization } from "../src/permission/capability-ticket.js";

const TICKET_AUTHORIZATION: CapabilityTicketAuthorization = {
  ticketId: "ticket-test",
  binding: {
    workspaceIdentity: "workspace-test",
    attachmentId: "attachment-test",
    surfaceKind: "desktop",
    subject: { kind: "session", id: "prompt-admission-test" },
  },
  scope: { toolClasses: ["read"] },
  expiresAt: 2_000,
  revocationEpoch: 0,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createRuntime(
  sessionKey: string,
  generateText: (input: unknown) => Promise<unknown>,
  config: Record<string, unknown> = {},
) {
  return new AgentRuntime(
    createSessionId(sessionKey),
    {
      mode: "build",
      modelSelection: { providerId: "test-provider", modelId: "test-model" },
      ...config,
    },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({ generateText: generateText as never }),
    },
  );
}

function admissionOptions(inputId: string) {
  return {
    inputId,
    queryId: inputId,
    traceContext: {
      queryId: inputId,
      sessionId: createSessionId("prompt-admission-test"),
      traceId: `trace-${inputId}`,
    },
  } as never;
}

describe("AgentRuntime prompt admission", () => {
  it("keeps requireQueue input queued even when the runtime is idle", async () => {
    let modelCalls = 0;
    const runtime = createRuntime("prompt-admission-require-queue", async () => {
      modelCalls += 1;
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const admission = await runtime.admitPrompt("future turn", undefined, {
      ...admissionOptions("require-queue"),
      automationId: "automation-queued",
      requireQueue: true,
    });

    expect(admission.kind).toBe("queued");
    expect(modelCalls).toBe(0);
    expect((await runtime.getProjection()).pendingSteerInputs).toEqual([
      expect.objectContaining({ automationId: "automation-queued" }),
    ]);
  });


  it("admits inject input to the next-step inbox without starting a turn while idle", async () => {
    let modelCalls = 0;
    const runtime = createRuntime(
      "prompt-admission-inject-idle",
      async () => {
        modelCalls += 1;
        return {
          finishReason: "stop",
          text: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      { goalLayerEnabled: true },
    );

    // inject 目标(设计 §3.5):绝不唤醒——idle 时也不 start turn,只落 next-step 收件箱。
    const admission = await runtime.admitPrompt("ambient context", undefined, {
      ...admissionOptions("inject-idle"),
      queueDelivery: "inject",
    });

    expect(admission.kind).toBe("queued");
    expect(modelCalls).toBe(0);
    const projection = await runtime.getProjection();
    const queued = projection.pendingSteerInputs.find(
      (item) => item.pendingInputId === (admission as { pendingInputId?: string }).pendingInputId,
    );
    expect(queued?.delivery).toBe("inject");
  });

  it("recognizes the inject lane even when the goal layer flag is off", async () => {
    // 设计 M11 Remove 清单已删 inject→queue 降级残留:inject 车道恒可用,不因关旗而降级。
    const runtime = createRuntime("prompt-admission-inject-off", async () => ({
      finishReason: "stop",
      text: "done",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));

    const admission = await runtime.admitPrompt("ambient context", undefined, {
      ...admissionOptions("inject-off"),
      queueDelivery: "inject",
    });

    // 关旗仍落 inject 收件箱,不降级为普通 queue 起轮。
    expect(admission.kind).toBe("queued");
    if (admission.kind !== "queued") throw new Error("inject request was not queued");
    const projection = await runtime.getProjection();
    const queued = projection.pendingSteerInputs.find(
      (item) => item.pendingInputId === (admission as { pendingInputId?: string }).pendingInputId,
    );
    expect(queued?.delivery).toBe("inject");
  });

  it("rejects queued capability-ticket input instead of deferring the authorization domain", async () => {
    const runtime = createRuntime("prompt-admission-ticket-queue", async () => ({
      finishReason: "stop",
      text: "done",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));

    await expect(
      runtime.admitPrompt("ticket queue", undefined, {
        ...admissionOptions("ticket-queue"),
        requireQueue: true,
        capabilityTicket: TICKET_AUTHORIZATION,
      }),
    ).rejects.toThrow(/capability ticket admission cannot be deferred/);
  });

  it("rejects inject capability-ticket input instead of deferring the authorization domain", async () => {
    const runtime = createRuntime("prompt-admission-ticket-inject", async () => ({
      finishReason: "stop",
      text: "done",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));

    await expect(
      runtime.admitPrompt("ticket inject", undefined, {
        ...admissionOptions("ticket-inject"),
        queueDelivery: "inject",
        capabilityTicket: TICKET_AUTHORIZATION,
      }),
    ).rejects.toThrow(/capability ticket admission cannot be deferred/);
  });

  it("keeps a direct inject steer on the inject lane when the goal layer flag is off", async () => {
    const modelGate = deferred<unknown>();
    const modelStarted = deferred<void>();
    const runtime = createRuntime("prompt-admission-inject-steer-off", async () => {
      modelStarted.resolve();
      await modelGate.promise;
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const first = await runtime.admitPrompt("first", undefined, admissionOptions("first"));
    if (first.kind !== "started") throw new Error("first prompt was not admitted");
    await modelStarted.promise;

    await runtime.steerTurn({ delivery: "inject", input: "ambient steer" });
    const projection = await runtime.getProjection();
    // 关旗也不降级:steer inject 仍落 inject 车道。
    expect(projection.pendingSteerInputs.map((item) => [item.input, item.delivery])).toEqual([
      ["ambient steer", "inject"],
    ]);

    modelGate.resolve(undefined);
    await first.completion;
  });

  it("reserves before the first turn reaches TurnStarted, so the second prompt is queued", async () => {
    const modelGate = deferred<unknown>();
    let modelCalls = 0;
    const runtime = createRuntime("prompt-admission-reservation", async () => {
      modelCalls += 1;
      await modelGate.promise;
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const first = await runtime.admitPrompt("first", undefined, admissionOptions("first"));
    const second = await runtime.admitPrompt("second", undefined, admissionOptions("second"));

    if (first.kind !== "started") throw new Error("first prompt was not admitted");
    if (second.kind !== "queued") throw new Error("second prompt was not queued");
    expect(modelCalls).toBeLessThanOrEqual(1);

    modelGate.resolve(undefined);
    await first.completion;
  });

  it("queues against activeTurn after the reservation is promoted", async () => {
    const modelGate = deferred<unknown>();
    const runtime = createRuntime("prompt-admission-active", async () => {
      await modelGate.promise;
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const first = await runtime.admitPrompt("first", undefined, admissionOptions("active-first"));
    for (let attempt = 0; attempt < 100 && !runtime.getActiveTurnInfo(); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(runtime.getActiveTurnInfo()).toBeDefined();

    const second = await runtime.admitPrompt(
      "second",
      undefined,
      admissionOptions("active-second"),
    );
    expect(second.kind).toBe("queued");

    modelGate.resolve(undefined);
    if (first.kind === "started") await first.completion;
  });

  it("keeps the queued Submission Selection after the Session Selection changes", async () => {
    const firstRequestGate = deferred<unknown>();
    const requests: Array<{ providerId: string; reasoningLevel: unknown; context: string }> = [];
    const runtime = new AgentRuntime(
      createSessionId("prompt-admission-frozen-submission-selection"),
      {
        mode: "build",
        modelSelection: { providerId: "provider-a", modelId: "model-a" },
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              providerId: String(observation.model.providerId),
              reasoningLevel: observation.model.options.reasoningLevel,
              context: JSON.stringify(request.messages),
            });
            await firstRequestGate.promise;
            return {
              finishReason: "stop",
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    const first = await runtime.admitPrompt("first", undefined, admissionOptions("frozen-first"));
    const second = await runtime.admitPrompt("second", undefined, {
      ...admissionOptions("frozen-second"),
      intent: {
        kind: "sendText",
        modelSelection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "low" },
        },
        requestedDelivery: "queue",
        sourceCommandId: "frozen-second",
      },
    });
    expect(second.kind).toBe("queued");

    runtime.setSessionModelSelection({
      providerId: "provider-c",
      modelId: "model-c",
      options: { reasoningLevel: "high" },
    });

    const queuedInput = (await runtime.getProjection()).pendingSteerInputs.find(
      (input) => input.pendingInputId === second.pendingInputId,
    );
    expect(queuedInput?.intent?.modelSelection).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "low" },
    });
    expect(runtime.getSessionModelSelection()).toMatchObject({
      providerId: "provider-c",
      modelId: "model-c",
    });

    firstRequestGate.resolve(undefined);
    if (first.kind === "started") await first.completion;
    // 不只断言队列里的 DTO：按消费者接到的冻结 intent 开新 Turn，验证正式 Model 和 Context。
    await runtime.executeTurn("second", undefined, { intent: queuedInput?.intent });
    expect(requests.at(-1)).toMatchObject({ providerId: "provider-b", reasoningLevel: "low" });
    expect(requests.at(-1)?.context).toContain("provider-b/model-b");
    expect(requests.at(-1)?.context).not.toContain("provider-c/model-c");
    // 配置改变只影响后续输入，旧队列执行不能倒写会话选择。
    expect(requests[0]?.providerId).toBe("provider-a");
    expect(runtime.getSessionModelSelection()?.providerId).toBe("provider-c");
    await runtime.executeTurn("third", undefined, {
      intent: {
        kind: "sendText",
        sourceCommandId: "after-switch",
        admissionSeq: 3,
        modelSelection: runtime.getSessionModelSelection(),
        requestedDelivery: "startNow",
      },
    });
    expect(requests.at(-1)?.providerId).toBe("provider-c");
  });

  it("treats a runtime command drain as busy even without an active turn", async () => {
    const runtime = createRuntime("prompt-admission-drain", async () => ({
      finishReason: "stop",
      text: "done",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const internal = runtime as unknown as { runtimeCommandDrainActive: boolean };
    internal.runtimeCommandDrainActive = true;

    const admission = await runtime.admitPrompt(
      "during drain",
      undefined,
      admissionOptions("during-drain"),
    );

    expect(admission.kind).toBe("queued");
    internal.runtimeCommandDrainActive = false;
  });

  it("keeps two session runtimes independent while both foreground turns are running", async () => {
    const modelGates = [deferred<unknown>(), deferred<unknown>()];
    let modelCalls = 0;
    const createGatedRuntime = (key: string, gate: ReturnType<typeof deferred<unknown>>) =>
      createRuntime(key, async () => {
        modelCalls += 1;
        await gate.promise;
        return {
          finishReason: "stop",
          text: key,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      });
    const firstRuntime = createGatedRuntime("prompt-admission-a", modelGates[0]!);
    const secondRuntime = createGatedRuntime("prompt-admission-b", modelGates[1]!);

    const first = await firstRuntime.admitPrompt("a", undefined, admissionOptions("a"));
    const second = await secondRuntime.admitPrompt("b", undefined, admissionOptions("b"));

    if (first.kind !== "started" || second.kind !== "started") {
      throw new Error("both sessions must be admitted independently");
    }
    for (let attempt = 0; attempt < 100 && modelCalls < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(modelCalls).toBe(2);

    modelGates[0]!.resolve(undefined);
    modelGates[1]!.resolve(undefined);
    await Promise.all([first.completion, second.completion]);
  });
});

it("附件事实在场时 guide 不得内联进宿主回合，降级为 queue 并携带来源事实", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const requests: unknown[] = [];
  const runtime = createRuntime("attachment-guide-not-steered", async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return {
      finishReason: "stop",
      text: "working on A",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  });
  const first = await runtime.admitPrompt("task A");
  await entered.promise;
  const remoteAttachment = {
    source: "remote" as const,
    attachment: { attachmentId: "mobile-guide-1", role: "read_mostly" as const },
  };
  const guide = await runtime.admitPrompt("remote guide", undefined, {
    queueDelivery: "guide",
    attachment: remoteAttachment,
  } as never);
  expect(guide.kind).toBe("queued");
  release.resolve();
  if (first.kind !== "started") throw new Error("first not started");
  await first.completion;
  // 若被 steer 内联，宿主回合会继续下一次 model 调用；降级为 queue 后没有第二次调用，
  // 远端文本也不会出现在运行中的宿主回合消息里。
  expect(requests).toHaveLength(1);
  const projection = await (
    runtime as unknown as {
      rebuildProjection(): Promise<{
        pendingSteerInputs: Array<{ input: string; delivery?: string; attachment?: unknown }>;
      }>;
    }
  ).rebuildProjection();
  const item = projection.pendingSteerInputs.find((input) => input.input === "remote guide");
  expect(item).toMatchObject({ delivery: "queue", attachment: remoteAttachment });
});

it("renders a human guide through real admission and keeps the ongoing turn", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const requests: unknown[] = [];
  const runtime = createRuntime("human-guide-presentation", async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return {
      finishReason: "stop",
      text: requests.length === 1 ? "working on A" : "continued A",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  });
  const first = await runtime.admitPrompt("task A");
  await entered.promise;
  const guide = await runtime.admitPrompt("short B", undefined, { queueDelivery: "guide" });
  expect(guide.kind).toBe("queued");
  release.resolve();
  if (first.kind !== "started") throw new Error("first not started");
  await first.completion;
  expect(requests).toHaveLength(2);
  const messages = (requests[1] as { messages: Array<{ role: string; content: unknown }> })
    .messages;
  const incoming = messages.find(
    (message) =>
      typeof message.content === "string" &&
      message.content.includes("The user sent a new message while you were working:"),
  );
  expect(incoming).toMatchObject({
    role: "user",
    content:
      "<system-reminder>\nThe user sent a new message while you were working:\nshort B\n\nThis is how ZCode surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>",
  });
});
