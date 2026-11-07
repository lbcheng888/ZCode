import { describe, expect, it } from "vitest";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";

import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

describe("background task notification admission", () => {
  it("returns true only when the notification is actually enqueued", async () => {
    const sessionID = createSessionId("watchdog-notify-admission");
    const runtime = createTestAgentRuntime(
      sessionID,
      { mode: "build", workingDirectory: "/tmp/zcode-watchdog-notify" },
      { eventStore: createTestSessionEventStore() },
    );
    const traceContext = createRootTraceContext({ sessionId: sessionID });
    const notification = {
      text: "super-agent watchdog: trigger backlog is stale",
      toolName: "SuperAgentWatchdog",
      traceContext,
    };

    expect(runtime.enqueueBackgroundTaskNotification(notification)).toBe(true);

    // shutdown 后队列拒收：命令面据此返回失败，而不是虚报 notify 成功。
    runtime.beginShutdown();
    expect(runtime.enqueueBackgroundTaskNotification(notification)).toBe(false);
    await runtime.close();
  });
});
