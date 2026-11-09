/**
 * cli-swarm 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { CliSwarmContract } from "./contract.js";

export function exampleCliSwarm(contract: CliSwarmContract): { readonly swarm?: boolean } {
  return contract.resolve(true);
}
