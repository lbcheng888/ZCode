import { useMemo, useState } from "react";
import {
  Bot,
  FileText,
  ListTodo,
  LoaderIcon,
  Pause,
  Play,
  Target,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  describeWorkflowSubagentModel,
  type WorkflowSubagentModelLabel,
} from "@/components/workflow-timeline/subagent-model-label.js";
import { TID_V4_TODO_PANEL } from "@zcode/shared/test-ids";
import type { GoalState, PlanItem } from "@zcode/shared/zcode-protocol-v4";
import { buildSessionPlanOpenRequest } from "../ConversationStatusPanel.js";
import type { ConversationStatusPanelModel } from "../conversationStatusPanelModel.js";
import { getConversationGoalElapsedSeconds } from "../conversationGoalSummaryModel.js";
import type { OpenPlanDetailSideTabRequest } from "@/lib/workspaceSidePane.js";
import { getStatusPanelTodoFocusWindow } from "../statusPanelTodoWindow.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";

type ChipId = "goal" | "plans" | "bash" | "agents" | "progress";

const GOAL_STATUS_MESSAGE_IDS: Record<GoalState["status"], string> = {
  active: "chat.composerChips.goalStatus.active",
  paused: "chat.composerChips.goalStatus.paused",
  verifying: "chat.composerChips.goalStatus.verifying",
  verified: "chat.composerChips.goalStatus.verified",
  notSatisfied: "chat.composerChips.goalStatus.notSatisfied",
  failed: "chat.composerChips.goalStatus.failed",
};

/** 秒 → 人类可读的短时长（沿用状态面板既有口径：不足 1 分钟只给秒）。 */
function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/**
 * composer 上方的状态 chip 行（对齐 Kimi Code 桌面版的信息层级）：
 * 目标 / 计划 / 后台 Bash / 后台 Agent / 当前进度。目标由 chip 行上方的完整卡片承载
 * （标题 + 状态 + 暂停/继续/取消 + objective + 预算行），关闭后回落到 goal chip；
 * 其余每颗 chip 只带一行摘要，点开在**同一位置**就地展开明细（限高滚动）。计划面板里的
 * 每条计划行是「跳到计划详情侧 tab」的入口（与状态面板同一个 buildSessionPlanOpenRequest），
 * 由宿主注入 onOpenPlanDetail 后才可点；其余 chip 不新增第二个明细面。
 *
 * 计数语义与 kimi 一致：后台类 chip 的数字是「运行中」数量，为 0 时整颗隐藏。
 */
