import { useMemo, useState } from "react";
import { Bot, FileText, ListTodo, LoaderIcon, Target, TerminalSquare } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  describeWorkflowSubagentModel,
  type WorkflowSubagentModelLabel,
} from "@/components/workflow-timeline/subagent-model-label.js";
import { TID_V4_TODO_PANEL } from "@zcode/shared/test-ids";
import type { GoalState, PlanItem } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationStatusPanelModel } from "../conversationStatusPanelModel.js";
import { getStatusPanelTodoFocusWindow } from "../statusPanelTodoWindow.js";

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
 * 目标 / 计划 / 后台 Bash / 后台 Agent / 当前进度。每颗 chip 只带一行摘要，
 * 点开在**同一位置**就地展开明细（限高滚动），不跳侧栏、不新增第二个明细面。
 *
 * 计数语义与 kimi 一致：后台类 chip 的数字是「运行中」数量，为 0 时整颗隐藏。
 */
export function ComposerStatusChips({
  model,
  isStreaming = false,
  defaultOpenChip = null,
  className,
}: {
  model: ConversationStatusPanelModel;
  /** 会话运行期在进度 chip 上给一个转圈，替代旧待办条的渐变动画。 */
  isStreaming?: boolean;
  /** 仅测试与快照:初始展开某颗 chip，生产调用方不传（默认全收起）。 */
  defaultOpenChip?: ChipId | null;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const [openChip, setOpenChip] = useState<ChipId | null>(defaultOpenChip);
  const progress = useMemo(() => buildProgress(model.plan), [model.plan]);
  const chips = buildChips({ model, progress, isStreaming, intl });
  if (chips.length === 0) {
    return null;
  }
  const active = chips.find((chip) => chip.id === openChip) ?? null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* 展开面板与 chip 行同列、在行上方：用户视线不需要移动，composer 也不被顶走。 */}
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
          const expanded = openChip === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              data-testid={chip.testId}
              aria-expanded={expanded}
              onClick={() => setOpenChip(expanded ? null : chip.id)}
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
  panel: React.ReactNode;
  testId?: string;
}

function buildChips({
  model,
  progress,
  isStreaming,
  intl,
}: {
  model: ConversationStatusPanelModel;
  progress: ProgressSummary | null;
  isStreaming: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
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
      panel: (
        <div className="flex flex-col gap-1">
          <span className="text-ui-base text-foreground">{goal.objective}</span>
          <span className="text-ui-sm text-foreground-subtlest">
            {intl.formatMessage(
              { id: "chat.composerChips.goalElapsed" },
              { elapsed: formatElapsed(goal.timeUsedSeconds), iteration: goal.iteration },
            )}
          </span>
        </div>
      ),
    });
  }

  if (model.sessionPlans && model.sessionPlans.items.length > 0) {
    chips.push({
      id: "plans",
      label: intl.formatMessage({ id: "chat.statusPanel.sessionPlans" }),
      icon: <FileText className="size-4 shrink-0" />,
      trailing: <ChipCount count={model.sessionPlans.items.length} />,
      panel: (
        <ul className="flex flex-col gap-1.5">
          {model.sessionPlans.items.map((item) => (
            <li key={item.rowId} className="truncate text-ui-base text-foreground-subtle">
              {item.title ?? item.markdown.slice(0, 120)}
            </li>
          ))}
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
