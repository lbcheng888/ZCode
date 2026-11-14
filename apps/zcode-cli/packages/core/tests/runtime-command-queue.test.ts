import { describe, expect, it, vi } from "vitest";
import { createRuntimeCommandQueue } from "../src/runtime/command-queue.js";
import type {
  RuntimeCommand,
  RuntimeCommandId,
  RuntimeCommandPriority,
} from "../src/runtime/command-queue.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  acquireForegroundPromotionLease,
  drainRuntimeCommandQueue,
  enqueueRuntimeCommand,
  releaseForegroundPromotionLease,
  stopActiveForegroundExecution,
} from "../src/runtime/methods/runtime-command-queue.js";
import { createTurnCancelledError } from "../src/runtime/helpers/index.js";

function command(id: string, priority: RuntimeCommandPriority): RuntimeCommand {
  return {
    createdAt: new Date(`2026-06-29T00:00:0${id.at(-1) ?? "0"}.000Z`),
    id: id as RuntimeCommandId,
    mode: "task-notification",
    priority,
    source: "background_task",
    text: `<task-notification><task-id>${id}</task-id></task-notification>`,
    traceContext: {
      sessionId: "sess_runtime_command_queue",
      spanId: `span_${id}`,
      traceId: "trace_runtime_command_queue",
    },
  } as RuntimeCommand;
}

function promptCommand(
  id: string,
  priority: RuntimeCommandPriority,
  inputId?: string,
): RuntimeCommand {
  return {
    createdAt: new Date("2026-06-29T00:01:00.000Z"),
    id: id as RuntimeCommandId,
    input: id,
    mode: "prompt",
    ...(inputId ? { options: { inputId } } : {}),
    priority,
    reject: () => {},
    resolve: () => {},
    traceContext: {
      sessionId: "sess_runtime_command_queue",
      spanId: `span_${id}`,
      traceId: "trace_runtime_command_queue",
    },
  } as RuntimeCommand;
}

