// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { swarmActivityStateSchema } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";
import {
  ComposerStatusChips,
  type ComposerSwarmActivity,
  type ComposerSwarmActivityUnit,
} from "../src/v4/composer/ComposerStatusChips.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, unknown>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

/**
 * 与 v4 snapshot.swarmActivity 的宿主投影同形：基础计数对应 SwarmActivityState
 * （cancelled 与 failed 一样不计入 completed），units 是逐 worker 明细
 * taskId/description/status/error。只 mock i18n 取值器，chip 与面板走真实组件。
 */
const SWARM_UNITS = [
  { taskId: "task-pending", description: "梳理协议 schema 与快照键", status: "pending" },
  { taskId: "task-running", description: "实现宿主编排投影", status: "running" },
  { taskId: "task-done", description: "补齐单元测试", status: "done" },
  {
    taskId: "task-failed",
    description: "接入旧发送端",
    status: "failed",
    error: "子代理执行失败：provider 连接超时",
  },
  {
    taskId: "task-cancelled",
    description: "回写合并闸门",
    status: "cancelled",
    error: "合并闸门拒绝：基准工作树不清洁",
  },
] as const satisfies readonly ComposerSwarmActivityUnit[];

function swarmActivity(overrides: Partial<ComposerSwarmActivity> = {}): ComposerSwarmActivity {
  // 计数与 units 都走真实 v4 schema 解析：协议漂移会让本用例先失败。
  return swarmActivityStateSchema.parse({
    roundId: "round-1",
    activeUnits: 2,
    completedUnits: 1,
    totalUnits: 5,
    failedUnits: 2,
    units: SWARM_UNITS,
    ...overrides,
  });
}

function statusPanelModel(): ConversationStatusPanelModel {
  return {
    hasContent: true,
    git: null,
    goal: null,
    sessionPlans: null,
    plan: null,
    runningBashWorks: [],
    runningSubagentWorks: [],
    runningWorkflowRuns: [],
  };
}

const roots: Root[] = [];

