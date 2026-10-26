import { clearAppData } from "../helpers/desktop-app.js";
import { waitForUpstreamRequest } from "../helpers/conversation-session-network.js";
import { releaseControlledReplay } from "../helpers/controlled-replay.js";
import {
  getUpstreamThoughtLevelLabels,
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_THOUGHT_LEVEL,
} from "../helpers/upstream-provider.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const CASE_TIMEOUT_MS = 240_000;
const PARENT_MARKER = "E2E_COMPOSER_AGENT_CHIP_MODEL_PARENT";
const PARENT_DONE = "E2E_COMPOSER_AGENT_CHIP_MODEL_PARENT_DONE";
const CHILD_MARKER = "E2E_COMPOSER_AGENT_CHIP_MODEL_CHILD";
const CHILD_DONE = "E2E_COMPOSER_AGENT_CHIP_MODEL_CHILD_DONE";
const TOOL_CALL_ID = "toolu_e2e_composer_agent_chip_model";
const CHILD_FIXTURE_ID = "composer-agent-chip-model-child-held";
const AGENT_DESCRIPTION = "Composer chip model probe";
// chip 没有 testid（只有 todo chip 有），定位只能依赖受支持语言的可见文案。
const AGENT_CHIP_LABELS = ["Background agents", "后台 Agent"];
const AGENT_CHIP_PANEL_SELECTOR = '[data-composer-status-panel="agents"]';

interface RunningAgentChipSnapshot {
  chipPresent: boolean;
  chipExpanded: boolean;
  chipText: string;
  chipCount: number | null;
  panelPresent: boolean;
  panelText: string;
  agents: {
    title: string;
    modelText: string;
    modelTitle: string | null;
    subagentType: string;
  }[];
}

describe("composer 后台 Agent chip 的模型与 effort 投影", () => {
  before(async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("background Agent 运行期 chip 展示 spawn 时的 model 与 effort，终态后隐藏", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await sendV4Prompt(
      `${PARENT_MARKER}: launch one background Agent and, after its task notification, reply with ${PARENT_DONE}.`,
    );
    await waitForV4TimelineContaining(PARENT_MARKER, 60_000);
    // child 请求的受控流已挂住：它既证明真实 background Agent 已启动，也把 chip 的
    // running 窗口固定到断言完成之后，避免 delayMs 时长不足造成的 flake。
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [CHILD_MARKER] },
      "background Agent 子代理请求没有到达 replay server",
      60_000,
    );

    // 只等「chip 已就绪且该行已带模型事实」，具体取值失败要立即报错而不是空转超时；
    // 同时容忍 subagents 投影与 backgroundWorks 交接的短窗口（后者没有 model 字段）。
    const runningChip = await waitForRunningAgentChip(
      (snapshot) => {
        const [agent] = snapshot.agents;
        return (
          snapshot.chipPresent &&
          snapshot.panelPresent &&
          snapshot.chipCount === 1 &&
          snapshot.agents.length === 1 &&
          Boolean(agent?.modelTitle)
        );
      },
      "background Agent 运行期间 composer 没有出现带模型事实的 Background agents chip",
      90_000,
    );
    expect(
      AGENT_CHIP_LABELS.some((label) => runningChip.chipText.startsWith(label)),
    ).toBe(true);
    expect(runningChip.agents).toHaveLength(1);
    expect(runningChip.panelText).toContain(AGENT_DESCRIPTION);

    const [agent] = runningChip.agents;
    if (!agent) {
      throw new Error(
        `agents chip 面板没有 Agent 行: ${JSON.stringify(runningChip)}`,
      );
    }
    expect(agent.subagentType).toBe("general-purpose");
    // 规范串原样来自 spawn 时实际生效的选择（子代理继承父会话的 provider/model/$level），
    // 只挂在模型词 span 的 title 上，因此不受 locale 影响。
    expect(agent.modelTitle).toBe(buildExpectedAgentModelCanonical());
    if (agent.modelText.length === 0) {
      throw new Error(
        `agents chip 没有渲染可见模型词: ${JSON.stringify(runningChip)}`,
      );
    }
    expect(buildAcceptedAgentModelTexts()).toContain(agent.modelText);
    expect(runningChip.panelText).toContain(agent.modelText);

    await releaseControlledReplay(CHILD_FIXTURE_ID);
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [
          "<task-notification>",
          "<status>completed</status>",
        ],
        includes: [`<tool-use-id>${TOOL_CALL_ID}</tool-use-id>`, CHILD_DONE],
      },
      "completed background Agent notification 没有回到父会话",
      90_000,
    );
    await waitForV4TimelineContaining(PARENT_DONE, 90_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "background Agent 完成后父会话没有回到 idle",
      60_000,
    );
    // chip 的数字是「运行中」数量：子代理进入终态后整颗 chip 必须消失，
    // 证明前面读到的是 running 投影而不是历史行。
    const settledChip = await waitForRunningAgentChip(
      (snapshot) => !snapshot.chipPresent && !snapshot.panelPresent,
      "background Agent 完成后 composer 的 Background agents chip 没有隐藏",
      60_000,
    );
    expect(settledChip.chipCount).toBeNull();
    expect(settledChip.agents).toEqual([]);
  });
});

