/**
 * 裁决会话工具面（M3 / T1 零工具注入锚点）。
 *
 * 双闸设计：
 * - toolAllowlist（会话级，fail-closed 主闸）：只放行 M3 钦定的只读面——
 *   trigger/订阅/目标摘要/recall。P2 现存工具中只有 Recall 与 GoalRead 属于该面；
 *   trigger/订阅读工具落地后在此追加。未知未来工具默认排除。
 * - toolDisallowlist（turn 级纵深，automation/off-peak sendPrompt 同型）：
 *   枚举全部已知执行/副作用工具——即便宿主只接了 turn 级黑名单（sendPrompt 只有
 *   toolDisallowlist 面），verdict JSON 之外也零副作用（T1）。
 */

/** 会话级只读工具白名单（M3 工具面）。空/缺席 = 零工具。 */
export const ADJUDICATION_TOOL_ALLOWLIST = ["Recall", "GoalRead"] as const;

/**
 * turn 级执行工具黑名单（T1：裁决会话无任何执行工具）。
 * 覆盖 core/contracts 全量内置副作用工具 + 通用文件读（M3 工具面不含文件读）。
 */
export const ADJUDICATION_TOOL_DISALLOWLIST = [
  // 文件/系统副作用
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "ApplyPatch",
  "Read",
  "Glob",
  "Grep",
  // 子代理/技能/外发
  "Agent",
  "Skill",
  "SendMessage",
  "ReplyToChannel",
  "WebFetch",
  "WebSearch",
  // 任务/后台
  "TaskStop",
  "TaskOutput",
  "TodoWrite",
  "TodoRead",
  // 定时/闲时
  "CronCreate",
  "CronUpdate",
  "CronDelete",
  "CronList",
  "OffPeakCreate",
  "OffPeakList",
  // 工作流全家族（含只读内省——工具面不含）
  "Workflow",
  "CreateWorkflow",
  "AmendWorkflow",
  "SaveWorkflow",
  "ResumeWorkflowRun",
  "EvalWorkflowSnippet",
  "FillWorkflowHole",
  "ResolveWorkflowQuestion",
  "GetWorkflowRun",
  "ListWorkflowRuns",
  "ListSavedWorkflows",
  // goal 变更（GoalRead 在白名单，变更面全部禁用）
  "GoalCreate",
  "GoalUpdate",
  "GoalBlock",
  // 交互/模式/协调
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "escalate",
  "submit_result",
  "RespondToCoordinator",
  // 元工具/代码执行
  "DeferredToolCall",
  "ListModels",
  "ReadSessionContext",
  "js",
] as const;