async function renderChips(
  activity: ComposerSwarmActivity,
  defaultOpenChip: "swarm" | null = null,
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ComposerStatusChips, {
        model: statusPanelModel(),
        swarmActivity: activity,
        defaultOpenChip,
      }),
    );
  });
  return container;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLButtonElement).click();
  });
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("SwarmActivityPanel", () => {
  it("展开蜂群 chip 后按 units 顺序渲染每个 worker 的状态与描述", async () => {
    const container = await renderChips(swarmActivity());
    expect(container.firstElementChild?.className).toBe("relative flex flex-col gap-2 mb-0");
    const chip = container.querySelector("button[aria-expanded]");
    expect(chip).not.toBeNull();
    if (!chip) return;
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-composer-status-panel="swarm"]')).toBeNull();
    // 收起态不渲染空浮层，chip 行仍直接参与文档流。
    expect(container.querySelector('[data-composer-status-overlay="true"]')).toBeNull();

    await click(chip);

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    // 面板挂在绝对定位浮层里，chip 行不在浮层内：展开不改变行高与 composer 位置。
    const overlay = container.querySelector('[data-composer-status-overlay="true"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.className).toBe(
      "absolute bottom-full left-0 z-30 flex w-full flex-col gap-2 mb-2 pointer-events-auto",
    );
    expect(overlay?.querySelector('[data-composer-status-panel="swarm"]')).not.toBeNull();
    expect(overlay?.querySelector("button[aria-expanded]")).toBeNull();
    expect(container.querySelector('[data-composer-status-panel="swarm"]')).not.toBeNull();
    const rows = [...container.querySelectorAll("[data-swarm-unit]")];
    expect(rows.map((row) => row.getAttribute("data-swarm-unit"))).toEqual(
      SWARM_UNITS.map((unit) => unit.taskId),
    );
    expect(rows.map((row) => row.getAttribute("data-swarm-unit-status"))).toEqual(
      SWARM_UNITS.map((unit) => unit.status),
    );
    for (const [index, unit] of SWARM_UNITS.entries()) {
      const row = rows[index];
      expect(row).toBeDefined();
      if (!row) continue;
      // 五态各有自己的 i18n 文案；描述按行原序展示并带完整 title（视觉上 truncate）。
      expect(row.textContent).toContain(`chat.composerChips.swarmUnit.${unit.status}`);
      expect(row.textContent).toContain(unit.description);
      expect(
        [...row.querySelectorAll("[title]")].some(
          (element) => element.getAttribute("title") === unit.description,
        ),
      ).toBe(true);
    }

    // 再点一次收起：浮层连同面板一起消失，chip 回到可展开态。
    await click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-composer-status-panel="swarm"]')).toBeNull();
    expect(container.querySelector('[data-composer-status-overlay="true"]')).toBeNull();
  });

  it("failed/cancelled 行展示原始错误，done 行不带错误副行", async () => {
    const container = await renderChips(swarmActivity(), "swarm");
    const failedRow = container.querySelector('[data-swarm-unit="task-failed"]');
    const cancelledRow = container.querySelector('[data-swarm-unit="task-cancelled"]');
    const doneRow = container.querySelector('[data-swarm-unit="task-done"]');
    expect(failedRow).not.toBeNull();
    expect(cancelledRow).not.toBeNull();
    expect(doneRow).not.toBeNull();

    expect(failedRow?.textContent).toContain("子代理执行失败：provider 连接超时");
    expect(
      [...(failedRow?.querySelectorAll("[title]") ?? [])].some(
        (element) => element.getAttribute("title") === "子代理执行失败：provider 连接超时",
      ),
    ).toBe(true);
    expect(cancelledRow?.textContent).toContain("合并闸门拒绝：基准工作树不清洁");
    expect(
      [...(cancelledRow?.querySelectorAll("[title]") ?? [])].some(
        (element) => element.getAttribute("title") === "合并闸门拒绝：基准工作树不清洁",
      ),
    ).toBe(true);
    expect(doneRow?.textContent).toContain("chat.composerChips.swarmUnit.done");
    expect(doneRow?.textContent).not.toContain("连接超时");
    expect(doneRow?.textContent).not.toContain("合并闸门拒绝");
  });

  it("running 行只展示 lastMessage 副行，终态行不渲染活动/消息", async () => {
    const liveUnits = [
      {
        taskId: "task-live",
        description: "实时任务",
        status: "running",
        agentId: "agent-1",
        childSessionId: "child-1",
        // 旧快照可能还带 currentActivity；新投影不再写，UI 也不得把它渲染成重复状态文案。
        currentActivity: "running",
        lastMessage: "正在读取 src/index.ts",
      },
      {
        taskId: "task-settled",
        description: "已结束任务",
        status: "done",
        // 终态行即使数据里残留活动字段也不能再渲染活动副行。
        currentActivity: "running",
        lastMessage: "终态残留消息",
      },
    ] as const satisfies readonly ComposerSwarmActivityUnit[];
    const container = await renderChips(
      swarmActivity({
        activeUnits: 1,
        completedUnits: 1,
        failedUnits: 0,
        totalUnits: 2,
        units: liveUnits,
      }),
      "swarm",
    );

    const liveRow = container.querySelector('[data-swarm-unit="task-live"]');
    const settledRow = container.querySelector('[data-swarm-unit="task-settled"]');
    expect(liveRow?.querySelector("[data-swarm-unit-last-message]")?.textContent).toBe(
      "正在读取 src/index.ts",
    );
    // running 行只多一条最近消息：状态文案恰好出现一次，不再有「当前活动：运行中」副行。
    expect(liveRow?.textContent?.split("chat.composerChips.swarmUnit.running")).toHaveLength(2);
    expect(liveRow?.textContent).not.toContain("chat.composerChips.swarmUnit.activityLine");
    // 终态清空活动行：不渲染活动容器、活动文案与残留消息。
    expect(settledRow?.querySelector("[data-swarm-unit-activity]")).toBeNull();
    expect(settledRow?.querySelector("[data-swarm-unit-last-message]")).toBeNull();
    expect(settledRow?.textContent).not.toContain("chat.composerChips.swarmUnit.activityLine");
    expect(settledRow?.textContent).not.toContain("终态残留消息");
  });

  it("units 仍在时即使本轮已全部收尾也保留可展开 chip", async () => {
    const terminalUnits = SWARM_UNITS.map((unit) =>
      unit.status === "pending" || unit.status === "running"
        ? { ...unit, status: "done" as const }
        : unit,
    );
    const container = await renderChips(
      swarmActivity({ activeUnits: 0, completedUnits: 3, units: terminalUnits }),
      "swarm",
    );

    expect(container.querySelector('[data-composer-status-panel="swarm"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-swarm-unit]").length).toBe(SWARM_UNITS.length);
  });

  it("totalUnits=0 但 units 仍在时仍保留可展开 chip", async () => {
    const terminalUnits = SWARM_UNITS.map((unit) =>
      unit.status === "pending" || unit.status === "running"
        ? { ...unit, status: "done" as const }
        : unit,
    );
    const container = await renderChips(
      swarmActivity({
        activeUnits: 0,
        completedUnits: 0,
        failedUnits: 0,
        totalUnits: 0,
        units: terminalUnits,
      }),
      "swarm",
    );

    expect(container.querySelector('[data-composer-status-panel="swarm"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-swarm-unit]").length).toBe(SWARM_UNITS.length);
  });

  it("units 为空或缺席时不渲染面板，保持旧纯指示器", async () => {
    for (const units of [undefined, []] as const) {
      const container = await renderChips(swarmActivity({ units }), "swarm");
      // defaultOpenChip 指向 swarm 也不会产出空面板：没有明细时 chip 仍是 span。
      expect(container.querySelector('[data-composer-status-panel="swarm"]')).toBeNull();
      expect(container.querySelector("[data-swarm-unit]")).toBeNull();
      expect(container.querySelector('[data-swarm-active="2"]')).not.toBeNull();
      expect(container.querySelector("button[aria-expanded]")).toBeNull();
    }
  });
});
