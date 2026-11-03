import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { z } from "zod";
import {
  zcodeAutomationBotDeliveryTargetSchema,
  type BotProvider,
} from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import { BOTS_OUTBOX_DEAD_LETTER_FILE } from "./config.js";

/**
 * Bot 出站死信（M7③）：automation 投递在 bot 删除/禁用/provider 不匹配/群未授权
 * 或终态消息发送失败时，除既有的节流 warn 外持久化一行死信，作为审计与重试的唯一权威。
 *
 * 存储约定与 BotsRepo 一致：版本化 JSON 文件 + zod 解析 + 文件锁内读改写 + 原子私有写。
 * 文件不存在时创建空的 version 1；未来版本文件不被旧代码重新解释。
 */

export const BOT_OUTBOX_DEAD_LETTER_MAX_ATTEMPTS = 5;
export const BOT_OUTBOX_DEAD_LETTER_PAYLOAD_TEXT_LIMIT = 2_000;
const BOT_OUTBOX_DEAD_LETTER_BACKOFF_BASE_MS = 60_000;
const BOT_OUTBOX_DEAD_LETTER_BACKOFF_CAP_MS = 3_600_000;

export const botOutboxDeadLetterAutomationSchema = z
  .object({
    runId: z.string().min(1).optional(),
    target: zcodeAutomationBotDeliveryTargetSchema,
    taskId: z.string().min(1),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().min(1).optional(),
  })
  .strict();

export type BotOutboxDeadLetterAutomation = z.infer<typeof botOutboxDeadLetterAutomationSchema>;

export const botOutboxDeadLetterRowSchema = z.object({
  /** 稳定 id：同一失败事件只 upsert 一行，绝不追加第二行。 */
  id: z.string().min(1),
  botId: z.string().min(1),
  provider: z.string().min(1),
  chatType: z.enum(["private", "group"]),
  providerUserId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  conversationThreadId: z.string().min(1).nullable().optional(),
  reason: z.string().min(1),
  /** 群目标 send_failed 行的授权快照：重放前必须复核群授权仍然成立，防止撤销后仍重投。 */
  groupAuthorizationId: z.string().min(1).optional(),
  /** 纯引用型死信（如 watchAutomationRun 预检跳过）携带可重放的 automation watch 参数。 */
  automation: botOutboxDeadLetterAutomationSchema.optional(),
  payloadRef: z.string().min(1).optional(),
  payloadText: z.string().optional(),
  payloadTruncated: z.boolean().optional(),
  attempts: z.number().int().nonnegative(),
  status: z.enum(["pending", "dropped"]),
  lastError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nextRetryAt: z.number(),
});

export type BotOutboxDeadLetterRow = z.infer<typeof botOutboxDeadLetterRowSchema>;

export const botsOutboxDeadLetterFileSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(botOutboxDeadLetterRowSchema),
  })
  .strict();

export type BotOutboxDeadLetterFile = z.infer<typeof botsOutboxDeadLetterFileSchema>;

export interface BotOutboxDeadLetterInput {
  id: string;
  botId: string;
  provider: BotProvider;
  chatType: "private" | "group";
  providerUserId: string;
  threadId?: string;
  conversationThreadId?: string | null;
  reason: string;
  groupAuthorizationId?: string;
  automation?: BotOutboxDeadLetterAutomation;
  payloadRef?: string;
  payloadText?: string;
  payloadTruncated?: boolean;
  lastError?: string;
}

export interface BotOutboxDeadLetterStore {
  read(): Promise<BotOutboxDeadLetterFile>;
  upsert(input: BotOutboxDeadLetterInput): Promise<BotOutboxDeadLetterRow>;
  update(id: string, next: BotOutboxDeadLetterRow): Promise<void>;
  remove(id: string): Promise<void>;
}

function createDefaultDeadLetterFile(): BotOutboxDeadLetterFile {
  return { version: 1, entries: [] };
}

