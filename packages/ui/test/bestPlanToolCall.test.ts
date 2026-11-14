// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskChatToolCall } from "../src/lib/taskChatMessageTypes.js";
import type { TaskChatToolCallTreeNode } from "../src/lib/toolCallTree.js";
import { buildToolDisplayModel } from "../src/lib/toolDisplay.js";
import { resolveToolCallIdentity } from "../src/lib/toolIdentity.js";
import { BestPlanToolCallBlock } from "../src/ToolCallBlocks/renderers/best-plan.js";
import { resolveToolCallRenderer } from "../src/ToolCallBlocks/resolveRenderer.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * ProposeBestPlan 的六字段契约（summary + 现状证据 + 候选方案 + 推荐 + 影响面 + 验证）。
 * UI 已把这张卡降级为纯传输通道：字段由 worker 回复陈述，任何形态的 input 都不再产出可见输出。
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

function bestPlanToolCall(input: unknown, status = "completed"): TaskChatToolCall {
  return {
    toolId: "tool-propose-best-plan",
    toolName: "ProposeBestPlan",
    kind: "other",
    input,
    status,
  };
}

function bestPlanNode(input: unknown, status?: string): TaskChatToolCallTreeNode {
  return { toolCall: bestPlanToolCall(input, status), childToolCalls: [] };
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
async function renderBestPlan(input: unknown, status = "completed"): Promise<HTMLDivElement> {
  const context = renderContext(bestPlanNode(input, status));
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

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
});

describe("BestPlanToolCallBlock", () => {
  it("六字段齐全也渲染为空：卡降级为纯传输通道，消息流不再出现第二份方案", async () => {
    const container = await renderBestPlan(BEST_PLAN_INPUT);

    expect(container.textContent).toBe("");
    expect(container.childElementCount).toBe(0);
  });

  it("坏 input 与 failed 状态同样渲染为空：通道不解析 input，也不画失败状态", async () => {
    for (const [input, status] of [
      [undefined, "completed"],
      [{}, "completed"],
      ["not-an-object", "completed"],
      [BEST_PLAN_INPUT, "failed"],
    ] as const) {
      const container = await renderBestPlan(input, status);

      expect(container.textContent).toBe("");
      expect(container.childElementCount).toBe(0);
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
