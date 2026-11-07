/**
 * verdict JSON schema 与校验（spec §2.1 / T2 fail-closed）。
 *
 * 模型输出 → 提取 JSON（容忍单层 markdown 围栏，与 title-generation / expert
 * parser 同型的确定性清洗，非启发式兜底）→ JSON.parse → 结构校验 → 外键/覆盖校验。
 * 任一步失败返回 degraded，驱动器整批降级 record-only（无部分执行）。
 */
import type {
  AdjudicationChengPlanReceipt,
  AdjudicationDisposition,
  AdjudicationSchemeCard,
  AdjudicationVerdictDecision,
} from "./contract.js";

export type VerdictValidationFailure = "json" | "schema" | "coverage";

export type VerdictValidation =
  | { ok: true; decisions: AdjudicationVerdictDecision[] }
  | { ok: false; failure: VerdictValidationFailure };

/** disposition 合法值（连字符记法，spec §2.1）。 */
const DISPOSITIONS: ReadonlySet<string> = new Set(["accept", "reject", "record-only"]);

/**
 * 确定性提取 JSON：整体 trim 后若被单层 ``` / ```json 围栏包裹则剥壳；
 * 其余情况原样返回（不扫描正文找 {…}——扫不出来就该 fail-closed）。
 */
export function extractVerdictJson(outputText: string): string {
  const trimmed = outputText.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return (match?.[1] ?? trimmed).trim();
}

/**
 * M6 方案卡结构解析：五字段齐全且候选方案 ≥2 才通过；任一处形状不符返回 undefined
 * （整批 schema-fail 降级 record-only，fail-closed）。缺席合法——出口门按档位与
 * proposalGate 决定是否拦下（缺字段不外发），不在解析层伪造内容。
 */
function parseSchemeCard(raw: unknown): AdjudicationSchemeCard | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.currentEvidence !== "string" || record.currentEvidence.length === 0) {
    return undefined;
  }
  if (typeof record.recommendation !== "string" || record.recommendation.length === 0) {
    return undefined;
  }
  if (typeof record.impact !== "string" || record.impact.length === 0) return undefined;
  if (typeof record.verification !== "string" || record.verification.length === 0) {
    return undefined;
  }
  const rawOptions = record.candidateOptions;
  if (!Array.isArray(rawOptions) || rawOptions.length < 2) return undefined;
  const candidateOptions: { option: string; cost: string }[] = [];
  for (const rawOption of rawOptions) {
    if (typeof rawOption !== "object" || rawOption === null) return undefined;
    const option = rawOption as Record<string, unknown>;
    if (typeof option.option !== "string" || option.option.length === 0) return undefined;
    if (typeof option.cost !== "string" || option.cost.length === 0) return undefined;
    candidateOptions.push({ option: option.option, cost: option.cost });
  }
  return {
    currentEvidence: record.currentEvidence,
    candidateOptions,
    recommendation: record.recommendation,
    impact: record.impact,
    verification: record.verification,
  };
}

function parseDecision(raw: unknown): AdjudicationVerdictDecision | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const triggerId = record.triggerId;
  const disposition = record.disposition;
  if (typeof triggerId !== "string" || triggerId.length === 0) return undefined;
  if (typeof disposition !== "string" || !DISPOSITIONS.has(disposition)) return undefined;
  const decision: AdjudicationVerdictDecision = {
    triggerId,
    disposition: disposition as AdjudicationDisposition,
  };
  if (record.reason !== undefined) {
    if (typeof record.reason !== "string") return undefined;
    decision.reason = record.reason;
  }
  if (record.evidence !== undefined) {
    if (!Array.isArray(record.evidence) || record.evidence.some((e) => typeof e !== "string")) {
      return undefined;
    }
    decision.evidence = record.evidence as string[];
  }
  if (record.scheme !== undefined) {
    const scheme = parseSchemeCard(record.scheme);
    if (!scheme) return undefined;
    decision.scheme = scheme;
  }
  if (record.chengPlanId !== undefined) {
    if (typeof record.chengPlanId !== "string" || record.chengPlanId.length === 0) {
      return undefined;
    }
    decision.chengPlanId = record.chengPlanId;
  }
  return decision;
}

/**
 * 校验一批 verdict。前置：candidateIds = 本批 triggerId 全集（来自 trigger_events
 * pending 行）。后置：ok=true 时 decisions 与 candidateIds 双射（外键命中 + 每条
 * 恰好一次）；任何失败 = 整批降级（调用方转 record-only，无部分执行）。
 */
export function validateVerdictBatch(
  outputText: string,
  candidateIds: ReadonlySet<string>,
): VerdictValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractVerdictJson(outputText));
  } catch {
    return { ok: false, failure: "json" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, failure: "schema" };
  const rawDecisions = (parsed as Record<string, unknown>).decisions;
  if (!Array.isArray(rawDecisions)) return { ok: false, failure: "schema" };

  const decisions: AdjudicationVerdictDecision[] = [];
  const seen = new Set<string>();
  for (const raw of rawDecisions) {
    const decision = parseDecision(raw);
    if (!decision) return { ok: false, failure: "schema" };
    // 外键：triggerId 必须命中本批候选；重复 = 覆盖失败（每条恰好一次）。
    if (!candidateIds.has(decision.triggerId) || seen.has(decision.triggerId)) {
      return { ok: false, failure: "coverage" };
    }
    seen.add(decision.triggerId);
    decisions.push(decision);
  }
  // 覆盖：模型不得遗漏候选（缺失 = 覆盖失败，整批降级）。
  if (seen.size !== candidateIds.size) return { ok: false, failure: "coverage" };
  return { ok: true, decisions };
}

export type ChengPlanReferenceValidation =
  | { ok: true }
  | { ok: false; unmatchedPlanIds: readonly string[] };

/**
 * verdict 的 chengPlanId 必须命中本批真实 ChengPlan 工具回执。没有引用 = 通过；
 * 任一引用未命中 = 整批降级（返回全部未命中 id，供审计原因）。
 */
export function validateChengPlanReferences(
  decisions: readonly AdjudicationVerdictDecision[],
  receipts: readonly AdjudicationChengPlanReceipt[],
): ChengPlanReferenceValidation {
  const receiptPlanIds = new Set(receipts.map((receipt) => receipt.planId));
  const unmatchedPlanIds = [
    ...new Set(
      decisions
        .map((decision) => decision.chengPlanId)
        .filter((planId): planId is string => planId !== undefined)
        .filter((planId) => !receiptPlanIds.has(planId)),
    ),
  ];
  return unmatchedPlanIds.length === 0 ? { ok: true } : { ok: false, unmatchedPlanIds };
}
