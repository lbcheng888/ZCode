import { WorkflowError } from "@zcode/dynamic-workflow";

import type { ChengHostPort } from "./workflow-cheng-world-read.js";

export interface ScopedChengHostPort {
  /** 只暴露本 run 生命周期的端口（generate/inspect/verify/graph/cancel）。 */
  readonly port: ChengHostPort;
  /** 取消本 run 自己的在途 job（不碰其他 run 的 host job）。 */
  cancelActive(): Promise<number>;
  activeJobIds(): string[];
  /** 保留 API 兼容；active 归属已不依赖 base 广播，无需退订。 */
  dispose(): void;
}

/**
 * run-scoped 端口：共享同一个 host 连接，但只跟踪/取消**本 run** 启动的 job。
 * workflow run 取消时，driver.dispose 调 `cancelActive` 即可精确停掉自己的 host job。
 *
 * 归属来自本端口 `generate` 收到的 `onStarted(jobId)`，**不是** base 端口的全局
 * `onJobLifecycle` 广播：同一会话并发 run 时，广播会把别的 run 的 job 灌进本 run 的
 * active 集合，导致 dispose 误 cancel 别人的 job。
 */
export function createScopedChengHostPort(base: ChengHostPort): ScopedChengHostPort {
  const active = new Set<string>();
  // run 已结算后，迟到的 generate 仍可能返回 jobId；没有这道栅栏，它会在
  // cancelActive 快照之后才进入 active，永远不会被取消。
  let closed = false;
  let lateCancelError: unknown;

  const port: ChengHostPort = {
    async generate(input, onStarted) {
      let ownJobId: string | undefined;
      try {
        const result = await base.generate(input, (jobId) => {
          if (closed) {
            // run 已经 dispose：不再登记为 active，立即取消这个迟到 job。
            void base.cancel(jobId).catch((error: unknown) => {
              lateCancelError = error;
            });
            return;
          }
          active.add(jobId);
          ownJobId = jobId;
          onStarted?.(jobId);
        });
        if (lateCancelError !== undefined) {
          throw lateCancelError;
        }
        return result;
      } finally {
        // resolve / reject 都算结束；未 started 就没有归属可删。
        if (ownJobId !== undefined) {
          active.delete(ownJobId);
        }
      }
    },
    inspect: (jobId) => base.inspect(jobId),
    verify: (jobId) => base.verify(jobId),
    plan: (jobId, task) => base.plan(jobId, task),
    graph: (jobId, task, view) => base.graph(jobId, task, view),
    async cancel(jobId) {
      active.delete(jobId);
      return base.cancel(jobId);
    },
    async cancelActive() {
      closed = true;
      const ids = [...active];
      const results = await Promise.allSettled(ids.map((jobId) => base.cancel(jobId)));
      const failed: string[] = [];
      ids.forEach((jobId, index) => {
        if (results[index]?.status === "rejected") {
          // host 取消失败时 job 可能仍在跑；保留在 active 里，不假装已取消。
          failed.push(jobId);
        } else {
          active.delete(jobId);
        }
      });
      if (failed.length > 0) {
        throw new WorkflowError(
          "DriverError",
          `Failed to cancel Cheng jobs: ${failed.join(",")}`,
        );
      }
      return ids.length;
    },
    onJobLifecycle: (listener) => base.onJobLifecycle(listener),
  };

  return {
    port,
    cancelActive: () => port.cancelActive(),
    activeJobIds: () => [...active],
    dispose: () => {
      closed = true;
    },
  };
}
