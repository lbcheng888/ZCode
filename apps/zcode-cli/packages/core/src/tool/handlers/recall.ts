// ============================================================
// Recall Tool Handler - 引用图链式召回（M9，只读）
// ============================================================
// 规格：docs/architecture/super-agent-context-recall-spec.md。
// 不变量：一页输出里出现的每个 refs ID，都能用同一次调用的 ids 模式再次解析
// （dsh orchestrator_read 形状）。一切读面按 workspace/session scope 过滤；
// trigger/subscription 是预留 kind——storage lane 端口接入前响亮返回能力缺席。

import {
  RECALL_ITEM_SUMMARY_MAX_CHARS,
  RECALL_PAGE_LIMIT_DEFAULT,
  RECALL_TEXT_PAGE_CHARS_DEFAULT,
  RECALL_TOOL_NAME,
  RecallInputJsonSchema,
  RecallInputSchema,
  RecallOutputJsonSchema,
  RecallOutputSchema,
  formatRecallResourceId,
  normalizeRecallResourceId,
  parseRecallResourceId,
  recallArtifactUriFromId,
  type RecallInput,
  type RecallItem,
  type RecallOutput,
  type SessionId,
  type WorkspaceId,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const RECALL_TIMEOUT_MS = 30_000;
const RECALL_MAX_OUTPUT_BYTES = 80_000;
/** kind 列表面的取数上限：limit API 只有上界没有 offset，超出即诚实截断。 */
const RECALL_LIST_FETCH_CAP = 200;
/** port 侧 listRunsForSession 的硬上限（bootstrap DEFAULT/MAX 64）。 */
const RECALL_WF_RUNS_FETCH_CAP = 64;
/** wf-event 一页的事件条数（dsh lists 20/50 同档，取小档）。 */
const RECALL_WF_EVENT_PAGE_LIMIT = 20;

const RECALL_DESCRIPTION = [
  "Loads full resources from the session's reference graph by stable id, one bounded page at a time.",
  "",
  "- Pass `ids` to resolve concrete resources (every id shown in a previous page's `refs` or in a recovery pointer's recallSeedIds resolves here), or `kind` to list one page of a resource kind in the current workspace/session scope.",
  "- Each item carries a `summary` plus `refs` — the ids of the resources it points at. Walk long chains by feeding `refs` back into `ids`; follow `nextCursor` for the next page of a listing.",
  "- Resource id forms: session:sess_…, target:target_…, target-event:target_…/<n>, wf-run:<runId>, wf-event:<runId>/<startSeq>, artifact:<sessionId>/<artifactId> (zcode-artifact:// URIs are the same ids).",
  "- Use this instead of re-reading transcripts when earlier context was compacted away or spilled to an artifact: the id survives compaction, the full content does not.",
].join("\n");

type ResolveOutcome =
  | { item: RecallItem; ok: true }
  | { ok: false; reason: "missing" }
  | { ok: false; id: string; reason: "scope_denied" };

const recallHandler: ToolHandler = async (input, context) => {
  const parsed = RecallInputSchema.parse(input) as RecallInput;
  try {
    if (parsed.ids !== undefined) {
      return await resolveIds(parsed, context);
    }
    return await listKind(parsed, context);
  } catch (error) {
    // 端口缺席是结构化业务失败，不是 handler 崩溃——响亮但可被模型继续使用。
    if (error instanceof RecallCapabilityAbsentError) {
      return {
        status: "capability_absent",
        items: [],
        missing: [],
        truncated: false,
        reason: error.code,
      } satisfies RecallOutput;
    }
    throw error;
  }
};

async function resolveIds(parsed: RecallInput, context: ToolExecutionContext): Promise<RecallOutput> {
  const ids = parsed.ids ?? [];
  const items: RecallItem[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const outcome = await resolveOne(id, parsed.cursor, context);
    if (outcome.ok) {
      items.push(outcome.item);
      continue;
    }
    if (outcome.reason === "scope_denied") {
      return {
        status: "scope_denied",
        items: [],
        missing: [],
        truncated: false,
        reason: `resource_out_of_scope:${outcome.id}`,
      };
    }
    missing.push(id);
  }
  return {
    status: "success",
    items,
    missing,
    truncated: items.some((item) => item.summary.includes(TRUNCATION_MARKER)),
  };
}

async function listKind(parsed: RecallInput, context: ToolExecutionContext): Promise<RecallOutput> {
  const kind = parsed.kind as string;
  const limit = parsed.limit ?? RECALL_PAGE_LIMIT_DEFAULT;
  const offset = parsed.cursor === undefined ? 0 : Number.parseInt(parsed.cursor, 10);

  switch (kind) {
    case "session":
      return listSessionsPage(offset, limit, context);
    case "target":
      return listTargetPage(context);
    case "target-event":
      return listTargetEventsPage(offset, limit, context);
    case "wf-run":
      return listWorkflowRunsPage(offset, limit, context);
    case "wf-event":
    case "artifact":
      return {
        status: "list_unsupported",
        items: [],
        missing: [],
        truncated: false,
        reason: "not_listable",
      };
    default:
      // trigger / subscription 预留 kind：storage lane 端口未接入，能力缺席是诚实答案。
      return {
        status: "capability_absent",
        items: [],
        missing: [],
        truncated: false,
        reason: "recall_source_not_wired",
      };
  }
}

async function resolveOne(
  id: string,
  cursor: string | undefined,
  context: ToolExecutionContext,
): Promise<ResolveOutcome> {
  // zcode-artifact:// URI 与 artifact:<session>/<id> 是同一个资源（schema 已保证可归一）。
  const parsed = parseRecallResourceId(normalizeRecallResourceId(id));
  if (!parsed) return { ok: false, reason: "missing" };

  switch (parsed.kind) {
    case "session":
      return resolveSession(parsed.id, context);
    case "target":
      return resolveTarget(parsed.id, context);
    case "target-event":
      return resolveTargetEvent(parsed.segments[0], Number.parseInt(parsed.segments[1], 10), context);
    case "wf-run":
      return resolveWorkflowRun(parsed.id, context);
    case "wf-event":
      return resolveWorkflowEventPage(
        parsed.segments[0],
        Number.parseInt(parsed.segments[1], 10),
        context,
      );
    case "artifact":
      return resolveArtifact(parsed.id, cursor, context);
    case "trigger":
    case "subscription":
      // 预留 kind：storage lane 端口接入 ToolExecutionContext 之前不存在合法读面。
      throw new RecallCapabilityAbsentError("recall_source_not_wired");
  }
}

class RecallCapabilityAbsentError extends Error {
  constructor(readonly code: string) {
    super(`Recall capability absent: ${code}`);
    this.name = "RecallCapabilityAbsentError";
  }
}

function requireSessionStore(context: ToolExecutionContext) {
  if (!context.sessionStore) {
    throw new RecallCapabilityAbsentError("missing_session_store");
  }
  return context.sessionStore;
}

function sessionInScope(
  input: { id: string; workspaceID?: string },
  context: ToolExecutionContext,
): boolean {
  if (input.id === context.sessionId) return true;
  // 任一侧缺席时不因此拒绝（legacy/本地会话没有 workspace identity）。
  if (input.workspaceID === undefined || context.workspaceIdentity === undefined) return true;
  return input.workspaceID === String(context.workspaceIdentity);
}

async function resolveSession(
  sessionId: string,
  context: ToolExecutionContext,
): Promise<ResolveOutcome> {
  const store = requireSessionStore(context);
  const session = await store.getSession(sessionId as SessionId);
  if (!session) return { ok: false, reason: "missing" };
  if (
    !sessionInScope(
      { id: session.id, workspaceID: session.workspaceID ? String(session.workspaceID) : undefined },
      context,
    )
  ) {
    return { ok: false, id: `session:${session.id}`, reason: "scope_denied" };
  }

  const refs: string[] = [];
  // 只有当前会话的 target 行能被 resolveTarget 读到（它只查 context.sessionId）；
  // 别的会话的 target ref 用 ids 模式跟进必然 missing，违反「refs 可再解析」不变量，不发。
  if (session.id === context.sessionId) {
    const goal = await store.readTarget({ sessionID: session.id });
    if (goal) refs.push(formatRecallResourceId("target", [goal.targetID]));
  }

  const deletedNote = session.time.deleted !== undefined ? " | deleted" : "";
  return {
    ok: true,
    item: {
      id: formatRecallResourceId("session", [session.id]),
      kind: "session",
      summary: boundSummary(
        `${session.title || "(untitled)"} | ${session.directory} | task=${session.taskType}${deletedNote}`,
      ),
      refs,
    },
  };
}

async function resolveTarget(
  targetId: string,
  context: ToolExecutionContext,
): Promise<ResolveOutcome> {
  const store = requireSessionStore(context);
  const goal = await store.readTarget({ sessionID: context.sessionId });
  // target 行是每会话单行实体；id 不命中当前行即不存在（不跨会话找）。
  if (!goal || goal.targetID !== targetId) return { ok: false, reason: "missing" };

  const refs: string[] = [formatRecallResourceId("session", [context.sessionId])];
  const events = await readTargetEventsSafe(store, context);
  const firstEvent = events.find((event) => event.targetID === targetId);
  if (firstEvent) {
    refs.push(formatRecallResourceId("target-event", [targetId, String(firstEvent.id)]));
  }
  return {
    ok: true,
    item: {
      id: formatRecallResourceId("target", [targetId]),
      kind: "target",
      summary: boundSummary(`status=${goal.status} rev=${goal.revision} | ${goal.objective}`),
      refs,
    },
  };
}

async function resolveTargetEvent(
  targetId: string,
  eventId: number,
  context: ToolExecutionContext,
): Promise<ResolveOutcome> {
  const store = requireSessionStore(context);
  const events = await readTargetEventsSafe(store, context);
  // 只在当前会话的事件日志里找——别的会话的事件对本会话就是不存在（不泄露存在性）。
  const event = events.find(
    (candidate) => candidate.targetID === targetId && candidate.id === eventId,
  );
  if (!event) return { ok: false, reason: "missing" };

  const snapshotNote =
    event.snapshot === null ? "snapshot=tombstone" : `snapshot.objective=${event.snapshot.objective}`;
  const reasonNote = event.reason ? ` | reason=${event.reason}` : "";
  const blockerNote = event.blockerCode ? ` | blocker=${event.blockerCode}` : "";
  return {
    ok: true,
    item: {
      id: formatRecallResourceId("target-event", [targetId, String(eventId)]),
      kind: "target-event",
      summary: boundSummary(
        `kind=${event.kind} at=${event.time}${reasonNote}${blockerNote} | ${snapshotNote}`,
      ),
      refs: [
        formatRecallResourceId("target", [targetId]),
        formatRecallResourceId("session", [context.sessionId]),
      ],
    },
  };
}

async function resolveWorkflowRun(
  runId: string,
  context: ToolExecutionContext,
): Promise<ResolveOutcome> {
  const runs = await listSessionWorkflowRuns(context);
  const run = runs.find((candidate) => candidate.runId === runId);
  if (!run) return { ok: false, reason: "missing" };

  const updatedNote = run.updatedAt === undefined ? "" : ` | updated=${run.updatedAt}`;
  // label 可选（老服务端偏斜安全）；与 runId 相同时是无信息兜底，不重复显示。
  const labelNote =
    run.label !== undefined && run.label !== run.runId ? ` (${run.label})` : "";
  return {
    ok: true,
    item: {
      id: formatRecallResourceId("wf-run", [runId]),
      kind: "wf-run",
      summary: boundSummary(`status=${run.status}${updatedNote}${labelNote}`),
      // 事件页起点：wf-event 的 <startSeq> 从 0 起（含首事件，journal 序号可为 0）。
      refs: [formatRecallResourceId("wf-event", [runId, "0"])],
    },
  };
}

async function resolveWorkflowEventPage(
  runId: string,
  startSequence: number,
  context: ToolExecutionContext,
): Promise<ResolveOutcome> {
  const runs = await listSessionWorkflowRuns(context);
  if (!runs.some((candidate) => candidate.runId === runId)) {
    return { ok: false, reason: "missing" };
  }
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.listEvents !== "function") {
    throw new RecallCapabilityAbsentError("missing_run_port");
  }

  // journal 的 afterSequence 是「严格大于」；召回 ID 的 <startSeq> 是「从该序号起（含）」，
  // 两者差一。首事件可能落在 sequence 0（journal 的 max+1 coalesce 从 0 起）。
  const page = await port.listEvents(runId, {
    afterSequence: startSequence - 1,
    limit: RECALL_WF_EVENT_PAGE_LIMIT,
  });
  const lines: string[] = [];
  let budget = RECALL_TEXT_PAGE_CHARS_DEFAULT;
  // next-hop 必须锚在最后一条完整渲染的事件上：budget 中途耗尽时若用端口页末序号，
  // break 点之后、页末之前的事件会在 refs 链上永久不可达（只能手猜 startSeq）。
  let renderedSeq: number | undefined;
  for (const [index, event] of page.events.entries()) {
    const payload = JSON.stringify(event.payload);
    const line = `${event.sequence} ${event.type} ${payload}`;
    if (line.length > budget) {
      // 首条即超预算：按整页硬上限渲染这一条再停，保证 next-hop 有推进（零推进即死循环）。
      const sliceBudget = index === 0 ? RECALL_TEXT_PAGE_CHARS_DEFAULT : budget;
      lines.push(
        `${line.slice(0, Math.max(0, sliceBudget - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`,
      );
      if (index === 0) renderedSeq = event.sequence;
      break;
    }
    lines.push(line);
    budget -= line.length + 1;
    renderedSeq = event.sequence;
  }

  const refs = [formatRecallResourceId("wf-run", [runId])];
  const pageEndSeq = page.events.at(-1)?.sequence;
  // 预算截断早于端口页尾时同样需要下一跳；锚点是最后一条完整渲染的事件序号。
  const earlyBreak = pageEndSeq !== undefined && renderedSeq !== undefined && renderedSeq < pageEndSeq;
  if (renderedSeq !== undefined && (page.hasMore || earlyBreak)) {
    refs.push(formatRecallResourceId("wf-event", [runId, String(renderedSeq + 1)]));
  }

  return {
    ok: true,
    item: {
      id: formatRecallResourceId("wf-event", [runId, String(startSequence)]),
      kind: "wf-event",
      summary: lines.length === 0 ? `(no events from sequence ${startSequence})` : lines.join("\n"),
      refs,
    },
  };
}

