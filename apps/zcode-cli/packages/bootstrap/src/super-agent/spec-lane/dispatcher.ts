/**
 * M5 spec run dispatcher（spec-lane spec §6-1：mandate/触发 lane 拥有）。
 * 触发档位为 speculative/auto 且 verdict accept 后，由程序按固定顺序启动受限 run：
 *   1. prepareSpecRunEgress → plan（无代理则拒绝启动）；
 *   2. buildSpecRestrictedProfile() → 受限 profile（工具面/权限模式结构固定）；
 *   3. fence.prepare → per-run OS egress 围栏（可选；启用时失败即拒绝启动，
 *      spec §3.4 顺序：代理之后、命令执行之前）；
 *   4. 以 fence.childBroker 改写代理端点（Linux = veth relay）→ buildProcessEnv →
 *      无凭据子进程 env（生产 = adapters buildSpecRunEnv；接线缝见 spec §6-4）；
 *   5. launch → **subagent run**（Phase 3 唯一合法形态；workflow 形态在 profile /
 *      processEnv 接线前禁止启动，本端口不提供 workflow 形态）；
 *   6. run 终态后 teardown 围栏、stopSpecRunEgress。
 *
 * 失败模型：任一步失败原样上抛（dispatcher 不吞、不降级直连）；applyVerdicts 的
 * 异步阶段经 onError 告警。缺 proxyUrl / env 未携带代理 / profile 被削弱 /
 * 围栏不可用 = 拒绝启动。
 */
import { buildSpecRestrictedProfile, SPEC_RESTRICTED_PROFILE_NAME } from "@zcode/core";
import type { AgentProfile } from "@zcode/shared";

import type {
  SpecRunEgressPlan,
  SpecRunNetworkPolicy,
  SuperAgentSpecLaneContract,
} from "./contract.js";
import type { SpecFenceContract, SpecFenceHandle } from "./fence/index.js";

/** dispatcher 启动载荷（结构 = trigger.TriggerSpecRunInput 子集，不 import 兄弟模块）。 */
export interface SpecRunDispatchInput {
  triggerId: string;
  workspaceIdentity: string;
  threadKey: string;
  source: string;
  tier: "speculative" | "auto";
  reason?: string;
  evidence?: readonly string[];
  card?: {
    currentEvidence: string;
    candidateOptions: readonly { option: string; cost: string }[];
    recommendation: string;
    impact: string;
    verification: string;
  };
}

/** subagent run 启动端口：组合根把既有 subagent 启动路径包成该形状（spec §6-1）。 */
export interface SpecRunLaunchPort {
  launch(request: SpecRunLaunchRequest): Promise<{ runId: string }>;
}

export interface SpecRunLaunchRequest {
  workspaceRoot: string;
  /** Phase 3 唯一合法形态；workflow 形态须等 profile/processEnv 接线后才能启用。 */
  form: "subagent";
  profile: AgentProfile;
  /** 无凭据 env（buildProcessEnv 产出；必须携带 egress 代理变量）。 */
  processEnv: Record<string, string>;
  /** 与 buildProcessEnv 同源；接执行适配器（createNodeExecutionAdapter({ network })）。 */
  network: SpecRunNetworkPolicy;
  /** 本次 run 已建立的 OS 围栏句柄；未启用围栏时缺省（现状协作式代理）。 */
  fence?: SpecFenceHandle;
  prompt: string;
  trigger: SpecRunDispatchInput;
}

export interface SpecRunDispatcherDeps {
  egress: SuperAgentSpecLaneContract;
  /** 生产 = adapters buildSpecRunEnv({ proxyUrl })；接线缝经组合根注入（spec §6-4）。 */
  buildProcessEnv: (plan: SpecRunEgressPlan) => Record<string, string>;
  /** subagent 启动路径适配器（宿主注入）。 */
  launch: SpecRunLaunchPort;
  /** trigger workspaceIdentity → 真实 workspace 根目录（egress 注册表键）。 */
  resolveWorkspaceRoot: (input: SpecRunDispatchInput) => string;
  /** per-repo 依赖镜像白名单（spec §4.3）；缺省 [] = 零 egress。 */
  resolveAllowHosts?: (workspaceRoot: string) => readonly string[];
  /**
   * P6 OS 级 egress 围栏（spec §3）。缺省 = 现状协作式代理（flag off）。
   * 提供时强制：prepare 失败（平台不支持/权限不足/探测不确定）抛 typed
   * FenceStartupError，run 拒绝启动，不回落 env 代理。
   */
  fence?: SpecFenceContract;
}

/** egress plan 的代理地址 → 围栏 broker 端点；端口缺失/非法即拒绝启动。 */
function parseEgressBroker(proxyUrl: string): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch (error) {
    throw new Error(`spec run 拒绝启动：egress proxyUrl 非法（${proxyUrl}）`, { cause: error });
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`spec run 拒绝启动：egress proxyUrl 缺有效端口（${proxyUrl}）`);
  }
  return { host: parsed.hostname, port };
}

