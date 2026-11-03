// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingWouldAcceptCard } from "@zcode/shared/zcode-protocol-v4";
import { testId } from "@zcode/shared/test-ids";
import {
  TID_WOULD_ACCEPT_EMPTY,
  TID_WOULD_ACCEPT_INBOX,
  TID_WOULD_ACCEPT_PROMOTE,
  WouldAcceptInbox,
} from "@/would-accept/WouldAcceptInbox.js";

const mocks = vi.hoisted(() => ({
  optionalServices: null as unknown,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => mocks.optionalServices,
}));

afterEach(() => {
  cleanup();
  mocks.optionalServices = null;
});

const CARD: PendingWouldAcceptCard = {
  cardId: "card-1",
  source: "im",
  summary: "群里问发布状态",
  suggestedTier: "auto",
  createdAt: 1_796_000_000_000,
};

const promoteTestId = (cardId: string) => testId(TID_WOULD_ACCEPT_PROMOTE, cardId);

describe("WouldAcceptInbox", () => {
  it("快照缺席该键（undefined=unknown）时不渲染收件箱", () => {
    const { container } = render(createElement(WouldAcceptInbox, { cards: undefined }));
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId(TID_WOULD_ACCEPT_INBOX)).toBeNull();
    expect(screen.queryByTestId(TID_WOULD_ACCEPT_EMPTY)).toBeNull();
  });

  it("显式空数组渲染空态，不渲染卡片列表", () => {
    render(createElement(WouldAcceptInbox, { cards: [] }));
    expect(screen.getByTestId(TID_WOULD_ACCEPT_EMPTY)).toBeTruthy();
    expect(screen.queryByTestId(TID_WOULD_ACCEPT_INBOX)).toBeNull();
    expect(screen.queryByTestId(promoteTestId(CARD.cardId))).toBeNull();
  });

  it("宿主未接入 mandate 服务时批转入口禁用并如实提示未接入", () => {
    render(createElement(WouldAcceptInbox, { cards: [CARD] }));
    expect(screen.getByTestId(TID_WOULD_ACCEPT_INBOX)).toBeTruthy();
    expect(screen.getByText(CARD.summary)).toBeTruthy();
    const button = screen.getByTestId(promoteTestId(CARD.cardId)) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("wouldAccept.promoteUnavailable");
  });

  it("服务缝接入后按 spec §2.1 调 promoteWouldAccept(cardId)，成功后该卡片从列表抑制", async () => {
    const promoteWouldAccept = vi.fn(async (_cardId: string) => undefined);
    mocks.optionalServices = { mandateService: { promoteWouldAccept } };
    render(createElement(WouldAcceptInbox, { cards: [CARD] }));
    const button = screen.getByTestId(promoteTestId(CARD.cardId)) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await vi.waitFor(() => expect(promoteWouldAccept).toHaveBeenCalledWith("card-1"));
    await vi.waitFor(() => expect(screen.queryByTestId(TID_WOULD_ACCEPT_INBOX)).toBeNull());
    expect(screen.getByTestId(TID_WOULD_ACCEPT_EMPTY)).toBeTruthy();
  });

  it("多卡列表下每张卡的批转按钮 testid 按 cardId 区分，可被 getByTestId 精确命中", () => {
    const second: PendingWouldAcceptCard = { ...CARD, cardId: "card-2", source: "webhook" };
    render(createElement(WouldAcceptInbox, { cards: [CARD, second] }));
    expect(screen.getByTestId(promoteTestId("card-1"))).toBeTruthy();
    expect(screen.getByTestId(promoteTestId("card-2"))).toBeTruthy();
    // base 前缀本身不是合法 testid，getByTestId 不会因多卡歧义失败。
    expect(screen.queryByTestId(TID_WOULD_ACCEPT_PROMOTE)).toBeNull();
  });
});