async function resolveArtifact(
  artifactId: string,
  cursor: string | undefined,
  context: ToolExecutionContext,
): Promise<ResolveOutcome> {
  const parsed = parseRecallResourceId(`artifact:${artifactId}`);
  if (!parsed) return { ok: false, reason: "missing" };
  const [sessionId] = parsed.segments;
  // artifact 是会话作用域资源：别的会话的 URI 即使知道也不给读。
  if (sessionId !== context.sessionId) {
    return { ok: false, id: `artifact:${artifactId}`, reason: "scope_denied" };
  }
  if (!context.artifactStore) {
    throw new RecallCapabilityAbsentError("missing_artifact_store");
  }

  const uri = recallArtifactUriFromId(`artifact:${artifactId}`);
  if (!uri) return { ok: false, reason: "missing" };
  const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const result = await context.artifactStore.readToolResultArtifact({ uri });
  const page = result.content.slice(offset, offset + RECALL_TEXT_PAGE_CHARS_DEFAULT);
  const nextOffset = offset + RECALL_TEXT_PAGE_CHARS_DEFAULT;
  const hasMore = nextOffset < result.content.length;
  const header = `contentType=${result.contentType} bytes=${result.bytes} offset=${offset}\n`;
  const summary = `${header}${page}${hasMore ? TRUNCATION_MARKER : ""}`;

  return {
    ok: true,
    item: {
      id: `artifact:${artifactId}`,
      kind: "artifact",
      summary,
      refs: [formatRecallResourceId("session", [sessionId])],
      ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
    },
  };
}

