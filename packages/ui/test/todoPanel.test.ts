import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanItem, PlanState } from "@zcode/shared/zcode-protocol-v4";
import { TID_V4_TODO_PANEL } from "@zcode/shared/test-ids";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { TodoPanel } from "../src/TodoPanel.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

function planState(items: PlanItem[]): PlanState {
  return { items, updatedAt: 1_777_777_777 };
}

function renderWithTooltipProvider(element: ReactElement) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element));
}

describe("TodoPanel", () => {
  it("hides the todo panel after every step is completed", () => {
    const html = renderWithTooltipProvider(
      createElement(TodoPanel, {
        isStreaming: true,
        plan: planState([
          { id: "step-1", status: "completed", content: "分析问题" },
          { id: "step-2", status: "completed", content: "修复问题" },
        ]),
      }),
    );

    expect(html).toBe("");
  });

  it("hides the todo panel for an empty plan", () => {
    const html = renderWithTooltipProvider(
      createElement(TodoPanel, {
        isStreaming: false,
        plan: planState([]),
      }),
    );

    expect(html).toBe("");
  });

  it("renders completed/total progress for the collapsed strip", () => {
    const html = renderWithTooltipProvider(
      createElement(TodoPanel, {
        isStreaming: false,
        plan: planState([
          { id: "step-1", status: "completed", content: "已经完成的事项" },
          { id: "step-2", status: "inProgress", content: "正在处理的事项" },
          { id: "step-3", status: "pending", content: "还要处理的事项" },
        ]),
      }),
    );

    expect(html).toContain(`data-testid="${TID_V4_TODO_PANEL}"`);
    expect(html).toContain("1/3");
    // 收起态标题显示当前 inProgress 项；已完成项不出现在进度条里。
    expect(html).toContain("正在处理的事项");
    expect(html).not.toContain("已经完成的事项");
  });

  it("renders only the active item, never the todo list itself", () => {
    const html = renderWithTooltipProvider(
      createElement(TodoPanel, {
        isStreaming: false,
        plan: planState([
          { id: "step-1", status: "completed", content: "已经完成的事项" },
          { id: "step-2", status: "inProgress", content: "正在处理的事项" },
          { id: "step-3", status: "pending", content: "还要处理的事项" },
        ]),
      }),
    );

    // 芯片只给当前任务与完成比；明细由会话状态面板承担，避免两处重复渲染同一份清单。
    expect(html).toContain("正在处理的事项");
    expect(html).not.toContain("已经完成的事项");
    expect(html).not.toContain("还要处理的事项");
    expect(html).not.toMatch(/\+\d/);
    // 芯片本身可点，用于展开状态面板的待办分区。
    expect(html).toContain("chat.longRunning.expand");
  });

  it("keeps the streaming gradient only while the turn is running", () => {
    const plan = planState([{ id: "step-1", status: "inProgress", content: "正在处理的事项" }]);

    const streamingHtml = renderWithTooltipProvider(
      createElement(TodoPanel, { isStreaming: true, plan }),
    );
    const idleHtml = renderWithTooltipProvider(
      createElement(TodoPanel, { isStreaming: false, plan }),
    );

    expect(streamingHtml).toContain("animated-gradient-text");
    // Bugfix 回归：停止/结束后残留的 inProgress 项不能继续显示 loading 渐变。
    expect(idleHtml).not.toContain("animated-gradient-text");
    expect(idleHtml).toContain("正在处理的事项");
  });

  it("uses a collapsed content button without making the plan header a button", () => {
    const html = renderWithTooltipProvider(
      createElement(TodoPanel, {
        isStreaming: true,
        plan: planState([
          {
            id: "step-1",
            status: "inProgress",
            content:
              "这是一个很长的待办标题，用来模拟手机远程控制窄屏里当前任务标题把右侧按钮挤出容器的问题",
          },
          {
            id: "step-2",
            status: "pending",
            content: "下一步",
          },
        ]),
      }),
    );

    expect(html).toMatch(/<button[^>]*aria-label="chat\.longRunning\.expand"/);
    // 芯片不再展开清单，因此不带展开态语义；plan header 也不能整体成为按钮。
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain('data-slot="plan-header" role="button"');
  });
});