function buildExpectedAgentModelCanonical(): string {
  const base = `${UPSTREAM_PROVIDER_ID}/${UPSTREAM_MODEL}`;
  return UPSTREAM_THOUGHT_LEVEL ? `${base}$${UPSTREAM_THOUGHT_LEVEL}` : base;
}

function buildAcceptedAgentModelTexts(): string[] {
  if (!UPSTREAM_THOUGHT_LEVEL) {
    return [UPSTREAM_MODEL];
  }
  // 运行卡按会话 locale 渲染档位词；不支持的语言表外的自定义档位原样显示。
  const levels = new Set([
    ...getUpstreamThoughtLevelLabels(UPSTREAM_THOUGHT_LEVEL),
    UPSTREAM_THOUGHT_LEVEL,
  ]);
  return [...levels].map((level) => `${UPSTREAM_MODEL} · ${level}`);
}

function readRunningAgentChip(): Promise<RunningAgentChipSnapshot> {
  return browser.execute(
    (chipLabels: string[], panelSelector: string) => {
      const normalize = (value: string) =>
        value
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const chip =
        Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) =>
            chipLabels.some((label) =>
              normalize(button.innerText).startsWith(label),
            ),
        ) ?? null;
      const panel = document.querySelector<HTMLElement>(panelSelector);
      const agents = Array.from(
        panel?.querySelectorAll<HTMLLIElement>("li") ?? [],
      ).map((row) => {
        const spans = Array.from(row.querySelectorAll<HTMLElement>("span"));
        const modelSpan =
          spans.find((span) => span.title.trim().length > 0) ?? null;
        const textSpans = spans.filter(
          (span) => span.innerText.trim().length > 0,
        );
        return {
          title: normalize(textSpans[0]?.innerText ?? ""),
          modelText: normalize(modelSpan?.innerText ?? ""),
          modelTitle: modelSpan?.title.trim() ?? null,
          subagentType: normalize(textSpans.at(-1)?.innerText ?? ""),
        };
      });
      const chipText = normalize(chip?.innerText ?? "");
      const countMatch = chipText.match(/(\d+)\s*$/);
      return {
        chipPresent: chip !== null,
        chipExpanded: chip?.getAttribute("aria-expanded") === "true",
        chipText,
        chipCount: countMatch ? Number(countMatch[1]) : null,
        panelPresent: panel !== null,
        panelText: normalize(panel?.innerText ?? ""),
        agents,
      };
    },
    AGENT_CHIP_LABELS,
    AGENT_CHIP_PANEL_SELECTOR,
  );
}

async function openRunningAgentChip(): Promise<void> {
  await browser.execute((chipLabels: string[]) => {
    const normalize = (value: string) =>
      value
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const chip =
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) =>
          chipLabels.some((label) =>
            normalize(button.innerText).startsWith(label),
          ),
      ) ?? null;
    if (chip && chip.getAttribute("aria-expanded") !== "true") {
      chip.click();
    }
  }, AGENT_CHIP_LABELS);
}

async function waitForRunningAgentChip(
  predicate: (snapshot: RunningAgentChipSnapshot) => boolean,
  timeoutMsg: string,
  timeout: number,
): Promise<RunningAgentChipSnapshot> {
  let latest = await readRunningAgentChip();
  try {
    await browser.waitUntil(
      async () => {
        if (!predicate(latest)) {
          await openRunningAgentChip();
          latest = await readRunningAgentChip();
        }
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  return latest;
}
