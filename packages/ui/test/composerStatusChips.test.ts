// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalState, PlanItem } from "@zcode/shared/zcode-protocol-v4";
import { TID_V4_TODO_PANEL } from "@zcode/shared/test-ids";
import type { ConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";
import { ComposerStatusChips } from "../src/v4/composer/ComposerStatusChips.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, unknown>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

function planItems(): PlanItem[] {
  return [
    { id: "a", status: "completed", content: "已经完成的事项" },
    { id: "b", status: "inProgress", content: "正在处理的事项" },
    { id: "c", status: "pending", content: "还要处理的事项" },
  ];
}

function goal(status: GoalState["status"] = "active"): GoalState {
  return {
    targetId: "t1",
    objective: "完成竖切目标",
    summaryTitle: null,
    timeUsedSeconds: 125,
    activeRunStartedAtMs: null,
    status,
    iteration: 3,
    verifications: [],
  } as GoalState;
}

function model(overrides: Partial<ConversationStatusPanelModel> = {}): ConversationStatusPanelModel {
  const items = planItems();
  return {
    hasContent: true,
    git: null,
    goal: null,
    sessionPlans: null,
    plan: {
      items,
      displayItems: items,
      completedCount: 1,
      waitingCount: 2,
      totalCount: 3,
    },
    runningBashWorks: [],
    runningSubagentWorks: [],
    runningWorkflowRuns: [],
    ...overrides,
  };
}

describe("ComposerStatusChips", () => {
  afterEach(cleanup);

  it("renders the progress chip with completed/total and no item text", () => {
    const html = renderToStaticMarkup(createElement(ComposerStatusChips, { model: model() }));

    expect(html).toContain(`data-testid="${TID_V4_TODO_PANEL}"`);
    expect(html).toContain("chat.composerChips.progress");
    expect(html).toContain("1/3");
    // 明细只在展开面板里；chip 本身不铺清单。
    expect(html).not.toContain("正在处理的事项");
  });

  it("expands the progress chip into the pending list in place", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerStatusChips, { model: model(), defaultOpenChip: "progress" }),
    );

    expect(html).toContain('data-composer-status-panel="progress"');
    expect(html).toContain("正在处理的事项");
    expect(html).toContain("还要处理的事项");
    // 已完成项不重复出现在待处理清单里。
    expect(html).not.toContain("已经完成的事项");
  });

  it("hides the progress chip when every item is completed or the plan is empty", () => {
    const allDone = planItems().map((item) => ({ ...item, status: "completed" as const }));
    const doneHtml = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model({
          plan: {
            items: allDone,
            displayItems: allDone,
            completedCount: 3,
            waitingCount: 0,
            totalCount: 3,
          },
        }),
      }),
    );
    const emptyHtml = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model({
          plan: { items: [], displayItems: [], completedCount: 0, waitingCount: 0, totalCount: 0 },
        }),
      }),
    );

    expect(doneHtml).toBe("");
    expect(emptyHtml).toBe("");
  });

  it("shows the goal chip with its status and expands to objective plus elapsed", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model({ goal: goal("active") }),
        defaultOpenChip: "goal",
      }),
    );

    expect(html).toContain("chat.statusPanel.goal");
    expect(html).toContain("chat.composerChips.goalStatus.active");
    expect(html).toContain('data-composer-status-panel="goal"');
    expect(html).toContain("完成竖切目标");
    expect(html).toContain("2m");
  });

  it("goal panel offers cancel (callback only) and close (view only)", () => {
    const onCancelGoal = vi.fn();
    const { container } = render(
      createElement(ComposerStatusChips, {
        model: model({ goal: goal("active") }),
        defaultOpenChip: "goal",
        onCancelGoal,
      }),
    );
    expect(container.querySelector('[data-composer-status-panel="goal"]')).not.toBeNull();
    // 关闭只收起就地展开的面板：不发命令，也不触发取消目标。
    fireEvent.click(container.querySelector('[data-goal-action="close"]')!);
    expect(container.querySelector('[data-composer-status-panel="goal"]')).toBeNull();
    expect(onCancelGoal).not.toHaveBeenCalled();

    // 再点 chip 展开后，取消目标只把意图交给父层（父层负责二次确认与 dispatch）。
    fireEvent.click(screen.getByText("chat.statusPanel.goal").closest("button")!);
    fireEvent.click(container.querySelector('[data-goal-action="clear"]')!);
    expect(onCancelGoal).toHaveBeenCalledTimes(1);
  });

  it("hides the goal cancel entry when no handler is provided (old CLI availability)", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model({ goal: goal("active") }),
        defaultOpenChip: "goal",
      }),
    );
    expect(html).not.toContain('data-goal-action="clear"');
    expect(html).toContain('data-goal-action="close"');
  });

  it("counts running background bash and agents, and hides them at zero", () => {
    const withWork = model({
      runningBashWorks: [
        { workId: "w1", kind: "bash", title: "npm test", status: "running", startedAt: 1 },
      ],
      runningSubagentWorks: [
        { childSessionId: "c1", subagentType: "coder", title: "修 um_main", status: "running" },
      ],
    });
    const html = renderToStaticMarkup(
      createElement(ComposerStatusChips, { model: withWork, defaultOpenChip: "agents" }),
    );
    expect(html).toContain("chat.composerChips.bash");
    expect(html).toContain("chat.composerChips.agents");
    // chip 本身只有计数；标题在展开面板里。
    expect(html).toContain('data-composer-status-panel="agents"');
    expect(html).toContain("修 um_main");

    const idle = renderToStaticMarkup(
      createElement(ComposerStatusChips, { model: model({ plan: null }) }),
    );
    expect(idle).not.toContain("chat.composerChips.bash");
    expect(idle).not.toContain("chat.composerChips.agents");
  });

  it("shows the running agent model with effort, and degrades when either part is absent", () => {
    const render = (agent: {
      childSessionId: string;
      subagentType: string;
      title: string;
      status: "running";
      model?: string;
    }) =>
      renderToStaticMarkup(
        createElement(ComposerStatusChips, {
          model: model({ runningSubagentWorks: [agent] }),
          defaultOpenChip: "agents",
        }),
      );

    const withEffort = render({
      childSessionId: "c1",
      subagentType: "coder",
      title: "修 um_main",
      status: "running",
      model: "custom-openai/glm-5.2$high",
    });
    expect(withEffort).toContain("glm-5.2 · chat.toolbar.thoughtLevel.value.high");

    // 规范串没有档位：只显示模型名，不补默认档位词。
    const modelOnly = render({
      childSessionId: "c1",
      subagentType: "coder",
      title: "修 um_main",
      status: "running",
      model: "custom-openai/glm-5.2",
    });
    expect(modelOnly).toContain("glm-5.2");
    expect(modelOnly).not.toContain("chat.toolbar.thoughtLevel");

    // 旧会话/旧 CLI 没有 model 字段：维持原样，不渲染空段。
    const legacy = render({
      childSessionId: "c1",
      subagentType: "coder",
      title: "修 um_main",
      status: "running",
    });
    expect(legacy).not.toContain("glm-5.2");
    expect(legacy).not.toContain("chat.toolbar.thoughtLevel");
    expect(legacy).toContain("修 um_main");
  });

  it("shows a running spinner on the progress chip only while streaming", () => {
    const running = renderToStaticMarkup(
      createElement(ComposerStatusChips, { model: model(), isStreaming: true }),
    );
    const idle = renderToStaticMarkup(createElement(ComposerStatusChips, { model: model() }));

    expect(running).toContain("animate-spin");
    expect(idle).not.toContain("animate-spin");
  });
});
