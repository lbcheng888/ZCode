/**
 * 把既有的 ExecutionPort 包装成“每条命令都在 OS 围栏内执行”。
 *
 * 只改执行请求里的 command（argv/shell 前缀），不改 env：env 代理继续作为
 * 纵深防御的协作层保留。生命周期方法原样委托给内层端口（receiver 保持内层
 * 实例，避免丢 this）。
 */
import type { ExecutionPort } from "@zcode/contracts";

import type { SpecFenceHandle } from "./contract.js";

export function createFencedExecutionPort(
  inner: ExecutionPort,
  fence: SpecFenceHandle,
): ExecutionPort {
  const wrapped: ExecutionPort = {
    run: (request, options) => inner.run(fence.wrapExecutionRequest(request), options),
  };
  if (inner.start) {
    wrapped.start = (request, options) =>
      inner.start!(fence.wrapExecutionRequest(request), options);
  }
  if (inner.getBackgroundTask) {
    wrapped.getBackgroundTask = (taskId) => inner.getBackgroundTask!(taskId);
  }
  if (inner.readBackgroundBashOutput) {
    wrapped.readBackgroundBashOutput = (taskId, sessionId) =>
      inner.readBackgroundBashOutput!(taskId, sessionId);
  }
  if (inner.cancelBackgroundTask) {
    wrapped.cancelBackgroundTask = (taskId) => inner.cancelBackgroundTask!(taskId);
  }
  if (inner.close) {
    wrapped.close = () => inner.close!();
  }
  return wrapped;
}
