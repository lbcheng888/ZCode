import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectId,
  createSessionId,
  type DynamicWorkflowRunEvent,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSessionSummary,
  type SessionId,
  type WorkspaceId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createDwfJournalStore } from "../../adapters/src/storage/session-store/repositories/dwf-journal.js";
import { recallToolEntry } from "../src/tool/handlers/recall.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

// 真 fixture：sqlite session store + 同库 dwf journal，零 mock。规格：
// docs/architecture/super-agent-context-recall-spec.md §2/§6。

/** 与 handlers/recall.ts 内部常量对齐（模块未导出，测试侧独立声明）。 */
const TRUNCATION_MARKER = "…[truncated]";
const RECALL_WF_EVENT_PAGE_LIMIT = 20;

const ROOTS: string[] = [];

afterEach(async () => {
  await Promise.all(ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
  db: DatabaseSync;
  sessionId: SessionId;
  otherWorkspaceSessionId: SessionId;
  sameWorkspaceSessionId: SessionId;
  targetId: string;
  runId: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "zcode-recall-tool-"));
  ROOTS.push(root);
  const dbPath = join(root, "session.sqlite");
  const store = await createSqliteSessionStore({ dbPath });
  const sessionId = createSessionId("recall-current");
  const otherWorkspaceSessionId = createSessionId("recall-other-ws");
  const sameWorkspaceSessionId = createSessionId("recall-same-ws");
  const projectID = createProjectId("recall-project");
  await store.createSession({
    id: sessionId,
    projectID,
    workspaceID: "ws_recall" as WorkspaceId,
    slug: "recall-current",
    title: "Recall current session",
    directory: root,
    version: "test",
  });
  await store.createSession({
    id: otherWorkspaceSessionId,
    projectID,
    workspaceID: "ws_other" as WorkspaceId,
    slug: "recall-other-ws",
    title: "Other workspace session",
    directory: root,
    version: "test",
  });
  await store.createSession({
    id: sameWorkspaceSessionId,
    projectID,
    workspaceID: "ws_recall" as WorkspaceId,
    slug: "recall-same-ws",
    title: "Same workspace session",
    directory: root,
    version: "test",
  });

  const goal = await store.setTarget({
    sessionID: sessionId,
    objective: "Ship the recall tool with graph walk coverage",
  });
  await store.updateTargetStatus({ sessionID: sessionId, status: "paused", reason: "user" });

  // 同库第二个连接开 dwf journal（migration 0019 由 store 建表）。
  const db = new DatabaseSync(dbPath);
  const journal = createDwfJournalStore(db);
  const runId = "dwfrun-recall-fixture";
  journal.createRun({
    runId,
    parentSessionId: String(sessionId),
    name: "nightly triage",
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
    status: "completed",
  });
  journal.appendEvent(runId, { type: "run-started", runId, caps: { maxConcurrency: 1 } });
  for (let index = 0; index < 25; index++) {
    journal.appendEvent(runId, { type: "log", message: `step ${index + 1}` });
  }

  return {
    store,
    db,
    sessionId,
    otherWorkspaceSessionId,
    sameWorkspaceSessionId,
    targetId: goal.targetID,
    runId,
  };
}

/** journal-backed 的最小 DynamicWorkflowRunPort：listEvents 走真 journal，枚举走真窄查询。 */
function createJournalBackedRunPort(fixture: Fixture): DynamicWorkflowRunPort {
  const journal = createDwfJournalStore(fixture.db);
  const introspection = journal as typeof journal & {
    listRunsByParentSession?: (
      parentSessionId: string,
      limit: number,
    ) => {
      runId: string;
      name?: string;
      status: DynamicWorkflowRunSessionSummary["status"];
      timeUpdated: number;
    }[];
  };
  return {
    async listRunsForSession(
      limit?: number,
    ): Promise<DynamicWorkflowRunSessionSummary[]> {
      if (typeof introspection.listRunsByParentSession !== "function") return [];
      return introspection
        .listRunsByParentSession(String(fixture.sessionId), limit ?? 16)
        .map((row) => ({
          runId: row.runId,
          label: row.name ?? row.runId,
          status: row.status,
          updatedAt: row.timeUpdated,
        }));
    },
    async listEvents(runId, page) {
      const afterSequence = page.afterSequence ?? 0;
      const limit = page.limit ?? 50;
      const rows = journal.listEvents(runId, {
        types: "all",
        reportItems: { limit: 0 },
        afterSequence,
        // 多取一条判定 hasMore，端口语义与生产一致。
        limit: limit + 1,
      });
      const hasMore = rows.length > limit;
      const events: DynamicWorkflowRunEvent[] = rows.slice(0, limit).map((row) => ({
        sequence: row.sequence,
        type: row.event.type,
        payload: row.event as unknown as Record<string, unknown>,
      }));
      return { events, hasMore };
    },
  } as DynamicWorkflowRunPort;
}

