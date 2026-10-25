import { useState } from "react";
import type { PlanItem, PlanState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
} from "@/components/ai-elements/plan.js";
import {
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  type QueueItemStatus,
} from "@/components/ai-elements/queue.js";
import { ChevronsUpDownIcon, ListTodo, LoaderIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TID_V4_TODO_PANEL } from "@zcode/shared/test-ids";
import { cn } from "./components/lib/utils.js";

const todoStatusIndicatorClasses: Record<PlanItem["status"], string> = {
  pending: "text-foreground-subtlest",
  inProgress: "text-foreground",
  completed: "text-success",
};

const todoStatusContentClassesStreaming: Record<PlanItem["status"], string> = {
  pending: "text-foreground-subtle",
  inProgress: "animated-gradient-text",
  completed: "text-foreground-subtlest line-through",
};

// Bugfix: 任务停止/结束后 plan 可能还留着 inProgress 项，如果继续套 animated-gradient-text，
// 面板就会一直显示 loading 态。非运行期降级为普通文本，仅保留状态色。
const todoStatusContentClassesIdle: Record<PlanItem["status"], string> = {
  pending: "text-foreground-subtle",
  inProgress: "text-foreground",
  completed: "text-foreground-subtlest line-through",
};

// PlanState 的 inProgress 与 Queue 原语的 in_progress 是同一状态的两种拼写；
// 指示器沿用既有 QueueItemIndicator 合同，只在这一处换算。
const todoStatusIndicatorStatus: Record<PlanItem["status"], QueueItemStatus> = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed",
};

export function TodoPanel({
  plan,
  isStreaming,
  className,
}: {
  plan: PlanState | null;
  isStreaming: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const [isOpen, setIsOpen] = useState(false);

  // 数据源换成 v4 投影快照（docs/v4-refactor/11-deletion-plan.md：保留外观、数据源换 projection），
  // 面板不再接受第二份 todo 类型，composer 上方进度条与状态面板消费同一份 snapshot.plan。
  const items = plan?.items ?? [];
  if (items.length === 0) {
    return null;
  }

  const completedCount = items.filter((item) => item.status === "completed").length;
  const isAllCompleted = completedCount === items.length;
  // Bugfix: provider 可能先把 todo 全部标成 completed，再稍后才推 task_complete 清空 store。
  // 这段间隙继续展示“已完成 todo”会让用户误以为还有待处理事项，所以全完成后直接隐藏面板。
  if (isAllCompleted) {
    return null;
  }

  // Bugfix: 展开态之前会把 completed 项继续画出来，只是加删除线；完成项越多面板越长。
  // 这里仅保留未完成项，让 todo 面板专注显示还需要关注的后续工作。
  const visibleItems = items.filter((item) => item.status !== "completed");
  const activeItem =
    items.find((item) => item.status === "inProgress") ??
    items.find((item) => item.status !== "completed") ??
    items[items.length - 1];
  // Bugfix: loading 视觉只在任务真正运行期出现。task 已完成/失败/被停止时，
  // 即便 plan 仍残留 in_progress 项，也不再转菊花或做渐变动画。
  const showLoadingState = isStreaming && !isAllCompleted;
  const todoStatusContentClasses = isStreaming
    ? todoStatusContentClassesStreaming
    : todoStatusContentClassesIdle;
  const toggleLabel = intl.formatMessage({ id: "todo.panel.toggle" });
  const toggleOpen = () => setIsOpen((current) => !current);

  return (
    <Plan
      // 挂载点从 v3 富文本面板换成 v4 composer 上方状态条：外壳（卡片边框/圆角/表面色）
      // 由面板自己持有，宿主不再套第二层容器，空清单或全完成时整条随同消失。
      data-testid={TID_V4_TODO_PANEL}
      className={cn(
        "gap-0 overflow-hidden rounded-xl border border-card-border bg-card py-0",
        className,
      )}
      open={isOpen}
      onOpenChange={setIsOpen}
      isStreaming={isStreaming}
    >
      {/* 修复原因：PlanHeader 负责撑满布局，不能再承担点击展开，否则空白区域也会误触。
          展开逻辑收敛到内容宽度按钮和右侧图标按钮，保留键盘与读屏状态。 */}
      <PlanHeader className={cn("group flex items-center gap-3 px-4 !py-3", isOpen && "!pb-1")}>
        <div className="flex min-w-0 flex-1 items-center">
          <button
            type="button"
            aria-expanded={isOpen}
            className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-3 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            onClick={toggleOpen}
          >
            {isOpen ? (
              <>
                <ListTodo className="size-4 shrink-0 text-foreground" />
                <PlanTitle className="min-w-0 truncate text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "todo.panel.title" })}
                </PlanTitle>
                <PlanDescription className="shrink-0 text-ui-base font-mono text-foreground-subtlest">
                  {`${completedCount}/${items.length}`}
                </PlanDescription>
              </>
            ) : showLoadingState ? (
              <>
                <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground" />
                <PlanTitle className="animated-gradient-text min-w-0 truncate text-ui-base font-medium">
                  {activeItem?.content ?? intl.formatMessage({ id: "todo.panel.currentTask" })}
                </PlanTitle>
              </>
            ) : (
              <>
                <ListTodo className="size-4 shrink-0 text-foreground" />
                <PlanTitle className="min-w-0 truncate text-ui-base font-medium text-foreground">
                  {activeItem?.content ?? intl.formatMessage({ id: "todo.panel.currentTask" })}
                </PlanTitle>
              </>
            )}
            {!isOpen ? (
              <PlanDescription className="shrink-0 text-ui-base font-mono text-foreground-subtle">
                {`${completedCount}/${items.length}`}
              </PlanDescription>
            ) : null}
          </button>
        </div>
        <PlanAction className="shrink-0">
          <ControlHintTooltip
            title={intl.formatMessage({
              id: isOpen ? "chat.longRunning.collapse" : "chat.longRunning.expand",
            })}
          >
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-expanded={isOpen}
              aria-label={toggleLabel}
              onClick={(event) => {
                event.stopPropagation();
                toggleOpen();
              }}
            >
              <ChevronsUpDownIcon className="size-4" />
              <span className="sr-only">{toggleLabel}</span>
            </Button>
          </ControlHintTooltip>
        </PlanAction>
      </PlanHeader>
      <PlanContent className="p-1">
        <QueueList className="mt-0">
          {visibleItems.map((item) => (
            <QueueItem
              key={item.id}
              className="gap-0 w-full rounded-lg px-3 py-2 hover:bg-hover/30"
            >
              <div className="flex min-w-0 items-center gap-3">
                <QueueItemIndicator
                  className={todoStatusIndicatorClasses[item.status]}
                  status={todoStatusIndicatorStatus[item.status]}
                />
                <QueueItemContent
                  className={`min-w-0 line-clamp-none ${todoStatusContentClasses[item.status]}`}
                  completed={false}
                >
                  {item.content}
                </QueueItemContent>
              </div>
            </QueueItem>
          ))}
        </QueueList>
      </PlanContent>
    </Plan>
  );
}
