import { memo } from "react";
import { testId } from "@zcode/shared/test-ids";
import type { PendingWouldAcceptCard } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWouldAcceptPromote } from "@/would-accept/useWouldAcceptPromote.js";

/** 组件级 test id（shared test-ids 目录不在本车道分区，避免跨分区登记；动态元素用 testId(base, cardId)）。 */
export const TID_WOULD_ACCEPT_INBOX = "would-accept-inbox";
export const TID_WOULD_ACCEPT_EMPTY = "would-accept-inbox-empty";
export const TID_WOULD_ACCEPT_PROMOTE = "would-accept-inbox-promote";

const TIER_MESSAGE_IDS = {
  record_only: "wouldAccept.tier.recordOnly",
  speculative: "wouldAccept.tier.speculative",
  auto: "wouldAccept.tier.auto",
} as const;

export interface WouldAcceptInboxProps {
  /**
   * 快照投影 `pendingWouldAccept`（spec §5.5）。
   * undefined = 旧发送端未发布该键（unknown≠0，不渲染收件箱，绝不当成空列表）；
   * [] = 已发布且零卡片的空态。
   */
  cards: readonly PendingWouldAcceptCard[] | undefined;
}

/**
 * would-accept 收件箱（desktop/web 共享）。
 *
 * record-only 裁决卡片列表 + 一键批转 auto。数据只来自快照投影；批转动作经
 * `useWouldAcceptPromote` 服务缝，宿主未接入 mandate RPC 时按钮禁用并如实提示。
 */
export const WouldAcceptInbox = memo(function WouldAcceptInbox({ cards }: WouldAcceptInboxProps) {
  const { intl } = useZCodeIntl();
  const promote = useWouldAcceptPromote();

  // 展示抑制只过滤已批转的卡片；权威列表仍是快照投影，下帧投影到达即恢复口径。
  const visibleCards =
    cards === undefined || !promote.configured
      ? cards
      : cards.filter((card) => !promote.promotedCardIds.has(card.cardId));

  if (visibleCards === undefined) return null;

  if (visibleCards.length === 0) {
    return (
      <section
        aria-label={intl.formatMessage({ id: "wouldAccept.title" })}
        className="rounded-lg border border-border/60 bg-background/40 px-3 py-2"
        data-testid={TID_WOULD_ACCEPT_EMPTY}
      >
        <p className="text-ui-caption text-muted-foreground">
          {intl.formatMessage({ id: "wouldAccept.empty" })}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label={intl.formatMessage({ id: "wouldAccept.title" })}
      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2"
      data-testid={TID_WOULD_ACCEPT_INBOX}
    >
      <h3 className="text-ui-sm font-medium text-foreground">
        {intl.formatMessage({ id: "wouldAccept.title" })}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {visibleCards.map((card) => (
          <li
            key={card.cardId}
            className="flex items-start justify-between gap-2 text-ui-caption text-muted-foreground"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-ui-sm text-foreground">{card.summary}</span>
              <span>
                <span className="mr-1.5 rounded border border-border/60 px-1">{card.source}</span>
                {intl.formatMessage({ id: TIER_MESSAGE_IDS[card.suggestedTier] })}
                {" · "}
                {new Date(card.createdAt).toLocaleString()}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 text-ui-caption"
              disabled={!promote.configured || promote.status === "promoting"}
              title={
                promote.configured
                  ? undefined
                  : intl.formatMessage({ id: "wouldAccept.promoteUnavailable" })
              }
              data-testid={testId(TID_WOULD_ACCEPT_PROMOTE, card.cardId)}
              onClick={() => {
                if (promote.configured) void promote.promoteWouldAccept(card.cardId);
              }}
            >
              {intl.formatMessage({ id: "wouldAccept.promoteAuto" })}
            </Button>
          </li>
        ))}
      </ul>
      {promote.configured && promote.status === "failed" && promote.error ? (
        <p className="text-ui-caption text-destructive">
          {intl.formatMessage({ id: "wouldAccept.promoteFailed" }, { message: promote.error })}
        </p>
      ) : null}
    </section>
  );
});
