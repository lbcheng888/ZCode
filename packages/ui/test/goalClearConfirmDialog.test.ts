// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TID_V4_GOAL_CLEAR_CONFIRM,
  TID_V4_GOAL_CLEAR_CONFIRM_ACCEPT,
} from "@zcode/shared/test-ids";
import { GoalClearConfirmDialog } from "../src/v4/ConversationGoalBanner.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

describe("GoalClearConfirmDialog", () => {
  afterEach(cleanup);

  it("renders title + description so a screen reader announces the destructive action", () => {
    const view = render(
      createElement(GoalClearConfirmDialog, {
        open: true,
        onOpenChange: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
    expect(view.getByTestId(TID_V4_GOAL_CLEAR_CONFIRM)).toBeTruthy();
    expect(view.getByText("chat.target.cancelTitle")).toBeTruthy();
    expect(view.getByText("chat.target.cancelDescription")).toBeTruthy();
    expect(view.getByText("common.cancel")).toBeTruthy();
  });

  it("confirm reports once; cancel never reports", () => {
    const onConfirm = vi.fn();
    const first = render(
      createElement(GoalClearConfirmDialog, {
        open: true,
        onOpenChange: vi.fn(),
        onConfirm,
      }),
    );
    fireEvent.click(first.getByTestId(TID_V4_GOAL_CLEAR_CONFIRM_ACCEPT));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    first.unmount();

    const onConfirmSecond = vi.fn();
    const second = render(
      createElement(GoalClearConfirmDialog, {
        open: true,
        onOpenChange: vi.fn(),
        onConfirm: onConfirmSecond,
      }),
    );
    fireEvent.click(second.getByText("common.cancel"));
    expect(onConfirmSecond).not.toHaveBeenCalled();
    second.unmount();
  });
});
