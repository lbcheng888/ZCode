// @vitest-environment jsdom
// S4 goal 用户直改入口（GoalEditSettingsMenu）：等级 radio 即时 dispatch、绑定只读显示
// payload=清除(null)（绑定已内化为 owner-scoped 自动绑定）；ConversationStatusPanel 的入口可见性
// （goal.revision 缺席 = 旧 CLI 快照无 CAS 键 → 隐藏）。不依赖 @testing-library：
// createRoot + act + 原生事件（React 19 的 act 自 react 导出）。
import { createElement, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalState } from "@zcode/shared/zcode-protocol-v4";

const menuCapture = vi.hoisted(() => ({
  radioGroups: [] as Array<{ onValueChange?: (value: string) => void; value?: string }>,
  items: [] as Array<{ onSelect?: () => void }>,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuRadioGroup: ({
    children,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    onValueChange?: (value: string) => void;
    value?: string;
  }) => {
    menuCapture.radioGroups.push({ onValueChange, value });
    return createElement("div", { "data-value": value }, children);
  },
  DropdownMenuRadioItem: ({ children, value }: { children: ReactNode; value: string }) =>
    createElement("div", { "data-goal-acceptance-option": value }, children),
  DropdownMenuSeparator: () => createElement("div", { "data-testid": "mock-menu-separator" }),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: ReactNode;
    onSelect?: () => void;
  } & Record<string, unknown>) => {
    menuCapture.items.push({ onSelect });
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (k.startsWith("data-")) props[k] = v;
    }
    return createElement("div", { ...props, onClick: () => onSelect?.() }, children);
  },
}));

import {
  ConversationStatusPanel,
  GoalEditSettingsMenu,
} from "../src/v4/ConversationStatusPanel.js";

function goalState(overrides: Partial<GoalState> = {}): GoalState {
  return {
    targetId: "goal-1",
    objective: "修绿",
    summaryTitle: null,
    timeUsedSeconds: 0,
    activeRunStartedAtMs: null,
    status: "active",
    iteration: 1,
    verifications: [],
    iterations: [],
    revision: 3,
    acceptanceLevel: "production",
    ...overrides,
  } as GoalState;
}

const roots: Root[] = [];
async function renderMenu(goal: GoalState) {
  const onUpdateAcceptance = vi.fn();
  const onBindChengRef = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(GoalEditSettingsMenu, { goal, onUpdateAcceptance, onBindChengRef }));
  });
  return { container, onUpdateAcceptance, onBindChengRef };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  menuCapture.radioGroups.length = 0;
  menuCapture.items.length = 0;
});

describe("GoalEditSettingsMenu（S4 内化：自动绑定，UI 只剩等级与清除）", () => {
  it("等级 radio 初值 = 当前等级；切换即 dispatch 新等级", async () => {
    menuCapture.radioGroups.length = 0;
    const { onUpdateAcceptance } = await renderMenu(goalState({ acceptanceLevel: "diagnostic" }));
    const radio = menuCapture.radioGroups.at(-1);
    expect(radio?.value).toBe("diagnostic");

    await act(async () => {
      radio?.onValueChange?.("production");
    });
    expect(onUpdateAcceptance).toHaveBeenCalledWith("production");
  });

  it("已有绑定时显示只读 job/task chip；清除项 dispatch null（唯一命令面）", async () => {
    const bindSpy = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        createElement(GoalEditSettingsMenu, {
          goal: goalState({
            chengRef: { jobId: "job-9", task: "p06_fib", runId: "run-1" },
          }),
          onUpdateAcceptance: vi.fn(),
          onBindChengRef: bindSpy,
        }),
      );
    });
    const chip = document.querySelector("[data-goal-cheng-bound='job-9']");
    expect(chip?.textContent).toContain("p06_fib");
    const clearItem = document.querySelector("[data-goal-action='clear-cheng-bind']");
    expect(clearItem).not.toBeNull();
    await act(async () => {
      (clearItem as HTMLElement).click();
    });
    expect(bindSpy).toHaveBeenCalledWith(null);
    expect(bindSpy).toHaveBeenCalledTimes(1);
  });

  it("无绑定时无 chip 也无清除项（等自动绑定器填充）", async () => {
    await renderMenu(goalState());
    expect(document.querySelector("[data-goal-cheng-bound]")).toBeNull();
    expect(document.querySelector("[data-goal-action='clear-cheng-bind']")).toBeNull();
  });
});

describe("ConversationStatusPanel 设置入口可见性", () => {
  it("goal 带 revision 且回调在场 → 挂出；缺 revision（旧 CLI）或回调缺席 → 隐藏", () => {
    const baseProps = {
      workspacePath: "/repo",
      gitSummary: null,
      summaryPanelVariantOverride: "panel" as const,
      onPauseGoal: vi.fn(),
      onResumeGoal: vi.fn(),
      onUpdateGoalAcceptance: vi.fn(),
      onBindGoalChengRef: vi.fn(),
    };
    // 旧 CLI 快照：无 revision → 无 CAS 键，入口隐藏。
    const legacy = renderToStaticMarkup(
      createElement(ConversationStatusPanel, {
        ...baseProps,
        goal: goalState({ revision: undefined }),
      }),
    );
    expect(legacy).not.toContain('data-goal-action="settings"');

    // 带 revision + 回调 → 挂出，等级 radio 初值 = 当前等级。
    menuCapture.radioGroups.length = 0;
    renderToStaticMarkup(
      createElement(ConversationStatusPanel, {
        ...baseProps,
        goal: goalState({ acceptanceLevel: "diagnostic" }),
      }),
    );
    expect(menuCapture.radioGroups.at(-1)?.value).toBe("diagnostic");

    // 只读面（回调缺席）→ 隐藏。
    const readOnly = renderToStaticMarkup(
      createElement(ConversationStatusPanel, {
        ...baseProps,
        onUpdateGoalAcceptance: undefined,
        onBindGoalChengRef: undefined,
        goal: goalState(),
      }),
    );
    expect(readOnly).not.toContain('data-goal-action="settings"');
  });
});
