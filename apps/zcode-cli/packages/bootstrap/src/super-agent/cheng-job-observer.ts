import { ChengJobRegistryOwner } from "./cheng-job-registry.js";
import type {
  ChengJobGateVerdict,
  ChengJobNotificationLedger,
  ChengJobTerminal,
} from "./cheng-job-registry.js";
import type { BackgroundRunRegistry } from "./watchdog/registry.js";

/**
 * owner-scoped 结构绑定（S4 内化）：本会话发起的 job 终态 succeeded 时，把当前 goal 的
 * chengRef 自动指向该 job。不是 recency 推断——owner 维度是 registry 行的结构事实；
 * 权威规则：绝不覆盖用户显式设置过的绑定（见 create-app 的 autoBound 守卫）。
 */
export interface ChengJobAutoBindPort {
  onOwnJobSucceeded(input: { jobId: string; task: string; runId?: string }): Promise<void>;
}

/** host 端口的 job 生命周期投影；由 `generate` 在真实 host 事件上调用。 */
export interface ChengJobObserver {
  started(input: { jobId: string; runId?: string; task?: string }): void;
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
  /** S4 内化：本会话成功 job → goal 自动绑定端口；缺席 = 自动绑定未接线。 */
  readonly autoBind?: ChengJobAutoBindPort;
}

/**
 * 生产观察者：把 host 的 job 生命周期写成 `kind=cheng-job` 的 registry 行，并在终态走
 * claim-first 通知。映射：succeeded→completed、failed→failed、cancelled→cancelled；
 * 其余状态（queued/running）只 progress/touch。
 */
export function createChengJobObserver(input: CreateChengJobObserverInput): LiveChengJobObserver {
  const owner = new ChengJobRegistryOwner({
    registry: input.registry,
    ledger: input.ledger,
  });
  // job→task 进程内映射：绑定器需要 task（GoalChengRef 必填）。会话重启丢映射时
  // 终态自动绑定按缺 task 跳过（不猜），显式绑定路径不受影响。
  const taskByJob = new Map<string, string>();
  return {
    owner,
    started({ jobId, task }) {
      if (task !== undefined) taskByJob.set(jobId, task);
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
      const terminalState: ChengJobTerminal = state === "succeeded" ? "completed" : state;
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
      // S4 内化：仅本会话（观察者按 owner session 构造）且 succeeded 且 task 已知时触发；
      // 端口失败不吞 job 终态——绑定失败记日志，主流程已收口。
      if (state === "succeeded" && input.autoBind !== undefined) {
        const task = taskByJob.get(jobId);
        if (task === undefined) return;
        try {
          await input.autoBind.onOwnJobSucceeded({
            jobId,
            task,
            ...(runId === undefined ? {} : { runId }),
          });
        } catch {
          // 自动绑定是增强，不改变 job 生命周期结果。
        }
      }
    },
  };
}
