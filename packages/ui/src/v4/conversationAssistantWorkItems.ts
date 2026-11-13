import type { ConversationRow, SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { isSessionToolName } from "@/ToolCallBlocks/session/contract.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import * as workflowToolNames from "@/lib/workflowToolNames.js";
import { isZCodeCuaToolName } from "@/lib/cuaPermissionAction.js";
import { joinFilePath } from "@/lib/path.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";

import {
  isExecuteToolCall,
  isExploreToolCall,
  isShellToolCallAwaitingCommand,
} from "@/lib/exploreToolCall.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  isConversationReasoningRowVisible,
  type ConversationReasoningVisibility,
} from "@/v4/conversationRowContext.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import {
  ENABLE_CUA_TOOL_CALL_GROUPING,
  prepareCuaGroups,
  type ConversationCuaGroupRenderItem,
} from "@/v4/conversationCuaGroups.js";

/** 本地「突出代码 / 三级折叠」的完整渲染项（含分组）。 */
export type ConversationAssistantWorkGroupedItem =
  | {
      kind: "row";
      key: string;
      row: AssistantWorkRow;
    }
  | {
      kind: "exploreGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | ConversationCuaGroupRenderItem
  | {
      kind: "executeGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | {
      kind: "changesGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | {
      kind: "agentToolCall";
      key: string;
      row: ToolCallRow;
      subagentRow: SubagentRow;
    };

/** upstream 连续摘要模型使用的窄项：只含 row / agentToolCall。 */
export type ConversationAssistantWorkRenderItem = Extract<
  ConversationAssistantWorkGroupedItem,
  { kind: "row" | "agentToolCall" }
>;

export const ENABLE_EXPLORE_TOOL_CALL_GROUPING = true;
export { ENABLE_CUA_TOOL_CALL_GROUPING } from "@/v4/conversationCuaGroups.js";
export const ENABLE_TERMINAL_TOOL_CALL_GROUPING = true;
export const ENABLE_CHANGES_TOOL_CALL_GROUPING = false;

export interface ConversationAssistantWorkRenderOptions {
  stageTailIsRunning?: boolean;
  enableCuaGrouping?: boolean;
  enableExploreGrouping?: boolean;
  enableTerminalGrouping?: boolean;
  enableChangesGrouping?: boolean;
}

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

const isToolCallRow = (row: AssistantWorkRow): row is ToolCallRow => row.kind === "toolCall";

const isAgentToolCallRow = (row: AssistantWorkRow): row is ToolCallRow =>
  isToolCallRow(row) && SUBAGENT_TOOL_NAMES.has(row.toolName);

function isExploreToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExploreToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function isExecuteToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExecuteToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function isChangesToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  return resolveToolCallIdentity(toolCallRowToLegacyNode(row).toolCall).family === "file-write";
}

