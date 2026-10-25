import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createSessionId,
  formatTodoStateForModel,
  todoItemsFromToolResultContent,
  type SessionEvent,
  type SessionStorePort,
  type TodoItem,
} from "@zcode/contracts";
import { todoReadHandler, todoWriteHandler } from "../src/tool/handlers/todo.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

describe("todo tools", () => {
  it("writes and reads session-local todos through the session store port", async () => {
    const store = createTodoStore();
    const context = createContext(store);

    const write = await todoWriteHandler(
      {
        todos: [
          {
            content: "Review v2 spec",
            priority: "high",
            status: "completed",
          },
          {
            content: "Implement TodoWrite",
            priority: "medium",
            status: "in_progress",
          },
        ],
      },
      context,
    );
    const read = await todoReadHandler({}, context);

    expect(write).toEqual({
      oldTodos: [],
      todos: [
        {
          content: "Review v2 spec",
          priority: "high",
          status: "completed",
        },
        {
          content: "Implement TodoWrite",
          priority: "medium",
          status: "in_progress",
        },
      ],
      summary: {
        completed: 1,
        inProgress: 1,
        pending: 0,
        total: 2,
      },
    });
    expect(read).toEqual({
      todos: write.todos,
    });
  });

  it("allows multiple in-progress todos and updates state", async () => {
    const store = createTodoStore();
    const context = createContext(store);

    const write = await todoWriteHandler(
      {
        todos: [
          {
            content: "First active task",
            priority: "high",
            status: "in_progress",
          },
          {
            content: "Second active task",
            priority: "medium",
            status: "in_progress",
          },
        ],
      },
      context,
    );

    expect(write.summary.inProgress).toBe(2);
    await expect(todoReadHandler({}, context)).resolves.toEqual({ todos: write.todos });
  });

  it("emits an authoritative TodosUpdated event only after the write succeeds", async () => {
    const store = createTodoStore();
    const emitted: SessionEvent[] = [];
    const previous: TodoItem[] = [{ content: "Old step", priority: "low", status: "pending" }];
    await store.updateTodos({ sessionID: createSessionId("todo-tool"), todos: previous });

    const order: string[] = [];
    const baseUpdate = store.updateTodos.bind(store);
    store.updateTodos = async (input) => {
      order.push("write");
      await baseUpdate(input);
    };
    const context = createContext(store, async (event) => {
      order.push("emit");
      emitted.push(event);
    });

    const write = await todoWriteHandler(
      {
        todos: [
          { content: "Ship projection", priority: "high", status: "in_progress" },
          { content: "Old step", priority: "low", status: "completed" },
        ],
      },
      context,
    );

    expect(order).toEqual(["write", "emit"]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: SessionEventType.TodosUpdated,
      sessionId: context.sessionId,
      payload: {
        previousTodos: previous,
        todos: write.todos,
      },
    });
  });

  it("does not emit TodosUpdated when the todo write fails", async () => {
    const store = createTodoStore();
    store.updateTodos = async () => {
      throw new Error("disk full");
    };
    const emitted: SessionEvent[] = [];
    const context = createContext(store, async (event) => {
      emitted.push(event);
    });

    await expect(
      todoWriteHandler(
        { todos: [{ content: "Never lands", priority: "high", status: "pending" }] },
        context,
      ),
    ).rejects.toThrow("disk full");
    expect(emitted).toEqual([]);
  });

  it("parses serialized TodoRead and TodoWrite outputs for projections", () => {
    const todos: TodoItem[] = [
      {
        content: "Project ACP plan entries",
        priority: "high",
        status: "in_progress",
      },
    ];

    expect(todoItemsFromToolResultContent(JSON.stringify({ todos }))).toEqual(todos);
    expect(
      todoItemsFromToolResultContent(
        JSON.stringify({
          oldTodos: [],
          todos,
          summary: {
            completed: 0,
            inProgress: 1,
            pending: 0,
            total: 1,
          },
        }),
      ),
    ).toEqual(todos);
    expect(formatTodoStateForModel(todos)).toContain(
      "1. [in_progress][high] Project ACP plan entries",
    );
    expect(todoItemsFromToolResultContent("{not-json")).toBeUndefined();
  });
});

function createTodoStore(): SessionStorePort {
  const todos = new Map<string, TodoItem[]>();

  return {
    async readTodos(input) {
      return [...(todos.get(input.sessionID) ?? [])];
    },
    async updateTodos(input) {
      todos.set(
        input.sessionID,
        input.todos.map((todo) => ({ ...todo })),
      );
    },
  } as unknown as SessionStorePort;
}

function createContext(
  sessionStore: SessionStorePort,
  emitEvent?: (event: SessionEvent) => Promise<void>,
): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: createSessionId("todo-tool"),
    sessionStore,
    ...(emitEvent ? { emitEvent } : {}),
    toolCallId: "todo-call",
    traceId: "trace-todo" as never,
    workingDirectory: "/tmp/zcode-todo-tool",
    workspaceRoot: "/tmp/zcode-todo-tool",
  };
}
