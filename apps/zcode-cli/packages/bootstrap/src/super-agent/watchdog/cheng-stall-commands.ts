import { parseAutomationRunId } from "@zcode/shared";

import type { BackgroundRunRegistry } from "./registry.js";
import type { WatchdogRepairCommandSurface } from "./ports.js";

/** 生产 host 取消端口（结构 = ChengHostPort.cancel；避免 watchdog import app 层）。 */
export interface ChengJobCancelPort {
  cancel(jobId: string): Promise<"queued" | "running" | "succeeded" | "failed" | "cancelled">;
}

export interface ChengStallRepairCommandsDeps {
  readonly registry: BackgroundRunRegistry;
  readonly host: ChengJobCancelPort;
}

/**
 * 生产 cancel-stalled 命令面（S3）：watchdog 命中的 cheng-job 只会经本面执行。
 *
 * - 只接受 registry 中真实存在、kind=cheng-job 的行；其它 kind 响亮拒绝（本组合根只挂
 *   cheng registry，不对 workflow 冒充支持）。
 * - host.cancel 只有返回 `cancelled` 才算成功；queued/running = 取消请求在途，repair
 *   记失败并由下一轮重试，不虚报成功。
 * - pause-automation / notify / pause-goal 在本切片未接，返回显式 unsupported 错误。
 */
