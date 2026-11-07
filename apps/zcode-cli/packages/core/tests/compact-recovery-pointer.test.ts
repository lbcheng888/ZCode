import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionId, type ModelRequest } from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import {
  extractCompactRecoveryPointer,
  formatCompactRecoveryPointerForModel,
} from "../src/compact/prompt.js";
import {
  collectCompactChengRefFacts,
  sanitizeCompactRecoveryPointer,
} from "../src/compact/cheng-ref-validation.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// M9 recoveryPointer 往返：模型吐块 → boundary 落库 → 重启 resume → anchor 重挂。
// 规格：docs/architecture/super-agent-context-recall-spec.md §4。

const ROOTS: string[] = [];

afterEach(async () => {
  await Promise.all(ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const OBJECTIVE = "Ship context recall with graph walk coverage";
const CRITERION = "targeted vitest green and rewind suite unchanged";
const SEED_ID = "target:target_recall_roundtrip";
const CHENG_RUN_ID = "m5-20261107T000000Z-12345";
const CHENG_JOB_ID = "a".repeat(64);
const CHENG_PLAN_ID = `cheng-plan://${CHENG_JOB_ID}`;

const POINTER_BLOCK = `<recovery_pointer>
{"objective":"${OBJECTIVE}","criterion":"${CRITERION}","fileMap":["apps/zcode-cli/packages/core/src/tool/handlers/recall.ts"],"openQuestions":["trigger port seam"],"recallSeedIds":["${SEED_ID}"],"chengRunId":"${CHENG_RUN_ID}","chengPlanId":"${CHENG_PLAN_ID}"}
</recovery_pointer>`;

function providerContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "type" in block && block.type === "text"
          ? String((block as { text: unknown }).text)
          : JSON.stringify(block),
      )
      .join("\n");
  }
  return String(content ?? "");
}

