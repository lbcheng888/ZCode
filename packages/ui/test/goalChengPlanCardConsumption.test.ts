// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalState, PlanItem } from "@zcode/shared/zcode-protocol-v4";
import {
  TID_V4_GOAL_CHENG_PLAN_CARD,
  TID_V4_GOAL_CHENG_PLAN_CARD_CONTINUE,
} from "@zcode/shared/test-ids";
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
  return [{ id: "a", status: "completed", content: "已经完成的事项" }];
}

function model(goal: GoalState): ConversationStatusPanelModel {
  const items = planItems();
  return {
    hasContent: true,
    git: null,
    goal,
    sessionPlans: null,
    plan: {
      items,
      displayItems: items,
      completedCount: 1,
      waitingCount: 0,
      totalCount: 1,
    },
    runningBashWorks: [],
    runningSubagentWorks: [],
    runningWorkflowRuns: [],
  };
}

describe("ChengPlan card renderer consumption", () => {
  it("renders goal.chengPlanCard as a visible compact route card", () => {
    const goal: GoalState = {
      targetId: "t1",
      objective: "完成竖切目标",
      summaryTitle: null,
      timeUsedSeconds: 125,
      activeRunStartedAtMs: null,
      status: "active",
      iteration: 3,
      verifications: [],
      chengPlanCard: {
        planId: "cheng-plan://job-1",
        runId: "run-1",
        frontier: {
          stage: "spec",
          target: "p02_min2",
          evidence: ["jobId:job-1", "settle_not_solved"],
        },
        recommended: { action: "fix_spec", target: "p02_min2" },
        evidenceRefs: ["jobId:job-1", "settle_not_solved", "gate:blocked"],
      },
    };
    const html = renderToStaticMarkup(createElement(ComposerStatusChips, { model: model(goal) }));

    expect(html).toContain(TID_V4_GOAL_CHENG_PLAN_CARD);
    expect(html).toContain('data-goal-cheng-plan-id="cheng-plan://job-1"');
    expect(html).toContain("spec@p02_min2");
    expect(html).toContain("fix_spec@p02_min2");
    expect(html).toContain('data-goal-cheng-run-id="run-1"');
    expect(html).toContain("settle_not_solved");
  });

  it("renders no ChengPlan card when the projection has no card", () => {
    const goal: GoalState = {
      targetId: "t1",
      objective: "完成竖切目标",
      summaryTitle: null,
      timeUsedSeconds: 125,
      activeRunStartedAtMs: null,
      status: "active",
      iteration: 3,
      verifications: [],
    };
    const html = renderToStaticMarkup(createElement(ComposerStatusChips, { model: model(goal) }));

    expect(html).not.toContain(TID_V4_GOAL_CHENG_PLAN_CARD);
  });
});

describe("ChengPlan card continue action（S4 一键接续）", () => {
  const roots: Root[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => {
        root.unmount();
      });
    }
  });

  function goalWithCard(): GoalState {
    return {
      targetId: "t1",
      objective: "完成竖切目标",
      summaryTitle: null,
      timeUsedSeconds: 125,
      activeRunStartedAtMs: null,
      status: "active",
      iteration: 3,
      verifications: [],
      chengPlanCard: {
        planId: "cheng-plan://job-1",
        runId: "run-1",
        frontier: { stage: "spec", target: "p02_min2", evidence: ["jobId:job-1"] },
        recommended: { action: "fix_spec", target: "p02_min2" },
        evidenceRefs: ["jobId:job-1"],
      },
    };
  }

  it("回调在场 → 接续按钮挂出并携带推荐动作；缺省（旧宿主/只读）→ 不渲染，卡保持只读证据", () => {
    const withHandler = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model(goalWithCard()),
        onContinueFromPlanCard: vi.fn(),
      }),
    );
    expect(withHandler).toContain(TID_V4_GOAL_CHENG_PLAN_CARD_CONTINUE);
    expect(withHandler).toContain('data-goal-cheng-continue="fix_spec@p02_min2"');
    expect(withHandler).toContain("chat.target.chengCard.continue");

    const withoutHandler = renderToStaticMarkup(
      createElement(ComposerStatusChips, { model: model(goalWithCard()) }),
    );
    expect(withoutHandler).not.toContain(TID_V4_GOAL_CHENG_PLAN_CARD_CONTINUE);
    // 无卡时无论回调与否都不出现接续按钮。
    const noCard = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model({ ...goalWithCard(), chengPlanCard: undefined }),
        onContinueFromPlanCard: vi.fn(),
      }),
    );
    expect(noCard).not.toContain(TID_V4_GOAL_CHENG_PLAN_CARD_CONTINUE);
  });

  it("点击接续按钮 → 恰好回调一次（dispatch 由 SessionPane 经 resumeGoal 通道派发）", async () => {
    const onContinueFromPlanCard = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        createElement(ComposerStatusChips, {
          model: model(goalWithCard()),
          onContinueFromPlanCard,
        }),
      );
    });
    const button = document.querySelector(
      `[data-testid="${TID_V4_GOAL_CHENG_PLAN_CARD_CONTINUE}"]`,
    );
    expect(button).not.toBeNull();
    await act(async () => {
      (button as HTMLButtonElement).click();
    });
    expect(onContinueFromPlanCard).toHaveBeenCalledTimes(1);
  });
});
