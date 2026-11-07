import type { DatabaseSync } from "node:sqlite";

import { ChengJobRegistryOwner } from "../cheng-job-registry.js";
import { SqliteBackgroundRunStore } from "../storage/background-run-store.js";
import { BackgroundRunRegistry } from "../watchdog/registry.js";

/** daemon 启动只对“超过 30s 未心跳”的 running 行做失败收口，避免误杀仍存活的 job。 */
export const CHENG_DAEMON_RECONCILE_STALE_MS = 30_000;

export interface DaemonChengReconcileResult {
  failed: number;
  suppressed: number;
}

/**
 * daemon 启动对账：只把 stale running cheng-job 标 `failed(host_restarted)`，不投递通知
 * （daemon 没有会话 runtime/会话库）。终态未认领的补投留给会话 app 的
 * `reconcileAfterRestart`；`terminalReason=host_restarted` 保证它不会被补投。
 */
export function reconcileChengJobsOnDaemonStartup(
  db: DatabaseSync,
  options: { staleAfterMs?: number; now?: number } = {},
): DaemonChengReconcileResult {
  const store = new SqliteBackgroundRunStore(db);
  const registry = new BackgroundRunRegistry(500, store);
  registry.hydrate(store.loadAll());
  const owner = new ChengJobRegistryOwner({ registry });
  return owner.reconcileRunningAfterRestart({
    staleAfterMs: options.staleAfterMs ?? CHENG_DAEMON_RECONCILE_STALE_MS,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
