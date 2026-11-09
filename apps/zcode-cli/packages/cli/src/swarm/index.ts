// 独立 CLI 的蜂群执行灰度旗（--swarm）。
// 只接受会话级显式开关：作用域与 --goal-layer 相同（--prompt / --target / tui）。
// 用户配置文件没有同名键——蜂群是会话级灰度，避免普通配置意外开启。

export const SWARM_SCOPE_ERROR = "--swarm can only be used with --prompt, --target, or tui.";

/**
 * 未传 --swarm 时**不写**该字段：让 Host / 协议决定会话级灰度（缺席即关，fail-closed）。
 * 显式 true/false 则原样写入，由装配层透传给 runtime。
 */
export function resolveSwarmRuntimeConfig(value: boolean | undefined): { swarm?: boolean } {
  return value === undefined ? {} : { swarm: value };
}
