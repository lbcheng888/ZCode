import { Lightbulb } from "lucide-react";
import { useCallback } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const BEST_PLAN_TOOL_ICON = <Lightbulb className="size-4 shrink-0 text-foreground-subtle" />;

/** 候选方案的一条：方案本身与它要付的代价，两者都是契约字段。 */
interface BestPlanCandidate {
  option: string;
  cost: string;
}

/** ProposeBestPlan 的六个字段：摘要 + 现状证据 + 候选方案 + 推荐 + 影响面 + 验证。 */
interface BestPlanInput {
  summary: string;
  currentEvidence: string;
  candidateOptions: BestPlanCandidate[];
  recommendation: string;
  impact: string;
  verification: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readCandidates(value: unknown): BestPlanCandidate[] | null {
  // 与 CLI 契约同一条数量约束：少于两条就没有比较，多出四条卡片会压垮正文。
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    return null;
  }

  const candidates: BestPlanCandidate[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const option = readString(entry.option);
    const cost = readString(entry.cost);
    // 缺一条代价就整张卡降级：静默丢候选会让「比较了哪些方案」变成谎话。
    if (option === undefined || cost === undefined) {
      return null;
    }
    candidates.push({ option, cost });
  }
  return candidates;
}

/**
 * 六字段任一缺失、或 input 根本不是对象时返回 null。流式首帧的 `{}` 也走这条路：
 * 卡面退成一句 `bestPlan.invalid`，绝不把 raw JSON 摊进消息流（六个字段名对读者没有信息）。
 */
function readBestPlanInput(value: unknown): BestPlanInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const summary = readString(value.summary);
  const currentEvidence = readString(value.currentEvidence);
  const candidateOptions = readCandidates(value.candidateOptions);
  const recommendation = readString(value.recommendation);
  const impact = readString(value.impact);
  const verification = readString(value.verification);
  if (
    summary === undefined ||
    currentEvidence === undefined ||
    candidateOptions === null ||
    recommendation === undefined ||
    impact === undefined ||
    verification === undefined
  ) {
    return null;
  }

  return {
    summary,
    currentEvidence,
    candidateOptions,
    recommendation,
    impact,
    verification,
  };
}

/** 单段正文：小标题 + 与 escalate 卡同款的正文块，六字段里五段共用。 */
function BestPlanField({ heading, value }: { heading: string; value: string }) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-ui-sm font-medium text-foreground-subtlest">{heading}</h4>
      <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
        {value}
      </p>
    </section>
  );
}

/**
 * ProposeBestPlan 的工具卡：把「先证明方案最优」的六字段按论证顺序铺开——
 * 现状证据 → 候选方案（逐条带代价）→ 推荐 → 影响面 → 验证方案，摘要进折叠行。
 *
 * 默认展开（forceOpen）：这张卡的全部价值就是让人一眼读完比较过程，
 * 折起来只剩一句摘要等于让用户再点一次。input 读不出六字段时只给降级文案，不摊 raw JSON。
 */
export function BestPlanToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const plan = readBestPlanInput(toolCall.input);
  const isFailed = toolCall.status === "failed";

  const titleLabel = intl.formatMessage({ id: "bestPlan.title" });
  const currentEvidenceHeading = intl.formatMessage({ id: "bestPlan.currentEvidence" });
  const candidateOptionsHeading = intl.formatMessage({ id: "bestPlan.candidateOptions" });
  const recommendationHeading = intl.formatMessage({ id: "bestPlan.recommendation" });
  const impactHeading = intl.formatMessage({ id: "bestPlan.impact" });
  const verificationHeading = intl.formatMessage({ id: "bestPlan.verification" });
  const invalidLabel = intl.formatMessage({ id: "bestPlan.invalid" });

  const renderContent = useCallback(() => {
    if (plan === null) {
      return <p className="text-ui-sm text-foreground-subtlest">{invalidLabel}</p>;
    }

    return (
      <div className="space-y-3">
        <BestPlanField heading={currentEvidenceHeading} value={plan.currentEvidence} />
        <section className="space-y-1.5">
          <h4 className="text-ui-sm font-medium text-foreground-subtlest">
            {candidateOptionsHeading}
          </h4>
          <ul className="space-y-1.5">
            {plan.candidateOptions.map((candidate, index) => (
              <li
                key={`${candidate.option}:${index}`}
                className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-2 text-ui-base leading-5 text-foreground"
              >
                {intl.formatMessage(
                  { id: "bestPlan.candidateOption" },
                  { option: candidate.option, cost: candidate.cost },
                )}
              </li>
            ))}
          </ul>
        </section>
        <BestPlanField heading={recommendationHeading} value={plan.recommendation} />
        <BestPlanField heading={impactHeading} value={plan.impact} />
        <BestPlanField heading={verificationHeading} value={plan.verification} />
      </div>
    );
  }, [
    candidateOptionsHeading,
    currentEvidenceHeading,
    impactHeading,
    intl,
    invalidLabel,
    plan,
    recommendationHeading,
    verificationHeading,
  ]);

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={BEST_PLAN_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen
        kindLabel={context.kindLabelOverride ?? titleLabel}
        sourceLabel={context.sourceLabel}
        primaryText={plan?.summary ?? null}
        statusLabel={isFailed ? context.statusLabel : undefined}
        statusTooltip={isFailed ? context.errorText : undefined}
        showFailureStatus={isFailed}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