function shouldDeferUnclassifiedShellToolCall(row: AssistantWorkRow): boolean {
  if (!isToolCallRow(row) || (row.status !== "inputStreaming" && row.status !== "running")) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isShellToolCallAwaitingCommand({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function resolveGroupStageStatus(
  rows: readonly ToolCallRow[],
  stageTailIsRunning: boolean,
): string {
  // Explore/Execute 父节点表达的是当前工作阶段，不是子工具执行状态的汇总。
  // 子工具可能已经全部完成，但只要当前运行工作段尚未出现下一条可见边界，父阶段仍在继续；
  // 反之，后续非当前分组内容已经出现时，即使迟到的子状态仍是 running，父阶段也必须结束。
  if (stageTailIsRunning) return "in_progress";
  return rows.some((row) => row.status === "cancelled") ? "stopped" : "completed";
}

function buildExploreGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  // 分组 builder 只会在连续同类工具达到两项后调用；空数组不是合法状态，
  // 不再用伪造 identity 的兜底掩盖调用方错误。
  const firstRow = rows[0]!;
  const childToolCalls = rows.map(toolCallRowToLegacyNode);

  return {
    kind: "exploreGroup" as const,
    // 旧 key/toolId 包含末尾 row 和数量，每新增一个 Explore 子工具都会重建组件，
    // 并让 ToolLayout 用新的 toolId 读取不到用户刚保存的展开状态。聚合身份锚定首个子工具，
    // 后续只更新 children，保证流式增长期间 React identity 和展开状态 identity 都稳定。
    key: `explore:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `explore:${firstRow.toolCallId}`,
        toolName: "Explore",
        kind: "Explore",
        title: "Explore",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls,
    },
  };
}

function buildExecuteGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "executeGroup" as const,
    // 分组 identity 如果包含末项或数量，流式新增命令会重建父组件并丢失展开状态。
    // 与 Explore 一样锚定首个真实 tool call，后续只更新 children。
    key: `execute:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `execute:${firstRow.toolCallId}`,
        toolName: "ExecuteGroup",
        kind: "executeGroup",
        title: "Execute",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

function buildChangesGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "changesGroup" as const,
    // Changes 的展开状态必须在流式追加 Write/Edit 时保持稳定，因此身份锚定首个 tool。
    key: `changes:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `changes:${firstRow.toolCallId}`,
        toolName: "ChangesGroup",
        kind: "changesGroup",
        title: "Changes",
        input: {},
        // Changes 是 UI 阶段容器，不是真实工具；子项失败/取消只留在各自明细，
        // 父级仅表达当前阶段是否仍位于可见运行段尾部。
        status: stageTailIsRunning ? "in_progress" : "completed",
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

/**
 * Agent 工具行 ↔ subagent 行必须按 parentToolCallId 精确配对。
 *
 * 同一轮并发 Agent 工具的 tool call 行按模型输出顺序出现，但 SubagentSpawned
 * 事件按异步调度顺序到达；旧 FIFO 会把一个 Agent 的标题与另一个 childSessionId 拼在一起。
 * 仅对缺少新字段的历史数据保留“同 turn 唯一剩余一对”的无歧义兼容。
 */
function pairSubagentRows(rows: readonly AssistantWorkRow[]): {
  subagentByAgentToolRowId: Map<number, SubagentRow>;
  claimedSubagentRowIds: Set<number>;
} {
  const subagentByAgentToolRowId = new Map<number, SubagentRow>();
  const claimedSubagentRowIds = new Set<number>();
  const agentToolByTurnAndCallId = new Map<string, ToolCallRow>();
  const agentToolRows: ToolCallRow[] = [];
  const subagentRows: SubagentRow[] = [];
  const legacySubagentRows: SubagentRow[] = [];

  for (const row of rows) {
    if (isAgentToolCallRow(row)) {
      agentToolRows.push(row);
      agentToolByTurnAndCallId.set(`${row.turnId}\0${row.toolCallId}`, row);
    } else if (row.kind === "subagent") {
      subagentRows.push(row);
    }
  }
  for (const row of subagentRows) {
    if (!row.parentToolCallId) {
      legacySubagentRows.push(row);
      continue;
    }
    const host = agentToolByTurnAndCallId.get(`${row.turnId}\0${row.parentToolCallId}`);
    if (host && host.turnId === row.turnId && !subagentByAgentToolRowId.has(host.rowId)) {
      subagentByAgentToolRowId.set(host.rowId, row);
      claimedSubagentRowIds.add(row.rowId);
    }
  }

  const remainingAgentToolsByTurn = new Map<string, ToolCallRow[]>();
  for (const row of agentToolRows) {
    if (subagentByAgentToolRowId.has(row.rowId)) continue;
    const turnRows = remainingAgentToolsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      remainingAgentToolsByTurn.set(row.turnId, [row]);
    }
  }
  const legacySubagentsByTurn = new Map<string, SubagentRow[]>();
  for (const row of legacySubagentRows) {
    const turnRows = legacySubagentsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      legacySubagentsByTurn.set(row.turnId, [row]);
    }
  }
  for (const [turnId, subagentRows] of legacySubagentsByTurn) {
    const toolRows = remainingAgentToolsByTurn.get(turnId);
    if (toolRows?.length !== 1 || subagentRows.length !== 1) continue;
    const host = toolRows[0];
    const subagent = subagentRows[0];
    if (!host || !subagent) continue;
    subagentByAgentToolRowId.set(host.rowId, subagent);
    claimedSubagentRowIds.add(subagent.rowId);
  }

  return { subagentByAgentToolRowId, claimedSubagentRowIds };
}

export function buildGroupedAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility,
  options?: ConversationAssistantWorkRenderOptions,
): ConversationAssistantWorkGroupedItem[] {
  const items: ConversationAssistantWorkGroupedItem[] = [];
  const enableExploreGrouping = options?.enableExploreGrouping ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING;
  const enableCuaGrouping = options?.enableCuaGrouping ?? ENABLE_CUA_TOOL_CALL_GROUPING;
  const enableTerminalGrouping =
    options?.enableTerminalGrouping ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING;
  const enableChangesGrouping = options?.enableChangesGrouping ?? ENABLE_CHANGES_TOOL_CALL_GROUPING;
  // Explore 的阶段边界和尾部状态必须基于用户实际可见的行序。等待 command 的 Shell
  // 若只在循环中跳过，仍会占据数组位置，导致前一个 Explore 被误判为已结束；
  // 隐藏 reasoning 也有相同问题。先统一剔除暂不可见行，再做配对、分组和尾部判断。
  const visibleRows = rows.filter((row) => {
    if (
      row.kind === "reasoning" &&
      !isConversationReasoningRowVisible(row.rowId, reasoningVisibility)
    ) {
      return false;
    }
    return !shouldDeferUnclassifiedShellToolCall(row);
  });
  const { subagentByAgentToolRowId, claimedSubagentRowIds } = pairSubagentRows(visibleRows);
  const preparedRows = prepareCuaGroups(
    visibleRows,
    enableCuaGrouping,
    options?.stageTailIsRunning === true,
  );
  let index = 0;

  while (index < preparedRows.length) {
    const row = preparedRows[index];
    if (!row) {
      index += 1;
      continue;
    }

    if (row.kind === "cuaGroup") {
      items.push(row);
      index += 1;
      continue;
    }

    // 已配对进 Agent 块的 subagent 行：不再单独渲染。
    if (row.kind === "subagent" && claimedSubagentRowIds.has(row.rowId)) {
      index += 1;
      continue;
    }
    if (isToolCallRow(row)) {
      const pairedSubagent = subagentByAgentToolRowId.get(row.rowId);
      if (pairedSubagent) {
        items.push({
          kind: "agentToolCall",
          key: `agent:${row.rowId}`,
          row,
          subagentRow: pairedSubagent,
        });
        index += 1;
        continue;
      }
    }

    const isExploreRow = isExploreToolCallRow(row);
    if (!isExploreRow) {
      if (enableChangesGrouping && isChangesToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < preparedRows.length) {
          const nextRow = preparedRows[index];
          if (!nextRow || nextRow.kind === "cuaGroup" || !isChangesToolCallRow(nextRow)) break;
          groupRows.push(nextRow);
          index += 1;
        }
        // 单个工具不需要额外的 UI 合成层；等第二个连续同类工具到达后再升级为父分组。
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: `row:${singleRow.rowId}`, row: singleRow });
          continue;
        }
        items.push(
          buildChangesGroup(
            groupRows,
            options?.stageTailIsRunning === true && index === preparedRows.length,
          ),
        );
        continue;
      }
      if (enableTerminalGrouping && isExecuteToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < preparedRows.length) {
          const nextRow = preparedRows[index];
          if (!nextRow || nextRow.kind === "cuaGroup" || !isExecuteToolCallRow(nextRow)) {
            break;
          }
          groupRows.push(nextRow);
          index += 1;
        }
        // 单个工具保留自身语义和渲染，避免只包含一个子项的 Terminal 容器。
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: `row:${singleRow.rowId}`, row: singleRow });
          continue;
        }
        items.push(
          buildExecuteGroup(
            groupRows,
            options?.stageTailIsRunning === true && index === preparedRows.length,
          ),
        );
        continue;
      }
      items.push({
        kind: "row",
        key: `row:${row.rowId}`,
        row,
      });
      index += 1;
      continue;
    }

    if (!enableExploreGrouping) {
      items.push({
        kind: "row",
        key: `row:${row.rowId}`,
        row,
      });
      index += 1;
      continue;
    }

    const groupRows: ToolCallRow[] = [row];
    index += 1;
    while (index < preparedRows.length) {
      const nextRow = preparedRows[index];
      if (!nextRow || nextRow.kind === "cuaGroup" || !isExploreToolCallRow(nextRow)) {
        break;
      }
      groupRows.push(nextRow);
      index += 1;
    }
    // Explore 只有在出现第二个连续只读工具后才成立；首项必须立即按原工具展示。
    if (groupRows.length === 1) {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
      continue;
    }
    items.push(
      buildExploreGroup(
        groupRows,
        options?.stageTailIsRunning === true && index === preparedRows.length,
      ),
    );
  }

  return items;
}

/**
 * 「突出代码」分组判据：终端/文件写入/子代理/CUA 等动作逐条保留；思考、查阅、
 * 网页、todo 等非代码工作项由调用方折叠成组。assistantText 是回复正文，永远不折叠。
 */
const CODE_TOOL_NAMES = new Set([
  "Agent",
  "ApplyPatch",
  "Bash",
  "Edit",
  "Execute",
  "MultiEdit",
  "NotebookEdit",
  "Task",
  "Terminal",
  "Write",
]);

function isCodeToolCallRow(row: ToolCallRow): boolean {
  if (CODE_TOOL_NAMES.has(row.toolName)) return true;
  const legacyNode = toolCallRowToLegacyNode(row);
  return (
    isExecuteToolCall({ kind: legacyNode.toolCall.kind, input: legacyNode.toolCall.input }) ||
    resolveToolCallIdentity(legacyNode.toolCall).family === "file-write"
  );
}

export function isCodeAssistantWorkItem(item: ConversationAssistantWorkGroupedItem): boolean {
  switch (item.kind) {
    case "executeGroup":
    case "changesGroup":
    case "cuaGroup":
    case "agentToolCall":
      return true;
    case "exploreGroup":
      return false;
    case "row": {
      if (item.row.kind === "reasoning") return false;
      if (item.row.kind !== "toolCall") return true;
      return isCodeToolCallRow(item.row);
    }
    default:
      return true;
  }
}

// upstream base item builder: Share/Timeline 的连续摘要模型使用 row/agentToolCall 窄项。
export function buildBaseAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility & { messageStreamShowTodos?: boolean },
): ConversationAssistantWorkRenderItem[] {
  const visibleRows = rows.filter(
    (row) =>
      (row.kind !== "reasoning" ||
        ((row.state !== "streaming" || row.text.length > 0) &&
          isConversationReasoningRowVisible(row.rowId, reasoningVisibility))) &&
      (row.kind !== "toolCall" ||
        reasoningVisibility.messageStreamShowTodos === true ||
        resolveToolCallIdentity(toolCallRowToLegacyNode(row).toolCall).family !== "todo") &&
      !shouldDeferUnclassifiedShellToolCall(row),
  );
  const { subagentByAgentToolRowId, claimedSubagentRowIds } = pairSubagentRows(visibleRows);
  const items: ConversationAssistantWorkRenderItem[] = [];
  for (const row of visibleRows) {
    if (row.kind === "subagent" && claimedSubagentRowIds.has(row.rowId)) continue;
    const subagentRow = isToolCallRow(row) ? subagentByAgentToolRowId.get(row.rowId) : undefined;
    if (isToolCallRow(row) && subagentRow) {
      items.push({ kind: "agentToolCall", key: `agent:${row.rowId}`, row, subagentRow });
    } else {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
    }
  }
  return items;
}

export function buildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility,
): ConversationAssistantWorkRenderItem[];
export function buildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility,
  options: ConversationAssistantWorkRenderOptions,
): ConversationAssistantWorkGroupedItem[];
export function buildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility,
  options?: ConversationAssistantWorkRenderOptions,
): ConversationAssistantWorkRenderItem[] | ConversationAssistantWorkGroupedItem[] {
  return options === undefined
    ? buildBaseAssistantWorkRenderItems(rows, reasoningVisibility)
    : buildGroupedAssistantWorkRenderItems(rows, reasoningVisibility, options);
}

export function getAssistantSummaryToolCategory(
  row: AssistantWorkRow,
): "explore" | "run" | "change" | "session" | null {
  if (row.kind !== "toolCall" || row.status === "pendingApproval") return null;
  const tool = toolCallRowToLegacyNode(row).toolCall;
  // 复用专用 renderer 的名字判定，避免 snake_case workflow 被通用 list/search 归类吞掉。
  if (Object.values(workflowToolNames).some((matches) => matches(tool))) return null;
  // 会话工具保留独立类别以维持代表图标优先级，统计时按调用次数合入执行数量。
  if (isSessionToolName(tool.toolName ?? tool.kind)) return "session";
  const family = resolveToolCallIdentity(tool).family;
  if (["file-read", "search", "web-fetch", "explore"].includes(family)) return "explore";
  if (
    family === "shell" ||
    family === "node-repl" ||
    [tool.toolName, tool.kind].some(isZCodeCuaToolName)
  )
    return "run";
  if (family === "file-write") return "change";
  return null;
}

/** 正文、Workflow、Subagent 与未归类工具是边界；不重新拼接真实工具关系。 */
export function groupConsecutiveAssistantSummaries(
  items: readonly ConversationAssistantWorkRenderItem[],
) {
  const groups: { key: string; items: ConversationAssistantWorkRenderItem[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const item of items) {
    const summary =
      item.kind !== "agentToolCall" &&
      (item.row.kind === "reasoning" || getAssistantSummaryToolCategory(item.row) !== null);
    if (!summary) {
      groups.push({ key: item.key, items: [item] });
      current = undefined;
      continue;
    }
    if (!current) {
      current = { key: item.key, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

// 工具行不可变；过去只缓存路径，文件列表仍在每次渲染重建 diff。两处共用完整摘要缓存。
const fileSummariesByRow = new WeakMap<
  ToolCallRow,
  ReturnType<typeof readRawToolCallFileSummaries>
>();
function fileSummaries(row: ToolCallRow) {
  const cached = fileSummariesByRow.get(row);
  if (cached) return cached;
  const tool = toolCallRowToLegacyNode(row).toolCall;
  const summaries = readRawToolCallFileSummaries(tool.raw, tool);
  fileSummariesByRow.set(row, summaries);
  return summaries;
}
function changedPaths(row: ToolCallRow): readonly string[] {
  // filePath 是目录展示字段；计数使用包含文件名的原始完整 path。
  return fileSummaries(row)
    .map((file) => file.path)
    .filter(Boolean);
}

// 路径别名曾被当作不同文件；计数和列表必须共用词法去重键，不依赖宿主文件系统。
function summaryFilePath(path: string, workspacePath?: string): string {
  const joined = (workspacePath ? joinFilePath(workspacePath, path) : path).replace(/\\/g, "/");
  const root = joined.startsWith("//")
    ? (joined.match(/^\/\/[^/]+\/[^/]+/)?.[0] ?? "//")
    : (joined.match(/^[A-Za-z]:\//)?.[0] ?? (joined.startsWith("/") ? "/" : ""));
  const parts: string[] = [];
  for (const part of joined.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !root) parts.push(part);
  }
  return root + (root && !root.endsWith("/") && parts.length ? "/" : "") + parts.join("/");
}

export function formatAssistantSummaryStatistics(
  items: readonly ConversationAssistantWorkRenderItem[],
  intl: IntlInstance,
  workspacePath?: string,
  completed = false,
): string {
  let explore = 0,
    run = 0,
    unresolved = 0;
  const files = new Set<string>();
  for (const item of items) {
    const category =
      item.kind === "agentToolCall" ? null : getAssistantSummaryToolCategory(item.row);
    if (category === "explore") explore++;
    // 统计工具调用，不统计返回的目标数；同一会话的多次操作也分别计数。
    if (category === "run" || category === "session") run++;
    if (category === "change" && item.row.kind === "toolCall") {
      const paths = changedPaths(item.row);
      if (!paths.length) unresolved++;
      for (const path of paths) files.add(summaryFilePath(path, workspacePath));
    }
  }
  const parts = (
    [
      ["explore", explore],
      ["run", run],
      ["change", files.size],
      ["unresolved", unresolved],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([category, count]) =>
      // 项目 intl 只替换占位符，不解析 ICU；复用 one/other 键，避免把模板原文显示给用户。
      intl.formatMessage(
        {
          id: `chat.summaryGroup.${category}.${completed ? "completed." : ""}${count === 1 ? "one" : "other"}`,
        },
        { count },
      ),
    );
  return (
    parts.join(intl.formatMessage({ id: "chat.summaryGroup.separator" })) ||
    intl.formatMessage({ id: "chat.summaryGroup.reasoning" })
  );
}

/** 整轮可见尾项决定可追加的组；不能把 history/正文的展示拆分当成独立生命周期。 */
export function getAssistantSummaryTailRowId(
  rows: readonly ConversationRow[],
  visibility: ConversationReasoningVisibility & { messageStreamShowTodos?: boolean },
): number | undefined {
  if (rows.at(-1)?.kind === "userInput") return undefined;
  const workRows = rows.filter(
    (row): row is AssistantWorkRow => row.kind !== "turnHeader" && row.kind !== "userInput",
  );
  return buildAssistantWorkRenderItems(workRows, visibility).at(-1)?.row.rowId;
}

/** 活动摘要与结构闭合分别派生，不能把暂时没有活动项误判为闭合。 */
export function getActiveAssistantSummaryItem(
  items: readonly ConversationAssistantWorkRenderItem[],
) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const row = item.row;
    if (
      row.kind === "reasoning"
        ? row.state === "streaming"
        : row.kind === "toolCall" && (row.status === "inputStreaming" || row.status === "running")
    )
      return item;
  }
  return undefined;
}

/** 只为统计选择代表图标，不改变工具顺序或活动摘要的图标。 */
export function getAssistantSummaryIconItem(items: readonly ConversationAssistantWorkRenderItem[]) {
  let selected: ConversationAssistantWorkRenderItem | undefined;
  let selectedPriority = Infinity;
  for (const item of items) {
    const category = getAssistantSummaryToolCategory(item.row);
    if (!category || item.row.kind !== "toolCall") continue;
    const tool = toolCallRowToLegacyNode(item.row).toolCall;
    const priority = [tool.toolName, tool.kind].some(isZCodeCuaToolName)
      ? 0
      : resolveToolCallIdentity(tool).family === "node-repl"
        ? 1
        : category === "change"
          ? 2
          : category === "run"
            ? 3
            : 4;
    if (priority < selectedPriority) {
      selected = item;
      selectedPriority = priority;
    }
  }
  return selected;
}

/** 仅 Change 的计数可展示文件；思考不计数，混合工具保留原统计。 */
export function getAssistantSummaryChangeFiles(
  items: readonly ConversationAssistantWorkRenderItem[],
  workspacePath?: string,
) {
  const files = new Map<string, ReturnType<typeof readRawToolCallFileSummaries>[number]>();
  let unresolved = 0;
  for (const item of items) {
    const category = getAssistantSummaryToolCategory(item.row);
    if (category && category !== "change") return undefined;
    if (category !== "change" || item.row.kind !== "toolCall") continue;
    const summaries = fileSummaries(item.row);
    if (!summaries.length) unresolved++;
    for (const file of summaries) {
      const path = summaryFilePath(file.path, workspacePath);
      if (!files.has(path)) files.set(path, { ...file, path });
    }
  }
  return files.size ? { files: [...files.values()], unresolved } : undefined;
}
