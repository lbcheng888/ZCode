// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskChatToolCall } from "../src/lib/taskChatMessageTypes.js";
import type { TaskChatToolCallTreeNode } from "../src/lib/toolCallTree.js";
import { buildToolDisplayModel } from "../src/lib/toolDisplay.js";
import { resolveToolCallIdentity } from "../src/lib/toolIdentity.js";
import { BestPlanToolCallBlock } from "../src/ToolCallBlocks/renderers/best-plan.js";
import { resolveToolCallRenderer } from "../src/ToolCallBlocks/resolveRenderer.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, unknown>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

/**
 * ProposeBestPlan 的六字段契约（summary + 现状证据 + 候选方案 + 推荐 + 影响面 + 验证）。
 * fixture 刻意用两种候选：卡面必须逐条给出 option 与其代价，而不是把它们并成一段散文。
 */
const BEST_PLAN_INPUT = {
  summary: "把 ProposeBestPlan 做成消息流内联卡",
  currentEvidence: "工具名未登记，卡片落 raw JSON 兜底",
  candidateOptions: [
    { option: "新增 best-plan family 与专用 renderer", cost: "shared 与 resolveRenderer 各改一处" },
    { option: "复用 fallback 卡并补文案", cost: "六个字段仍然摊成 JSON" },
  ],
  recommendation: "新增 best-plan family 与专用 renderer",
  impact: "只影响 ProposeBestPlan 这一条工具行",
  verification: "vitest run --project engineering packages/ui/test/bestPlanToolCall.test.ts",
} as const;

const BEST_PLAN_FIELD_KEYS = [
  "summary",
  "currentEvidence",
  "candidateOptions",
  "recommendation",
  "impact",
  "verification",
] as const;

function bestPlanToolCall(input: unknown, status = "completed"): TaskChatToolCall {
  return {
    toolId: "tool-propose-best-plan",
    toolName: "ProposeBestPlan",
    kind: "other",
    input,
    status,
  };
}

function bestPlanNode(input: unknown): TaskChatToolCallTreeNode {
  return { toolCall: bestPlanToolCall(input), childToolCalls: [] };
}

/** 与 ToolCallBlocks 宿主同一份装配：displayModel 走真实投影，其余字段给齐最小上下文。 */
function renderContext(node: TaskChatToolCallTreeNode): ToolCallBlockRenderContext {
  return {
    nestedToolRenderer: () => null,
    toolCallNode: node,
    workspacePath: "/workspace",
    displayModel: buildToolDisplayModel(node.toolCall, "/workspace"),
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "completed",
    childToolList: null,
  };
}

const roots: Root[] = [];

/** 从 resolveToolCallRenderer 取 renderer 再挂载：分流与渲染同一条链路，先分流失败就先暴露。 */
async function renderBestPlan(input: unknown): Promise<HTMLDivElement> {
  const context = renderContext(bestPlanNode(input));
  const Renderer: (props: ToolCallBlockRenderContext) => ReactNode =
    resolveToolCallRenderer(context);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(Renderer, context));
  });
  return container;
}

function textOf(container: HTMLElement): string {
  return container.textContent ?? "";
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
});