function normalizePayloadText(text: string): {
  payloadText: string;
  payloadTruncated?: boolean;
} {
  if (text.length <= BOT_OUTBOX_DEAD_LETTER_PAYLOAD_TEXT_LIMIT) return { payloadText: text };
  return {
    payloadText: text.slice(0, BOT_OUTBOX_DEAD_LETTER_PAYLOAD_TEXT_LIMIT),
    payloadTruncated: true,
  };
}

/** 退避：1 分钟 × 2^(attempts−1)，封顶 1 小时。 */
export function computeDeadLetterRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    BOT_OUTBOX_DEAD_LETTER_BACKOFF_BASE_MS * 2 ** exponent,
    BOT_OUTBOX_DEAD_LETTER_BACKOFF_CAP_MS,
  );
}

function normalizeAutomation(
  automation: BotOutboxDeadLetterAutomation | undefined,
): BotOutboxDeadLetterAutomation | undefined {
  return automation
    ? botOutboxDeadLetterAutomationSchema.parse({
        ...(automation.runId !== undefined ? { runId: automation.runId } : {}),
        target: automation.target,
        taskId: automation.taskId,
        workspacePath: automation.workspacePath,
        ...(automation.workspaceIdentity !== undefined
          ? { workspaceIdentity: automation.workspaceIdentity }
          : {}),
      })
    : undefined;
}

/**
 * 失败落行：首次失败写 attempts=1；同一稳定 id 再次失败只 upsert 并递增 attempts；
 * 已 dropped 的行保持 dropped（审计终态，不复活）；达到上限翻转 dropped。
 */
export function applyDeadLetterFailure(
  existing: BotOutboxDeadLetterRow | undefined,
  input: BotOutboxDeadLetterInput,
  now: number,
): BotOutboxDeadLetterRow {
  const payload = input.payloadText !== undefined ? normalizePayloadText(input.payloadText) : {};
  if (!existing) {
    return {
      id: input.id,
      botId: input.botId,
      provider: input.provider,
      chatType: input.chatType,
      providerUserId: input.providerUserId,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.conversationThreadId !== undefined
        ? { conversationThreadId: input.conversationThreadId }
        : {}),
      reason: input.reason,
      ...(input.groupAuthorizationId !== undefined
        ? { groupAuthorizationId: input.groupAuthorizationId }
        : {}),
      ...(normalizeAutomation(input.automation)
        ? { automation: normalizeAutomation(input.automation) }
        : {}),
      ...(input.payloadRef !== undefined ? { payloadRef: input.payloadRef } : {}),
      ...payload,
      ...(input.payloadTruncated !== undefined ? { payloadTruncated: input.payloadTruncated } : {}),
      attempts: 1,
      status: "pending",
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      createdAt: now,
      updatedAt: now,
      // Bugfix：首次失败必须按统一退避写 nextRetryAt（1 分钟 × 2^(attempts−1)）。
      // 之前写成 now（立即到期），轮询式重试调用方会以零退避烧完尝试上限。
      nextRetryAt: now + computeDeadLetterRetryDelayMs(1),
    };
  }
  const attempts = existing.attempts + 1;
  const automation = normalizeAutomation(input.automation);
  return {
    ...existing,
    reason: input.reason,
    ...(input.groupAuthorizationId !== undefined
      ? { groupAuthorizationId: input.groupAuthorizationId }
      : {}),
    ...(automation ? { automation } : {}),
    ...(input.payloadRef !== undefined ? { payloadRef: input.payloadRef } : {}),
    ...payload,
    ...(input.payloadTruncated !== undefined ? { payloadTruncated: input.payloadTruncated } : {}),
    attempts,
    status:
      existing.status === "dropped"
        ? "dropped"
        : attempts >= BOT_OUTBOX_DEAD_LETTER_MAX_ATTEMPTS
          ? "dropped"
          : "pending",
    ...(input.lastError !== undefined
      ? { lastError: input.lastError }
      : existing.lastError !== undefined
        ? { lastError: existing.lastError }
        : {}),
    updatedAt: now,
    nextRetryAt:
      existing.status === "dropped"
        ? existing.nextRetryAt
        : now + computeDeadLetterRetryDelayMs(attempts),
  };
}