async function listSessionsPage(
  offset: number,
  limit: number,
  context: ToolExecutionContext,
): Promise<RecallOutput> {
  const store = requireSessionStore(context);
  const fetch = Math.min(offset + limit + 1, RECALL_LIST_FETCH_CAP);
  const sessions = await store.listSessions({
    workspaceID: context.workspaceIdentity
      ? (String(context.workspaceIdentity) as WorkspaceId)
      : undefined,
    limit: fetch,
  });
  const window = sessions.slice(offset, offset + limit);
  const items: RecallItem[] = [];
  for (const session of window) {
    const outcome = await resolveSession(String(session.id), context);
    if (outcome.ok) items.push(outcome.item);
  }
  // 取数上限触顶（fetch 撞 RECALL_LIST_FETCH_CAP 且取满）时无法再 peek 窗口外一条：
  // 必须留下可观测的截断信号，否则第 200 条之后的会话静默不可达。窗口已耗尽（空页）
  // 时只报 truncated 不给 nextCursor，保证分页终止不空转。
  const capHit = fetch === RECALL_LIST_FETCH_CAP && sessions.length === fetch;
  const moreWithinFetch = sessions.length > offset + limit;
  const emitNextCursor = moreWithinFetch || (capHit && window.length > 0);
  return {
    status: "success",
    items,
    missing: [],
    truncated: capHit && !moreWithinFetch,
    ...(emitNextCursor ? { nextCursor: String(offset + limit) } : {}),
  };
}