export function createChengStallRepairCommands(
  deps: ChengStallRepairCommandsDeps,
): WatchdogRepairCommandSurface {
  return {
    async cancelStalledRun(runId) {
      const row = deps.registry.get(runId);
      if (row === undefined) {
        return { ok: false, error: `cancel-stalled 目标行不存在：${runId}` };
      }
      if (row.kind !== "cheng-job") {
        return { ok: false, error: `cancel-stalled 只支持 cheng-job，收到 ${row.kind}: ${runId}` };
      }
      try {
        const state = await deps.host.cancel(runId);
        return state === "cancelled"
          ? { ok: true }
          : { ok: false, error: `host cancel 未确认终态：${state}` };
      } catch (error) {
        return {
          ok: false,
          error: `host cancel 失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    async pauseWorkspaceAutomation() {
      return { ok: false, error: "pause-automation 未接入（S3 当前仅 cheng cancel-stalled）" };
    },
    async notifyUser() {
      return { ok: false, error: "notify-user 未接入（S3 当前仅 cheng cancel-stalled）" };
    },
    async pauseGoal() {
      return { ok: false, error: "pause-goal 未接入（S3 当前仅 cheng cancel-stalled）" };
    },
  };
}

/** 生产 workflow run 取消端口（结构 = DynamicWorkflowRunService.cancel）。 */
export interface WorkflowRunCancelPort {
  /** true = 已向在途 run 发 abort；终态仍由 run owner 回写。 */
  cancel(
    runId: string,
    context?: { workspaceKey?: string; ownerSession?: string },
  ): Promise<boolean>;
}

/** 生产 automation 条件暂停端口（结构 = AutomationPort.pause）。 */
export interface AutomationPausePort {
  pause(input: { id: string }, context?: { workspaceKey?: string }): Promise<boolean>;
}

/** notify-user 端口的显式失败形状；boolean 仍兼容既有调用方。 */
export type NotifyUserResult = boolean | { ok: boolean; error?: string };

export interface StallRepairCommandsDeps {
  readonly registry: BackgroundRunRegistry;
  /** cheng-job 行取消端口；缺席 = cheng cancel 能力未接。 */
  readonly chengHost?: ChengJobCancelPort;
  /** workflow 行取消端口；缺席 = workflow cancel 能力未接。 */
  readonly workflowRun?: WorkflowRunCancelPort;
  /** automation 行暂停端口；缺席 = pause-automation 能力未接。 */
  readonly automation?: AutomationPausePort;
  /**
   * notify-user 的真实投递端口（生产 = runtime task-notification 队列）。
   * 返回 true 才表示已入队；无能力时返回 `{ok:false,error}` 且 reason 原样带回；
   * 缺席/拒绝/异常都响亮失败。命令面不改 registry 行状态。
   */
  readonly notify?: (
    message: string,
    context?: { ownerSession?: string; workspaceKey?: string },
  ) => Promise<NotifyUserResult> | NotifyUserResult;
  /**
   * pause-goal 的升级信道（生产 = sessionStore 暂停当前 target + 中止在途前台执行）。
   * true 才表示目标已处于 paused；缺席/目标不匹配/不可暂停/异常都失败。
   */
  readonly pauseGoal?: (goalId: string) => Promise<boolean> | boolean;
}

/**
 * 生产 stall 修复命令面（S3）：同一 watchdog registry 上的 cheng-job / workflow 行
 * 按 kind 分派到各自 owner 的取消端口。命令面不改 registry 行状态——终态由 owner
 * 回写；cancel 只确认“abort 已发出/终态已确认”。未接端口响亮失败，不虚报成功。
 */
export function createStallRepairCommands(
  deps: StallRepairCommandsDeps,
): WatchdogRepairCommandSurface {
  return {
    async cancelStalledRun(runId) {
      const row = deps.registry.get(runId);
      if (row === undefined) {
        return { ok: false, error: `cancel-stalled 目标行不存在：${runId}` };
      }
      if (row.kind === "cheng-job") {
        if (deps.chengHost === undefined) {
          return { ok: false, error: `cancel-stalled 未接入 cheng-host cancel 端口：${runId}` };
        }
        try {
          const state = await deps.chengHost.cancel(runId);
          return state === "cancelled"
            ? { ok: true }
            : { ok: false, error: `host cancel 未确认终态：${state}` };
        } catch (error) {
          return {
            ok: false,
            error: `host cancel 失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      if (row.kind === "workflow") {
        if (deps.workflowRun === undefined) {
          return { ok: false, error: `cancel-stalled 未接入 workflow cancel 端口：${runId}` };
        }
        try {
          const accepted = await deps.workflowRun.cancel(runId, {
            ...(row.workspaceKey === undefined ? {} : { workspaceKey: row.workspaceKey }),
            ...(row.ownerSession === undefined ? {} : { ownerSession: row.ownerSession }),
          });
          return accepted
            ? { ok: true }
            : { ok: false, error: `workflow cancel 未确认在途 run：${runId}` };
        } catch (error) {
          return {
            ok: false,
            error: `workflow cancel 失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      return { ok: false, error: `cancel-stalled 不支持行类型 ${row.kind}: ${runId}` };
    },
    async pauseWorkspaceAutomation(workspaceKey, automationRunId) {
      if (deps.automation === undefined) {
        return { ok: false, error: "pause-automation 未接入 automation 端口" };
      }
      if (automationRunId === undefined) {
        return { ok: false, error: "pause-automation 拒绝：目标缺 automation runId" };
      }
      const row = deps.registry.get(automationRunId);
      if (row === undefined) {
        return { ok: false, error: `pause-automation 目标行不存在：${automationRunId}` };
      }
      if (row.kind !== "automation") {
        return {
          ok: false,
          error: `pause-automation 不支持行类型 ${row.kind}: ${automationRunId}`,
        };
      }
      if (row.workspaceKey !== undefined && row.workspaceKey !== workspaceKey) {
        return {
          ok: false,
          error: `pause-automation workspaceKey 不匹配：${workspaceKey} != ${row.workspaceKey}`,
        };
      }
      const parsed = parseAutomationRunId(automationRunId);
      if (parsed === null) {
        return { ok: false, error: `pause-automation 无法解析 automation runId：${automationRunId}` };
      }
      try {
        const paused = await deps.automation.pause({ id: parsed.automationId }, { workspaceKey });
        return paused
          ? { ok: true }
          : {
              ok: false,
              error: `automation pause 未生效（非 active/不存在）：${parsed.automationId}`,
            };
      } catch (error) {
        return {
          ok: false,
          error: `automation pause 失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    async notifyUser(message, context) {
      if (deps.notify === undefined) {
        return { ok: false, error: "notify-user 未接入通知端口" };
      }
      try {
        const result = await deps.notify(message, context);
        if (typeof result === "boolean") {
          return result ? { ok: true } : { ok: false, error: "notify-user 未确认入队" };
        }
        return result.ok
          ? { ok: true }
          : { ok: false, error: result.error ?? "notify-user 未确认入队" };
      } catch (error) {
        return {
          ok: false,
          error: `notify-user 失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    async pauseGoal(goalId) {
      if (deps.pauseGoal === undefined) {
        return { ok: false, error: "pause-goal 未接入目标暂停端口" };
      }
      try {
        const paused = await deps.pauseGoal(goalId);
        return paused
          ? { ok: true }
          : { ok: false, error: `pause-goal 未生效：${goalId}` };
      } catch (error) {
        return {
          ok: false,
          error: `pause-goal 失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
