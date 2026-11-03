import assert from "node:assert/strict";
import test from "node:test";
import type { PendingWouldAcceptCard } from "@zcode/shared/zcode-protocol-v4";
import type { Message } from "../src/app-model.js";
import {
  WOULD_ACCEPT_UNAVAILABLE_TEXT,
  WouldAcceptUnavailableError,
  formatWouldAcceptInboxText,
  parseWouldAcceptCommand,
  submitWouldAcceptInboxCommand,
  submitWouldAcceptPromoteCommand,
} from "../src/app-would-accept.js";

const CARD: PendingWouldAcceptCard = {
  cardId: "card-1",
  source: "im",
  summary: "群里问发布状态",
  suggestedTier: "auto",
  createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
};

function harness(listWouldAcceptCards?: () => Promise<readonly PendingWouldAcceptCard[]>) {
  let messages: Message[] = [];
  let status = "";
  return {
    get messages() {
      return messages;
    },
    get status() {
      return status;
    },
    run: () =>
      submitWouldAcceptInboxCommand({
        listWouldAcceptCards,
        setMessages: (updater) => {
          messages = typeof updater === "function" ? updater(messages) : updater;
        },
        setStatus: (value) => {
          status = value;
        },
      }),
  };
}

test("would-accept 命令只匹配 list 与 promote 两个本地子命令", () => {
  assert.deepEqual(parseWouldAcceptCommand("/would-accept"), { kind: "list" });
  assert.deepEqual(parseWouldAcceptCommand("  /would-accept  "), { kind: "list" });
  assert.deepEqual(parseWouldAcceptCommand("/would-accept promote card-9"), {
    kind: "promote",
    cardId: "card-9",
  });
  // 缺 cardId 也拦截（本地回 usage，不把半截命令发给模型）。
  assert.deepEqual(parseWouldAcceptCommand("/would-accept promote"), {
    kind: "promote",
    cardId: "",
  });
  assert.equal(parseWouldAcceptCommand("/would-accept promoteX"), undefined);
});

test("列表格式化：空态与非空列表（卡片行带 cardId 与 promote 用法）", () => {
  assert.equal(formatWouldAcceptInboxText([]), "Would-accept inbox is empty.");
  const text = formatWouldAcceptInboxText([CARD]);
  assert.match(text, /^Would-accept inbox \(1\):/);
  assert.match(text, /\[im → auto\]/);
  assert.match(text, /群里问发布状态/);
  assert.match(text, /2026-01-02T03:04:05\.000Z/);
  assert.match(text, /card=card-1/);
  assert.match(text, /Promote: \/would-accept promote <cardId>/);
});

test("数据缝缺席时如实报 unavailable，不造数据", async () => {
  const io = harness();
  await io.run();
  assert.equal(io.messages.length, 2);
  assert.deepEqual(io.messages[0], { content: "/would-accept", role: "user" });
  assert.deepEqual(io.messages[1], { content: WOULD_ACCEPT_UNAVAILABLE_TEXT, role: "agent" });
  assert.equal(io.status, "Would-accept inbox is not available.");
});

test("数据缝在场时渲染卡片列表", async () => {
  const io = harness(async () => [CARD, { ...CARD, cardId: "card-2", source: "webhook" }]);
  await io.run();
  assert.equal(io.messages.length, 2);
  const body = io.messages[1]?.content ?? "";
  assert.match(body, /^Would-accept inbox \(2\):/);
  assert.match(body, /\[webhook → auto\]/);
  assert.equal(io.status, "Would-accept inbox: 2 card(s).");
});

test("数据缝抛错时错误原样上浮到转写与状态", async () => {
  const io = harness(async () => {
    throw new Error("rpc down");
  });
  await io.run();
  assert.equal(io.messages[1]?.content, "Would-accept inbox failed: rpc down");
  assert.equal(io.status, "Would-accept inbox failed.");
});

test("缝在场但能力缺席（WouldAcceptUnavailableError）：列表如实报 unavailable，不当失败", async () => {
  const io = harness(async () => {
    throw new WouldAcceptUnavailableError();
  });
  await io.run();
  assert.equal(io.messages[1]?.content, WOULD_ACCEPT_UNAVAILABLE_TEXT);
  assert.equal(io.status, "Would-accept inbox is not available.");
});

function promoteHarness(promote?: (cardId: string) => Promise<void>) {
  let messages: Message[] = [];
  let status = "";
  return {
    get messages() {
      return messages;
    },
    get status() {
      return status;
    },
    run: (cardId: string) =>
      submitWouldAcceptPromoteCommand({
        cardId,
        promoteWouldAcceptCard: promote,
        setMessages: (updater) => {
          messages = typeof updater === "function" ? updater(messages) : updater;
        },
        setStatus: (value) => {
          status = value;
        },
      }),
  };
}

test("promote：成功呈现写行结果并如实标注执行档 Phase 3 边界", async () => {
  const seen: string[] = [];
  const io = promoteHarness(async (cardId) => {
    seen.push(cardId);
  });
  await io.run("card-7");
  assert.deepEqual(seen, ["card-7"]);
  assert.deepEqual(io.messages[0], { content: "/would-accept promote card-7", role: "user" });
  assert.match(
    io.messages[1]?.content ?? "",
    /Promoted card-7: auto mandate row recorded \(auto execution tier activates in a later phase\)\./,
  );
  assert.equal(io.status, "Would-accept card card-7 promoted to auto.");
});

test("promote：缺 cardId 回 usage，不调缝", async () => {
  let called = 0;
  const io = promoteHarness(async () => {
    called += 1;
  });
  await io.run("");
  assert.equal(called, 0);
  assert.equal(io.messages[1]?.content, "Usage: /would-accept promote <cardId>");
  assert.equal(io.status, "Would-accept promote needs a cardId.");
});

test("promote：缝缺席与能力缺席都如实报 unavailable", async () => {
  const missing = promoteHarness(undefined);
  await missing.run("card-1");
  assert.equal(missing.messages[1]?.content, WOULD_ACCEPT_UNAVAILABLE_TEXT);
  assert.equal(missing.status, "Would-accept inbox is not available.");

  const unavailable = promoteHarness(async () => {
    throw new WouldAcceptUnavailableError();
  });
  await unavailable.run("card-1");
  assert.equal(unavailable.messages[1]?.content, WOULD_ACCEPT_UNAVAILABLE_TEXT);
  assert.equal(unavailable.status, "Would-accept inbox is not available.");
});

test("promote：其它错误原样上浮到转写与状态", async () => {
  const io = promoteHarness(async () => {
    throw new Error("card gone");
  });
  await io.run("card-x");
  assert.equal(io.messages[1]?.content, "Would-accept promote failed: card gone");
  assert.equal(io.status, "Would-accept promote failed.");
});
