import { z } from "zod";
import { timestampSchema } from "./core.js";

/**
 * would-accept 收件箱卡片（super-agent Phase 2，spec §5.5 / design §6）。
 *
 * 这是 ConversationSnapshot / StatePatch 的 additive-optional 投影键：旧客户端整体忽略
 * 未知键（unknown≠0——键缺席是「未知」，不是「空收件箱」，所以快照侧不带 default）。
 * 卡片对象刻意不用 strict：将来卡片内部再加 additive 字段时，老客户端剥键存活，
 * 不会因 strict 拒收整份 snapshot。
 */

/** 触发来源词表与 trigger_events.source 对齐（spec §1.2）；git/file 为类型预留枚举值（P2 不产行），现在进闭集免得将来加值引发 closed-set 偏斜。 */
export const wouldAcceptSourceSchema = z.enum(["im", "webhook", "schedule", "ci", "git", "file"]);
export type WouldAcceptSource = z.infer<typeof wouldAcceptSourceSchema>;

/** 建议档位与 mandate.tier 同词汇（spec §1.4）。 */
export const wouldAcceptSuggestedTierSchema = z.enum(["record_only", "speculative", "auto"]);
export type WouldAcceptSuggestedTier = z.infer<typeof wouldAcceptSuggestedTierSchema>;

/**
 * mandate 批转 RPC 合同（spec §2.1 `super-agent-mandate.promoteWouldAccept(cardId)`）。
 *
 * 合同放 shared 是给跨层服务缝一个双方都能 import 的类型源：packages/ui 的缝探测与
 * wave 2 的 mandate 模块实现共享同一签名。只在调用侧写字符串契约没有编译关联，
 * 命名/签名漂移会让探测键永不命中（按钮永久 disabled 且零报错）。
 */
export interface WouldAcceptPromoteRpc {
  /** 一键批转 auto = 写 mandate 行（P2 允许写行；auto 执行档仍 P3 生效，卡片文案需如实呈现）。 */
  promoteWouldAccept(cardId: string): Promise<void>;
}

/**
 * 五字段方案卡（design M6，2026-11-02 用户裁定）：所有「问题→方案」类交付必须携带
 * 现状证据 / 候选方案（≥2，各带代价）/ 最佳推荐 / 影响面 / 验证方案。
 * 一句话摘要不构成「最佳方案」——收件箱出口按本 schema 校验，缺字段不外发。
 */
export const schemeCardSchema = z.object({
  /** 现状证据：根因 + file:line / 日志。 */
  currentEvidence: z.string().min(1),
  /** 候选方案 ≥2，每条带代价。 */
  candidateOptions: z
    .array(z.object({ option: z.string().min(1), cost: z.string().min(1) }))
    .min(2),
  /** 最佳推荐（第一性原理理由）。 */
  recommendation: z.string().min(1),
  /** 影响面：文件、兼容、回滚。 */
  impact: z.string().min(1),
  /** 验证方案：命令 + 判据。 */
  verification: z.string().min(1),
});
export type SchemeCard = z.infer<typeof schemeCardSchema>;

export const pendingWouldAcceptCardSchema = z.object({
  /** 卡片 id（would-accept 投影主键；批转 auto 时作为 mandate promote 的入参）。 */
  cardId: z.string().min(1),
  source: wouldAcceptSourceSchema,
  /** 裁决产出的事件摘要（trigger payload 摘要化后的展示面，不含原文/凭据）。 */
  summary: z.string(),
  suggestedTier: wouldAcceptSuggestedTierSchema,
  createdAt: timestampSchema,
  /**
   * M6 五字段方案卡内容（additive-optional：键已冻结，旧客户端剥键存活；
   * 缺席 = 旧行 / 非方案类卡，新收件箱按出口门决定是否呈现）。
   */
  scheme: schemeCardSchema.optional(),
});
export type PendingWouldAcceptCard = z.infer<typeof pendingWouldAcceptCardSchema>;
