/**
 * super-agent-daemon 标准调用示例：入口装配顺序（spec §2.2）。
 */
import type { ControlPlaneRpcRequestHandler } from "./contract.js";
import { createControlPlanePeerGuard, createControlPlaneRpcServer, DaemonPlaneManager } from "./contract.js";

export function exampleDaemonAssembly(deps: {
  endpoint: string;
  authToken: string;
  trustedPids: number[];
  handler: ControlPlaneRpcRequestHandler;
  database: ConstructorParameters<typeof DaemonPlaneManager>[0]["database"];
  adjudicationSession: ConstructorParameters<typeof DaemonPlaneManager>[0]["adjudicationSession"];
}): void {
  const guard = createControlPlanePeerGuard({
    trustedPids: [...deps.trustedPids, process.ppid],
  });
  void guard;
  void createControlPlaneRpcServer({
    endpoint: deps.endpoint,
    authToken: deps.authToken,
    handler: deps.handler,
  });
  void new DaemonPlaneManager({
    dataBaseDir: "/data",
    serverRoot: "/srv",
    database: deps.database,
    adjudicationSession: deps.adjudicationSession,
    mandateGate: false,
    onPlaneError: () => undefined,
  });
}
