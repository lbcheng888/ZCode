// @vitest-environment jsdom
// S4 goal 用户直改入口（GoalEditSettingsMenu）：等级 radio 即时 dispatch、绑定弹窗
// payload（jobId/task）、已有绑定的清除路径；ConversationStatusPanel 的入口可见性
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
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => {
    menuCapture.items.push({ onSelect });
    return createElement(
      "div",
      {
        "data-goal-action": "bind-cheng",
        onClick: () => onSelect?.(),
      },
      children,
    );
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

/** 受控 Input 的原生值设置 + input 事件（React onChange 监听 input 事件）。 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("GoalEditSettingsMenu", () => {
  it("等级 radio 初值 = 当前等级；切换即 dispatch 新等级", async () => {
    const { onUpdateAcceptance } = await renderMenu(goalState({ acceptanceLevel: "diagnostic" }));
    const radio = menuCapture.radioGroups.at(-1);
    expect(radio?.value).toBe("diagnostic");

    await act(async () => {
      radio?.onValueChange?.("production");
    });
    expect(onUpdateAcceptance).toHaveBeenCalledWith("production");
  });

  it("绑定弹窗：打开预填当前绑定，改输入后 dispatch 精确 payload（不含 runId）", async () => {
    const { onBindChengRef } = await renderMenu(
      goalState({ chengRef: { jobId: "job-9", task: "p06", runId: "run-1" } }),
    );

    await act(async () => {
      menuCapture.items.at(-1)?.onSelect?.();
    });
    const jobIdInput = document.querySelector("[data-goal-cheng-bind-job-id]") as HTMLInputElement;
    const taskInput = document.querySelector("[data-goal-cheng-bind-task]") as HTMLInputElement;
    expect(jobIdInput?.value).toBe("job-9");
    expect(taskInput?.value).toBe("p06");

    await act(async () => {
      setInputValue(jobIdInput, "job-10");
      setInputValue(taskInput, "p14");
    });
    await act(async () => {
      (document.querySelector("[data-goal-cheng-bind-submit]") as HTMLButtonElement).click();
    });
    expect(onBindChengRef).toHaveBeenCalledWith({ jobId: "job-10", task: "p14" });
  });

  it("空输入禁用提交；已有绑定可一键清除（dispatch null）", async () => {
    const { onBindChengRef } = await renderMenu(
      goalState({ chengRef: { jobId: "job-9", task: "p06", runId: "run-1" } }),
    );
    await act(async () => {
      menuCapture.items.at(-1)?.onSelect?.();
    });

    const jobIdInput = document.querySelector("[data-goal-cheng-bind-job-id]") as HTMLInputElement;
    await act(async () => {
      setInputValue(jobIdInput, " ");
    });
    const submit = document.querySelector("[data-goal-cheng-bind-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await act(async () => {
      (document.querySelector("[data-goal-cheng-bind-clear]") as HTMLButtonElement).click();
    });
    expect(onBindChengRef).toHaveBeenCalledWith(null);
    expect(onBindChengRef).toHaveBeenCalledTimes(1);
  });

  it("无既有绑定时弹窗不提供清除按钮", async () => {
    await renderMenu(goalState());
    await act(async () => {
      menuCapture.items.at(-1)?.onSelect?.();
    });
    expect(document.querySelector("[data-goal-cheng-bind-clear]")).toBeNull();
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
