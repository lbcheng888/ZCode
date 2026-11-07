import { z } from "zod";

import { timestampSchema } from "./core.js";

/**
 * v4 快照 `backgroundRuns[]` 的行视图（有界读面）。
 *
 * kind/owner/state 与 bootstrap watchdog contract 的 `BackgroundRunKind` /
 * `BackgroundRunOwner` 同集：新增一类背景执行必须在两处同时登记，否则投影
 * 解析即失败（fail-closed，不把未知类别静默塞给 UI）。stallClockRef/heartbeat
 * 是 owner 内部调度语义，不进入 UI 投影。
 */
export const backgroundRunKindSchema = z.enum([
  "workflow",
  "automation",
  "offpeak",
  "background_task",
  "goal",
  "cheng-job",
]);
export type BackgroundRunViewKind = z.infer<typeof backgroundRunKindSchema>;

export const backgroundRunOwnerSchema = z.enum([
  "dynamic-workflow",
  "runtime-background-task",
  "automation",
  "offpeak",
  "goal",
  "cheng-host",
]);
export type BackgroundRunViewOwner = z.infer<typeof backgroundRunOwnerSchema>;

export const backgroundRunViewStateSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
  "killed",
  "lost",
  "dropped",
]);
export type BackgroundRunViewState = z.infer<typeof backgroundRunViewStateSchema>;

export const backgroundRunViewSchema = z
  .object({
    id: z.string(),
    kind: backgroundRunKindSchema,
    owner: backgroundRunOwnerSchema,
    state: backgroundRunViewStateSchema,
    ownerSession: z.string().optional(),
    workspaceKey: z.string().optional(),
    narrowResultRef: z.string().optional(),
    /** 终态原因；`host_restarted` 是启动对账写入，UI 不得把它渲染成业务失败。 */
    terminalReason: z.string().optional(),
    /** owner 投影的 run-stalled 时刻；在场 ⇒ UI 可标 stall。 */
    stalledSince: timestampSchema.optional(),
    registeredAt: timestampSchema,
    updatedAt: timestampSchema,
    terminalAt: timestampSchema.optional(),
  })
  .strict();
export type BackgroundRunView = z.infer<typeof backgroundRunViewSchema>;
