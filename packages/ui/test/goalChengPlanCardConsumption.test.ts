// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalState, PlanItem } from "@zcode/shared/zcode-protocol-v4";
import { swarmActivityStateSchema } from "@zcode/shared/zcode-protocol-v4";
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

/** 普通会话（无 goal）：chip 行与 composer 同样只保留 4px。 */
function modelWithoutGoal(): ConversationStatusPanelModel {
  const items: PlanItem[] = [{ id: "pending", status: "pending", content: "待办事项" }];
  return {
    hasContent: true,
    git: null,
    goal: null,
    sessionPlans: null,
    plan: {
      items,
      displayItems: items,
      completedCount: 0,
      waitingCount: 1,
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
    const html = renderToStaticMarkup(
      createElement(ComposerStatusChips, { model: model(goal), defaultGoalCardOpen: true }),
    );

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
    const html = renderToStaticMarkup(
      createElement(ComposerStatusChips, { model: model(goal), defaultGoalCardOpen: true }),
    );

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
        defaultGoalCardOpen: true,
        onContinueFromPlanCard: vi.fn(),
      }),
    );
    expect(withHandler).toContain(TID_V4_GOAL_CHENG_PLAN_CARD_CONTINUE);
    expect(withHandler).toContain('data-goal-cheng-continue="fix_spec@p02_min2"');
    expect(withHandler).toContain("chat.target.chengCard.continue");

    const withoutHandler = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model(goalWithCard()),
        defaultGoalCardOpen: true,
      }),
    );
    expect(withoutHandler).not.toContain(TID_V4_GOAL_CHENG_PLAN_CARD_CONTINUE);
    // 无卡时无论回调与否都不出现接续按钮。
    const noCard = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model({ ...goalWithCard(), chengPlanCard: undefined }),
        defaultGoalCardOpen: true,
        onContinueFromPlanCard: vi.fn(),
      }),
    );
    expect(noCard).not.toContain(TID_V4_GOAL_CHENG_PLAN_CARD_CONTINUE);
  });

  it("进入会话默认折叠目标卡，点目标 chip 后展开", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(ComposerStatusChips, { model: model(goalWithCard()) }));
    });

    expect(container.querySelector(`[data-testid="${TID_V4_GOAL_CHENG_PLAN_CARD}"]`)).toBeNull();
    const goalButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("chat.statusPanel.goal"),
    );
    expect(goalButton).not.toBeUndefined();
    await act(async () => {
      (goalButton as HTMLButtonElement).click();
    });
    expect(
      container.querySelector(`[data-testid="${TID_V4_GOAL_CHENG_PLAN_CARD}"]`),
    ).not.toBeNull();
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
          defaultGoalCardOpen: true,
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

