// controller 级回归：/would-accept 拦截必须发生在 busy/idle 分支之前（app-submit-controller）。
// app-would-accept.test 只覆盖纯函数；若有人把拦截挪到 busy 分支之后或删除，
// 纯函数测试仍全绿，但命令会退化成把 /would-accept 发给模型/建回合——这里钉住真实行为。
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { WOULD_ACCEPT_UNAVAILABLE_TEXT } from "../src/app-would-accept.js";
import { useSubmitValue } from "../src/app-submit-controller.js";
import type { Message } from "../src/app-model.js";
import type { PendingWouldAcceptCard } from "@zcode/shared/zcode-protocol-v4";

type SubmitValueInput = Parameters<typeof useSubmitValue>[0];
type SubmitValue = ReturnType<typeof useSubmitValue>;

const CARD: PendingWouldAcceptCard = {
  cardId: "card-1",
  source: "im",
  summary: "群里问发布状态",
  suggestedTier: "auto",
  createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
};

/** 用 server render 驱动 hook（useSubmitValue 只用 useCallback），渲染期捕获返回的 submitValue。 */
function captureSubmitValue(input: SubmitValueInput): { submitValue: SubmitValue; messages: () => Message[] } {
  let messages: Message[] = [];
  let captured: SubmitValue | undefined;
  function Probe() {
    captured = useSubmitValue({
      ...input,
      setMessages: (updater) => {
        messages = typeof updater === "function" ? updater(messages) : updater;
      },
    });
    return null;
  }
  renderToString(React.createElement(Probe));
  assert.ok(captured, "useSubmitValue 应在渲染期间产出 submitValue");
  return { submitValue: captured, messages: () => messages };
}

function makeHarness(options: {
  busy: boolean;
  listWouldAcceptCards?: () => Promise<readonly PendingWouldAcceptCard[]>;
  promoteWouldAcceptCard?: (cardId: string) => Promise<void>;
}) {
  const calls = {
    sendInput: 0,
    submitPrompt: 0,
    setBusy: [] as boolean[],
    setQueuedInputs: 0,
    setDraftValue: [] as string[],
    status: [] as string[],
  };
  const input: SubmitValueInput = {
    applyResult: () => {},
    applySessionEvent: () => {},
    busy: options.busy,
    draftAttachmentsRef: { current: [] },
    emptyPromptStatus: "Enter a prompt.",
    messageInsertIndex: 0,
    options: {
      noColor: true,
      stderr: process.stderr,
      stdin: process.stdin,
      stdout: process.stdout,
      listWouldAcceptCards: options.listWouldAcceptCards,
      promoteWouldAcceptCard: options.promoteWouldAcceptCard,
      sendInput: async () => {
        // 拦截失效时才会被调用；返回值形状只需合法，断言钉的是「调用次数=0」。
        calls.sendInput += 1;
        return { kind: "rejected", reason: "no_active_turn" } as const;
      },
      submitPrompt: async () => {
        calls.submitPrompt += 1;
        return { response: "" };
      },
    },
    requestPermission: (() => {
      throw new Error("requestPermission 不应被 /would-accept 触发");
    }) as never,
    resolveSubmittedText: (value) => value,
    setBusy: (value) => {
      calls.setBusy.push(value);
    },
    setDraftAttachments: () => {},
    setDraftValue: (value) => {
      calls.setDraftValue.push(value);
    },
    setLastError: () => {},
    setLiveModelText: () => {},
    setQueuedInputs: () => {
      calls.setQueuedInputs += 1;
    },
    setSelection: () => {},
    setSlashSelection: () => {},
    setStatus: (status) => {
      calls.status.push(status);
    },
    setStatusDetails: () => {},
    turnRef: { current: undefined as AbortController | undefined },
  };
  return { calls, input };
}

test("busy 时提交 /would-accept 短路：不排队不进 sendInput，本地渲染 unavailable，清空草稿", async () => {
  const harness = makeHarness({ busy: true });
  const { submitValue, messages } = captureSubmitValue(harness.input);

  await submitValue("/would-accept");

  // 关键回归面：busy 分支（submitDuringActiveTurn）没有被走到。
  assert.equal(harness.calls.sendInput, 0);
  assert.equal(harness.calls.setQueuedInputs, 0);
  // 本地只读注入：user + agent 两条，不建回合。
  assert.deepEqual(messages(), [
    { content: "/would-accept", role: "user" },
    { content: WOULD_ACCEPT_UNAVAILABLE_TEXT, role: "agent" },
  ]);
  assert.deepEqual(harness.calls.status, ["Would-accept inbox is not available."]);
  // 草稿已清空（拦截分支自己处理，不把命令留给后续路径）。
  assert.ok(harness.calls.setDraftValue.includes(""));
});

test("空闲时提交 /would-accept 短路：不建回合不调 submitPrompt，有缝时渲染卡片列表", async () => {
  const harness = makeHarness({
    busy: false,
    listWouldAcceptCards: async () => [CARD],
  });
  const { submitValue, messages } = captureSubmitValue(harness.input);

  await submitValue("/would-accept");

  // 关键回归面：idle 分支（submitIdleTurn）没有被走到——不置 busy、不提交模型、不占 turnRef。
  assert.equal(harness.calls.submitPrompt, 0);
  assert.deepEqual(harness.calls.setBusy, []);
  assert.equal(harness.input.turnRef.current, undefined);

  const transcript = messages();
  assert.equal(transcript.length, 2);
  assert.deepEqual(transcript[0], { content: "/would-accept", role: "user" });
  assert.match(transcript[1]?.content ?? "", /群里问发布状态/);
  assert.deepEqual(harness.calls.status, ["Would-accept inbox: 1 card(s)."]);
});

test("busy 时提交 /would-accept promote 同样短路：不排队不进模型，promote 缝收到 cardId", async () => {
  const promoted: string[] = [];
  const harness = makeHarness({
    busy: true,
    promoteWouldAcceptCard: async (cardId) => {
      promoted.push(cardId);
    },
  });
  const { submitValue, messages } = captureSubmitValue(harness.input);

  await submitValue("/would-accept promote card-42");

  // 关键回归面：busy 分支没有被走到，命令也没泄漏给模型。
  assert.equal(harness.calls.sendInput, 0);
  assert.equal(harness.calls.setQueuedInputs, 0);
  assert.deepEqual(promoted, ["card-42"]);
  assert.deepEqual(messages(), [
    { content: "/would-accept promote card-42", role: "user" },
    {
      content:
        "Promoted card-42: auto mandate row recorded; best-plan execution authorized.",
      role: "agent",
    },
  ]);
  assert.deepEqual(harness.calls.status, ["Would-accept card card-42 promoted to auto."]);
  assert.ok(harness.calls.setDraftValue.includes(""));
});

test("空闲时提交 /would-accept promote 不建回合；缝缺席如实报 unavailable", async () => {
  const harness = makeHarness({ busy: false });
  const { submitValue, messages } = captureSubmitValue(harness.input);

  await submitValue("/would-accept promote card-1");

  assert.equal(harness.calls.submitPrompt, 0);
  assert.deepEqual(harness.calls.setBusy, []);
  assert.equal(harness.input.turnRef.current, undefined);
  assert.deepEqual(messages()[1], {
    content: "Would-accept inbox is not available in this build.",
    role: "agent",
  });
});