export function ComposerStatusChips({
  model,
  isStreaming = false,
  defaultOpenChip = null,
  onCancelGoal,
  onPauseGoal,
  onResumeGoal,
  parentSessionId,
  onOpenPlanDetail,
  className,
}: {
  model: ConversationStatusPanelModel;
  /** 会话运行期在进度 chip 上给一个转圈，替代旧待办条的渐变动画。 */
  isStreaming?: boolean;
  /** 仅测试与快照:初始展开某颗 chip；目标卡片默认展开，不走该开关。 */
  defaultOpenChip?: ChipId | null;
  /** 取消目标：只打开确认弹层，命令由 SessionPane 在确认后 dispatch。 */
  onCancelGoal?: () => void;
  /** 暂停目标；缺省表示宿主/旧 CLI 不支持，卡片不渲染该动作。 */
  onPauseGoal?: () => void;
  /** 继续目标；缺省表示宿主/旧 CLI 不支持，卡片不渲染该动作。 */
  onResumeGoal?: () => void;
  /** 计划详情 tab 的 parent session；缺省时计划行保持纯文本。 */
  parentSessionId?: string;
  /** 打开计划详情侧 tab；缺省时计划行保持纯文本（不跳转、不可点）。 */
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const [openChip, setOpenChip] = useState<ChipId | null>(defaultOpenChip);
  // 收起目标卡片只记「被收起的是哪个 target」：换目标（含 cleared 后重建）自然重新展开，
  // 组件实例跨会话复用也不会把「已关闭」带到另一个会话。
  const [dismissedGoalTargetId, setDismissedGoalTargetId] = useState<string | null>(null);
  const progress = useMemo(() => buildProgress(model.plan), [model.plan]);
  const goal = model.goal;
  const goalCardOpen = goal !== null && goal.targetId !== dismissedGoalTargetId;
  const now = useNowTicker(
    goalCardOpen &&
      goal !== null &&
      goal.activeRunStartedAtMs !== null &&
      (goal.status === "active" || goal.status === "verifying" || goal.status === "notSatisfied"),
  );
  const chips = buildChips({
    model,
    progress,
    isStreaming,
    intl,
    parentSessionId,
    onOpenPlanDetail,
  });
  if (chips.length === 0) {
    return null;
  }
  const active = chips.find((chip) => chip.id === openChip && chip.panel) ?? null;
  const closeGoalCard = () => {
    if (!goal) return;
    setOpenChip(null);
    setDismissedGoalTargetId(goal.targetId);
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* 展开面板与 chip 行同列、在行上方：用户视线不需要移动，composer 也不被顶走。 */}
      {goal && goalCardOpen ? (
        <GoalCard
          goal={goal}
          elapsedSeconds={getConversationGoalElapsedSeconds(goal, now)}
          intl={intl}
          onPauseGoal={onPauseGoal}
          onResumeGoal={onResumeGoal}
          onCancelGoal={onCancelGoal}
          onClose={closeGoalCard}
        />
      ) : null}
      {active ? (
        <div
          data-composer-status-panel={active.id}
          className="max-h-64 overflow-y-auto rounded-xl border border-card-border bg-card px-3 py-2"
        >
          {active.panel}
        </div>
      ) : null}
      <div className="flex gap-2 overflow-x-auto whitespace-nowrap pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {chips.map((chip) => {
          // 目标 chip 不开第二个明细面：点它只在「展开卡片 ⇄ 收起卡片」间切换。
          const expanded = chip.id === "goal" ? goalCardOpen : openChip === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              data-testid={chip.testId}
              aria-expanded={expanded}
              onClick={() => {
                if (chip.id === "goal" && goal) {
                  if (goalCardOpen) {
                    closeGoalCard();
                  } else {
                    setOpenChip(null);
                    setDismissedGoalTargetId(null);
                  }
                  return;
                }
                setOpenChip(expanded ? null : chip.id);
              }}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-1.5 text-ui-base text-foreground-subtle transition-colors hover:bg-hover/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                expanded && "bg-hover/30 text-foreground",
              )}
            >
              {chip.icon}
              <span className="font-medium">{chip.label}</span>
              {chip.trailing}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const GOAL_PAUSABLE_STATUSES: ReadonlySet<GoalState["status"]> = new Set([
  "active",
  "verifying",
  "notSatisfied",
]);

/**
 * 完整目标卡片：标题 + 状态 + 三个动作 + objective + 预算行。动作与侧栏同源——
 * 暂停/继续只交意图（命令由 SessionPane dispatch），取消复用既有确认弹层，
 * 关闭是纯视图动作（只收起卡片，不发命令、不读 availability）。
 */
