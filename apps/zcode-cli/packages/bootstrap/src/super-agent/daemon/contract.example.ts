/**
 * super-agent-daemon 标准调用示例：入口装配顺序（spec §2.2）。
 */
import type { ControlPlaneRpcRequestHandler } from "./contract.js";
import {
  createControlPlanePeerGuard,
  createControlPlaneRpcServer,
  createLazyAdjudicationSession,
  createEnvironmentAdjudicationSessionAssembly,
  DaemonPlaneManager,
} from "./contract.js";

export function exampleDaemonAssembly(deps: {
  endpoint: string;
  authToken: string;
  trustedPids: number[];
  handler: ControlPlaneRpcRequestHandler;
  database: ConstructorParameters<typeof DaemonPlaneManager>[0]["database"];
  dataBaseDir: string;
  env: Record<string, string | undefined>;
  abortSignal: AbortSignal;
}): void {
  // 裁决会话惰性装配：首个裁决批才启动 Provider Registry（Core 物化 Built-in 前
  // child 可能已 ready）；不可用即 typed 失败，候选留 pending。
  const adjudication = createLazyAdjudicationSession({
    abortSignal: deps.abortSignal,
    createAssembly: ({ abortSignal }) =>
      createEnvironmentAdjudicationSessionAssembly({
        env: deps.env,
        dataBaseDir: deps.dataBaseDir,
        abortSignal,
        onUnavailable: () => undefined,
      }),
  });
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
    dataBaseDir: deps.dataBaseDir,
    serverRoot: "/srv",
    database: deps.database,
    adjudicationSession: adjudication.session,
    mandateGate: false,
    onPlaneError: () => undefined,
  });
  void adjudication.dispose;
}
