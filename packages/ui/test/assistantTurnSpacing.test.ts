// 轮边界留白：上一轮以完成态助手正文收尾时，轮尾 hover 操作栏即使不可见也净占 28px
// （gap-5 20px + 按钮行 24px - mt-4 16px）。下一轮轮顶必须从 pt-14(56px) 收回到
// pt-7(28px)，否则 pb-5(20px) + 28px + 56px 会把轮间距堆到 104px。
// jsdom/SSR 没有布局引擎，这里锁定「渲染类名 + 判据」契约；像素级高度由 fixture 探针单独测量。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import type {
  AssistantTextRow,
  ConversationRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationTurnGroup, endsWithAssistantTextActions } from "@/v4/ConversationTurnGroup.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import {
  buildConversationTurnRenderUnits,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({}),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({
    highspeedCardService: { share: vi.fn() },
  }),
}));

vi.mock("@/v4/botGroupDeliveryContext.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/v4/botGroupDeliveryContext.js")>()),
  useBotTopicInterruption: () => false,
}));

const rowContext: ConversationRowRenderContext = {
  workspacePath: "/workspace",
  theme: "system",
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};

const noopPlatform = {} as IPlatformService;

function turnHeader(
  turnId: string,
  rowId: number,
  overrides: Partial<TurnHeaderRow> = {},
): TurnHeaderRow {
  return {
    rowId,
    turnId,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000 + rowId,
    ...overrides,
  };
}

function userInputRow(rowId: number, turnId: string): UserInputRow {
  return {
    rowId,
    turnId,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    text: "继续",
    origin: "realUser",
  };
}

function assistantTextRow(
  rowId: number,
  turnId: string,
  overrides: Partial<AssistantTextRow> = {},
): AssistantTextRow {
  return {
    rowId,
    entityId: `message-assistant-${rowId}`,
    turnId,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    state: "complete",
    text: "完成回复",
    ...overrides,
  };
}

function toolCallRow(rowId: number, turnId: string): ToolCallRow {
  return {
    rowId,
    turnId,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName: "Bash",
    status: "success",
    input: {},
    inputText: "{}",
  };
}

function turnTailMarkerRow(rowId: number, turnId: string): TimelineMarkerRow {
  return {
    rowId,
    turnId,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "forkNotice",
      parentSessionId: "session-parent",
      parentRowId: 1,
    },
  };
}

function buildSingleTurn(rows: ConversationRow[]): ConversationTurnRenderUnit {
  const units = buildConversationTurnRenderUnits(rows);
  const unit = units[0];
  if (!unit) throw new Error("render unit 未生成");
  return unit;
}

function shell(
  unit: ConversationTurnRenderUnit,
  options: { topClearedByTimeline?: boolean; followsAssistantTextActions?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(PlatformProvider, {
        platform: noopPlatform,
        children: createElement(TooltipProvider, {
          children: createElement(ConversationTurnGroup, {
            unit,
            context: rowContext,
            topClearedByTimeline: options.topClearedByTimeline,
            followsAssistantTextActions: options.followsAssistantTextActions,
          }),
        }),
      }),
    }),
  );
}

function sectionClass(html: string): string {
  const match = /<section[^>]*class="([^"]*)"/.exec(html);
  if (!match) throw new Error("section 未渲染");
  return match[1]!;
}

