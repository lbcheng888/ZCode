import { describe, expect, it } from "vitest";

import { superAgentDaemonModule } from "./module.js";
import {
  CONTROL_PLANE_ENDPOINT_PROBE_TIMEOUT_MS,
  CONTROL_PLANE_TRUSTED_PIDS_ENV,
  DaemonPlaneManager,
  TASKS_INDEX_RELATIVE_PATH,
  createControlPlanePeerGuard,
  createControlPlaneRpcServer,
  parseTrustedPids,
  resolveTasksIndexDatabasePath,
} from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("super-agent-daemon contract", () => {
  it("declares its module manifest", () => {
    expect(superAgentDaemonModule.id).toBe("super-agent-daemon");
  });

  it("exports the daemon host surface", () => {
    expect(typeof createControlPlanePeerGuard).toBe("function");
    expect(typeof createControlPlaneRpcServer).toBe("function");
    expect(typeof DaemonPlaneManager).toBe("function");
    expect(typeof parseTrustedPids).toBe("function");
    expect(typeof resolveTasksIndexDatabasePath).toBe("function");
  });

  it("keeps the trusted-pids env and endpoint budget stable", () => {
    expect(CONTROL_PLANE_TRUSTED_PIDS_ENV).toBe("ZCODE_CONTROL_PLANE_TRUSTED_PIDS");
    expect(CONTROL_PLANE_ENDPOINT_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TASKS_INDEX_RELATIVE_PATH).toContain("tasks-index.sqlite");
  });
});