/** 重试失败记账：attempts+1，到上限翻 dropped；成功路径不调用本函数（直接删行）。 */
export function planDeadLetterRetryFailure(
  row: BotOutboxDeadLetterRow,
  now: number,
  lastError: string,
  maxAttempts: number = BOT_OUTBOX_DEAD_LETTER_MAX_ATTEMPTS,
): BotOutboxDeadLetterRow {
  const attempts = row.attempts + 1;
  const dropped = attempts >= maxAttempts;
  return {
    ...row,
    attempts,
    status: dropped ? "dropped" : "pending",
    lastError,
    updatedAt: now,
    nextRetryAt: now + computeDeadLetterRetryDelayMs(attempts),
  };
}

/** 稳定 id：同一失败事件（kind+bot+目标+run+载荷）恒定映射到同一行。 */
export function buildBotOutboxDeadLetterId(parts: {
  kind: string;
  botId: string;
  providerUserId: string;
  threadId?: string;
  runRef: string;
  payloadSeed?: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        parts.kind,
        parts.botId,
        parts.providerUserId,
        parts.threadId ?? "",
        parts.runRef,
        parts.payloadSeed ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return `${parts.kind}:${parts.botId}:${digest}`;
}

export class BotsOutboxDeadLetterRepo implements BotOutboxDeadLetterStore {
  private readonly path = join(getAppConfigDir(), BOTS_OUTBOX_DEAD_LETTER_FILE);

  async read(): Promise<BotOutboxDeadLetterFile> {
    return withFileLock(this.path, () => this.readUnlocked());
  }

  async upsert(input: BotOutboxDeadLetterInput): Promise<BotOutboxDeadLetterRow> {
    return withFileLock(this.path, async () => {
      const current = await this.readUnlocked();
      const existing = current.entries.find((entry) => entry.id === input.id);
      const next = applyDeadLetterFailure(existing, input, Date.now());
      current.entries = existing
        ? current.entries.map((entry) => (entry.id === input.id ? next : entry))
        : [...current.entries, next];
      await this.writeUnlocked(botsOutboxDeadLetterFileSchema.parse(current));
      return next;
    });
  }

  async update(id: string, next: BotOutboxDeadLetterRow): Promise<void> {
    await withFileLock(this.path, async () => {
      const current = await this.readUnlocked();
      if (!current.entries.some((entry) => entry.id === id)) return;
      current.entries = current.entries.map((entry) => (entry.id === id ? next : entry));
      await this.writeUnlocked(botsOutboxDeadLetterFileSchema.parse(current));
    });
  }

  async remove(id: string): Promise<void> {
    await withFileLock(this.path, async () => {
      const current = await this.readUnlocked();
      if (!current.entries.some((entry) => entry.id === id)) return;
      current.entries = current.entries.filter((entry) => entry.id !== id);
      await this.writeUnlocked(botsOutboxDeadLetterFileSchema.parse(current));
    });
  }

  private async readUnlocked(): Promise<BotOutboxDeadLetterFile> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return createDefaultDeadLetterFile();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 文件损坏：按 spec 重建空 version-1 文件；否则 list/retry 入口会永久抛错、
      // 死信写入降级为节流 warn，审计形同失效。
      await this.recreateDefaultFile();
      return createDefaultDeadLetterFile();
    }
    const version = (parsed as { version?: unknown } | null)?.version;
    if (typeof version === "number" && version > 1) {
      // 未来版本文件不被旧代码重新解释（spec 明确要求抛错而非清空）。
      throw new Error(`Unsupported bot outbox dead letter file version: ${version}`);
    }
    const result = botsOutboxDeadLetterFileSchema.safeParse(parsed);
    if (!result.success) {
      await this.recreateDefaultFile();
      return createDefaultDeadLetterFile();
    }
    return result.data;
  }

  private async recreateDefaultFile(): Promise<void> {
    await this.writeUnlocked(createDefaultDeadLetterFile());
  }

  private async writeUnlocked(value: BotOutboxDeadLetterFile): Promise<void> {
    await atomicWritePrivateTextFile(this.path, `${JSON.stringify(value, null, 2)}\n`);
  }
}
