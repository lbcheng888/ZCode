// 独立 CLI 的 long-horizon goal 旗（--goal-layer）。
// 已转正（设计 M11 / Phase 1）：缺省 on——idle 回合驱动器、三维预算、target_anchor、
// inject 车道、目标状态 auto-drain 闸门与 5/5 todo 提醒默认启用。显式 off 仍可关闭，
// 关闭世界被削减到剩余语义（无 idle 驱动器、无三维预算，但 inject 车道恒可用、
// 旧忙碌循环已删除）。与 --workflow-mode 的差别：本旗有用户配置键 features.goalLayer
//（默认 true），供协议服务端 / 桌面端在不经过 CLI 参数时也默认开启。

export type CliGoalLayerMode = "off" | "on";

export const DEFAULT_CLI_GOAL_LAYER: CliGoalLayerMode = "on";

export const GOAL_LAYER_SCOPE_ERROR =
  "--goal-layer can only be used with --prompt, --target, or tui.";

/** 非法值抛错，由入口层格式化；缺省值不在这里补，入口层据此区分「未传」做作用域检查。 */
export function normalizeGoalLayerOption(
  value: string | undefined,
): CliGoalLayerMode | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "on" || normalized === "off") return normalized;
  throw new Error(`Unsupported --goal-layer value: ${value}. Supported values: on, off.`);
}

/**
 * 未传 --goal-layer 时**不写**该字段：让 bootstrap 回落 features.goalLayer
 * (默认 true)，配置/环境变量才真正成为 CLI 的兜底；显式 on/off 则覆盖配置。
 */
export function resolveGoalLayerRuntimeConfig(mode: CliGoalLayerMode | undefined): {
  goalLayerEnabled?: boolean;
} {
  return mode === undefined ? {} : { goalLayerEnabled: mode === "on" };
}