function GoalCard({
  goal,
  elapsedSeconds,
  intl,
  onPauseGoal,
  onResumeGoal,
  onCancelGoal,
  onClose,
}: {
  goal: GoalState;
  elapsedSeconds: number;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  onCancelGoal?: () => void;
  onClose: () => void;
}) {
  const canPause = onPauseGoal !== undefined && GOAL_PAUSABLE_STATUSES.has(goal.status);
  const canResume = onResumeGoal !== undefined && goal.status === "paused";
  const budgetLines = buildGoalBudgetLines(goal, elapsedSeconds, intl);
  return (
    <div
      data-composer-status-panel="goal"
      className="max-h-64 overflow-y-auto rounded-xl border border-card-border bg-card px-3 py-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Target className="size-4 shrink-0 text-foreground-subtle" />
          <span className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "chat.statusPanel.goal" })}
          </span>
          <span className={cn("text-ui-sm font-medium", goalStatusClass(goal.status))}>
            {intl.formatMessage({ id: GOAL_STATUS_MESSAGE_IDS[goal.status] })}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canPause ? (
            <GoalActionButton
              action="pause"
              label={intl.formatMessage({ id: "chat.target.pause" })}
              icon={<Pause className="size-3.5 shrink-0" />}
              onClick={onPauseGoal}
            />
          ) : null}
          {canResume ? (
            <GoalActionButton
              action="resume"
              label={intl.formatMessage({ id: "chat.target.resume" })}
              icon={<Play className="size-3.5 shrink-0" />}
              onClick={onResumeGoal}
            />
          ) : null}
          {onCancelGoal ? (
            <GoalActionButton
              action="clear"
              label={intl.formatMessage({ id: "chat.target.cancel" })}
              icon={<Trash2 className="size-3.5 shrink-0" />}
              onClick={onCancelGoal}
              danger
            />
          ) : null}
          <GoalActionButton
            action="close"
            label={intl.formatMessage({ id: "chat.target.closePanel" })}
            icon={<X className="size-3.5 shrink-0" />}
            onClick={onClose}
          />
        </div>
      </div>
      <p className="mt-1.5 break-words text-ui-base text-foreground">{goal.objective}</p>
      <p className="mt-0.5 text-ui-sm text-foreground-subtlest">
        {intl.formatMessage(
          { id: "chat.composerChips.goalElapsed" },
          { elapsed: formatElapsed(elapsedSeconds), iteration: goal.iteration },
        )}
      </p>
      {budgetLines.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
          {budgetLines.map((line) => (
            <span key={line.key} data-goal-budget={line.key}>
              {line.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GoalActionButton({
  action,
  label,
  icon,
  onClick,
  danger = false,
}: {
  action: "pause" | "resume" | "clear" | "close";
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      data-goal-action={action}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-1 hover:bg-hover/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
        danger ? "text-[var(--color-danger)]" : "text-foreground-subtle",
      )}
    >
      {icon}
    </button>
  );
}

const COMPACT_COUNT_FORMAT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * 预算行从快照的可选预算字段派生：旧快照/旧 CLI 没有这些键时整行不渲染，
 * 而不是显示「已用 0」或「不限」。tokensUsed 与 tokenBudget 同源（SessionGoal），
 * 因此以用量字段是否出现作为该段的存在判定。
 */
function buildGoalBudgetLines(
  goal: GoalState,
  elapsedSeconds: number,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): { key: string; text: string }[] {
  const lines: { key: string; text: string }[] = [];
  if (goal.tokensUsed !== undefined) {
    lines.push({
      key: "tokens",
      text:
        goal.tokenBudget !== undefined && goal.tokenBudget !== null
          ? intl.formatMessage(
              { id: "chat.composerChips.goalBudgetTokens" },
              {
                used: COMPACT_COUNT_FORMAT.format(goal.tokensUsed),
                budget: COMPACT_COUNT_FORMAT.format(goal.tokenBudget),
              },
            )
          : intl.formatMessage(
              { id: "chat.composerChips.goalBudgetTokensUsed" },
              { used: COMPACT_COUNT_FORMAT.format(goal.tokensUsed) },
            ),
    });
  }
  if (goal.turnBudget !== undefined && goal.turnBudget !== null && goal.turnsUsed !== undefined) {
    lines.push({
      key: "turns",
      text: intl.formatMessage(
        { id: "chat.composerChips.goalBudgetTurns" },
        { used: goal.turnsUsed, budget: goal.turnBudget },
      ),
    });
  }
  if (goal.wallClockBudgetSeconds !== undefined && goal.wallClockBudgetSeconds !== null) {
    lines.push({
      key: "wallClock",
      text: intl.formatMessage(
        { id: "chat.composerChips.goalBudgetWallClock" },
        {
          elapsed: formatElapsed(elapsedSeconds),
          budget: formatElapsed(goal.wallClockBudgetSeconds),
        },
      ),
    });
  }
  return lines;
}

/**
 * 运行中 Agent 行的模型词。规范串缺席（旧会话/旧 CLI）返回 undefined，调用方不渲染
 * 这一段；档位只从规范串的 `$level` 来，不动 row 的其它字段。
 */
function describeRunningAgentModel(
  canonical: string | undefined,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): WorkflowSubagentModelLabel | undefined {
  if (!canonical) return undefined;
  return describeWorkflowSubagentModel(canonical, {
    formatMessage: (descriptor, values) => intl.formatMessage(descriptor, values),
  });
}

interface Chip {
  id: ChipId;
  label: string;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
  /** 目标 chip 不开内联面板：明细由上方目标卡片承载，避免同一目标两个明细面。 */
  panel?: React.ReactNode;
  testId?: string;
}

function buildChips({
  model,
  progress,
  isStreaming,
  intl,
  parentSessionId,
  onOpenPlanDetail,
}: {
  model: ConversationStatusPanelModel;
  progress: ProgressSummary | null;
  isStreaming: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  parentSessionId?: string;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
}): Chip[] {
  const chips: Chip[] = [];

  if (model.goal) {
    const goal = model.goal;
    chips.push({
      id: "goal",
      label: intl.formatMessage({ id: "chat.statusPanel.goal" }),
      icon: <Target className="size-4 shrink-0" />,
      trailing: (
        <span className={cn("font-medium", goalStatusClass(goal.status))}>
          {intl.formatMessage({ id: GOAL_STATUS_MESSAGE_IDS[goal.status] })}
        </span>
      ),
    });
  }

  if (model.sessionPlans && model.sessionPlans.items.length > 0) {
    const canOpenPlanDetail = Boolean(parentSessionId && onOpenPlanDetail);
    chips.push({
      id: "plans",
      label: intl.formatMessage({ id: "chat.statusPanel.sessionPlans" }),
      icon: <FileText className="size-4 shrink-0" />,
      trailing: <ChipCount count={model.sessionPlans.items.length} />,
      panel: (
        <ul className="flex flex-col gap-1.5">
          {model.sessionPlans.items.map((item) => {
            const title = item.title ?? item.markdown.slice(0, 120);
            return (
              <li key={item.rowId} className="min-w-0 truncate text-ui-base text-foreground-subtle">
                {canOpenPlanDetail ? (
                  <button
                    type="button"
                    data-plan-directory-tool-call-id={item.toolCallId}
                    aria-label={intl.formatMessage({ id: "chat.statusPanel.openPlan" }, { title })}
                    onClick={() => {
                      if (!parentSessionId) return;
                      onOpenPlanDetail?.(buildSessionPlanOpenRequest(parentSessionId, item));
                    }}
                    className="flex w-full min-w-0 items-center rounded-md px-1 py-0.5 text-left hover:bg-hover/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                  >
                    <span className="truncate">{title}</span>
                  </button>
                ) : (
                  title
                )}
              </li>
            );
          })}
        </ul>
      ),
    });
  }

  if (model.runningBashWorks.length > 0) {
    chips.push({
      id: "bash",
      label: intl.formatMessage({ id: "chat.composerChips.bash" }),
      icon: <TerminalSquare className="size-4 shrink-0" />,
      trailing: <ChipCount count={model.runningBashWorks.length} active />,
      panel: (
        <ul className="flex flex-col gap-1.5">
          {model.runningBashWorks.map((work) => (
            <li key={work.workId} className="flex items-center gap-2">
              <RunningDot />
              <span className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
                {work.title}
              </span>
            </li>
          ))}
        </ul>
      ),
    });
  }

  if (model.runningSubagentWorks.length > 0) {
    chips.push({
      id: "agents",
      label: intl.formatMessage({ id: "chat.composerChips.agents" }),
      icon: <Bot className="size-4 shrink-0" />,
      trailing: <ChipCount count={model.runningSubagentWorks.length} active />,
      panel: (
        <ul className="flex flex-col gap-1.5">
          {model.runningSubagentWorks.map((agent) => {
            const agentModel = describeRunningAgentModel(agent.model, intl);
            return (
              <li key={agent.childSessionId} className="flex items-center gap-2">
                <RunningDot />
                <span className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
                  {agent.title}
                </span>
                {agentModel ? (
                  // 旧会话/旧 CLI 没有 model 字段，此时保持 title · subagentType 两段。
                  <span
                    className="shrink-0 text-ui-sm text-foreground-subtlest"
                    title={agent.model}
                  >
                    {agentModel.level === undefined
                      ? agentModel.name
                      : `${agentModel.name} · ${agentModel.level}`}
                  </span>
                ) : null}
                <span className="shrink-0 text-ui-sm text-foreground-subtlest">
                  {agent.subagentType}
                </span>
              </li>
            );
          })}
        </ul>
      ),
    });
  }

  if (progress) {
    chips.push({
      id: "progress",
      // 进度 chip 承载原 composer 待办条的 testid：E2E 用它定位「待办进度」。
      testId: TID_V4_TODO_PANEL,
      label: intl.formatMessage({ id: "chat.composerChips.progress" }),
      icon: <ListTodo className="size-4 shrink-0" />,
      trailing: (
        <span className="inline-flex items-center gap-1.5 font-mono text-foreground-subtle">
          {isStreaming ? <LoaderIcon className="size-3.5 shrink-0 animate-spin" /> : null}
          {`${progress.completed}/${progress.total}`}
        </span>
      ),
      panel: <ProgressPanel items={progress.items} />,
    });
  }

  return chips;
}

interface ProgressSummary {
  items: readonly PlanItem[];
  completed: number;
  total: number;
}

function buildProgress(plan: ConversationStatusPanelModel["plan"]): ProgressSummary | null {
  if (!plan || plan.items.length === 0) return null;
  // 与旧待办条同一收敛：全部完成时整块隐藏，避免 provider 先全完成、后推 task_complete 的间隙误导。
  if (plan.completedCount === plan.items.length) return null;
  return { items: plan.items, completed: plan.completedCount, total: plan.items.length };
}

function ProgressPanel({ items }: { items: readonly PlanItem[] }) {
  const pending = items.filter((item) => item.status !== "completed");
  // 长清单沿用状态面板既有的聚焦窗口:当前项附近三条 + 前后折叠计数,
  // 保证展开面板不会把 composer 顶出视口,也不改变 snapshot 的原序。
  const window = getStatusPanelTodoFocusWindow(pending as PlanItem[]);
  const rows = (list: readonly PlanItem[]) => list.map((item) => (
    <li key={item.id} className="flex items-start gap-2">
      <RunningDot active={item.status === "inProgress"} />
      <span
        className={cn(
          "min-w-0 flex-1 text-ui-base",
          item.status === "inProgress" ? "text-foreground" : "text-foreground-subtle",
        )}
      >
        {item.content}
      </span>
    </li>
  ));
  return (
    <ul className="flex flex-col gap-1.5">
      {window.compact && window.precedingItems.length > 0 ? (
        <li className="font-mono text-ui-sm text-foreground-subtlest">
          {`+${window.precedingItems.length}`}
        </li>
      ) : null}
      {rows(window.focusItems)}
      {window.compact && window.followingItems.length > 0 ? (
        <li className="font-mono text-ui-sm text-foreground-subtlest">
          {`+${window.followingItems.length}`}
        </li>
      ) : null}
    </ul>
  );
}

function ChipCount({ count, active = false }: { count: number; active?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-foreground-subtle">
      {active ? <span className="size-1.5 rounded-full bg-[var(--color-success)]" /> : null}
      {count}
    </span>
  );
}

function RunningDot({ active = true }: { active?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1.5 size-1.5 shrink-0 rounded-full",
        active ? "bg-[var(--color-success)]" : "bg-foreground-subtlest",
      )}
    />
  );
}

function goalStatusClass(status: GoalState["status"]): string {
  if (status === "active" || status === "verifying") return "text-[var(--color-success)]";
  if (status === "verified") return "text-[var(--color-success)]";
  if (status === "failed") return "text-[var(--color-danger)]";
  return "text-foreground-subtle";
}