async function listTargetPage(context: ToolExecutionContext): Promise<RecallOutput> {
  const outcome = await resolveCurrentTarget(context);
  return {
    status: "success",
    items: outcome ? [outcome] : [],
    missing: [],
    truncated: false,
  };
}

async function resolveCurrentTarget(context: ToolExecutionContext): Promise<RecallItem | undefined> {
  const store = requireSessionStore(context);
  const goal = await store.readTarget({ sessionID: context.sessionId });
  if (!goal) return undefined;
  const outcome = await resolveTarget(goal.targetID, context);
  return outcome.ok ? outcome.item : undefined;
}

async function listTargetEventsPage(
  offset: number,
  limit: number,
  context: ToolExecutionContext,
): Promise<RecallOutput> {
  const store = requireSessionStore(context);
  const events = await readTargetEventsSafe(store, context);
  const window = events.slice(offset, offset + limit);
  const items: RecallItem[] = [];
  for (const event of window) {
    const outcome = await resolveTargetEvent(event.targetID, event.id, context);
    if (outcome.ok) items.push(outcome.item);
  }
  return {
    status: "success",
    items,
    missing: [],
    truncated: false,
    ...(events.length > offset + limit ? { nextCursor: String(offset + limit) } : {}),
  };
}

async function listWorkflowRunsPage(
  offset: number,
  limit: number,
  context: ToolExecutionContext,
): Promise<RecallOutput> {
  const runs = await listSessionWorkflowRuns(context);
  const window = runs.slice(offset, offset + limit);
  const items: RecallItem[] = [];
  for (const run of window) {
    const outcome = await resolveWorkflowRun(run.runId, context);
    if (outcome.ok) items.push(outcome.item);
  }
  return {
    status: "success",
    items,
    missing: [],
    truncated: false,
    ...(runs.length > offset + limit ? { nextCursor: String(offset + limit) } : {}),
  };
}

