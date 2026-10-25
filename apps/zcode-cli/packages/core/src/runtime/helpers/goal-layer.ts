import type { AgentRuntimeConfig } from "../types.js";

/**
 * long-horizon goal 灰度旗的唯一读数点：只有显式 true 才启用新行为。
 * 缺席 = 关闭（与 dynamicWorkflowEnabled 的「缺席即开启」刻意相反），
 * 因此嵌入方 / 旧 Host 不下发该字段时自动落回旧行为。
 */
export function isGoalLayerEnabled(
  config: Pick<AgentRuntimeConfig, "goalLayerEnabled">,
): boolean {
  return config.goalLayerEnabled === true;
}
