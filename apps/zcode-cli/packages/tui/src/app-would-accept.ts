import {
  WOULD_ACCEPT_UNAVAILABLE_TEXT,
  WouldAcceptUnavailableError,
} from "@zcode/shared/would-accept-host";
import type { PendingWouldAcceptCard } from "@zcode/shared/zcode-protocol-v4";
import type React from "react";
import type { Message } from "./app-model.js";
import type { TuiListWouldAcceptCards, TuiPromoteWouldAcceptCard } from "./types.js";

// 类与文案住在 @zcode/shared：CLI 的非 TUI 路径也会加载宿主查询模块，不能从 TUI
// 运行时 import。这里 re-export 保持既有公开面与 instanceof 身份。
export { WOULD_ACCEPT_UNAVAILABLE_TEXT, WouldAcceptUnavailableError };

/**
 * would-accept 收件箱的 TUI 降级命令（spec §5.5）。
 *
 * 本地命令：不进模型、不建回合。列表数据经 `options.listWouldAcceptCards` 缝、批转经
 * `options.promoteWouldAcceptCard` 缝，由 CLI 宿主接到控制面 `listPendingWouldAccept` /
 * `promoteWouldAccept`；能力缺席（flag 关 / 构建未接入）抛
 * {@link WouldAcceptUnavailableError}，如实报 unavailable，不猜、不造数据。
 * 文案沿用 TUI 既有英文常量先例（/mode 描述等），完整 i18n 走 @zcode/i18n 由集成车道补。
 */
const WOULD_ACCEPT_COMMAND_NAME = "/would-accept";
const WOULD_ACCEPT_PROMOTE_COMMAND = `${WOULD_ACCEPT_COMMAND_NAME} promote`;

export type WouldAcceptCommand =
  | { kind: "list" }
  | { kind: "promote"; cardId: string };

/**
 * `/would-accept` 本地命令解析：list 与 promote 两个子命令（其余参数不拦截，
 * 保持原样交给模型路径）。promote 缺 cardId 也拦截，由执行侧回 usage。
 */
export function parseWouldAcceptCommand(text: string): WouldAcceptCommand | undefined {
  const trimmed = text.trim();
  if (trimmed === WOULD_ACCEPT_COMMAND_NAME) return { kind: "list" };
  if (trimmed === WOULD_ACCEPT_PROMOTE_COMMAND) return { kind: "promote", cardId: "" };
  if (trimmed.startsWith(`${WOULD_ACCEPT_PROMOTE_COMMAND} `)) {
    return {
      kind: "promote",
      cardId: trimmed.slice(WOULD_ACCEPT_PROMOTE_COMMAND.length + 1).trim(),
    };
  }
  return undefined;
}

export function formatWouldAcceptInboxText(cards: readonly PendingWouldAcceptCard[]): string {
  if (cards.length === 0) return "Would-accept inbox is empty.";
  const lines = cards.map(
    (card, index) =>
      `${index + 1}. [${card.source} → ${card.suggestedTier}] ${card.summary} (${new Date(card.createdAt).toISOString()}) card=${card.cardId}`,
  );
  return [
    `Would-accept inbox (${cards.length}):`,
    ...lines,
    `Promote: ${WOULD_ACCEPT_PROMOTE_COMMAND} <cardId>`,
  ].join("\n");
}

export async function submitWouldAcceptInboxCommand(input: {
  listWouldAcceptCards?: TuiListWouldAcceptCards;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setStatus: (status: string) => void;
}): Promise<void> {
  input.setMessages((current) => [...current, { content: WOULD_ACCEPT_COMMAND_NAME, role: "user" }]);

  if (!input.listWouldAcceptCards) {
    input.setMessages((current) => [
      ...current,
      { content: WOULD_ACCEPT_UNAVAILABLE_TEXT, role: "agent" },
    ]);
    input.setStatus("Would-accept inbox is not available.");
    return;
  }

  try {
    const cards = await input.listWouldAcceptCards();
    const text = formatWouldAcceptInboxText(cards);
    input.setMessages((current) => [...current, { content: text, role: "agent" }]);
    input.setStatus(`Would-accept inbox: ${cards.length} card(s).`);
  } catch (error) {
    if (error instanceof WouldAcceptUnavailableError) {
      input.setMessages((current) => [
        ...current,
        { content: WOULD_ACCEPT_UNAVAILABLE_TEXT, role: "agent" },
      ]);
      input.setStatus("Would-accept inbox is not available.");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    input.setMessages((current) => [
      ...current,
      { content: `Would-accept inbox failed: ${message}`, role: "agent" },
    ]);
    input.setStatus("Would-accept inbox failed.");
  }
}

export async function submitWouldAcceptPromoteCommand(input: {
  cardId: string;
  promoteWouldAcceptCard?: TuiPromoteWouldAcceptCard;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setStatus: (status: string) => void;
}): Promise<void> {
  const commandText = input.cardId
    ? `${WOULD_ACCEPT_PROMOTE_COMMAND} ${input.cardId}`
    : WOULD_ACCEPT_PROMOTE_COMMAND;
  input.setMessages((current) => [...current, { content: commandText, role: "user" }]);

  if (!input.cardId) {
    input.setMessages((current) => [
      ...current,
      { content: `Usage: ${WOULD_ACCEPT_PROMOTE_COMMAND} <cardId>`, role: "agent" },
    ]);
    input.setStatus("Would-accept promote needs a cardId.");
    return;
  }
  if (!input.promoteWouldAcceptCard) {
    input.setMessages((current) => [
      ...current,
      { content: WOULD_ACCEPT_UNAVAILABLE_TEXT, role: "agent" },
    ]);
    input.setStatus("Would-accept inbox is not available.");
    return;
  }

  try {
    await input.promoteWouldAcceptCard(input.cardId);
    // M4 边界如实呈现：批转只落显式 auto mandate 行，auto 执行档 Phase 3 才生效。
    input.setMessages((current) => [
      ...current,
      {
        content: `Promoted ${input.cardId}: auto mandate row recorded; best-plan execution authorized.`,
        role: "agent",
      },
    ]);
    input.setStatus(`Would-accept card ${input.cardId} promoted to auto.`);
  } catch (error) {
    if (error instanceof WouldAcceptUnavailableError) {
      input.setMessages((current) => [
        ...current,
        { content: WOULD_ACCEPT_UNAVAILABLE_TEXT, role: "agent" },
      ]);
      input.setStatus("Would-accept inbox is not available.");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    input.setMessages((current) => [
      ...current,
      { content: `Would-accept promote failed: ${message}`, role: "agent" },
    ]);
    input.setStatus("Would-accept promote failed.");
  }
}
