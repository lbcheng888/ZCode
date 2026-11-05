import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { z } from "zod";
import { getAppConfigDir } from "../paths.js";
import { BOTS_TRIGGER_TASK_BINDINGS_FILE } from "./config.js";

/**
 * child `host.worker.createTask` 的 Core 侧幂等权威（milestone-b-spec §3.3）。
 *
 * child 的 `trigger_subscriptions` 唯一约束在 super-agent 域库，Core 不得跨进程读写；
 * 因此 Core 必须自己保存 `triggerId → sessionId`。这里只落**已完成**绑定：
 * - 命中 = 同一 trigger 已建过会话，直接返回 sessionId（禁止「建了再说」）；
 * - 缺失 = 尚未完成；重试会走既有 bots createTask 路径，届时 bot state 的
 *   `activeTaskId` 会把已建会话收敛为 resume + 同 commandId 投递，不重复建任务。
 *
 * 存储约定与 BotsRepo/出站死信一致：版本化 JSON + zod 严格解析 + 文件锁内读改写 +
 * 原子私有写。文件损坏或版本不符**不重建**（重建会把幂等事实清零，导致重投双建），
 * 直接抛错让调用方响亮失败。
 */

/** 绑定键按 triggerId；workspace/threadKey 随行保存，跨界命中即拒绝。 */
export const botTriggerTaskBindingSchema = z
  .object({
    workspaceIdentity: z.string().min(1),
    threadKey: z.string().min(1),
    sessionId: z.string().min(1),
    createdAt: z.number(),
  })
  .strict();
export type BotTriggerTaskBinding = z.infer<typeof botTriggerTaskBindingSchema>;

export const botTriggerTaskBindingsFileSchema = z
  .object({
    version: z.literal(1),
    bindings: z.record(z.string(), botTriggerTaskBindingSchema),
  })
  .strict();
export type BotTriggerTaskBindingsFile = z.infer<typeof botTriggerTaskBindingsFileSchema>;

export interface BotTriggerTaskBindingStore {
  get(triggerId: string): Promise<BotTriggerTaskBinding | undefined>;
  set(triggerId: string, binding: BotTriggerTaskBinding): Promise<void>;
}

export class FileBotTriggerTaskBindingStore implements BotTriggerTaskBindingStore {
  private readonly path: string;

  /** `path` 仅供测试/显式注入；生产缺省落 `{appConfigDir}/bot-trigger-task-bindings.v1.json`。 */
  constructor(path?: string) {
    this.path = path ?? join(getAppConfigDir(), BOTS_TRIGGER_TASK_BINDINGS_FILE);
  }

  async get(triggerId: string): Promise<BotTriggerTaskBinding | undefined> {
    return withFileLock(this.path, async () => {
      const current = await this.readUnlocked();
      return current.bindings[triggerId];
    });
  }

  async set(triggerId: string, binding: BotTriggerTaskBinding): Promise<void> {
    await withFileLock(this.path, async () => {
      const current = await this.readUnlocked();
      current.bindings[triggerId] = binding;
      await atomicWritePrivateTextFile(this.path, `${JSON.stringify(current, null, 2)}\n`);
    });
  }

  private async readUnlocked(): Promise<BotTriggerTaskBindingsFile> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, bindings: {} };
    }
    // 解析失败不兜底：清空绑定会让同 trigger 重投建出第二个会话。
    return botTriggerTaskBindingsFileSchema.parse(JSON.parse(raw));
  }
}
