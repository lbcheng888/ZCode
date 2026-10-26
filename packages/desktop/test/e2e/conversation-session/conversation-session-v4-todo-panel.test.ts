// Todo 面板竖切：TodoWrite tool_use → TodosUpdated/plan 投影 → composer 上方进度条。
// 覆盖：空态不渲染 → live 更新（受控流撑开 running 窗口）→ 应用重启后冷恢复 → 空清单清空隐藏。
import { clearAppData } from "../helpers/desktop-app.js";
import { releaseControlledReplay } from "../helpers/controlled-replay.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart.js";
import {
  getV4PaneSnapshot,
  getV4TodoPanelProjection,
  readV4TodoPanelDetailText,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
  waitForV4TodoPanelHidden,
  waitForV4TodoPanelRatio,
} from "../helpers/v4-conversation.js";

const SEED_PROMPT = "E2E_TODO_SEED 建立 todo 面板用例会话";
const WRITE_1_PROMPT = "E2E_TODO_WRITE_1 记录两条待办";
const WRITE_2_PROMPT = "E2E_TODO_WRITE_2 推进待办进度";
const CLEAR_PROMPT = "E2E_TODO_CLEAR 清空待办";

const PENDING_ITEM = "Inspect composer todo strip";
const ACTIVE_ITEM = "Verify live todo progress";
const NEXT_ITEM = "Recheck cold resume projection";

describe("v4 conversation todo 面板", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("空态不渲染 → TodoWrite 实时更新 → 重启冷恢复 → 清空隐藏", async function () {
    this.timeout(240_000);

    await prepareV4ConversationE2E();

    await sendV4Prompt(SEED_PROMPT);
    await waitForV4TimelineContaining("TODO_SEED_OK", 60_000);
    const seedPane = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "seed turn 没有建立 session 或没有结束",
      60_000,
    );
    const sessionId = seedPane.sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`seed turn 后没有绑定 session: ${JSON.stringify(seedPane)}`);
    }

    // 空态：session 已建立、composer 已挂载，但 plan 为 null，TodoPanel 返回 null。
    const emptyPanel = await getV4TodoPanelProjection();
    expect(emptyPanel.composerPresent).toBe(true);
    expect(emptyPanel.present).toBe(false);

    // 实时更新：tool 执行后续轮仍被受控流 gate 住，用 canStop 证明断言的是 live 投影。
    await sendV4Prompt(WRITE_1_PROMPT);
    const livePanel = await waitForV4TodoPanelRatio(
      "0/2",
      "TodoWrite 后 todo 面板没有显示 0/2 进度",
      45_000,
    );
    expect(livePanel.completed).toBe(0);
    expect(livePanel.total).toBe(2);
    // 展开面板给的是「未完成清单」：当前项与待处理项都会出现（这正是明细面存在的意义）。
    const liveDetail = await readV4TodoPanelDetailText();
    expect(liveDetail).toContain(ACTIVE_ITEM);
    expect(liveDetail).toContain(PENDING_ITEM);
    expect(livePanel.inComposerDock).toBe(true);
    expect(livePanel.beforeComposer).toBe(true);
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "todo 面板出现时 turn 已经结束，无法证明实时更新",
      30_000,
    );

    await releaseControlledReplay("v4-todo-panel-write-1-follow");
    await waitForV4TimelineContaining("TODO_WRITE_1_OK", 60_000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "第一个 TodoWrite turn 没有结束", 60_000);
    const settledPanel = await waitForV4TodoPanelRatio(
      "0/2",
      "收尾后 todo 进度不再是 0/2",
      30_000,
    );
    expect(settledPanel.present).toBe(true);

    // 进度推进：2/3，且已完成项按 TodoPanel 的过滤规则不再出现在文案里。
    await sendV4Prompt(WRITE_2_PROMPT);
    const updatedPanel = await waitForV4TodoPanelRatio(
      "2/3",
      "更新 TodoWrite 后面板没有显示 2/3 进度",
      60_000,
    );
    expect(updatedPanel.completed).toBe(2);
    expect(updatedPanel.total).toBe(3);
    const updatedDetail = await readV4TodoPanelDetailText();
    expect(updatedDetail).toContain(NEXT_ITEM);
    // 第二次写入把前两项都标成 completed：未完成清单里只剩新项。
    expect(updatedDetail).not.toContain(ACTIVE_ITEM);
    expect(updatedDetail).not.toContain(PENDING_ITEM);
    await waitForV4TimelineContaining("TODO_WRITE_2_OK", 60_000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "第二个 TodoWrite turn 没有结束", 60_000);
    expect((await getV4PaneSnapshot()).sessionId).toBe(sessionId);

    // 重开恢复：真实重启 Electron（复用 profile）后重开同一 session，plan 由 todo 表冷恢复重建。
    await restartIntoWorkspacePreservingProfile();
    await selectV4TaskById(sessionId, 30_000);
    await waitForV4TimelineContaining("TODO_WRITE_2_OK", 90_000);
    const resumedPanel = await waitForV4TodoPanelRatio(
      "2/3",
      "重启冷恢复后 todo 面板没有恢复 2/3 进度",
      60_000,
    );
    expect(await readV4TodoPanelDetailText()).toContain(NEXT_ITEM);
    expect(resumedPanel.inComposerDock).toBe(true);
    expect(resumedPanel.beforeComposer).toBe(true);

    // 清空：空清单 TodosUpdated 把 plan 置空，面板卸载但 composer 仍在。
    await sendV4Prompt(CLEAR_PROMPT);
    await waitForV4TimelineContaining("TODO_CLEAR_OK", 60_000);
    await waitForV4TodoPanelHidden("清空待办后 todo 面板仍然挂载", 30_000);
    const clearedPanel = await getV4TodoPanelProjection();
    expect(clearedPanel.composerPresent).toBe(true);
    expect(clearedPanel.present).toBe(false);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "清空待办 turn 没有结束", 60_000);
  });
});