function buildSpecRunPrompt(input: SpecRunDispatchInput): string {
  const lines = [
    "投机执行任务（spec lane）：环境事件触发，在 workspace 内静默复现并修复问题。",
    `触发来源: ${input.source}`,
    `线程: ${input.threadKey}`,
    `档位: ${input.tier}`,
  ];
  if (input.reason) lines.push(`裁决理由: ${input.reason}`);
  if (input.evidence && input.evidence.length > 0) {
    lines.push(`证据引用:\n${input.evidence.map((entry) => `- ${entry}`).join("\n")}`);
  }
  if (input.card) {
    lines.push(
      "",
      "方案卡（M6）：",
      `现状证据: ${input.card.currentEvidence}`,
      `候选方案:\n${input.card.candidateOptions
        .map((option, index) => `  ${index + 1}. ${option.option}（代价：${option.cost}）`)
        .join("\n")}`,
      `最佳推荐: ${input.card.recommendation}`,
      `影响面: ${input.card.impact}`,
      `验证方案: ${input.card.verification}`,
    );
  }
  lines.push(
    "",
    "约束：工具面无出站能力、环境无凭据、网络只能走本地白名单代理；只写 workspace 内文件；不 arm scheduler/goal/嵌套 run。",
  );
  return lines.join("\n");
}

/**
 * 创建 dispatcher（结构实现 trigger.TriggerSpecRunPort.start）。
 * 前置：egress 由组合根持有；launch 只走 subagent 形态。
 * 后置：run 结束后 egress 代理已停止（成功或失败都停）；失败原样上抛。
 */
export function createSpecRunDispatcher(deps: SpecRunDispatcherDeps): {
  start(input: SpecRunDispatchInput): Promise<void>;
} {
  // per-workspace 串行队列：egress 契约是「同 workspace 再次 prepare = 先停旧实例再起
  // 新实例」，并发 run 的 prepare/stop 会互相关掉对方的代理。一批评决可同时 dispatch
  // 多个 accept，因此 prepare→launch→stop 必须按 workspace 原子串行。
  const queues = new Map<string, Promise<void>>();

  const runOnce = async (input: SpecRunDispatchInput, workspaceRoot: string): Promise<void> => {
    const plan = await deps.egress.prepareSpecRunEgress({
      workspaceRoot,
      ...(deps.resolveAllowHosts
        ? { allowHosts: deps.resolveAllowHosts(workspaceRoot) }
        : {}),
    });
    let fenceHandle: SpecFenceHandle | undefined;
    try {
      if (plan.proxyUrl.trim().length === 0) {
        // 无代理 = 拒绝启动（spec §0：任何路径都不回退直连）。
        throw new Error("spec run 拒绝启动：egress plan 缺 proxyUrl");
      }
      const profile = buildSpecRestrictedProfile();
      if (profile.name !== SPEC_RESTRICTED_PROFILE_NAME) {
        throw new Error(
          `spec run 拒绝启动：profile 被替换为 ${profile.name}（必须是 ${SPEC_RESTRICTED_PROFILE_NAME}）`,
        );
      }
      if (deps.fence) {
        // 序列：prepare egress 代理 → prepare OS 围栏 → launch（执行命令）。
        // 围栏不可用 = 抛 typed FenceStartupError，run 拒绝启动（spec §3.4 E6）。
        const broker = parseEgressBroker(plan.proxyUrl);
        fenceHandle = await deps.fence.prepare({
          runId: input.triggerId,
          workspaceRoot,
          broker,
          // Linux 的 broker relay 仍由代理 allowlist 裁决，白名单原样传入。
          allowHosts: plan.allowHosts,
        });
      }
      // Linux 围栏内子进程必须改用 veth relay 端点（宿主 loopback broker 跨 netns
      // 不可达）；darwin 的 childBroker 与宿主 broker 同址。env 与 network 必须
      // 同源指向最终端点，否则 launch 会拒绝启动。
      const effectiveProxyUrl = fenceHandle
        ? `http://${fenceHandle.childBroker.host}:${fenceHandle.childBroker.port}`
        : plan.proxyUrl;
      const effectivePlan: SpecRunEgressPlan = {
        ...plan,
        proxyUrl: effectiveProxyUrl,
        networkPolicy: { httpProxy: effectiveProxyUrl, noProxy: "" },
      };
      const processEnv = deps.buildProcessEnv(effectivePlan);
      const proxy = processEnv.HTTP_PROXY ?? processEnv.http_proxy;
      if (proxy !== effectiveProxyUrl) {
        // env 未携带代理 = 无凭据/egress 三件套没有绑死，拒绝启动。
        throw new Error(
          "spec run 拒绝启动：processEnv 未携带 egress 代理（HTTP_PROXY 与 effective proxyUrl 不一致）",
        );
      }
      await deps.launch.launch({
        workspaceRoot,
        form: "subagent",
        profile,
        processEnv,
        network: effectivePlan.networkPolicy,
        ...(fenceHandle ? { fence: fenceHandle } : {}),
        prompt: buildSpecRunPrompt(input),
        trigger: input,
      });
    } finally {
      // 先拆围栏（本 run 已结束），再停代理（不泄漏监听）；任一失败原样上抛。
      try {
        if (fenceHandle) await fenceHandle.teardown();
      } finally {
        await deps.egress.stopSpecRunEgress(workspaceRoot);
      }
    }
  };

  return {
    async start(input: SpecRunDispatchInput): Promise<void> {
      const workspaceRoot = deps.resolveWorkspaceRoot(input);
      if (workspaceRoot.trim().length === 0) {
        throw new Error("spec run 拒绝启动：workspaceRoot 为空");
      }
      const previous = queues.get(workspaceRoot) ?? Promise.resolve();
      // 前一个 run 的失败不阻断后续排队 run（各自 error 原样上抛给各自调用方）。
      const current = previous.catch(() => undefined).then(() => runOnce(input, workspaceRoot));
      const tail = current.then(
        () => undefined,
        () => undefined,
      );
      queues.set(workspaceRoot, tail);
      try {
        await current;
      } finally {
        if (queues.get(workspaceRoot) === tail) queues.delete(workspaceRoot);
      }
    },
  };
}
