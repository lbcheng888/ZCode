/**
 * super-agent-watchdog 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 组合根（宿主进程内，里程碑 A）：建 registry → 绑投影端口给各 owner 钩子 →
 * 装配 command surface / 端口 → start。LLM 无进展裁决缺省不挂（flag OFF）。
 */
import type { SuperAgentWatchdogContract, WatchdogRepairCommandSurface } from "./contract.js";
import { createBackgroundRunProjectionPort } from "./composition.js";
import { BackgroundRunRegistry } from "./registry.js";
import { createSuperAgentWatchdog } from "./watchdog.js";

export function exampleSuperAgentWatchdog(commands: WatchdogRepairCommandSurface): void {
  const registry = new BackgroundRunRegistry(500);
  const watchdog = createSuperAgentWatchdog({ registry, commands });

  // 1) M8：把投影端口交给 owner 钩子（core setBackgroundRunProjection / services setter）。
  const projection = createBackgroundRunProjectionPort(registry);
  projection.register({
    id: "run-1",
    kind: "workflow",
    owner: "dynamic-workflow",
    stallClockRef: "dwf-run:run-1",
  });

  // 2) owner 原子回写终态（仅 owner；异 owner 会抛 BackgroundRunOwnershipError）。
  projection.settle("run-1", "dynamic-workflow", "completed", {
    narrowResultRef: "artifact://run-1/report.md",
  });

  // 3) 生命周期：start 起程序循环，stop 等在途 tick 收尾（宿主无关）。
  watchdog.start();
  void watchdog.stop();

  // 对外契约形状（测试与跨进程代理按此对齐）。
  const _contract: SuperAgentWatchdogContract = watchdog;
  void _contract;
}
