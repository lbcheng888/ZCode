import type { PlanItem, PlanState } from "@zcode/shared/zcode-protocol-v4";
import { Plan, PlanDescription, PlanHeader, PlanTitle } from "@/components/ai-elements/plan.js";
import { ListTodo, LoaderIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TID_V4_TODO_PANEL } from "@zcode/shared/test-ids";
import { cn } from "./components/lib/utils.js";

/**
 * composer 上方的待办状态芯片。
 *
 * 只显示「当前任务 + 已完成/总数」，**不渲染清单**：待办明细由会话状态面板的待办分区承担
 * （该面板可以展开/收起但不可关闭，因此两处同时给明细必然逐字重复）。点击芯片展开状态面板，
 * 由调用方通过 onRevealDetail 提供跳转。
 */
export function TodoPanel({
  plan,
  isStreaming,
  className,
  onRevealDetail,
}: {
  plan: PlanState | null;
  isStreaming: boolean;
  className?: string;
  /** 点击芯片时的跳转（展开会话状态面板）。 */
  onRevealDetail?: () => void;
}) {
  const { intl } = useZCodeIntl();
  // 数据源是 v4 投影快照（snapshot.plan），与状态面板的待办分区同一份。
  const items: readonly PlanItem[] = plan?.items ?? [];
  if (items.length === 0) {
    return null;
  }

  const completedCount = items.filter((item) => item.status === "completed").length;
  // Bugfix: provider 可能先把 todo 全部标成 completed，再稍后才推 task_complete 清空 store。
  // 这段间隙继续展示“已完成 todo”会让用户误以为还有待处理事项，所以全完成后直接隐藏。
  if (completedCount === items.length) {
    return null;
  }

  const activeItem =
    items.find((item) => item.status === "inProgress") ??
    items.find((item) => item.status !== "completed") ??
    items[items.length - 1];
  // Bugfix: loading 视觉只在任务真正运行期出现；停止/结束后残留的 inProgress 项不再转菊花。
  const showLoadingState = isStreaming;
  const revealLabel = intl.formatMessage({ id: "chat.longRunning.expand" });

  return (
    <Plan
      data-testid={TID_V4_TODO_PANEL}
      className={cn(
        "gap-0 overflow-hidden rounded-xl border border-card-border bg-card py-0",
        className,
      )}
      isStreaming={isStreaming}
    >
      <PlanHeader className="group flex items-center gap-3 px-4 !py-3">
        <button
          type="button"
          aria-label={revealLabel}
          title={revealLabel}
          className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-3 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onClick={onRevealDetail}
        >
          {showLoadingState ? (
            <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground" />
          ) : (
            <ListTodo className="size-4 shrink-0 text-foreground" />
          )}
          <PlanTitle
            className={cn(
              "min-w-0 truncate text-ui-base font-medium",
              showLoadingState ? "animated-gradient-text" : "text-foreground",
            )}
          >
            {activeItem?.content ?? intl.formatMessage({ id: "todo.panel.currentTask" })}
          </PlanTitle>
          <PlanDescription className="shrink-0 text-ui-base font-mono text-foreground-subtle">
            {`${completedCount}/${items.length}`}
          </PlanDescription>
        </button>
      </PlanHeader>
    </Plan>
  );
}
