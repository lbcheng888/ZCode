// 独立 CLI 的 long-horizon goal 灰度旗（--goal-layer）。
// 缺省 off：只有显式 on 才启用 idle 回合驱动器、三维预算、target_anchor、inject 车道、
// 目标状态 auto-drain 闸门与 5/5 todo 提醒；off 时逐项恢复旧行为。
// 与 --workflow-mode 的差别：本旗有用户配置键 features.goalLayer（默认 false），
// 供协议服务端 / 桌面端在不经过 CLI 参数时也默认关闭。

export type CliGoalLayerMode = "off" | "on";

export const DEFAULT_CLI_GOAL_LAYER: CliGoalLayerMode = "off";

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
 * (默认 false)，配置/环境变量才真正成为 CLI 的兜底；显式 on/off 则覆盖配置。
 */
export function resolveGoalLayerRuntimeConfig(mode: CliGoalLayerMode | undefined): {
  goalLayerEnabled?: boolean;
} {
  return mode === undefined ? {} : { goalLayerEnabled: mode === "on" };
}
