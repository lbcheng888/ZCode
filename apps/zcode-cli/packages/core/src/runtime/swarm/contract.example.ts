/**
 * swarm-runtime 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { SwarmRuntimeContract } from "./contract.js";

export async function exampleSwarmRuntime(contract: SwarmRuntimeContract): Promise<void> {
  await contract.runGoalRound("把目标拆成可并行的子任务并执行");
}
