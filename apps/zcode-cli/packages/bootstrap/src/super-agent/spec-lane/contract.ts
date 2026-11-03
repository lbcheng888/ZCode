/**
 * super-agent-spec-lane 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 *
 * 实施规格：docs/architecture/super-agent-spec-lane-spec.md（M5 受限 profile +
 * 结构隔离 + 协作式 egress 代理；env 级代理可被 --noproxy 类客户端绕过，残留见 spec §8-6）。
 */
export type SuperAgentSpecLaneId = string & { readonly __brand: "SuperAgentSpecLaneId" };

/** 注入执行适配器的网络策略形状；noProxy 恒为空串——spec run 不设 NO_PROXY（spec §3）。 */
export interface SpecRunNetworkPolicy {
  httpProxy: string;
  noProxy: "";
}

/** prepare 的产物：dispatcher 拿它接执行适配器（processEnv + network）与代理生命周期。 */
export interface SpecRunEgressPlan {
  /** 代理归属的 workspace（per-workspace 注册表键）。 */
  workspaceRoot: string;
  /** 本地 egress 代理地址，如 http://127.0.0.1:12345。 */
  proxyUrl: string;
  /** 传给 createNodeExecutionAdapter({ network }) 的策略；与 buildSpecRunEnv 同源。 */
  networkPolicy: SpecRunNetworkPolicy;
  /** 生效的 allowlist（host 或 host:port，已归一化）。空数组 = 零 egress。 */
  allowHosts: readonly string[];
}

export interface PrepareSpecRunEgressRequest {
  /** 代理归属的 workspace；同 workspace 再次 prepare = 先停旧实例再起新实例。 */
  workspaceRoot: string;
  /**
   * per-repo 依赖镜像白名单（spec §4.3：如 ["registry.npmjs.org", "pypi.org"]）。
   * 缺省 [] = 零 egress（一切转发被拒）。条目必须是 "host" 或 "host:port" 字符串，
   * 非字符串/空串条目抛错（配置损坏必须暴露，不静默丢弃，见 normalizeSpecEgressAllowlist）。
   */
  allowHosts?: readonly string[];
  /** 监听端口；缺省 0（临时端口）。仅测试与受控宿主使用。 */
  port?: number;
}

/**
 * egress 代理启动失败（端口占用、listen 错误等）。
 * fail-closed：抛出即 spec run 拒绝启动，任何路径都不回退直连（spec §0 硬不变量）。
 */
export class SpecEgressStartupError extends Error {
  readonly code = "spec_egress_startup_failed";
  constructor(
    readonly workspaceRoot: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`spec egress 代理启动失败（run 拒绝启动）: ${message}`, options);
    this.name = "SpecEgressStartupError";
  }
}

/**
 * super-agent-spec-lane 对外契约（一个意图一个方法）。
 * 代理随 spec run 同生命周期（不进 daemon；迁 daemon 只动组合根，契约不变，spec §8-4）。
 * 不发事件、不落持久化：本模块只持有进程内 per-workspace 注册表。
 */
export interface SuperAgentSpecLaneContract {
  /**
   * (re)启动某 workspace 的 egress 代理。
   * 前置：workspaceRoot 非空；allowHosts（若给）已通过 normalizeSpecEgressAllowlist 形状校验。
   * 后置：该 workspace 有且仅有一个监听中的代理（同 workspace 旧实例先停后起）；
   * 返回 networkPolicy 与 proxyUrl 同源，可直接接执行适配器。
   * 幂等：按 workspace 覆盖式——重复 prepare 是替换，不是叠加。listen 失败抛
   * SpecEgressStartupError（不静默降级）。不发事件，不等待持久化。
   */
  prepareSpecRunEgress(request: PrepareSpecRunEgressRequest): Promise<SpecRunEgressPlan>;

  /**
   * 停止并清理某 workspace 的代理。
   * 前置：无（缺席即 no-op）。后置：该 workspace 无监听中的代理。
   * 幂等：重复 stop 是 no-op。不发事件，不等待持久化。
   */
  stopSpecRunEgress(workspaceRoot: string): Promise<void>;
}
