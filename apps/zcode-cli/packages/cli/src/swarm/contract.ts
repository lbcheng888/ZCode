/**
 * cli-swarm 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * CLI 只做灰度旗到 runtime 配置的窄转换；蜂群是否真正执行仍由 Host/目标层裁决。
 */
export interface SwarmCliConfig {
  /** 显式会话级灰度；缺席 = 不写字段，由 Host/协议决定（fail-closed）。 */
  readonly swarm?: boolean;
}

export interface CliSwarmContract {
  /** 前置：仅在 --prompt / --target / tui 作用域调用；undefined 返回空对象。 */
  resolve(value: boolean | undefined): SwarmCliConfig;
}