describe("BestPlanToolCallBlock", () => {
  it("按论证顺序渲染六字段，两个候选各自带 option 与 cost", async () => {
    const container = await renderBestPlan(BEST_PLAN_INPUT);
    const text = textOf(container);

    // 折叠行：种类词用 bestPlan.title，摘要直接用 input.summary。
    expect(text).toContain("bestPlan.title");
    expect(text).toContain(BEST_PLAN_INPUT.summary);

    expect(text).toContain("bestPlan.currentEvidence");
    expect(text).toContain(BEST_PLAN_INPUT.currentEvidence);
    expect(text).toContain("bestPlan.candidateOptions");
    expect(text).toContain("bestPlan.recommendation");
    expect(text).toContain(BEST_PLAN_INPUT.recommendation);
    expect(text).toContain("bestPlan.impact");
    expect(text).toContain(BEST_PLAN_INPUT.impact);
    expect(text).toContain("bestPlan.verification");
    expect(text).toContain(BEST_PLAN_INPUT.verification);

    const candidates = Array.from(container.querySelectorAll("li"));
    expect(candidates).toHaveLength(2);
    for (const [index, candidate] of BEST_PLAN_INPUT.candidateOptions.entries()) {
      expect(candidates[index]?.textContent).toContain(candidate.option);
      expect(candidates[index]?.textContent).toContain(candidate.cost);
    }

    // 顺序即论证顺序：现状证据 → 候选方案 → 推荐 → 影响面 → 验证方案。
    const positions = [
      "bestPlan.currentEvidence",
      "bestPlan.candidateOptions",
      "bestPlan.recommendation",
      "bestPlan.impact",
      "bestPlan.verification",
    ].map((heading) => text.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);

    // 不落 raw JSON：input 的字段名一个都不上屏（六字段以中文标签 + 正文出现）。
    for (const key of BEST_PLAN_FIELD_KEYS) {
      expect(text).not.toContain(`"${key}"`);
    }
  });

  it("空/坏 input 只给 bestPlan.invalid 降级文案，不摊 raw JSON", async () => {
    const badInputs: unknown[] = [
      undefined,
      null,
      {},
      "not-an-object",
      { ...BEST_PLAN_INPUT, candidateOptions: [] },
      { ...BEST_PLAN_INPUT, recommendation: "" },
      { ...BEST_PLAN_INPUT, candidateOptions: [{ option: "只有方案没有代价" }] },
      // 契约要求 2..4：只有一条候选没有比较，五条会压垮卡面。
      { ...BEST_PLAN_INPUT, candidateOptions: [{ option: "只有一条", cost: "没有比较" }] },
      {
        ...BEST_PLAN_INPUT,
        candidateOptions: Array.from({ length: 5 }, (_, index) => ({
          option: `候选${index}`,
          cost: `代价${index}`,
        })),
      },
    ];

    for (const input of badInputs) {
      const container = await renderBestPlan(input);
      const text = textOf(container);

      expect(text).toContain("bestPlan.invalid");
      // 卡片仍在（种类词在），但五段正文与候选列表都不画。
      expect(text).toContain("bestPlan.title");
      expect(text).not.toContain("bestPlan.currentEvidence");
      expect(text).not.toContain("bestPlan.verification");
      expect(container.querySelectorAll("li")).toHaveLength(0);
      for (const key of BEST_PLAN_FIELD_KEYS) {
        expect(text).not.toContain(`"${key}"`);
      }
    }
  });

  it("工具身份进入 best-plan family，分流到 BestPlanToolCallBlock", () => {
    const node = bestPlanNode(BEST_PLAN_INPUT);
    const identity = resolveToolCallIdentity(node.toolCall);

    expect(identity.family).toBe("best-plan");
    expect(identity.toolName).toBe("ProposeBestPlan");
    expect(resolveToolCallRenderer(renderContext(node))).toBe(BestPlanToolCallBlock);
  });
});

describe("bestPlan 文案键", () => {
  it("zh-CN 与 en-US 的 bestPlan 键完整对齐，候选模板带 option 与 cost", () => {
    const namespace = "bestPlan.";
    const zhKeys = Object.keys(zhCN)
      .filter((key) => key.startsWith(namespace))
      .sort();
    const enKeys = Object.keys(enUS)
      .filter((key) => key.startsWith(namespace))
      .sort();

    expect(enKeys).toEqual(zhKeys);
    expect(zhCN["bestPlan.title"]).toBe("超级代理最佳方案");
    expect(enUS["bestPlan.title"]).toBe("Super-agent best plan");
    expect(zhCN["bestPlan.candidateOption"]).toContain("{option}");
    expect(zhCN["bestPlan.candidateOption"]).toContain("{cost}");
  });
});
