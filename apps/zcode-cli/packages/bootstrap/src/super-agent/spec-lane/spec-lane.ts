/**
 * super-agent-spec-lane 实现（M5 spec §4.2）：per-workspace egress 代理注册表。
 * 纯进程内状态——不发事件、不落持久化；宿主无关（不 import 宿主 API）。
 */
import {
  type PrepareSpecRunEgressRequest,
  type SpecRunEgressPlan,
  type SuperAgentSpecLaneContract,
} from "./contract.js";
import {
  normalizeSpecEgressAllowlist,
  startEgressProxy,
  type EgressProxyHandle,
} from "./egress-proxy.js";

export function createSuperAgentSpecLane(): SuperAgentSpecLaneContract {
  const running = new Map<string, EgressProxyHandle>();

  return {
    async prepareSpecRunEgress(
      request: PrepareSpecRunEgressRequest,
    ): Promise<SpecRunEgressPlan> {
      if (!request.workspaceRoot.trim()) {
        throw new Error("workspaceRoot 不能为空");
      }
      // allowHosts 形状校验先于停旧实例：配置损坏时旧代理保持在跑（不制造无代理窗口）。
      const allowHosts = normalizeSpecEgressAllowlist(request.allowHosts);

      const existing = running.get(request.workspaceRoot);
      if (existing) {
        running.delete(request.workspaceRoot);
        await existing.close();
      }

      const handle = await startEgressProxy({
        allowHosts,
        workspaceRoot: request.workspaceRoot,
        ...(request.port !== undefined ? { port: request.port } : {}),
      });
      running.set(request.workspaceRoot, handle);

      return {
        workspaceRoot: request.workspaceRoot,
        proxyUrl: handle.url,
        networkPolicy: { httpProxy: handle.url, noProxy: "" },
        allowHosts: handle.allowHosts.map((entry) =>
          entry.port === undefined ? entry.host : `${entry.host}:${entry.port}`,
        ),
      };
    },

    async stopSpecRunEgress(workspaceRoot: string): Promise<void> {
      const existing = running.get(workspaceRoot);
      if (!existing) return;
      running.delete(workspaceRoot);
      await existing.close();
    },
  };
}
