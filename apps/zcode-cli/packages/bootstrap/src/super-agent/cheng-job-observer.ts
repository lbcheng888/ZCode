import { ChengJobRegistryOwner } from "./cheng-job-registry.js";
import type {
  ChengJobGateVerdict,
  ChengJobNotificationLedger,
  ChengJobTerminal,
} from "./cheng-job-registry.js";
import type { BackgroundRunRegistry } from "./watchdog/registry.js";

/** host 端口的 job 生命周期投影；由 `generate` 在真实 host 事件上调用。 */
export interface ChengJobObserver {
  started(input: { jobId: string; runId?: string }): void;
  progress(input: { jobId: string }): void;
  terminal(input: {
    jobId: string;
    state: "succeeded" | "failed" | "cancelled";
    runId?: string;
  }): void | Promise<void>;
}

export interface LiveChengJobObserver extends ChengJobObserver {
  readonly owner: ChengJobRegistryOwner;
}

export interface CreateChengJobObserverInput {
  readonly registry: BackgroundRunRegistry;
  readonly ledger: ChengJobNotificationLedger;
  readonly ownerSession: string;
  readonly workspaceKey: string;
  /**
   * 产出后 gate 解析（生产接 host verify）。红 gate 时终态通知静默丢弃；
   * 缺席 = 不做产出后 gate 评估（旧 host/测试路径）。
   */
  readonly resolveGate?: (input: {
    jobId: string;
    runId?: string;
  }) => Promise<ChengJobGateVerdict | undefined>;
}

/**
 * 生产观察者：把 host 的 job 生命周期写成 `kind=cheng-job` 的 registry 行，并在终态走
 * claim-first 通知。映射：succeeded→completed、failed→failed、cancelled→cancelled；
 * 其余状态（queued/running）只 progress/touch。
 */
export function createChengJobObserver(
  input: CreateChengJobObserverInput,
): LiveChengJobObserver {
  const owner = new ChengJobRegistryOwner({
    registry: input.registry,
    ledger: input.ledger,
  });
  return {
    owner,
    started({ jobId }) {
      owner.register({
        jobId,
        ownerSession: input.ownerSession,
        workspaceKey: input.workspaceKey,
      });
    },
    progress({ jobId }) {
      owner.touch(jobId, input.ownerSession);
    },
    async terminal({ jobId, state, runId }) {
      const terminalState: ChengJobTerminal =
        state === "succeeded" ? "completed" : state;
      // 产出后 delivery gate：只有 succeeded 的 run 可评估；红 gate 静默丢弃通知。
      const gate =
        state === "succeeded" && input.resolveGate
          ? await input.resolveGate({
              jobId,
              ...(runId === undefined ? {} : { runId }),
            })
          : undefined;
      await owner.terminal({
        jobId,
        state: terminalState,
        ...(runId === undefined ? {} : { runId }),
        ...(gate === undefined ? {} : { gate }),
        gateLevel: gate?.level === "PRODUCTION" ? "PRODUCTION" : "DIAGNOSTIC_NOT_ACCEPTANCE",
      });
    },
  };
}