describe("assistant turn spacing", () => {
  it("只有完成态助手正文收尾的轮才判定为带轮尾操作栏", () => {
    const answerTurn = buildSingleTurn([
      turnHeader("turn-a", 1),
      userInputRow(2, "turn-a"),
      assistantTextRow(3, "turn-a"),
    ]);
    expect(answerTurn.latestAssistantTextRow?.state).toBe("complete");
    expect(endsWithAssistantTextActions(answerTurn)).toBe(true);
    expect(endsWithAssistantTextActions(undefined)).toBe(false);

    // 正文之后还有工具行：操作栏不是轮内最后一个流内节点。
    const toolTailTurn = buildSingleTurn([
      turnHeader("turn-b", 10),
      userInputRow(11, "turn-b"),
      assistantTextRow(12, "turn-b"),
      toolCallRow(13, "turn-b"),
    ]);
    expect(endsWithAssistantTextActions(toolTailTurn)).toBe(false);

    // 轮尾 boundary 渲染在操作栏之后，不能收紧下一轮轮顶。
    const boundaryTailTurn = buildSingleTurn([
      turnHeader("turn-c", 20),
      userInputRow(21, "turn-c"),
      assistantTextRow(22, "turn-c"),
      turnTailMarkerRow(23, "turn-c"),
    ]);
    expect(boundaryTailTurn.assistantTailRows).toHaveLength(1);
    expect(endsWithAssistantTextActions(boundaryTailTurn)).toBe(false);

    // 中断正文没有轮尾操作栏。
    const interruptedTurn = buildSingleTurn([
      turnHeader("turn-d", 30, { state: "completedInterrupted" }),
      userInputRow(31, "turn-d"),
      assistantTextRow(32, "turn-d", { state: "interrupted" }),
    ]);
    expect(endsWithAssistantTextActions(interruptedTurn)).toBe(false);
  });

  it("运行中的轮即使有 action 锚点也不收紧后续轮顶", () => {
    const runningTurn = buildSingleTurn([
      turnHeader("turn-running", 40, { state: "running" }),
      userInputRow(41, "turn-running"),
      assistantTextRow(42, "turn-running", { state: "streaming", actions: { canFork: true } }),
    ]);
    expect(runningTurn.isRunning).toBe(true);
    expect(runningTurn.latestAssistantTextRow?.rowId).toBe(42);
    expect(endsWithAssistantTextActions(runningTurn)).toBe(false);
  });

  it("有内容时渲染操作栏并带 -mt-4 净偏移", () => {
    const answerTurn = buildSingleTurn([
      turnHeader("turn-a", 1),
      userInputRow(2, "turn-a"),
      assistantTextRow(3, "turn-a"),
    ]);
    const html = shell(answerTurn);
    // 操作栏真实存在：复制按钮以正文 rowId 为 testId，按钮行由 icon-sm 的 size-6 撑到 24px。
    expect(html).toContain('data-testid="v4-copy-3"');
    expect(html).toContain("size-6");
    expect(html).toContain("-mt-4");
  });

  it("下一轮轮顶按上一轮判据从 pt-14 收到 pt-7", () => {
    const answerTurn = buildSingleTurn([
      turnHeader("turn-a", 1),
      userInputRow(2, "turn-a"),
      assistantTextRow(3, "turn-a"),
    ]);

    const defaultClass = sectionClass(shell(answerTurn));
    expect(defaultClass).toContain("pt-14");
    expect(defaultClass).not.toContain("pt-7");

    const tightClass = sectionClass(shell(answerTurn, { followsAssistantTextActions: true }));
    expect(tightClass).toContain("pt-7");
    expect(tightClass).not.toContain("pt-14");
    // 轮间净留白契约：pb-5(20) + 操作栏(gap-5 20 - mt-4 16 + size-6 24) + pt-7(28)
    // = 76px，正好是操作栏进入流内布局之前的轮间距。
    expect(tightClass).toContain("pb-5");
  });

  it("会话首轮的 pt-0 优先于收紧规则", () => {
    const answerTurn = buildSingleTurn([
      turnHeader("turn-a", 1),
      userInputRow(2, "turn-a"),
      assistantTextRow(3, "turn-a"),
    ]);
    const html = shell(answerTurn, {
      topClearedByTimeline: true,
      followsAssistantTextActions: true,
    });
    const className = sectionClass(html);
    expect(className).toContain("pt-0");
    expect(className).not.toContain("pt-7");
    expect(className).not.toContain("pt-14");
  });
});
