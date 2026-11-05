/**
 * 派发桥周期循环（B-SPEC §3.5 / §4.4；M7② exactly-once 的生产驱动端）。
 *
 * 组合根在 leader 接管后 `start()`、降级/停止时 `stop()`；每轮：
 * 1. `resumePendingAfterBoot` 推送 pending 行与 pushed 停滞行（同 commandId 重投）；
 * 2. `sweepSkipped(now, grace)` 把超过宽限仍未推的 in_window 行 CAS skipped。
 *
 * 单 plane 范围：单 child 多 plane 共用一个 tasks-index；桥实例按 plane 构造，
 * 扫描收窄到本 workspace，避免每个 plane 重复推他 plane 的行（CAS 只保证终态唯一，
 * 不阻止并发重复 push）。
 *
 * 本模块只做循环调度；状态机与 CAS 权威在 dispatchBridge.ts（不新造第二套）。
 * 循环间隔与宽限由调用方注入（生产缺省见下；测试可缩短）。
 */
import type { SuperAgentDispatchBridgeContract } from "./dispatchBridgePort.js";

/** 轮询间隔 20s：与 Core scheduler poll 同值——桥只在 Core 写 pending 后消费。 */
export const DISPATCH_LOOP_INTERVAL_MS = 20_000;
/** 宽限 5 分钟：与 scheduler misfire 宽限同值（in_window 超过即 skipped）。 */
export const DISPATCH_GRACE_MS = 5 * 60_000;

export interface DispatchLoopOptions {
  bridge: SuperAgentDispatchBridgeContract;
  workspaceIdentity: string;
  now: () => number;
  onError: (error: unknown, context: string) => void;
  intervalMs?: number;
  graceMs?: number;
}

export interface DispatchLoop {
  /** 接管即跑一轮并启动周期；可重复调用（幂等，含 follower→leader 重新接管）。 */
  start(): void;
  /** 暂停周期；可再次 start（leader 失而复得）；在途一轮自然收尾。 */
  stop(): void;
  /** 单轮（测试/诊断）；受单飞保护。 */
  runOnce(): Promise<void>;
}

export function createDispatchLoop(options: DispatchLoopOptions): DispatchLoop {
  const intervalMs = options.intervalMs ?? DISPATCH_LOOP_INTERVAL_MS;
  const graceMs = options.graceMs ?? DISPATCH_GRACE_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let active = false;

  async function runOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const timestamp = options.now();
      try {
        const result = await options.bridge.resumePendingAfterBoot({
          workspaceIdentity: options.workspaceIdentity,
        });
        // 推失败不吞：行保持 pushed 可续推，失败面按 A10 告警缝原样暴露。
        for (const failure of result.failures) {
          options.onError(
            new Error(`dispatch push 失败（requestId=${failure.requestId}）: ${failure.message}`),
            "super_agent.dispatch.push",
          );
        }
      } catch (error) {
        options.onError(error, "super_agent.dispatch.push");
      }
      try {
        // 先推后扫：宿主可达时行已转 pushed，不会被误结算；宿主不可达时行保持 pending，
        // 超宽限由本步 CAS skipped(no_dispatcher)（T3①）。
        const skipped = options.bridge.sweepSkipped(timestamp, graceMs, {
          workspaceIdentity: options.workspaceIdentity,
        });
        if (skipped > 0) {
          options.onError(
            new Error(
              `dispatch 宽限跳过 ${skipped} 行（workspace=${options.workspaceIdentity}）`,
            ),
            "super_agent.dispatch.sweep",
          );
        }
      } catch (error) {
        options.onError(error, "super_agent.dispatch.sweep");
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer !== undefined) clearInterval(timer);
      active = true;
      // 接管即跑一轮：kill 后重启的 pushed 停滞行要尽快续推。
      void runOnce();
      timer = setInterval(() => {
        if (active) void runOnce();
      }, intervalMs);
      // 不单独阻止宿主进程退出（进程生命周期即控制面生命周期）。
      timer.unref?.();
    },
    stop() {
      active = false;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    runOnce,
  };
}