describe("RuntimeCommandQueue", () => {
  it("dequeues commands by priority before FIFO order", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(command("later-1", "later"));
    queue.enqueue(command("next-1", "next"));
    queue.enqueue(command("now-1", "now"));
    queue.enqueue(command("next-2", "next"));

    expect(queue.dequeue()?.id).toBe("now-1");
    expect(queue.dequeue()?.id).toBe("next-1");
    expect(queue.dequeue()?.id).toBe("next-2");
    expect(queue.dequeue()?.id).toBe("later-1");
    expect(queue.dequeue()).toBeUndefined();
  });

  it("dequeues all same-priority task notifications as one frozen batch", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(command("next-1", "next"));
    queue.enqueue(command("next-2", "next"));
    queue.enqueue(command("later-1", "later"));

    const batch = queue.dequeueNextBatch();

    expect(Object.isFrozen(batch)).toBe(true);
    expect(batch.map((item) => item.id)).toEqual(["next-1", "next-2"]);
    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["later-1"]);
    expect(queue.dequeueNextBatch()).toEqual([]);
  });

  it("collects task notifications across later same-priority modes", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(command("next-1", "next"));
    queue.enqueue(promptCommand("prompt-1", "next"));
    queue.enqueue(command("next-2", "next"));

    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["next-1", "next-2"]);
    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["prompt-1"]);
  });

  it("does not batch past a higher-priority or earlier same-priority command", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(promptCommand("prompt-next", "next"));
    queue.enqueue(command("notification-next-1", "next"));
    queue.enqueue(promptCommand("prompt-now", "now"));
    queue.enqueue(command("notification-next-2", "next"));
    queue.enqueue(command("notification-later", "later"));

    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["prompt-now"]);
    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["prompt-next"]);
    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual([
      "notification-next-1",
      "notification-next-2",
    ]);
    expect(queue.dequeueNextBatch().map((item) => item.id)).toEqual(["notification-later"]);
  });

  it("returns a frozen snapshot that cannot mutate the queue", () => {
    const queue = createRuntimeCommandQueue();
    queue.enqueue(command("next-1", "next"));

    const snapshot = queue.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as RuntimeCommand[]).push(command("now-1", "now"));
    }).toThrow();
    expect(queue.size()).toBe(1);
  });

  it("removes queued commands by id without touching other priorities", () => {
    const queue = createRuntimeCommandQueue();
    queue.enqueue(command("later-1", "later"));
    queue.enqueue(command("next-1", "next"));
    queue.enqueue(command("now-1", "now"));

    const removed = queue.removeById("next-1" as RuntimeCommandId);

    expect(removed?.id).toBe("next-1");
    expect(queue.size()).toBe(2);
    expect(queue.dequeue()?.id).toBe("now-1");
    expect(queue.dequeue()?.id).toBe("later-1");
  });

  it("returns all commands at or above the requested priority rank in enqueue order", () => {
    const queue = createRuntimeCommandQueue();

    queue.enqueue(command("later-1", "later"));
    queue.enqueue(command("next-1", "next"));
    queue.enqueue(command("now-1", "now"));
    queue.enqueue(command("next-2", "next"));
    queue.enqueue(command("later-2", "later"));

    const selected = queue.getByMaxPriority("next");

    expect(selected.map((item) => item.id)).toEqual(["next-1", "now-1", "next-2"]);
    expect(queue.size()).toBe(5);
    for (const item of selected) {
      queue.removeById(item.id);
    }
    expect(queue.size()).toBe(2);
    expect(queue.dequeue()?.id).toBe("later-1");
    expect(queue.dequeue()?.id).toBe("later-2");
    expect(queue.dequeue()).toBeUndefined();
  });

  it("tracks cancel-pending ids when removal races with dequeue", () => {
    const queue = createRuntimeCommandQueue();
    const id = "next-1" as RuntimeCommandId;

    expect(queue.consumeCancelPending(id)).toBe(false);
    queue.markCancelPending(id);

    expect(queue.consumeCancelPending(id)).toBe(true);
    expect(queue.consumeCancelPending(id)).toBe(false);
  });

  it("holds earlier runtime work until the leased promoted command is runnable", async () => {
    const executionOrder: string[] = [];
    const runtime = {
      activeForegroundExecution: undefined,
      activeTurn: undefined,
      activeTurnStartReservation: undefined,
      executeTurnCommand: vi.fn().mockImplementation(async (input: string) => {
        executionOrder.push(input);
        return {};
      }),
      foregroundPromotionLease: undefined,
      runtimeCommandDrainActive: false,
      runtimeCommandQueue: createRuntimeCommandQueue(),
    } as unknown as AgentRuntimeInternal;

    expect(
      acquireForegroundPromotionLease.call(runtime, {
        leaseId: "lease-bg44",
        mode: "after-current",
        promotedInputId: "lease-bg44",
      }),
    ).toEqual({ kind: "acquired", leaseId: "lease-bg44" });
    runtime.runtimeCommandQueue.enqueue(promptCommand("notification-b", "next"));

    await drainRuntimeCommandQueue.call(runtime);
    expect(executionOrder).toEqual([]);
    expect(runtime.runtimeCommandQueue.size()).toBe(1);

    runtime.runtimeCommandQueue.enqueue(promptCommand("promoted-prompt", "next", "lease-bg44"));
    await drainRuntimeCommandQueue.call(runtime);

    expect(executionOrder).toEqual(["promoted-prompt", "notification-b"]);
    expect(runtime.foregroundPromotionLease).toBeUndefined();
  });

  it("rejects idle-only acquisition while runtime work is pending", () => {
    const runtime = {
      activeForegroundExecution: undefined,
      activeTurn: undefined,
      activeTurnStartReservation: undefined,
      foregroundPromotionLease: undefined,
      runtimeCommandDrainActive: false,
      runtimeCommandQueue: createRuntimeCommandQueue(),
    } as unknown as AgentRuntimeInternal;
    runtime.runtimeCommandQueue.enqueue(promptCommand("notification-b", "next"));

    expect(
      acquireForegroundPromotionLease.call(runtime, {
        leaseId: "auto-drain-bg43",
        mode: "idle-only",
        promotedInputId: "notification-b",
      }),
    ).toEqual({ kind: "busy" });
  });
});

