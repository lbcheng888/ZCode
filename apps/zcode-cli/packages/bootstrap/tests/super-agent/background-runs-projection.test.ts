import { describe, expect, it } from "vitest";

import { backgroundRunViewSchema, statePatchSchema } from "@zcode/shared/zcode-protocol-v4";

import { projectBackgroundRuns } from "../../src/zcode-protocol/background-runs-projection.js";
import type { BackgroundRunRow } from "../../src/super-agent/watchdog/index.js";

function row(overrides: Partial<BackgroundRunRow> = {}): BackgroundRunRow {
  return {
    id: "run-1",
    kind: "cheng-job",
    owner: "cheng-host",
    state: "running",
    stallClockRef: "cheng-job:run-1",
    registeredAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("backgroundRuns v4 projection", () => {
  it("maps registry rows through the typed view and drops owner-internal clocks", () => {
    const [view] = projectBackgroundRuns([
      row({
        id: "cheng-1",
        ownerSession: "sess-1",
        workspaceKey: "ws-1",
        narrowResultRef: "cheng-run://m5-1",
        stalledSince: 2000,
      }),
    ]);
    expect(view).toMatchObject({
      id: "cheng-1",
      kind: "cheng-job",
      owner: "cheng-host",
      state: "running",
      ownerSession: "sess-1",
      workspaceKey: "ws-1",
      narrowResultRef: "cheng-run://m5-1",
      stalledSince: 2000,
      registeredAt: 1000,
      updatedAt: 1000,
    });
    expect(view).not.toHaveProperty("stallClockRef");
    expect(view).not.toHaveProperty("heartbeat");
  });

  it("keeps running rows ahead of newer terminal rows and applies the bound", () => {
    const oldRunning = row({ id: "active-old", updatedAt: 100 });
    const newerTerminal = row({
      id: "done-new",
      state: "completed",
      terminalAt: 9000,
      updatedAt: 9000,
    });
    const newestTerminal = row({
      id: "done-newest",
      state: "failed",
      terminalReason: "host_restarted",
      terminalAt: 10_000,
      updatedAt: 10_000,
    });
    const views = projectBackgroundRuns([newestTerminal, newerTerminal, oldRunning], 2);
    expect(views.map((view) => view.id)).toEqual(["active-old", "done-newest"]);
    expect(views[1]?.terminalReason).toBe("host_restarted");
  });

  it("publishes an explicit empty array and rejects an invalid bound", () => {
    expect(projectBackgroundRuns([])).toEqual([]);
    expect(() => projectBackgroundRuns([], -1)).toThrow(/non-negative integer/);
    expect(() => projectBackgroundRuns([], 1.5)).toThrow(/non-negative integer/);
  });

  it("is the closed shape behind StatePatch.backgroundRuns", () => {
    const views = projectBackgroundRuns([row()]);
    expect(statePatchSchema.parse({ backgroundRuns: views }).backgroundRuns).toEqual(views);
    const unknownKind = { ...views[0], kind: "future-kind" };
    expect(backgroundRunViewSchema.safeParse(unknownKind).success).toBe(false);
    expect(() => statePatchSchema.parse({ backgroundRuns: [unknownKind] })).toThrow();
  });
});