function contextWith(fixture: Fixture, overrides: Partial<ToolExecutionContext> = {}) {
  return {
    abortSignal: new AbortController().signal,
    sessionId: fixture.sessionId,
    workspaceIdentity: "ws_recall",
    toolCallId: "toolu_recall",
    traceId: "trace_recall" as never,
    workingDirectory: "/workspace/project",
    workspaceRoot: "/workspace/project",
    sessionStore: fixture.store,
    dynamicWorkflowRunPort: createJournalBackedRunPort(fixture),
    ...overrides,
  } as ToolExecutionContext;
}

async function recall(
  fixture: Fixture,
  input: Record<string, unknown>,
  overrides: Partial<ToolExecutionContext> = {},
) {
  return (await recallToolEntry.handler(input, contextWith(fixture, overrides))) as {
    status: string;
    items: { id: string; kind: string; summary: string; refs: string[]; nextCursor?: string }[];
    missing: string[];
    nextCursor?: string;
    truncated: boolean;
    reason?: string;
  };
}

describe("Recall tool over real store fixtures", () => {
  it("walks the target -> target-event -> session graph by chained ids", async () => {
    const fixture = await createFixture();

    const targetPage = await recall(fixture, {
      ids: [`target:${fixture.targetId}`],
    });
    expect(targetPage.status).toBe("success");
    expect(targetPage.items).toHaveLength(1);
    const targetItem = targetPage.items[0];
    expect(targetItem.kind).toBe("target");
    expect(targetItem.summary).toContain("Ship the recall tool");
    // 每个 refs 都能再次解析（链式召回归一不变量）。
    const sessionRef = targetItem.refs.find((ref) => ref.startsWith("session:"));
    const eventRef = targetItem.refs.find((ref) => ref.startsWith("target-event:"));
    expect(sessionRef).toBe(`session:${fixture.sessionId}`);
    expect(eventRef).toBeDefined();

    const hop = await recall(fixture, { ids: [sessionRef!, eventRef!] });
    expect(hop.status).toBe("success");
    expect(hop.missing).toEqual([]);
    expect(hop.items.map((item) => item.kind).sort()).toEqual(["session", "target-event"]);
    const eventItem = hop.items.find((item) => item.kind === "target-event");
    expect(eventItem?.summary).toContain("kind=");
    // target-event 的下一跳回到 target 与当前 session。
    expect(eventItem?.refs).toContain(`target:${fixture.targetId}`);
    expect(eventItem?.refs).toContain(`session:${fixture.sessionId}`);
  });

  it("pages workflow journal events with next-hop refs", async () => {
    const fixture = await createFixture();

    const runPage = await recall(fixture, { ids: [`wf-run:${fixture.runId}`] });
    expect(runPage.status).toBe("success");
    expect(runPage.items[0].summary).toContain("status=completed");
    expect(runPage.items[0].summary).toContain("nightly triage");
    const eventsRef = runPage.items[0].refs[0];
    expect(eventsRef).toBe(`wf-event:${fixture.runId}/0`);

    const firstEvents = await recall(fixture, { ids: [eventsRef] });
    expect(firstEvents.status).toBe("success");
    const firstItem = firstEvents.items[0];
    // journal 序号从 0 起：seq0=run-started、seq1..25=step 1..25；首页 20 条（seq0..19）。
    expect(firstItem.summary).toContain("run-started");
    expect(firstItem.summary).toContain("step 1");
    const nextHop = firstItem.refs.find((ref) => ref.startsWith(`wf-event:${fixture.runId}/`));
    expect(nextHop).toBe(`wf-event:${fixture.runId}/20`);

    const secondEvents = await recall(fixture, { ids: [nextHop!] });
    expect(secondEvents.status).toBe("success");
    expect(secondEvents.items[0].summary).toContain("step 20");
    expect(secondEvents.items[0].summary).toContain("step 25");
    // 末页没有更多事件 → 不再给 wf-event 下一跳。
    expect(
      secondEvents.items[0].refs.filter((ref) => ref.startsWith("wf-event:")),
    ).toEqual([]);
  });

  it("resolves artifacts by id and by zcode-artifact URI with character paging", async () => {
    const fixture = await createFixture();
    const content = `${"x".repeat(4_500)}END`;
    const artifactStore = {
      async writeToolResultArtifact() {
        throw new Error("not used");
      },
      async readToolResultArtifact(request: { uri: string }) {
        expect(request.uri).toBe(`zcode-artifact://${fixture.sessionId}/art_page`);
        return {
          uri: request.uri,
          content,
          contentType: "text/plain",
          bytes: Buffer.byteLength(content, "utf8"),
        };
      },
    };

    const firstPage = await recall(
      fixture,
      { ids: [`artifact:${fixture.sessionId}/art_page`] },
      { artifactStore },
    );
    expect(firstPage.status).toBe("success");
    expect(firstPage.items[0].summary).toContain("offset=0");
    expect(firstPage.items[0].summary).toContain("…[truncated]");
    expect(firstPage.items[0].nextCursor).toBe("4000");

    const uriPage = await recall(
      fixture,
      { ids: [`zcode-artifact://${fixture.sessionId}/art_page`], cursor: "4000" },
      { artifactStore },
    );
    expect(uriPage.status).toBe("success");
    expect(uriPage.items[0].id).toBe(`artifact:${fixture.sessionId}/art_page`);
    expect(uriPage.items[0].summary).toContain("offset=4000");
    expect(uriPage.items[0].summary).toContain("END");
    expect(uriPage.items[0].nextCursor).toBeUndefined();
  });

  it("rejects out-of-scope sessions and foreign-session artifacts", async () => {
    const fixture = await createFixture();

    const foreignSession = await recall(fixture, {
      ids: [`session:${fixture.otherWorkspaceSessionId}`],
    });
    expect(foreignSession.status).toBe("scope_denied");
    expect(foreignSession.reason).toContain(String(fixture.otherWorkspaceSessionId));

    const foreignArtifact = await recall(
      fixture,
      { ids: [`artifact:${fixture.otherWorkspaceSessionId}/art_1`] },
      {
        artifactStore: {
          async readToolResultArtifact() {
            throw new Error("must not read a foreign session artifact");
          },
        } as unknown as ToolExecutionContext["artifactStore"],
      },
    );
    expect(foreignArtifact.status).toBe("scope_denied");
  });

  it("lists scoped kinds and reports unknown ids without swallowing them", async () => {
    const fixture = await createFixture();

    const firstPage = await recall(fixture, { kind: "session", limit: 1 });
    expect(firstPage.status).toBe("success");
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBe("1");
    const secondPage = await recall(fixture, {
      kind: "session",
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items).toHaveLength(1);
    const listedIds = [firstPage.items[0].id, secondPage.items[0].id];
    expect(listedIds).toContain(`session:${fixture.sessionId}`);
    expect(listedIds).toContain(`session:${fixture.sameWorkspaceSessionId}`);
    expect(listedIds).not.toContain(`session:${fixture.otherWorkspaceSessionId}`);

    const events = await recall(fixture, { kind: "target-event" });
    expect(events.items.length).toBeGreaterThanOrEqual(2);

    const runs = await recall(fixture, { kind: "wf-run" });
    expect(runs.items.map((item) => item.id)).toEqual([`wf-run:${fixture.runId}`]);

    const unknown = await recall(fixture, {
      ids: [`target:${fixture.targetId}`, "session:sess_does_not_exist"],
    });
    expect(unknown.status).toBe("success");
    expect(unknown.missing).toEqual(["session:sess_does_not_exist"]);
    expect(unknown.items).toHaveLength(1);

    const notListable = await recall(fixture, { kind: "wf-event" });
    expect(notListable.status).toBe("list_unsupported");
  });

  it("never emits a cross-session target ref that ids mode cannot resolve", async () => {
    const fixture = await createFixture();
    // 同 workspace 另一个会话也有 goal（goal-layer 默认开）：列表页/直接 ids 都不许
    // 发它解析不到的 target ref（resolveTarget 只读当前会话的 readTarget 行）。
    await fixture.store.setTarget({
      sessionID: fixture.sameWorkspaceSessionId,
      objective: "Other session objective",
    });

    const direct = await recall(fixture, {
      ids: [`session:${fixture.sameWorkspaceSessionId}`],
    });
    expect(direct.status).toBe("success");
    expect(direct.items[0].refs.filter((ref) => ref.startsWith("target:"))).toEqual([]);

    const listPage = await recall(fixture, { kind: "session", limit: 50 });
    expect(listPage.status).toBe("success");
    const currentItem = listPage.items.find((item) => item.id === `session:${fixture.sessionId}`);
    const sameWsItem = listPage.items.find(
      (item) => item.id === `session:${fixture.sameWorkspaceSessionId}`,
    );
    expect(currentItem).toBeDefined();
    expect(sameWsItem).toBeDefined();
    // 当前会话的 target ref 仍要发（这是 resolveTarget 唯一能读的行）。
    expect(currentItem!.refs).toContain(`target:${fixture.targetId}`);
    expect(sameWsItem!.refs.filter((ref) => ref.startsWith("target:"))).toEqual([]);

    // 链式召回归一不变量：列表页出现的每个 refs ID 都能用 ids 模式再次解析。
    const allRefs = listPage.items.flatMap((item) => item.refs);
    expect(allRefs.length).toBeGreaterThan(0);
    const resolved = await recall(fixture, { ids: allRefs });
    expect(resolved.status).toBe("success");
    expect(resolved.missing).toEqual([]);
    expect(resolved.items).toHaveLength(allRefs.length);
  });

  it("anchors wf-event next-hop on the last fully rendered event when the text budget breaks early", async () => {
    const fixture = await createFixture();
    const journal = createDwfJournalStore(fixture.db);
    const runId = "dwfrun-recall-budget";
    journal.createRun({
      runId,
      parentSessionId: String(fixture.sessionId),
      name: "budget run",
      caps: { maxConcurrency: 1 },
      spentTokens: 0,
      status: "completed",
    });
    // 每条 ~530 字符：4000 预算只够渲染前 7 条，break 早于端口页尾（20 条）。
    const pad = "a".repeat(500);
    for (let index = 0; index < 30; index++) {
      journal.appendEvent(runId, { type: "log", message: `step ${index + 1} ${pad}` });
    }
    const portFixture: Fixture = { ...fixture, runId };

    const firstPage = await recall(portFixture, { ids: [`wf-event:${runId}/0`] });
    expect(firstPage.status).toBe("success");
    const summaryLines = firstPage.items[0].summary.split("\n");
    const fullLines = summaryLines.filter((line) => !line.endsWith(TRUNCATION_MARKER));
    expect(fullLines.length).toBeGreaterThan(0);
    expect(fullLines.length).toBeLessThan(RECALL_WF_EVENT_PAGE_LIMIT);
    const renderedSeq = Number.parseInt(fullLines.at(-1)!.split(" ")[0], 10);
    // 回归：预算截断时旧实现按端口页末（seq 19）+1 发下一跳，seq 7..19 永久不可达。
    expect(renderedSeq).toBeLessThan(RECALL_WF_EVENT_PAGE_LIMIT - 1);
    const nextHop = firstPage.items[0].refs.find((ref) => ref.startsWith(`wf-event:${runId}/`));
    expect(nextHop).toBe(`wf-event:${runId}/${renderedSeq + 1}`);

    // 沿 refs 链走到头：30 条事件每条都至少被完整渲染一次，不跳不漏。
    const reached = new Set<number>(
      fullLines.map((line) => Number.parseInt(line.split(" ")[0], 10)),
    );
    let cursor: string | undefined = nextHop;
    let previousStart = 0;
    while (cursor) {
      const page = await recall(portFixture, { ids: [cursor] });
      expect(page.status).toBe("success");
      const item = page.items[0];
      const startSeq = Number.parseInt(item.id.split("/").at(-1)!, 10);
      expect(startSeq).toBeGreaterThan(previousStart);
      previousStart = startSeq;
      for (const line of item.summary.split("\n")) {
        if (line.endsWith(TRUNCATION_MARKER)) continue;
        reached.add(Number.parseInt(line.split(" ")[0], 10));
      }
      cursor = item.refs.find((ref) => ref.startsWith(`wf-event:${runId}/`));
    }
    for (let sequence = 1; sequence < 30; sequence++) {
      expect(reached.has(sequence)).toBe(true);
    }
  });

  it("advances past a first event that alone exceeds the page budget", async () => {
    const fixture = await createFixture();
    const journal = createDwfJournalStore(fixture.db);
    const runId = "dwfrun-recall-huge-first";
    journal.createRun({
      runId,
      parentSessionId: String(fixture.sessionId),
      name: "huge first",
      caps: { maxConcurrency: 1 },
      spentTokens: 0,
      status: "completed",
    });
    journal.appendEvent(runId, { type: "log", message: "b".repeat(6_000) });
    journal.appendEvent(runId, { type: "log", message: "second event" });
    const portFixture: Fixture = { ...fixture, runId };

    const firstPage = await recall(portFixture, { ids: [`wf-event:${runId}/0`] });
    expect(firstPage.status).toBe("success");
    expect(firstPage.items[0].summary.startsWith("0 ")).toBe(true);
    expect(firstPage.items[0].summary).toContain(TRUNCATION_MARKER);
    // 首条即超预算也要有推进（零推进死循环回归）。
    const nextHop = firstPage.items[0].refs.find((ref) => ref.startsWith(`wf-event:${runId}/`));
    expect(nextHop).toBe(`wf-event:${runId}/1`);

    const secondPage = await recall(portFixture, { ids: [nextHop!] });
    expect(secondPage.status).toBe("success");
    expect(secondPage.items[0].summary).toContain("second event");
  });

  it("reports honest truncation when the session listing hits the fetch cap", async () => {
    const fixture = await createFixture();
    // ws_recall 共 201 个会话：fetch 上限 200 触顶后，第 200 条之后必须可观测。
    const projectID = createProjectId("recall-project");
    for (let index = 0; index < 199; index++) {
      await fixture.store.createSession({
        id: createSessionId(`recall-cap-${index}`),
        projectID,
        workspaceID: "ws_recall" as WorkspaceId,
        slug: `recall-cap-${index}`,
        title: `Cap session ${index}`,
        directory: "/workspace/project",
        version: "test",
      });
    }

    // limit 上限 50：offset 0/50/100 均未触顶（可 peek 窗口外一条），offset 150 时
    // fetch=min(201,200)=200 触顶，窗口后无法再 peek → 必须 truncated + nextCursor。
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const listed = await recall(fixture, { kind: "session", limit: 50, ...(cursor ? { cursor } : {}) });
      expect(listed.items).toHaveLength(50);
      expect(listed.truncated).toBe(false);
      expect(listed.nextCursor).toBe(String((page + 1) * 50));
      cursor = listed.nextCursor;
    }

    const capped = await recall(fixture, { kind: "session", limit: 50, cursor: cursor! });
    expect(capped.items).toHaveLength(50);
    expect(capped.truncated).toBe(true);
    expect(capped.nextCursor).toBe("200");

    // offset 200：窗口已耗尽，空页 + truncated 收尾，不给 nextCursor（分页终止不空转）。
    const drained = await recall(fixture, {
      kind: "session",
      limit: 50,
      cursor: capped.nextCursor!,
    });
    expect(drained.items).toEqual([]);
    expect(drained.truncated).toBe(true);
    expect(drained.nextCursor).toBeUndefined();
  });

  it("answers capability_absent for unwired recall sources and missing ports", async () => {
    const fixture = await createFixture();

    const triggerKind = await recall(fixture, { kind: "trigger" });
    expect(triggerKind.status).toBe("capability_absent");
    expect(triggerKind.reason).toBe("recall_source_not_wired");

    const noRunPort = await recall(
      fixture,
      { ids: [`wf-run:${fixture.runId}`] },
      { dynamicWorkflowRunPort: undefined },
    );
    expect(noRunPort.status).toBe("capability_absent");
    expect(noRunPort.reason).toBe("missing_run_port");
  });
});