async function listSessionWorkflowRuns(context: ToolExecutionContext) {
  const port = context.dynamicWorkflowRunPort;
  if (
    port === undefined ||
    typeof port.listRunsForSession !== "function" ||
    typeof port.listEvents !== "function"
  ) {
    // scope 的权威就是「本服务父会话名下的 run 枚举」；端口不全时宁可缺席也不放跨会话读洞。
    throw new RecallCapabilityAbsentError("missing_run_port");
  }
  return port.listRunsForSession(RECALL_WF_RUNS_FETCH_CAP);
}

async function readTargetEventsSafe(
  store: NonNullable<ToolExecutionContext["sessionStore"]>,
  context: ToolExecutionContext,
) {
  if (typeof store.readTargetEvents !== "function") {
    throw new RecallCapabilityAbsentError("missing_target_events");
  }
  return store.readTargetEvents({ sessionID: context.sessionId });
}

const TRUNCATION_MARKER = "…[truncated]";

function boundSummary(summary: string): string {
  if (summary.length <= RECALL_ITEM_SUMMARY_MAX_CHARS) return summary;
  return `${summary.slice(0, RECALL_ITEM_SUMMARY_MAX_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

export const recallToolEntry: ToolEntry = {
  capability: "Recall full resources from the session reference graph by stable id",
  metadata: {
    shouldDefer: true,
    name: RECALL_TOOL_NAME,
    description: RECALL_DESCRIPTION,
    modelInstructions: [
      "Prefer Recall over re-reading transcripts when earlier context was compacted: the recovery anchor's recallSeedIds and every item.refs id resolve here.",
      "Walk reference graphs hop by hop: put a page's refs ids into the next ids call; follow nextCursor for the next page of a listing or the next artifact content page.",
      "Never invent ids — only resolve ids you were given (refs, recallSeedIds, tool results).",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: RECALL_TIMEOUT_MS,
    maxOutputBytes: RECALL_MAX_OUTPUT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: recallHandler,
  formatModelContent: (output) => formatRecallModelContent(RecallOutputSchema.parse(output)),
  inputSchema: RecallInputJsonSchema,
  outputSchema: RecallOutputJsonSchema,
  runtimeInputSchema: RecallInputSchema,
  runtimeOutputSchema: RecallOutputSchema,
  permission: {
    permission: "session.recall.read",
    reason: "Read compacted-away resources in the current session's reference graph",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: RECALL_MAX_OUTPUT_BYTES,
    maxModelBytes: RECALL_MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: RECALL_MAX_OUTPUT_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: RECALL_TIMEOUT_MS,
    maxMs: RECALL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Recall was cancelled before resources were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatRecallModelContent(output: RecallOutput): string {
  if (output.status !== "success") {
    return `Recall ${output.status}${output.reason ? ` (${output.reason})` : ""}`;
  }
  const blocks = output.items.map((item) => {
    const refsLine = item.refs.length > 0 ? `\nrefs: ${item.refs.join(", ")}` : "";
    const cursorLine = item.nextCursor !== undefined ? `\nnextCursor: ${item.nextCursor}` : "";
    return `[${item.kind}] ${item.id}\n${item.summary}${refsLine}${cursorLine}`;
  });
  const parts = [blocks.join("\n\n")];
  if (output.nextCursor !== undefined) {
    parts.push(`nextCursor: ${output.nextCursor} (pass it back for the next page)`);
  }
  if (output.missing.length > 0) {
    parts.push(`missing: ${output.missing.join(", ")}`);
  }
  if (output.truncated) {
    parts.push("Some content was truncated; follow refs/nextCursor for the rest.");
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}