describe("Swarm activity indicator", () => {
  function activeGoal(): GoalState {
    return {
      targetId: "t1",
      objective: "完成竖切目标",
      summaryTitle: null,
      timeUsedSeconds: 125,
      activeRunStartedAtMs: null,
      status: "active",
      iteration: 3,
      verifications: [],
    };
  }

  it("显示活跃工作单元数与 completed/total 进度（真实 schema 形状）", () => {
    const swarmActivity = swarmActivityStateSchema.parse({
      activeUnits: 2,
      completedUnits: 2,
      totalUnits: 4,
    });
    const html = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model(activeGoal()),
        swarmActivity,
      }),
    );

    expect(html).toContain(">chat.composerChips.swarm<");
    expect(html).toContain('data-swarm-active="2"');
    expect(html).toContain('data-swarm-progress="2/4"');
    expect(html).not.toContain("data-swarm-interrupted");
    expect(html).not.toContain("data-swarm-failed");
    // 文案由 intl 渲染，占位符必须拿到完整快照：2 活跃 · 2/4 完成。
    expect(html).toContain("chat.composerChips.swarmProgress:");
    expect(html).toContain("&quot;active&quot;:2");
    expect(html).toContain("&quot;completed&quot;:2");
    expect(html).toContain("&quot;total&quot;:4");
    // chip 行与 composer 相邻：goal 会话只保留行自身 pb-1 的 4px，不再叠加外部 mb-2。
    expect(html).toContain('class="flex flex-col gap-2 mb-0"');
    expect(html).not.toContain('class="flex flex-col gap-2 mb-2"');
    expect(html).not.toContain('class="flex flex-col gap-2 -mb-2"');
  });

  it("无 goal 会话与 composer 同样只保留 4px", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerStatusChips, { model: modelWithoutGoal() }),
    );

    expect(html).toContain('class="flex flex-col gap-2 mb-0"');
    expect(html).not.toContain('class="flex flex-col gap-2 mb-2"');
  });

  it("运行中失败的单元追加 failed 读数，不改变进行中文案", () => {
    const swarmActivity = swarmActivityStateSchema.parse({
      activeUnits: 1,
      completedUnits: 1,
      totalUnits: 3,
      failedUnits: 1,
    });
    const html = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model(activeGoal()),
        swarmActivity,
      }),
    );

    expect(html).toContain(">chat.composerChips.swarm<");
    expect(html).toContain('data-swarm-failed="1"');
    expect(html).toContain("chat.composerChips.swarmFailed:");
    expect(html).toContain("&quot;failed&quot;:1");
    expect(html).not.toContain("data-swarm-interrupted");
  });

  it("中断收尾：区分已中断文案，trailing 保留 completed/total 与 failed", () => {
    // 直接消费生产者形状：failedUnits/interrupted/roundId 全部来自真实 schema 解析。
    const swarmActivity = swarmActivityStateSchema.parse({
      roundId: "round-1",
      activeUnits: 0,
      completedUnits: 2,
      totalUnits: 4,
      failedUnits: 1,
      interrupted: true,
    });
    // 生产者携带的轮次身份同样被读端接受；chip 只用到计数/中断位。
    expect(swarmActivity.roundId).toBe("round-1");
    expect(swarmActivity.failedUnits).toBe(1);
    expect(swarmActivity.interrupted).toBe(true);
    const html = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model(activeGoal()),
        swarmActivity,
      }),
    );

    expect(html).toContain(">chat.composerChips.swarmInterrupted<");
    expect(html).not.toContain(">chat.composerChips.swarm<");
    expect(html).toContain('data-swarm-active="0"');
    expect(html).toContain('data-swarm-progress="2/4"');
    expect(html).toContain('data-swarm-interrupted="true"');
    expect(html).toContain('data-swarm-failed="1"');
    expect(html).toContain("chat.composerChips.swarmInterruptedProgress:");
    expect(html).toContain("&quot;completed&quot;:2");
    expect(html).toContain("&quot;total&quot;:4");
    expect(html).toContain("chat.composerChips.swarmFailed:");
    expect(html).toContain("&quot;failed&quot;:1");
    expect(html).toContain('class="flex flex-col gap-2 mb-0"');
    expect(html).not.toContain("-mb-2");
  });

  it("快照缺席、无活跃单元且未中断、总数为 0 时整颗隐藏", () => {
    const absent = renderToStaticMarkup(
      createElement(ComposerStatusChips, { model: model(activeGoal()) }),
    );
    expect(absent).not.toContain("data-swarm-active");
    expect(absent).not.toContain("chat.composerChips.swarm");

    const idle = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model(activeGoal()),
        swarmActivity: { activeUnits: 0, completedUnits: 2, totalUnits: 4 },
      }),
    );
    expect(idle).not.toContain("data-swarm-active");
    // 无运行中单元且未中断 → 整颗隐藏；goal 会话根节点保持 mb-0。
    expect(idle).toContain('class="flex flex-col gap-2 mb-0"');
    expect(idle).not.toContain("mb-2");

    const empty = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model(activeGoal()),
        swarmActivity: { activeUnits: 0, completedUnits: 0, totalUnits: 0 },
      }),
    );
    expect(empty).not.toContain("data-swarm-active");
    expect(empty).not.toContain("chat.composerChips.swarm");
  });

  it("interrupted=true 且 totalUnits=0 时仍渲染中断 chip（无计数）", () => {
    const interruptedEmpty = renderToStaticMarkup(
      createElement(ComposerStatusChips, {
        model: model(activeGoal()),
        swarmActivity: { activeUnits: 0, completedUnits: 0, totalUnits: 0, interrupted: true },
      }),
    );
    expect(interruptedEmpty).toContain(">chat.composerChips.swarmInterrupted<");
    expect(interruptedEmpty).toContain('data-swarm-interrupted="true"');
    // 零单元没有可展示的计数：不发布 active/progress 读数。
    expect(interruptedEmpty).not.toContain("data-swarm-active");
    expect(interruptedEmpty).not.toContain("data-swarm-progress");
    expect(interruptedEmpty).not.toContain("chat.composerChips.swarmInterruptedProgress");
  });
});
