import type { TriggerWorkerContext } from "./contract.js";

/**
 * 投递/分派文本与 M2 上下文装配的内容上限（§2.1「内容上限约束」）。
 * 常量集中在此：trigger_events.payload 单行上限 64KB（§1.2），投递面只取摘要文本。
 */
export const TRIGGER_DISPATCH_TEXT_MAX_CHARS = 4_000;
export const GOAL_SUMMARY_MAX_CHARS = 500;
export const NARROW_RESULT_MAX_CHARS = 200;
export const NARROW_RESULT_MAX_COUNT = 3;
export const OPEN_QUESTION_MAX_CHARS = 200;
export const OPEN_QUESTION_MAX_COUNT = 5;
export const RECALL_SEED_MAX_COUNT = 10;

function truncateChars(value: string, maxChars: number): string {
  // 按 code point 截断，避免拆散代理对；上限以字符数计（与上下文预算口径一致）。
  const points = Array.from(value);
  return points.length <= maxChars ? value : points.slice(0, maxChars).join("");
}

/**
 * trigger_events.payload（摘要化 JSON）→ 投递文本。约定 payload 为对象时携带
 * 字符串 `text` 字段（Intake 摘要化契约）；解析失败或无 text 时返回空串——
 * 事件仍照常投递（订阅者靠 triggerId/上下文识别），不捏造文本。
 */
export function extractPayloadText(payloadJson: string, maxChars: number): string {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed === "string") return truncateChars(parsed, maxChars);
    if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
      const text = (parsed as { text: unknown }).text;
      if (typeof text === "string") return truncateChars(text, maxChars);
    }
  } catch {
    // payload 损坏不阻断路由：原文不落日志（§0），按空文本继续。
  }
  return "";
}

export interface AssembleHumanExplicitWakeTextInput {
  text: string;
  context?: TriggerWorkerContext;
}

/**
 * human-explicit 的唤醒文本 = 触发原文 + M2 上下文装配（目标摘要 + 最近窄结果 +
 * 未决问题 + recall 种子 ID 列表），各段有上限、缺段不占位。结构保持纯文本：
 * resume/createTask 的入参与既有 bots 私聊 createTask 面一致，不引入新协议类型。
 */
export function assembleHumanExplicitWakeText(
  input: AssembleHumanExplicitWakeTextInput,
): string {
  const sections: string[] = [];
  if (input.text.trim().length > 0) sections.push(input.text);

  const context = input.context;
  if (context?.goalSummary && context.goalSummary.trim().length > 0) {
    sections.push(`目标：${truncateChars(context.goalSummary, GOAL_SUMMARY_MAX_CHARS)}`);
  }
  const narrowResults = (context?.recentNarrowResults ?? [])
    .filter((item) => item.trim().length > 0)
    .slice(0, NARROW_RESULT_MAX_COUNT)
    .map((item) => `- ${truncateChars(item, NARROW_RESULT_MAX_CHARS)}`);
  if (narrowResults.length > 0) {
    sections.push(`最近结果：\n${narrowResults.join("\n")}`);
  }
  const openQuestions = (context?.openQuestions ?? [])
    .filter((item) => item.trim().length > 0)
    .slice(0, OPEN_QUESTION_MAX_COUNT)
    .map((item) => `- ${truncateChars(item, OPEN_QUESTION_MAX_CHARS)}`);
  if (openQuestions.length > 0) {
    sections.push(`未决：\n${openQuestions.join("\n")}`);
  }
  const recallSeeds = (context?.recallSeedIds ?? [])
    .filter((id) => id.trim().length > 0)
    .slice(0, RECALL_SEED_MAX_COUNT);
  if (recallSeeds.length > 0) {
    sections.push(`recall 种子：${recallSeeds.join(", ")}`);
  }
  return sections.join("\n\n");
}
