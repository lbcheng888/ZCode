// @vitest-environment jsdom
// composer 会话统计条：buildComposerUsageStats 的口径，以及默认折叠/点击互斥展开。
// 仓库 UI 测试约定 createRoot + act，不使用 @testing-library/react。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  ConversationRow,
  SessionUsageState,
  ToolCallRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ComposerUsageStatsFooter,
  buildComposerUsageStats,
  formatContextPercent,
} from "../src/chat-input-toolbar/contextUsage.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const USAGE: SessionUsageState = {
  contextWindow: {
    usedTokens: 3_000,
    maxTokens: 8_000,
    autoCompactThresholdTokens: null,
  },
  cumulative: {
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
  },
};

function turnHeaderRow(rowId: number, overrides: Partial<TurnHeaderRow> = {}): TurnHeaderRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000 + rowId,
    ...overrides,
  };
}

function toolCallRow(rowId: number): ToolCallRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName: "Bash",
    status: "success",
    inputText: "{}",
  };
}

// 两轮 turnHeader 的工时与 output 都按行加权；toolCall 只计步数。
const ROWS: ConversationRow[] = [
  turnHeaderRow(1, { modelDurationMs: 4_000, toolDurationMs: 1_000, outputTokens: 100 }),
  toolCallRow(2),
  toolCallRow(3),
  toolCallRow(4),
  turnHeaderRow(5, { modelDurationMs: 6_000, toolDurationMs: 2_000, outputTokens: 100 }),
];

type StatsIntl = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string;
};

/** 直接用 zh-CN 真实文案，避免测试再维护一份标签副本。 */
const intl: StatsIntl = {
  formatMessage(descriptor, values) {
    let message = zhCN[descriptor.id] ?? descriptor.id;
    for (const [key, value] of Object.entries(values ?? {})) {
      message = message.replaceAll(`{${key}}`, String(value));
    }
    return message;
  },
};

const roots: Root[] = [];

beforeAll(() => {
  // Radix Popper 量触发器尺寸依赖 ResizeObserver；jsdom 没有。
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

async function renderFooter(
  options: {
    usage?: SessionUsageState | null;
    rows?: readonly ConversationRow[];
    partialWindow?: boolean;
  } = {},
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ComposerUsageStatsFooter, {
        usage: options.usage === undefined ? USAGE : options.usage,
        rows: options.rows ?? ROWS,
        partialWindow: options.partialWindow ?? false,
        intl,
        locale: "zh-CN",
      }),
    );
  });
  return container;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

function usagePill(container: HTMLElement, text: string): HTMLButtonElement {
  const buttons = [
    ...container.querySelectorAll<HTMLButtonElement>("[data-composer-usage-stats] button"),
  ];
  const button = buttons.find((candidate) => (candidate.textContent ?? "").includes(text));
  if (!button) throw new Error(`未找到统计 pill：${text}`);
  return button;
}

function panel(key: "session" | "token" | "context"): Element | null {
  return document.querySelector(`[data-composer-usage-stats-panel="${key}"]`);
}

/** 会话 pill 没有可见 label，靠 aria-label 定位；同时用它验证可访问名。 */
function sessionPill(container: HTMLElement): HTMLButtonElement {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>("[data-composer-usage-stats] button"),
  ].find((candidate) => (candidate.getAttribute("aria-label") ?? "").includes("会话统计"));
  if (!button) throw new Error("未找到会话统计 pill");
  return button;
}

function sessionAriaLabel(container: HTMLElement): string {
  return sessionPill(container).getAttribute("aria-label") ?? "";
}

/** UsageStatsPanelRow 是两个 span（标签/值）；按标签取渲染值。 */
function panelRowValue(element: Element, label: string): string | null {
  for (const row of element.querySelectorAll("div")) {
    const spans = row.querySelectorAll("span");
    if (spans.length === 2 && (spans[0]?.textContent ?? "") === label) {
      return spans[1]?.textContent ?? null;
    }
  }
  return null;
}