describe("RuntimeCommandQueue drain failure isolation", () => {
  function settledPromptCommand(
    id: string,
    priority: RuntimeCommandPriority,
  ): { command: RuntimeCommand; completion: Promise<unknown> } {
    let resolve!: (result: unknown) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return {
      command: { ...promptCommand(id, priority), reject, resolve } as RuntimeCommand,
      completion,
    };
  }

  // 先挂上结算观察，保证命令 promise 的拒绝不会在测试自己 await 之前被判定为 unhandled。
  function observeCompletion(completion: Promise<unknown>): Promise<Record<string, unknown>> {
    return completion.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
  }

  it.each([
    ["普通错误", () => new Error("turn failed")],
    ["TurnCancelled", () => createTurnCancelledError(new Error("send-now preempted the turn"))],
  ] as const)("rejects a failed prompt (%s) and keeps draining later commands", async (
    _label,
    createFailure,
  ) => {
    const executionOrder: string[] = [];
    const failure = createFailure();
    const runtime = {
      activeForegroundExecution: undefined,
      activeTurn: undefined,
      activeTurnStartReservation: undefined,
      executeTurnCommand: vi.fn(async (input: string) => {
        executionOrder.push(input);
        if (input === "first-prompt") throw failure;
        return {};
      }),
      foregroundPromotionLease: undefined,
      runtimeCommandDrainActive: false,
      runtimeCommandQueue: createRuntimeCommandQueue(),
    } as unknown as AgentRuntimeInternal;
    const first = settledPromptCommand("first-prompt", "next");
    const second = settledPromptCommand("second-prompt", "later");
    const firstOutcome = observeCompletion(first.completion);
    const secondOutcome = observeCompletion(second.completion);
    runtime.runtimeCommandQueue.enqueue(first.command);
    runtime.runtimeCommandQueue.enqueue(second.command);

    await expect(drainRuntimeCommandQueue.call(runtime)).resolves.toBeUndefined();
    expect(await firstOutcome).toEqual({ error: failure });
    expect(await secondOutcome).toEqual({ result: {} });
    expect(executionOrder).toEqual(["first-prompt", "second-prompt"]);
  });

  it("keeps draining when send-now preempts a running prompt and enqueues the next message", async () => {
    const executionOrder: string[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const cancelled = createTurnCancelledError(new Error("send-now preempted the turn"));
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const first = settledPromptCommand("preempted-prompt", "next");
      const second = settledPromptCommand("send-now-prompt", "now");
      const firstOutcome = observeCompletion(first.completion);
      const secondOutcome = observeCompletion(second.completion);
      const runtime = {
        activeForegroundExecution: undefined,
        activeTurn: undefined,
        activeTurnStartReservation: undefined,
        drainRuntimeCommandQueue: vi.fn(() => drainRuntimeCommandQueue.call(runtime)),
        executeTurnCommand: vi.fn(
          async (
            input: string,
            _attachments: unknown,
            options?: { abortSignal?: AbortSignal },
          ) => {
            executionOrder.push(input);
            if (input !== "preempted-prompt") return {};
            // 模拟 send-now：取消正在跑的 turn，再把用户新消息排进队列。
            stopActiveForegroundExecution.call(runtime, {
              preserveQueueAutoDrainOnCancel: true,
            });
            expect(options?.abortSignal?.aborted).toBe(true);
            enqueueRuntimeCommand.call(runtime, second.command);
            throw cancelled;
          },
        ),
        foregroundPromotionLease: undefined,
        runtimeCommandDrainActive: false,
        runtimeCommandQueue: createRuntimeCommandQueue(),
      } as unknown as AgentRuntimeInternal;
      runtime.runtimeCommandQueue.enqueue(first.command);

      await expect(drainRuntimeCommandQueue.call(runtime)).resolves.toBeUndefined();
      expect(await firstOutcome).toEqual({ error: cancelled });
      expect(await secondOutcome).toEqual({ result: {} });
      expect(executionOrder).toEqual(["preempted-prompt", "send-now-prompt"]);
      // 让事件循环把可能的未处理拒绝暴露出来，再断言确实一条都没有。
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("logs both fire-and-forget drain failures instead of leaking them", async () => {
    const drainError = new Error("queue drain failed");
    const logError = vi.fn();
    const runtime = {
      drainRuntimeCommandQueue: vi.fn(async () => {
        throw drainError;
      }),
      foregroundPromotionLease: {
        leaseId: "lease-drain-failure",
        promotedInputId: "prompt-drain-failure",
      },
      logger: { error: logError },
      runtimeCommandQueue: createRuntimeCommandQueue(),
    } as unknown as AgentRuntimeInternal;

    enqueueRuntimeCommand.call(runtime, promptCommand("prompt-drain-failure", "next"));
    expect(releaseForegroundPromotionLease.call(runtime, "lease-drain-failure")).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(logError).toHaveBeenCalledTimes(2);
    for (const call of logError.mock.calls) {
      expect(call[0]).toBe("Runtime command queue drain failed");
      expect(call[1]).toBe(drainError);
      expect(call[2]).toMatchObject({
        errorMessage: "queue drain failed",
        event: "runtime_command_queue.drain_failed",
        module: "core.runtime",
        status: "failed",
      });
    }
  });
});
