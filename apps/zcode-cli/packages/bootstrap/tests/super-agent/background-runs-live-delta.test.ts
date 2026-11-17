import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectId,
  createSessionId,
  SessionEventType,
  type SessionEvent,
} from "@zcode/contracts";
import {
  DELIVERY_PROFILES,
  type BackgroundRunView,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";

import { BackgroundRunRegistry } from "../../src/super-agent/watchdog/registry.js";
import { projectBackgroundRuns } from "../../src/zcode-protocol/background-runs-projection.js";
import { ConversationV4Gateway } from "../../src/zcode-protocol-v4/v4-gateway.js";

describe("backgroundRuns[] live delta bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces (<= 250ms) started, progress, and terminal transitions into state.updated deltas", async () => {
    const registry = new BackgroundRunRegistry(100);
    const frames: ConversationTopicFrame[] = [];
    const gateway = new ConversationV4Gateway({
      sessionExists: () => true,
      getSessionMeta: () => ({
        projectId: createProjectId("proj-1"),
        workspace: "/tmp/ws",
      }),
      emitWireFrame: (routed) => {
        frames.push(routed.frame);
      },
      executeCommand: async () => ({
        commandId: "cmd-1",
        status: "completed",
      }),
      loadPersistedEvents: async () => ({ events: [], synthesized: false }),
      getSessionBackgroundRunsSeed: () => projectBackgroundRuns(registry.list()),
    });

    const sessionId = createSessionId("session-1");
    const createdEvent: SessionEvent = {
      eventId: "evt-1" as SessionEvent["eventId"],
      seq: 1,
      type: SessionEventType.SessionCreated,
      sessionId,
      timestamp: 1_796_000_000_000,
      payload: {
        projectId: createProjectId("proj-1"),
        workspace: "/tmp/ws",
      },
    };
    gateway.ingest(sessionId, createdEvent);

    const subscription = await gateway.subscribe({
      connectionId: "conn-1",
      topic: `conversation/${sessionId}`,
      clientMode: "desktop-continuous",
    });
    subscription.commit();

    const unsubscribe = registry.subscribe(() => {
      gateway.scheduleBackgroundRunsRefresh(sessionId, 150);
    });

    // Rapid started + progress within 150ms should coalesce into 1 delta
    registry.register(
      {
        id: "cheng-job-1",
        kind: "cheng-job",
        owner: "cheng-host",
        ownerSession: sessionId,
        workspaceKey: "/tmp/ws",
      },
      1_796_000_000_100,
    );
    registry.touch("cheng-job-1", "cheng-host", {}, 1_796_000_000_200);

    vi.advanceTimersByTime(149);
    expect(frames.filter((f) => f.payload.kind === "deltas")).toHaveLength(0);

    vi.advanceTimersByTime(1 + DELIVERY_PROFILES.continuous.flushWindowMs);
    const afterStartDeltas = frames.filter((f) => f.payload.kind === "deltas");
    expect(afterStartDeltas).toHaveLength(1);
    const firstFrame = afterStartDeltas[0]!;
    if (firstFrame.payload.kind !== "deltas") throw new Error("expected deltas");
    const startPatch = firstFrame.payload.deltas.find((d) => d.op === "state.updated");
    if (startPatch?.op !== "state.updated") throw new Error("expected state.updated");
    expect((startPatch.patch.backgroundRuns as BackgroundRunView[])[0]).toMatchObject({
      id: "cheng-job-1",
      state: "running",
      updatedAt: 1_796_000_000_200,
    });

    // Terminal transition also emits live delta
    registry.settle("cheng-job-1", "cheng-host", "completed", 1_796_000_000_300);
    vi.advanceTimersByTime(150 + DELIVERY_PROFILES.continuous.flushWindowMs);
    const afterTerminalDeltas = frames.filter((f) => f.payload.kind === "deltas");
    expect(afterTerminalDeltas).toHaveLength(2);
    const secondFrame = afterTerminalDeltas[1]!;
    if (secondFrame.payload.kind !== "deltas") throw new Error("expected deltas");
    const terminalPatch = secondFrame.payload.deltas.find((d) => d.op === "state.updated");
    if (terminalPatch?.op !== "state.updated") throw new Error("expected state.updated");
    expect((terminalPatch.patch.backgroundRuns as BackgroundRunView[])[0]).toMatchObject({
      id: "cheng-job-1",
      state: "completed",
      updatedAt: 1_796_000_000_300,
    });

    unsubscribe();
    gateway.dispose();
  });
});