/** 裸“0%”指独立读数就是 0%，不是 20%/60% 这类更大百分比的一部分。 */
function bareZeroPercentElements(container: HTMLElement): Element[] {
  return [...container.querySelectorAll("*")].filter(
    (element) => (element.textContent ?? "").trim() === "0%",
  );
}

describe("buildComposerUsageStats", () => {
  it("从真实 usage 与 turnHeader/toolCall 行汇总 token、缓存、上下文和加权工时", () => {
    const stats = buildComposerUsageStats(USAGE, ROWS);

    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.totalTokens).toBe(1_200);
    expect(stats.cacheHitRate).toBeCloseTo(0.6);
    expect(stats.uncachedInputTokens).toBe(400);
    expect(stats.cacheReadTokens).toBe(600);
    expect(stats.cacheWriteTokens).toBe(100);
    expect(stats.outputTokens).toBe(200);
    expect(stats.contextUsedTokens).toBe(3_000);
    expect(stats.contextMaxTokens).toBe(8_000);
    expect(stats.contextPercent).toBeCloseTo(0.375);
    expect(stats.turns).toBe(2);
    expect(stats.steps).toBe(3);
    expect(stats.modelDurationMs).toBe(10_000);
    expect(stats.toolDurationMs).toBe(3_000);
    expect(stats.timedTurns).toBe(2);
    // 加权口径：同一批同时有 outputTokens 与 modelDurationMs 的 turnHeader 行，
    // 用 output 之和 / modelDuration 之和，而不是最后一轮的瞬时值。
    expect(stats.tokensPerSecond).toBeCloseTo(20);
    expect(stats.partialWindow).toBe(false);
  });

  it("工时 optional 缺失时返回 null 而不是 0，输出速度只用同一批带工时行", () => {
    const rows: ConversationRow[] = [
      turnHeaderRow(1, { modelDurationMs: 4_000, outputTokens: 100 }),
      // 有 output 但没有 modelDurationMs：不得进入速度的分子。
      turnHeaderRow(2, { outputTokens: 1_000 }),
      // 有工时但没有 outputTokens：同样不得进入速度的分母。
      turnHeaderRow(3, { modelDurationMs: 6_000 }),
    ];
    const stats = buildComposerUsageStats(USAGE, rows);

    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.turns).toBe(3);
    // 只有第 1、3 行带 modelDurationMs，求和只覆盖这两行。
    expect(stats.modelDurationMs).toBe(10_000);
    // 没有任何一行带 toolDurationMs：缺失就是 null，不是 0。
    expect(stats.toolDurationMs).toBeNull();
    // 三轮都没有 toolDurationMs，模型/工具工时齐全的行数为 0。
    expect(stats.timedTurns).toBe(0);
    // 若跨行混合会得到 (100+1000)/10s = 110 tok/s；同一批行口径是 100/4s = 25。
    expect(stats.tokensPerSecond).toBeCloseTo(25);
  });

  it("显式 0 工时按缺失处理，不计覆盖也不放大 tok/s", () => {
    // 普通 provider + 工具的真实投影：上游只记录工具区间，缺失的模型段被落成
    // modelDurationMs: 0（见 product-projection highspeedTimingForTurn）。
    const rows: ConversationRow[] = [
      turnHeaderRow(1, { modelDurationMs: 0, toolDurationMs: 2_000, outputTokens: 1_000 }),
      turnHeaderRow(2, { modelDurationMs: 4_000, toolDurationMs: 0, outputTokens: 100 }),
    ];
    const stats = buildComposerUsageStats(USAGE, rows);

    expect(stats).not.toBeNull();
    if (!stats) return;
    // 0 段不参与求和：模型只有第 2 行的 4s，工具有第 1 行的 2s。
    expect(stats.modelDurationMs).toBe(4_000);
    expect(stats.toolDurationMs).toBe(2_000);
    // 第 1 行模型 0ms、第 2 行工具 0ms：没有任何一轮模型+工具都有效。
    expect(stats.timedTurns).toBe(0);
    // 若把 0ms 行计入分子会得到 (1000+100)/4s = 275；有效同批只有 100/4s = 25。
    expect(stats.tokensPerSecond).toBeCloseTo(25);
  });

  it("没有任何带工时行时工时与速度均为 null", () => {
    const rows: ConversationRow[] = [
      turnHeaderRow(1, { outputTokens: 100 }),
      turnHeaderRow(2, { outputTokens: 300 }),
    ];
    const stats = buildComposerUsageStats(USAGE, rows);

    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.modelDurationMs).toBeNull();
    expect(stats.toolDurationMs).toBeNull();
    expect(stats.timedTurns).toBe(0);
    expect(stats.tokensPerSecond).toBeNull();
  });

  it("覆盖计数只统计模型与工具工时都齐全的 turn 行", () => {
    const rows: ConversationRow[] = [
      turnHeaderRow(1, { modelDurationMs: 4_000, toolDurationMs: 1_000, outputTokens: 100 }),
      // 只有模型工时，缺工具工时：不计入覆盖。
      turnHeaderRow(2, { modelDurationMs: 6_000, outputTokens: 100 }),
      // 两个工时都没有：不计入覆盖。
      turnHeaderRow(3, { outputTokens: 100 }),
    ];
    const stats = buildComposerUsageStats(USAGE, rows);

    expect(stats?.turns).toBe(3);
    expect(stats?.timedTurns).toBe(1);
  });

  it("partialWindow 由调用方透传；缺失 usage 或没有可展示事实时返回 null", () => {
    expect(buildComposerUsageStats(USAGE, ROWS, true)?.partialWindow).toBe(true);

    expect(buildComposerUsageStats(null, ROWS)).toBeNull();
    expect(buildComposerUsageStats(undefined, ROWS)).toBeNull();
    expect(
      buildComposerUsageStats(
        {
          contextWindow: null,
          cumulative: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        ROWS,
      ),
    ).toBeNull();
  });
});

