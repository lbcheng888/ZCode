/**
 * 真实子进程 fixture：走**真实 CLI 入口** `runSuperAgentControlPlaneCommand`，
 * 由 env 决定 authToken / peer 模式（不是测试直连 startControlPlaneDaemon）。
 * 仅测试使用。
 */
import { runSuperAgentControlPlaneCommand } from "../../../src/app/super-agent-daemon-entry.js";

void (async () => {
  const code = await runSuperAgentControlPlaneCommand({
    argv: [],
    env: process.env,
    onError: (error, context) => {
      process.send?.({
        type: "test-error",
        context,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  process.exit(code);
})();
