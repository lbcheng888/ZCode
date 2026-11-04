import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
} from "@zcode/contracts";
import type { AgentProfile, ModelSelection } from "@zcode/shared";
import {
  filterDisallowedToolNames,
  getToolRuleName,
  normalizeToolNameAlias,
} from "../tool/tool-visibility.js";

export const SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS = [
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
] as const;

export function buildSubagentChildDisallowRules(
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  return [
    ...SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS,
    ...(disallowedTools ?? []),
  ];
}

/**
 * mcp 动态名前缀剔除规则：`mcp__*` 剔除全部 MCP 工具，`mcp__<server>__*` 剔除
 * 该 server 的工具。精确名集合（filterDisallowedToolNames）覆盖不了运行期才知道
 * 的动态名，这里按前缀补齐——spec profile 靠这条把 `mcp__x__y` 挡在
 * `tools:["*"]` 的展开路径之外（docs/architecture/super-agent-spec-lane-spec.md §2.2）。
 */
function isMcpPrefixDisallowRule(rule: string): boolean {
  const name = getToolRuleName(rule);
  return name.startsWith("mcp__") && name.endsWith("*");
}

export function filterSubagentChildToolNames(
  toolNames: readonly string[],
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  // 子 agent 没有独立的 plan approval 恢复面，暴露 plan tools 会让
  // ExitPlanMode 等待用户确认并卡住父 turn，因此所有子 agent 工具面统一剔除。
  const rules = buildSubagentChildDisallowRules(disallowedTools);
  const exactFiltered = filterDisallowedToolNames(toolNames, rules);
  const mcpPrefixes = rules
    .filter(isMcpPrefixDisallowRule)
    .map((rule) => getToolRuleName(rule).slice(0, -1));
  if (mcpPrefixes.length === 0) return exactFiltered;
  return exactFiltered.filter(
    (toolName) => !mcpPrefixes.some((prefix) => toolName.startsWith(prefix)),
  );
}

// ============================================================
// spec restricted profile（M5 投机执行 spec lane，见
// docs/architecture/super-agent-spec-lane-spec.md §2）
// ============================================================

/**
 * spec run 的工具面白名单：workspace 读写 + 本地执行 + 任务簿。
 * 复现-修复所需全集；除此以外的工具一律不进面——出站能力靠这份白名单
 * 从源头消失，`disallowedTools` 只是调用方把 tools 改写成 "*" 时的第二道闸。
 */
export const SPEC_RESTRICTED_TOOLFACE = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Bash",
  "TodoWrite",
  "TodoRead",
] as const;

/**
 * 出站/信道/逃逸剔除表（spec §2.2）。设计 M5：投机会话在 verdict 前
 * 不持有任何出站工具或信道句柄——每一类都是一条绕过 egress 代理的旁路：
 * - 出站网络工具：sideEffectScope=network，不走子进程代理 env；
 * - 信道句柄：对会话外发声（回复频道、跨 agent 消息、升级、结果投递）；
 * - node_repl（js）：进程内任意 JS，fetch 不经代理 env；
 * - 编排/派发工具：Agent/Task/CreateWorkflow 等派生的子运行拿的是
 *   general-purpose profile（tools:["*"]）与常规 env，父 profile 约束不向下遗传；
 * - 调度与 goal 武装：Cron/OffPeak/Goal 在 verdict 前埋下未来的自主 run。
 */
export const SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS = [
  "WebFetch",
  "WebSearch",
  "ReplyToChannel",
  "SendMessage",
  // 子代理控制信道（向父 agent 投递消息）：spec run 由宿主程序驱动，不持有任何
  // 跨 agent 信道；`resolveBuiltInToolAllowlist` 会对 subagent_child 无条件补进
  // 工具面，必须靠 disallowedTools 注册门剔除（spec §2.2）。
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  "escalate",
  "submit_result",
  "js",
  "Agent",
  "Task",
  "Workflow",
  "CreateWorkflow",
  "AmendWorkflow",
  "ResumeWorkflowRun",
  "CronCreate",
  "CronUpdate",
  "CronDelete",
  "OffPeakCreate",
  "GoalCreate",
  "GoalUpdate",
  "GoalBlock",
  // 动态 MCP 名前缀规则：tools:["*"] 展开路径（resolveSubagentToolAllowlist）只吃
  // disallowedTools 精确规则，精确表覆盖不了 mcp__x__y 这类运行期名字，必须带前缀闸。
  "mcp__*",
] as const;