describe("formatContextPercent", () => {
  const belowPointOnePercentLabel = "低于 0.1%";

  it("null 与 0 不被改写成下限文案，恰好 0.1% 仍由 Intl 格式化", () => {
    expect(formatContextPercent(null, "zh-CN", { belowPointOnePercentLabel })).toBeNull();
    // 0 是真实的零占用；不能因为四舍五入成 0% 就改写成「低于 0.1%」。
    expect(formatContextPercent(0, "zh-CN", { belowPointOnePercentLabel })).toBe("0%");
    // 0.001 是阈值本身，Intl 输出 0.1%；判定必须严格小于才走下限文案。
    expect(formatContextPercent(0.001, "zh-CN", { belowPointOnePercentLabel })).toBe("0.1%");
    expect(formatContextPercent(0.0016, "zh-CN", { belowPointOnePercentLabel })).toBe("0.2%");
    expect(formatContextPercent(0.375, "zh-CN", { belowPointOnePercentLabel })).toBe("37.5%");
  });

  it("非零且低于 0.1% 返回调用方传入的本地化下限文案", () => {
    expect(formatContextPercent(0.0004, "zh-CN", { belowPointOnePercentLabel })).toBe("低于 0.1%");
    expect(
      formatContextPercent(0.0001, "en-US", {
        belowPointOnePercentLabel: enUS["chat.composerUsageStats.belowPointOnePercent"] ?? "",
      }),
    ).toBe("below 0.1%");
  });

  it("zh-CN 与 en-US 的统计条文案键完整对齐", () => {
    const namespace = "chat.composerUsageStats.";
    const zhKeys = Object.keys(zhCN)
      .filter((key) => key.startsWith(namespace))
      .sort();
    const enKeys = Object.keys(enUS)
      .filter((key) => key.startsWith(namespace))
      .sort();
    expect(enKeys).toEqual(zhKeys);
    expect(zhCN["chat.composerUsageStats.durationCoverage"]).toBe(
      "模型+工具工时齐全 {covered}/{total} 轮",
    );
    expect(enUS["chat.composerUsageStats.durationCoverage"]).toBe(
      "Model+tool timing complete {covered}/{total} turns",
    );
  });
});