describe("compact recovery pointer", () => {
  it("extracts the block, strips it from the summary text, and formats the anchor", () => {
    const raw = `<summary>Keep the recall work.\n1. Primary request\n</summary>\n${POINTER_BLOCK}`;
    const extracted = extractCompactRecoveryPointer(raw);
    expect(extracted.invalid).toBeUndefined();
    expect(extracted.pointer?.objective).toBe(OBJECTIVE);
    expect(extracted.pointer?.criterion).toBe(CRITERION);
    expect(extracted.pointer?.recallSeedIds).toEqual([SEED_ID]);
    expect(extracted.pointer?.chengRunId).toBe(CHENG_RUN_ID);
    expect(extracted.pointer?.chengPlanId).toBe(CHENG_PLAN_ID);
    expect(extracted.text).toContain("Keep the recall work.");
    expect(extracted.text).not.toContain("<recovery_pointer>");

    const projected = formatCompactRecoveryPointerForModel(extracted.pointer!);
    expect(projected).toContain("Recovery anchor (restored after compaction");
    expect(projected).toContain(OBJECTIVE);
    expect(projected).toContain(SEED_ID);
    expect(projected).toContain(CRITERION);
    expect(projected).toContain("Cheng references (explicit prior evidence)");
    expect(projected).toContain(`- run_id: ${CHENG_RUN_ID}`);
    expect(projected).toContain(`- plan_id: ${CHENG_PLAN_ID}`);
  });

  it("drops fabricated Cheng refs but keeps real tool receipts and the rest of the pointer", () => {
    const entries: RuntimeMessageEntry[] = [
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-inspect", name: "ChengInspect", input: { jobId: CHENG_JOB_ID } },
          ],
        },
      },
      {
        message: {
          role: "tool",
          content: JSON.stringify({
            status: "ok",
            jobId: CHENG_JOB_ID,
            runId: CHENG_RUN_ID,
            state: "succeeded",
            runDir: null,
            exitCode: 41,
            cancelRequested: false,
          }),
          isError: false,
          toolCallId: "call-inspect",
          toolName: "ChengInspect",
        },
      },
    ];
    const base = {
      objective: OBJECTIVE,
      criterion: CRITERION,
      fileMap: ["apps/zcode-cli/packages/core/src/compact/prompt.ts"],
      openQuestions: [],
      recallSeedIds: [SEED_ID],
    };

    const real = sanitizeCompactRecoveryPointer(
      {
        ...base,
        chengRunId: CHENG_RUN_ID,
        chengPlanId: CHENG_PLAN_ID,
      },
      collectCompactChengRefFacts(entries),
    );
    expect(real).toMatchObject({
      objective: OBJECTIVE,
      chengRunId: CHENG_RUN_ID,
      chengPlanId: CHENG_PLAN_ID,
      recallSeedIds: [SEED_ID],
    });

    const fabricated = sanitizeCompactRecoveryPointer(
      {
        ...base,
        chengRunId: "m5-invented",
        chengPlanId: `cheng-plan://${"b".repeat(64)}`,
      },
      collectCompactChengRefFacts(entries),
    );
    expect(fabricated).toEqual(base);
    expect(fabricated).not.toHaveProperty("chengRunId");
    expect(fabricated).not.toHaveProperty("chengPlanId");
  });

  it("stays lenient when the block is missing or invalid (compact must not wedge)", () => {
    const missing = extractCompactRecoveryPointer("<summary>plain summary</summary>");
    expect(missing.pointer).toBeUndefined();
    expect(missing.invalid).toBeUndefined();
    expect(missing.text).toBe("<summary>plain summary</summary>");

    const invalid = extractCompactRecoveryPointer(
      `<summary>s</summary>\n<recovery_pointer>{"objective": broken</recovery_pointer>`,
    );
    expect(invalid.pointer).toBeUndefined();
    expect(invalid.invalid).toBeTruthy();
    expect(invalid.text).not.toContain("<recovery_pointer>");
  });

  it("round-trips objective across compact and a simulated restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-recovery-pointer-"));
    ROOTS.push(root);
    const dbPath = join(root, "session.sqlite");
    const sessionId = createSessionId("recovery-pointer-roundtrip");
    const requests: ModelRequest[] = [];

    const modelImplementation = {
      async generateText(request: ModelRequest) {
        requests.push(request);
        const requestText = request.messages
          .map((message) => providerContentToText(message.content))
          .join("\n");
        if (requestText.includes("create a detailed summary")) {
          // 模型按 prompt 第 10 节输出结构化块；runtime 负责剥离与持久化。
          return {
            finishReason: "stop",
            text: `<summary>Keep working on the recall tool.</summary>\n${POINTER_BLOCK}`,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }
        return {
          finishReason: "stop",
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };

    // 第一世：造历史、跑 compact、落库（真实 sqlite）。
    const store1 = await createSqliteSessionStore({ dbPath });
    const runtime1 = createTestAgentRuntime(
      sessionId,
      {
        systemPrompt: "You are a recovery pointer test agent.",
        workingDirectory: root,
        titleGeneration: { enabled: false },
      },
      {
        sessionStore: store1,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory(modelImplementation as never),
      },
    );
    await runtime1.executeTurn("first setup before compact");
    await runtime1.executeTurn("second setup before compact");
    const goal = await store1.createTarget({ objective: OBJECTIVE, sessionID: sessionId });
    await store1.updateTargetChengRef!({
      chengRef: {
        jobId: CHENG_JOB_ID,
        task: "p02_min2",
        runId: CHENG_RUN_ID,
        planId: CHENG_PLAN_ID,
      },
      revision: goal!.revision,
      sessionID: sessionId,
      targetID: goal!.targetID,
    });

    const compactPromptBefore = requests.some((request) =>
      request.messages
        .map((message) => providerContentToText(message.content))
        .join("\n")
        .includes("create a detailed summary"),
    );
    expect(compactPromptBefore).toBe(false);

    const internals = runtime1 as unknown as {
      compactActiveConversation(
        customInstructions: string | undefined,
        traceContext: { traceId: string },
        events: unknown[],
        options: Record<string, unknown>,
      ): Promise<unknown>;
    };
    await internals.compactActiveConversation(
      undefined,
      { traceId: "trace-recovery-pointer" },
      [],
      { compactReason: "user_requested", phase: "standalone_turn", trigger: "manual" },
    );

    // compact prompt 强制了结构化指针（模型可见契约）。
    const compactRequest = requests.find((request) =>
      request.messages
        .map((message) => providerContentToText(message.content))
        .join("\n")
        .includes("create a detailed summary"),
    );
    expect(
      compactRequest?.messages
        .map((message) => providerContentToText(message.content))
        .join("\n"),
    ).toContain("Recovery Pointer (REQUIRED)");

    // 第二世：新开 store 连接 + 新 runtime（模拟重启），冷恢复。
    const store2 = await createSqliteSessionStore({ dbPath });
    const persisted = await store2.messages({ sessionID: sessionId });
    const compactionPart = persisted
      .flatMap((message) => message.parts)
      .find((part) => part.type === "compaction" && part.compactBoundary?.recoveryPointer);
    expect(compactionPart).toBeDefined();
    expect(compactionPart!.compactBoundary!.recoveryPointer!.objective).toBe(OBJECTIVE);
    expect(compactionPart!.compactBoundary!.recoveryPointer!.recallSeedIds).toEqual([SEED_ID]);
    expect(compactionPart!.compactBoundary!.recoveryPointer!.chengRunId).toBe(CHENG_RUN_ID);
    expect(compactionPart!.compactBoundary!.recoveryPointer!.chengPlanId).toBe(CHENG_PLAN_ID);

    // 指针块从持久化的摘要文本里剥掉（模型看到的是 reminder 投影，不是裸 JSON 块）。
    const summaryText = persisted
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    expect(summaryText).not.toContain("<recovery_pointer>");

    const runtime2 = createTestAgentRuntime(
      sessionId,
      {
        systemPrompt: "You are a recovery pointer test agent.",
        workingDirectory: root,
        titleGeneration: { enabled: false },
      },
      {
        sessionStore: store2,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory(modelImplementation as never),
      },
    );
    await runtime2.resumeFromStore();
    await runtime2.executeTurn("continue after restart");

    const postResumeContext = requests
      .at(-1)!
      .messages.map((message) => providerContentToText(message.content))
      .join("\n");
    // 重挂的 anchor：objective / criterion / recall 种子都回到模型上下文。
    expect(postResumeContext).toContain("Recovery anchor (restored after compaction");
    expect(postResumeContext).toContain(OBJECTIVE);
    expect(postResumeContext).toContain(CRITERION);
    expect(postResumeContext).toContain(SEED_ID);
    expect(postResumeContext).toContain(`- run_id: ${CHENG_RUN_ID}`);
    expect(postResumeContext).toContain(`- plan_id: ${CHENG_PLAN_ID}`);
  });

  it("does not re-hang an anchor when the compact summary carried no pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-recovery-pointer-none-"));
    ROOTS.push(root);
    const dbPath = join(root, "session.sqlite");
    const sessionId = createSessionId("recovery-pointer-none");
    const requests: ModelRequest[] = [];

    const modelImplementation = {
      async generateText(request: ModelRequest) {
        requests.push(request);
        const requestText = request.messages
          .map((message) => providerContentToText(message.content))
          .join("\n");
        if (requestText.includes("create a detailed summary")) {
          return {
            finishReason: "stop",
            text: "<summary>Legacy summary without any pointer block.</summary>",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }
        return {
          finishReason: "stop",
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };

    const store1 = await createSqliteSessionStore({ dbPath });
    const runtime1 = createTestAgentRuntime(
      sessionId,
      {
        systemPrompt: "You are a recovery pointer test agent.",
        workingDirectory: root,
        titleGeneration: { enabled: false },
      },
      {
        sessionStore: store1,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory(modelImplementation as never),
      },
    );
    await runtime1.executeTurn("first setup");
    await runtime1.executeTurn("second setup");
    const internals = runtime1 as unknown as {
      compactActiveConversation(
        customInstructions: string | undefined,
        traceContext: { traceId: string },
        events: unknown[],
        options: Record<string, unknown>,
      ): Promise<unknown>;
    };
    await internals.compactActiveConversation(
      undefined,
      { traceId: "trace-recovery-pointer-none" },
      [],
      { compactReason: "user_requested", phase: "standalone_turn", trigger: "manual" },
    );

    const store2 = await createSqliteSessionStore({ dbPath });
    const persisted = await store2.messages({ sessionID: sessionId });
    const compactionPart = persisted
      .flatMap((message) => message.parts)
      .find((part) => part.type === "compaction");
    expect(compactionPart).toBeDefined();
    expect(compactionPart!.compactBoundary?.recoveryPointer).toBeUndefined();

    const runtime2 = createTestAgentRuntime(
      sessionId,
      {
        systemPrompt: "You are a recovery pointer test agent.",
        workingDirectory: root,
        titleGeneration: { enabled: false },
      },
      {
        sessionStore: store2,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory(modelImplementation as never),
      },
    );
    await runtime2.resumeFromStore();
    await runtime2.executeTurn("continue without anchor");
    const postResumeContext = requests
      .at(-1)!
      .messages.map((message) => providerContentToText(message.content))
      .join("\n");
    expect(postResumeContext).not.toContain("Recovery anchor (restored after compaction");
  });
});
