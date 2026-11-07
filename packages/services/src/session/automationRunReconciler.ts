import {
  AUTOMATION_RUN_STALE_MS,
  STALE_AUTOMATION_RUN_REASON,
  type AutomationRepo,
  type StaleAutomationRun,
} from "./automationRepo.js";
import type { AutomationRunProjectionSqlite } from "./automationRunProjection.js";

export interface ReconcileStaleAutomationRunsOptions {
  repo: Pick<AutomationRepo, "reconcileStaleRuns">;
  projection?: Pick<AutomationRunProjectionSqlite, "settle">;
  now?: number;
  staleAfterMs?: number;
  reason?: string;
}

/**
 * scheduler claim 后 host 未回写终态的投影收口：台账已由 repo 事务置 failed，
 * 再把同 id 的 registry automation 行 settle 为 failed（不写 completed）。
 * 行不存在 = no-op；调用方负责在启动与周期 tick 执行并上报计数。
 */
export async function reconcileStaleAutomationRuns(
  options: ReconcileStaleAutomationRunsOptions,
): Promise<StaleAutomationRun[]> {
  const normalizedNow = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? AUTOMATION_RUN_STALE_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error(`Invalid staleAfterMs: ${String(staleAfterMs)}`);
  }
  const reconciled = await options.repo.reconcileStaleRuns({
    now: normalizedNow,
    staleAfterMs,
    reason: options.reason ?? STALE_AUTOMATION_RUN_REASON,
  });
  for (const run of reconciled) {
    options.projection?.settle(run.runId, "automation", "failed");
  }
  return reconciled;
}
