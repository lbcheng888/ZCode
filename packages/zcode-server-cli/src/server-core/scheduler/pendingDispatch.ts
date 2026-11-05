/**
 * Core scheduler 的 `dispatch_requests.pending_dispatch` 写入器（B-SPEC §4.4/§4.5）。
 *
 * 写者归属（§4.5）：`pending_dispatch` INSERT 只由 Core scheduler 写；`pushed` /
 * `dispatched` / `skipped` 的 CAS 只由 child 派发桥写。本文件只做 INSERT（幂等：
 * `run_id`/`command_id` 双 UNIQUE），绝不改状态列。
 *
 * 为什么单独开连接：`@zcode/services` 的 AutomationRepo 不暴露内部连接；Core 与
 * AutomationRepo 同进程、同库（WAL），第二个连接只写 pending 行，忙等预算与 services
 * 启动预算一致。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** 与其他 tasks-index 写者一致的忙等预算。 */
const BUSY_TIMEOUT_MS = 5_000;

export interface PendingDispatchInput {
  runId: string;
  workspaceIdentity: string;
  /**
   * 目标会话：绑定会话的 automation 用 `targetTaskId`（该域 taskId 即 v4 sessionId）；
   * 未绑定会话时为 null。派发桥 push 需要 sessionId，null 行由 bridge 响亮拒绝
   * （`dispatch.sessionRequired`），不会静默投递——未绑定会话的 createTask 面
   * 尚未接线，登记在交付说明。
   */
  sessionId: string | null;
  /** 派发载荷（automation.prompt）；桥 push 直接作为 sendText 文本。 */
  payload: string | null;
  now: number;
}

export interface PendingDispatchInsertResult {
  requestId: string;
  commandId: string;
  created: boolean;
}

export interface PendingDispatchWriter {
  /** 启动期校验 tasks-index 已迁移（缺表响亮失败，不在首次写入才暴露）。 */
  verify(): void;
  insert(input: PendingDispatchInput): PendingDispatchInsertResult;
  close(): void;
}

/**
 * commandId = sha256(runId)（§1.6）：崩溃重投同键，CommandInbox 幂等吸收。
 * 与 desktop scheduler / bootstrap dispatchBridge 同式，跨进程可复算。
 */
export function pendingDispatchCommandId(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}

/**
 * 打开 tasks-index 并校验 `dispatch_requests` 表存在。缺表 = tasks-index 未迁移：
 * 构造期响亮失败（B-SPEC §2.3/§8-6），不得静默建空表或推迟到首次写入才暴露。
 */
export function createPendingDispatchWriter(options: {
  databasePath: string;
  now?: () => number;
}): PendingDispatchWriter {
  const now = options.now ?? Date.now;
  let db: DatabaseSync | undefined;
  let closed = false;

  function getDb(): DatabaseSync {
    if (closed) throw new Error("pending dispatch writer 已关闭");
    if (!db) {
      // node:sqlite 开库会先落文件再 prepare；缺文件直接开会在抛错前留下 0 字节空库。
      // 与 bootstrap 桥构造同一判据：先探测存在性，不用「文件存在」当迁移证明，但也不
      // 制造假现场。
      if (!existsSync(options.databasePath)) {
        throw new Error(`tasks-index 数据库不存在: ${options.databasePath}`);
      }
      const opened = new DatabaseSync(options.databasePath);
      try {
        opened.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
        // 必须检查 sqlite_master 查询结果：缺表时 `.get()` 返回 undefined 而不抛错，
        // 只看是否抛错会让「未迁移」在启动期静默通过，推迟到首次 insert 才 no such table。
        const probe = opened
          .prepare(
            "select 1 as present from sqlite_master where type = 'table' and name = 'dispatch_requests'",
          )
          .get();
        if (!probe) throw new Error("dispatch_requests table missing");
      } catch (error) {
        opened.close();
        throw new Error(
          `tasks-index 未迁移（缺少 dispatch_requests 表）: ${options.databasePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      db = opened;
    }
    return db;
  }

  return {
    verify() {
      getDb();
    },
    insert(input) {
      const timestamp = input.now > 0 ? input.now : now();
      const commandId = pendingDispatchCommandId(input.runId);
      const requestId = randomUUID();
      const statement = getDb().prepare(
        `insert into dispatch_requests (
          id, run_id, command_id, workspace_identity, session_id, payload,
          status, skip_reason, dispatch_policy, attempts,
          claimed_at, pushed_at, acked_at, settled_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, 'pending_dispatch', NULL, 'in_window', 0,
          ?, NULL, NULL, NULL, ?, ?)
        on conflict do nothing`,
      );
      const result = statement.run(
        requestId,
        input.runId,
        commandId,
        input.workspaceIdentity,
        input.sessionId,
        input.payload,
        timestamp,
        timestamp,
        timestamp,
      );
      if (Number(result.changes) > 0) {
        return { requestId, commandId, created: true };
      }
      const existing = getDb()
        .prepare("select id, command_id from dispatch_requests where run_id = ?")
        .get(input.runId) as { id: string; command_id: string } | undefined;
      if (!existing) {
        // on conflict do nothing 后回读不到 = 约束/驱动异常，响亮失败（不猜已有行）。
        throw new Error(`dispatch_requests 行在幂等短路后消失: ${input.runId}`);
      }
      return {
        requestId: existing.id,
        commandId: String(existing.command_id),
        created: false,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        db?.close();
      } catch {
        // 关闭失败不掩盖调用方的收口路径。
      }
      db = undefined;
    },
  };
}