const SPEC_RESTRICTED_OUTBOUND_SET: ReadonlySet<string> = new Set(
  SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS,
);

/**
 * 出站工具名判定：归一别名（web_search→WebSearch）后查表，并按 `mcp__`
 * 前缀剔除全部 MCP 工具（动态名，精确表覆盖不了）。
 */
export function isSpecRestrictedOutboundToolName(toolName: string): boolean {
  const normalized = normalizeToolNameAlias(toolName);
  if (SPEC_RESTRICTED_OUTBOUND_SET.has(normalized)) return true;
  return normalized.startsWith("mcp__");
}

/**
 * 按 spec 受限口径过滤工具面：剔除出站表内工具与全部 `mcp__*`。
 * 与 `filterSubagentChildToolNames` 正交——后者剔 plan 两件套，本函数剔出站。
 */
export function filterSpecRestrictedToolNames(
  toolNames: readonly string[],
): readonly string[] {
  return toolNames.filter((toolName) => !isSpecRestrictedOutboundToolName(toolName));
}

/**
 * spec run 的完整剔除规则：child 强制规则（plan 两件套）∪ 出站表 ∪ 调用方附加。
 * 传给 `filterSubagentChildToolNames` 即得最终过滤器。
 */
export function buildSpecRestrictedDisallowRules(
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  return [
    ...buildSubagentChildDisallowRules(disallowedTools),
    ...SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS,
  ];
}

/** spec profile 允许覆盖的字段：系统提示词与模型；工具面与权限模式不可覆写。 */
export interface SpecRestrictedProfileOverrides {
  systemPrompt?: string;
  modelSelection?: ModelSelection;
  maxTurns?: number;
}

export const SPEC_RESTRICTED_PROFILE_NAME = "spec-restricted";

/**
 * 静默 spec run 的权限模式：`dontAsk` → `resolveSubagentPermissionMode` 映射
 * yolo（guarded 父收紧为 guarded）。静默 run 没有人可答 ask——`edit` 模式下
 * Bash（sideEffectScope=system）会 ask 并挂到权限超时，CI 复现直接残废。
 * 严格性不由模式承担：工具面白名单 ∩ 无凭据 env ∩ egress 代理三层组合
 * 严格强于任何单一既有 AgentPermissionMode（spec §2.3）。
 */
export const SPEC_RESTRICTED_PERMISSION_MODE = "dontAsk" satisfies NonNullable<
  AgentProfile["permissionMode"]
>;

function buildSpecRestrictedSystemPrompt(): string {
  return [
    "You are a speculative-execution worker (spec lane). Reproduce the reported failure inside this workspace, fix it, and report evidence.",
    "",
    "Constraints: your toolface has no outbound or channel tools; network egress is expected to go through a local allowlist proxy (cooperative, env-level); your environment carries no credentials.",
    "- Do not reach hosts outside the per-repo dependency allowlist; package installs must use the configured mirrors. The allowlist proxy is not a physical barrier — bypassing it is still a policy violation and will fail review.",
    "- Write only inside the workspace. Do not arm schedulers, goals, or nested runs.",
  ].join("\n");
}

/**
 * 构造 spec restricted profile（M5）。工具面、出站剔除表与权限模式是
 * 结构性固定的——overrides 只能给系统提示词与模型，无法把 profile 削弱成
 * 任何既有模式的松集（spec §2.3「比任何既有模式都严」的机械保证）。
 *
 * 消费方：子代理路径经 `runner.resolveAllowedTools(profile)`（tools 白名单 +
 * disallowedTools 过滤）与 `resolveSubagentPermissionMode(profile.permissionMode)`
 * 原样生效，既有机械零改动。
 */
export function buildSpecRestrictedProfile(
  overrides: SpecRestrictedProfileOverrides = {},
): AgentProfile {
  return {
    name: SPEC_RESTRICTED_PROFILE_NAME,
    description:
      "Speculative CI repro/fix worker: workspace-write-only toolface, no outbound or channel tools, credential-free environment, egress via a local allowlist proxy (cooperative, env-level).",
    source: "built-in",
    systemPrompt: overrides.systemPrompt ?? buildSpecRestrictedSystemPrompt(),
    tools: [...SPEC_RESTRICTED_TOOLFACE],
    disallowedTools: [...SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS],
    permissionMode: SPEC_RESTRICTED_PERMISSION_MODE,
    ...(overrides.modelSelection ? { modelSelection: overrides.modelSelection } : {}),
    ...(overrides.maxTurns !== undefined ? { maxTurns: overrides.maxTurns } : {}),
  };
}
