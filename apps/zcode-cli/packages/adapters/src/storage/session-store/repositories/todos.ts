import type { DatabaseSync } from "node:sqlite";
import { SESSION_ENTRY_TODO_STATE, type SessionId, type TodoItem } from "@zcode/contracts";
import { decodeTodoRow } from "../codecs.js";
import type { TodoRow } from "../rows.js";
import { saveSessionEntry } from "./session-entries.js";
import { touchSession } from "./sessions.js";

export async function readTodos(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<TodoItem[]> {
  const rows = db
    .prepare(
      `
      select * from todo
      where session_id = ?
      order by position asc
      `,
    )
    .all(input.sessionID) as unknown as TodoRow[];

  return rows.map(decodeTodoRow);
}

export async function updateTodos(
  db: DatabaseSync,
  input: { sessionID: SessionId; todos: TodoItem[] },
): Promise<void> {
  const now = Date.now();

  db.exec("begin immediate");
  try {
    db.prepare("delete from todo where session_id = ?").run(input.sessionID);
    if (input.todos.length > 0) {
      const insert = db.prepare(
        `
        insert into todo (
          session_id, content, status, priority, position, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?)
        `,
      );

      for (const [position, todo] of input.todos.entries()) {
        insert.run(input.sessionID, todo.content, todo.status, todo.priority, position, now, now);
      }
    }
    // 原因：todo 表是 delete+insert，空表既可能是“从未写过”，也可能是“写过并清空”。
    // 冷恢复（尤其 fork/edit-retry 子会话）必须能区分两者，否则清空会在重启后复活旧 plan。
    // marker 与 todo 行在同一事务内落库：崩溃只会同时丢失两者，不会产生半写状态。
    // 值仍以 todo 表为权威，marker 只表达“本会话写过”这一持久事实。
    saveSessionEntry(db, {
      id: `todo_state:${input.sessionID}`,
      sessionID: input.sessionID,
      type: SESSION_ENTRY_TODO_STATE,
      time: { created: now, updated: now },
      data: { todosCount: input.todos.length, updatedAt: now },
      touchSession: false,
    });
    touchSession(db, input.sessionID, now);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
