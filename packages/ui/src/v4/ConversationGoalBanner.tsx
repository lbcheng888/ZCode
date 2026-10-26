import { memo } from "react";
import {
  TID_V4_GOAL_BANNER,
  TID_V4_GOAL_CLEAR_CONFIRM,
  TID_V4_GOAL_CLEAR_CONFIRM_ACCEPT,
} from "@zcode/shared/test-ids";
import type { GoalState } from "@zcode/shared/zcode-protocol-v4";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ConversationGoalBannerProps {
  goal: GoalState;
}

/**
 * M4 goal 横幅：展示 sendGoalCommand/resumeGoal 的 goal 状态投影（objective/status/iteration）。
 * memo：goal 不变时不随 SessionPane 其他状态重渲染。
 */
function ConversationGoalBannerImpl({ goal }: ConversationGoalBannerProps) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-testid={TID_V4_GOAL_BANNER}
      data-goal-status={goal.status}
      data-goal-objective={goal.objective}
      className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-ui-sm"
    >
      <span className="text-[var(--color-foreground-subtle)]">
        {intl.formatMessage({ id: "chat.goalBanner.label" })}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--color-foreground)]">
        {goal.objective}
      </span>
      <span className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-foreground-subtle)]">
        {goal.status} · #{goal.iteration}
      </span>
    </div>
  );
}

export const ConversationGoalBanner = memo(ConversationGoalBannerImpl);

export interface GoalClearConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/**
 * 取消目标的二次确认。clearGoal 是破坏性动作（删除 target 行 + 三维预算），
 * 侧栏与 composer chip 共用 SessionPane 里的同一个实例，避免出现两条确认路径。
 * 与 goal 横幅同文件：packages/ui 是 legacy 未受管模块，architecture 规则不允许新增源码文件。
 *
 * Esc 关闭由 Radix DismissableLayer 在 document 捕获阶段 preventDefault 完成，
 * SessionPane 的窗口级 Esc→stop 会看到 defaultPrevented 而跳过，不会误停生成。
 */
export function GoalClearConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: GoalClearConfirmDialogProps) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={TID_V4_GOAL_CLEAR_CONFIRM}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "chat.target.cancelTitle" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "chat.target.cancelDescription" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid={TID_V4_GOAL_CLEAR_CONFIRM_ACCEPT}
            onClick={onConfirm}
          >
            {intl.formatMessage({ id: "chat.target.cancel" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