describe("ComposerUsageStatsFooter", () => {
  it("默认折叠：渲染三颗读数，但不挂载 PopoverContent", async () => {
    const container = await renderFooter();

    expect(container.querySelector("[data-composer-usage-stats]")).not.toBeNull();
    expect(container.querySelectorAll("[data-composer-usage-stats] button")).toHaveLength(3);
    expect(container.textContent).toContain("2 轮 · 3 步 · 20 tok/s");
    // 会话 pill 不能只有数值文本；可访问名必须同时给出“会话统计”和折叠读数。
    const ariaLabel = sessionAriaLabel(container);
    expect(ariaLabel).toContain("会话统计");
    expect(ariaLabel).toContain("2 轮");
    expect(ariaLabel).toContain("3 步");
    expect(ariaLabel).toContain("20 tok/s");
    // Token/Context pill 的可见 label 仍在，继续作为原生可访问名的一部分。
    expect(usagePill(container, "Token 用量").textContent).toContain("Token 用量");
    expect(usagePill(container, "上下文").textContent).toContain("上下文");
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it("点击会话统计 pill 展开后 aria-expanded=true，再点一次收起", async () => {
    const container = await renderFooter();
    const pill = sessionPill(container);

    // 折叠态：Radix PopoverTrigger 注入 aria-haspopup/aria-expanded。
    expect(pill.getAttribute("aria-expanded")).toBe("false");

    await click(pill);
    const sessionPanel = panel("session");
    expect(sessionPanel).not.toBeNull();
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(sessionPanel?.textContent).toContain("会话统计");
    expect(sessionPanel?.textContent).toContain("模型用时");
    expect(sessionPanel?.textContent).toContain("0 分 10 秒");
    expect(sessionPanel?.textContent).toContain("工具调用用时");
    expect(sessionPanel?.textContent).toContain("0 分 3 秒");

    await click(pill);
    expect(panel("session")).toBeNull();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("点击 Token 用量 pill 展开缓存命中/未缓存输入/缓存读取/输出，再点一次收起", async () => {
    const container = await renderFooter();
    const pill = usagePill(container, "Token 用量");

    await click(pill);
    const tokenPanel = panel("token");
    expect(tokenPanel).not.toBeNull();
    expect(tokenPanel?.getAttribute("aria-label")).toBe("Token 用量");
    expect(tokenPanel?.textContent).toContain("缓存命中");
    expect(tokenPanel?.textContent).toContain("60%");
    expect(tokenPanel?.textContent).toContain("未缓存输入");
    expect(tokenPanel?.textContent).toContain("400 tok");
    expect(tokenPanel?.textContent).toContain("缓存读取");
    expect(tokenPanel?.textContent).toContain("600 tok");
    expect(tokenPanel?.textContent).toContain("输出");
    expect(tokenPanel?.textContent).toContain("200 tok");

    await click(pill);
    expect(panel("token")).toBeNull();
  });

  it("点击上下文 pill 展开 used/max、百分比与缓存命中，再点一次收起", async () => {
    const container = await renderFooter();
    const pill = usagePill(container, "上下文");

    await click(pill);
    const contextPanel = panel("context");
    expect(contextPanel).not.toBeNull();
    expect(contextPanel?.getAttribute("aria-label")).toBe("上下文");
    expect(contextPanel?.textContent).toContain("3,000 / 8,000");
    // 百分比保留一位小数：37.5% 不能四舍五入成 38%。
    expect(contextPanel?.textContent).toContain("37.5%");
    expect(contextPanel?.textContent).toContain("缓存命中");
    expect(contextPanel?.textContent).toContain("60%");

    await click(pill);
    expect(panel("context")).toBeNull();
  });

  it("打开 Token 用量时会话统计自动关闭，同一时间只开一个面板", async () => {
    const container = await renderFooter();
    const sessionPill = usagePill(container, "2 轮");
    const tokenPill = usagePill(container, "Token 用量");

    await click(sessionPill);
    expect(panel("session")).not.toBeNull();

    // jsdom 的 click() 不会像真实鼠标那样先派发 pointerdown；按 mousedown → click 顺序补一次
    // 指针按下，让会话面板先走 outside-close，再打开 token。
    await act(async () => {
      // Radix 在挂载后延迟一个 macrotask 才监听 document pointerdown。
      await new Promise((resolve) => setTimeout(resolve, 0));
      tokenPill.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    await click(tokenPill);
    expect(panel("session")).toBeNull();
    expect(panel("token")).not.toBeNull();
    expect(document.querySelectorAll('[data-slot="popover-content"]')).toHaveLength(1);
  });

  it("点击 body 外部后所有 popover 关闭", async () => {
    const container = await renderFooter();
    const pill = sessionPill(container);

    await click(pill);
    expect(panel("session")).not.toBeNull();
    expect(pill.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      // Radix 在挂载后延迟一个 macrotask 才监听 document pointerdown。
      await new Promise((resolve) => setTimeout(resolve, 0));
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });

    expect(document.querySelectorAll('[data-slot="popover-content"]')).toHaveLength(0);
    expect(panel("session")).toBeNull();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("没有 usage 时 footer 整体不存在", async () => {
    const container = await renderFooter({ usage: null });

    expect(container.querySelector("[data-composer-usage-stats]")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it("窗口不完整时，折叠态与统计面板都明确标注已加载窗口", async () => {
    const container = await renderFooter({ partialWindow: true });

    // 折叠态必须先把 turns/steps/tok/s 的窗口口径写在最前面，不能当作会话总量。
    expect(container.textContent).toContain("已加载窗口 · 2 轮 · 3 步 · 20 tok/s");
    // 可访问名同样要带上窗口口径，读屏不能把已加载窗口当成会话总量。
    expect(sessionAriaLabel(container)).toContain("会话统计");
    expect(sessionAriaLabel(container)).toContain("已加载窗口");

    await click(usagePill(container, "2 轮"));
    expect(panel("session")?.textContent).toContain("数据范围：已加载窗口");
  });

  it("面板宽度用响应式上限，窄屏不会溢出", async () => {
    const container = await renderFooter();

    await click(usagePill(container, "2 轮"));
    expect(panel("session")?.className).toContain("w-[min(20rem,calc(100vw-2rem))]");
    // min() 已限宽，max-w 作为上限兜底；footer 自身允许换行并允许子项收缩。
    expect(panel("session")?.className).toContain("max-w-[calc(100vw-2rem)]");
    const footer = container.querySelector("[data-composer-usage-stats]");
    expect(footer?.className).toContain("flex-wrap");
    expect(footer?.className).toContain("min-w-0");
  });

  it("只有模型工时：保留模型用时，文案点明模型+工具两项齐全 0/2 轮", async () => {
    const rows: ConversationRow[] = [
      // 第 1 行只有模型工时（整窗没有 toolDurationMs）；第 2 行没有工时。
      turnHeaderRow(1, { modelDurationMs: 4_000, outputTokens: 100 }),
      turnHeaderRow(2, { outputTokens: 100 }),
    ];
    const container = await renderFooter({ rows });

    await click(sessionPill(container));
    const sessionPanel = panel("session");
    expect(sessionPanel?.textContent).toContain("模型用时");
    expect(sessionPanel?.textContent).toContain("0 分 4 秒");
    expect(sessionPanel?.textContent).toContain("工具调用用时");
    expect(sessionPanel?.textContent).toContain("—");
    // 新文案点名「模型+工具工时齐全」：0/2 仅表示没有一轮两项齐全，不是工时完全缺失。
    expect(sessionPanel?.textContent).toContain("模型+工具工时齐全 0/2 轮");
    expect(sessionPanel?.textContent).not.toContain("工时覆盖");
  });

  it("只有工具工时：保留工具用时，文案点明模型+工具两项齐全 0/2 轮", async () => {
    const rows: ConversationRow[] = [
      // 第 1 行只有工具工时；第 2 行没有工时。
      turnHeaderRow(1, { toolDurationMs: 1_000, outputTokens: 100 }),
      turnHeaderRow(2, { outputTokens: 100 }),
    ];
    const container = await renderFooter({ rows });

    await click(sessionPill(container));
    const sessionPanel = panel("session");
    expect(sessionPanel).not.toBeNull();
    if (!sessionPanel) return;
    expect(panelRowValue(sessionPanel, "模型用时")).toBe("—");
    expect(panelRowValue(sessionPanel, "工具调用用时")).toBe("0 分 1 秒");
    expect(sessionPanel.textContent).toContain("模型+工具工时齐全 0/2 轮");
    expect(sessionPanel.textContent).not.toContain("工时覆盖");
  });

  it("模型+工具工时齐全计数只统计两项都齐全的行", async () => {
    const rows: ConversationRow[] = [
      turnHeaderRow(1, { modelDurationMs: 4_000, toolDurationMs: 1_000, outputTokens: 100 }),
      turnHeaderRow(2, { modelDurationMs: 6_000, outputTokens: 100 }),
      turnHeaderRow(3, { outputTokens: 100 }),
    ];
    const container = await renderFooter({ rows });

    await click(sessionPill(container));
    expect(panel("session")?.textContent).toContain("模型+工具工时齐全 1/3 轮");
  });

  it("工时全部齐全时不显示覆盖提示", async () => {
    const container = await renderFooter();

    await click(sessionPill(container));
    expect(panel("session")?.textContent).not.toContain("模型+工具工时齐全");
  });

  it("没有工时行时模型/工具/输出速度都显示 —，折叠 pill 不显示 tok/s", async () => {
    const rows: ConversationRow[] = [
      turnHeaderRow(1, { outputTokens: 100 }),
      turnHeaderRow(2, { outputTokens: 100 }),
    ];
    const container = await renderFooter({ rows });
    const pill = sessionPill(container);

    expect(pill.textContent).not.toContain("tok/s");
    // 可访问名跟随折叠读数：仍保留轮/步（这里没有 toolCall 行，步数为 0），
    // 但没有 tok/s 时不虚构速度。
    expect(sessionAriaLabel(container)).toContain("2 轮");
    expect(sessionAriaLabel(container)).toContain("0 步");
    expect(sessionAriaLabel(container)).not.toContain("tok/s");
    await click(pill);
    const sessionPanel = panel("session");
    expect(sessionPanel).not.toBeNull();
    if (!sessionPanel) return;
    expect(panelRowValue(sessionPanel, "模型用时")).toBe("—");
    expect(panelRowValue(sessionPanel, "工具调用用时")).toBe("—");
    expect(panelRowValue(sessionPanel, "输出速度")).toBe("—");
  });

  it("显式 0 工时面板显示 —，并按缺失计入模型+工具工时齐全计数", async () => {
    const rows: ConversationRow[] = [
      // 与线上普通 provider 工具轮同形：模型工时 0、工具工时 >0。
      turnHeaderRow(1, { modelDurationMs: 0, toolDurationMs: 1_000, outputTokens: 100 }),
    ];
    const container = await renderFooter({ rows });
    const pill = sessionPill(container);

    expect(pill.textContent).not.toContain("tok/s");
    await click(pill);
    const sessionPanel = panel("session");
    expect(sessionPanel).not.toBeNull();
    if (!sessionPanel) return;
    expect(panelRowValue(sessionPanel, "模型用时")).toBe("—");
    expect(panelRowValue(sessionPanel, "工具调用用时")).toBe("0 分 1 秒");
    expect(sessionPanel.textContent).toContain("模型+工具工时齐全 0/1 轮");
    expect(panelRowValue(sessionPanel, "输出速度")).toBe("—");
  });

  it("totalTokens<=0 时不渲染 Token pill，但保留有效的 Context pill", async () => {
    const container = await renderFooter({
      usage: {
        ...USAGE,
        cumulative: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });

    expect(container.querySelector("[data-composer-usage-stats]")).not.toBeNull();
    expect(container.querySelectorAll("[data-composer-usage-stats] button")).toHaveLength(2);
    expect(container.textContent).not.toContain("Token 用量");
    expect(container.textContent).toContain("上下文");
  });

  it("上下文 used/max 为 0 时不渲染 Context pill（保留 Token pill），也不出现裸 0%", async () => {
    const container = await renderFooter({
      usage: {
        ...USAGE,
        contextWindow: {
          usedTokens: 0,
          maxTokens: 8_000,
          autoCompactThresholdTokens: null,
        },
      },
    });

    expect(container.querySelectorAll("[data-composer-usage-stats] button")).toHaveLength(2);
    expect(container.textContent).not.toContain("上下文");
    expect(container.textContent).toContain("Token 用量");
    // 0% 是不该出现的读数；Token pill 里的 60% 等数字不算裸 0%。
    expect(bareZeroPercentElements(container)).toHaveLength(0);
  });

  it("只有 token 事实时只渲染 Token pill", async () => {
    const container = await renderFooter({
      usage: {
        contextWindow: null,
        cumulative: {
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      rows: [],
    });

    expect(container.querySelectorAll("[data-composer-usage-stats] button")).toHaveLength(1);
    expect(container.textContent).toContain("Token 用量");
    expect(container.textContent).not.toContain("上下文");
  });

  it("只有 context 事实时只渲染 Context pill", async () => {
    const container = await renderFooter({
      usage: {
        contextWindow: {
          usedTokens: 3_000,
          maxTokens: 8_000,
          autoCompactThresholdTokens: null,
        },
        cumulative: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      rows: [],
    });

    expect(container.querySelectorAll("[data-composer-usage-stats] button")).toHaveLength(1);
    expect(container.textContent).toContain("上下文");
    expect(container.textContent).not.toContain("Token 用量");
  });

  it("cumulative 为 0 且 context used 为 0 时 footer 整体不渲染", async () => {
    const container = await renderFooter({
      usage: {
        contextWindow: {
          usedTokens: 0,
          maxTokens: 8_000,
          autoCompactThresholdTokens: null,
        },
        cumulative: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });

    expect(container.querySelector("[data-composer-usage-stats]")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("Token 与 Context 都无意义时 footer 返回 null", async () => {
    const container = await renderFooter({
      usage: {
        contextWindow: {
          usedTokens: 0,
          maxTokens: 0,
          autoCompactThresholdTokens: null,
        },
        cumulative: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });

    expect(container.querySelector("[data-composer-usage-stats]")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("0.2% 保留一位小数，不显示成 0%", async () => {
    const container = await renderFooter({
      usage: {
        ...USAGE,
        contextWindow: {
          usedTokens: 16,
          maxTokens: 8_000,
          autoCompactThresholdTokens: null,
        },
      },
    });

    expect(usagePill(container, "上下文").textContent).toContain("0.2%");
    expect(bareZeroPercentElements(container)).toHaveLength(0);
  });

  // >0 但四舍五入会变成 0.0% 的占比必须显示明确下限，不能让人误读成上下文完全未占用。
  async function expectBelowPointOnePercent(usedTokens: number, maxTokens: number): Promise<void> {
    const container = await renderFooter({
      usage: {
        ...USAGE,
        contextWindow: {
          usedTokens,
          maxTokens,
          autoCompactThresholdTokens: null,
        },
      },
    });

    expect(usagePill(container, "上下文").textContent).toContain("低于 0.1%");
    expect(bareZeroPercentElements(container)).toHaveLength(0);
  }

  it("0.04% 显示“低于 0.1%”，不显示成裸 0%", async () => {
    await expectBelowPointOnePercent(10, 25_000);
  });

  it("0.01% 显示“低于 0.1%”，不显示成裸 0%", async () => {
    await expectBelowPointOnePercent(1, 10_000);
  });
});

describe("isComposerUsageStatsWindowPartial", () => {
  it("totalCount 大于已加载窗口长度时为 true，相等时为 false", async () => {
    // 契约：从 ConversationComposer 抽出并导出纯 helper。实现 lane 落地前此用例明确失败，
    // 不用 skip/本地副本掩盖缺口。
    const module = (await import("../src/v4/ConversationComposer.js")) as {
      isComposerUsageStatsWindowPartial?: (
        totalCount: number | undefined,
        windowLength: number | undefined,
      ) => boolean;
    };
    const helper = module.isComposerUsageStatsWindowPartial;
    expect(helper).toBeTypeOf("function");
    if (!helper) return;

    expect(helper(5, 3)).toBe(true);
    expect(helper(3, 3)).toBe(false);
  });
});
