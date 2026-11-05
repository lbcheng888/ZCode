// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pendingWouldAcceptCardSchema,
  type PendingWouldAcceptCard,
} from "@zcode/shared/zcode-protocol-v4";
import { testId } from "@zcode/shared/test-ids";
import {
  TID_WOULD_ACCEPT_EMPTY,
  TID_WOULD_ACCEPT_INBOX,
  TID_WOULD_ACCEPT_PROMOTE,
  TID_WOULD_ACCEPT_SCHEME,
  WouldAcceptInbox,
} from "@/would-accept/WouldAcceptInbox.js";

const mocks = vi.hoisted(() => ({
  optionalServices: null as unknown,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (
        { id }: { id: string },
        values?: Record<string, string>,
      ) => (values ? `${id}:${Object.values(values).join(" | ")}` : id),
    },
  }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => mocks.optionalServices,
}));

afterEach(() => {
  cleanup();
  mocks.optionalServices = null;
});

// 走真实快照投影 schema 解析（不是手写 mock 形状）：卡片就是 v4 snapshot
// `pendingWouldAccept` 元素，schema 漂移会让测试先失败。
const CARD: PendingWouldAcceptCard = pendingWouldAcceptCardSchema.parse({
  cardId: "card-1",
  source: "im",
  summary: "群里问发布状态",
  suggestedTier: "auto",
  createdAt: 1_796_000_000_000,
});

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

  it("宿主注入 promote 实现（v4 命令 RPC）时优先走该实现，不要求 mandate 服务缝", async () => {
    const promoteWouldAccept = vi.fn(async (_cardId: string) => undefined);
    mocks.optionalServices = null;
    render(createElement(WouldAcceptInbox, { cards: [CARD], promote: { promoteWouldAccept } }));
    const button = screen.getByTestId(promoteTestId(CARD.cardId)) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await vi.waitFor(() => expect(promoteWouldAccept).toHaveBeenCalledWith("card-1"));
    await vi.waitFor(() => expect(screen.queryByTestId(TID_WOULD_ACCEPT_INBOX)).toBeNull());
  });

  it("M6 五字段方案卡：展开渲染证据/候选代价/推荐/影响/验证，而非只显示摘要", () => {
    const schemeCard: PendingWouldAcceptCard = pendingWouldAcceptCardSchema.parse({
      ...CARD,
      cardId: "card-scheme",
      scheme: {
        currentEvidence: "create-app.ts:237 每 app 一份登记表",
        candidateOptions: [
          { option: "共享登记表", cost: "需要进程级单例" },
          { option: "随队列持久化", cost: "schema 迁移" },
        ],
        recommendation: "进程级共享登记表",
        impact: "bootstrap/app + 跨会话投递",
        verification: "vitest admission 用例",
      },
    });
    render(createElement(WouldAcceptInbox, { cards: [schemeCard] }));

    const schemeNode = screen.getByTestId(testId(TID_WOULD_ACCEPT_SCHEME, "card-scheme"));
    expect(schemeNode.textContent).toContain("create-app.ts:237 每 app 一份登记表");
    expect(schemeNode.textContent).toContain("共享登记表");
    expect(schemeNode.textContent).toContain("需要进程级单例");
    expect(schemeNode.textContent).toContain("进程级共享登记表");
    expect(schemeNode.textContent).toContain("bootstrap/app + 跨会话投递");
    expect(schemeNode.textContent).toContain("vitest admission 用例");
    expect(schemeNode.textContent).toContain("wouldAccept.scheme.recommendation");
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
