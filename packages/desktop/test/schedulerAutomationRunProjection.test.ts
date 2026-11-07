import { describe, expect, it, vi } from "vitest";

import { registerClaimedAutomationRun } from "../src/scheduler/automationRunProjection.js";

describe("scheduler automation run projection", () => {
  it("maps scheduled and manual claims to the shared automation row shape", () => {
    const register = vi.fn();
    registerClaimedAutomationRun(
      { register },
      { runId: "auto-1:1700000000000", workspaceKey: "/ws/a" },
    );
    registerClaimedAutomationRun(
      { register },
      {
        runId: "auto-1:manual:run-1",
        workspaceKey: "/ws/a",
        ownerSession: "session-1",
      },
    );

    expect(register.mock.calls).toEqual([
      [
        {
          id: "auto-1:1700000000000",
          kind: "automation",
          owner: "automation",
          workspaceKey: "/ws/a",
        },
      ],
      [
        {
          id: "auto-1:manual:run-1",
          kind: "automation",
          owner: "automation",
          workspaceKey: "/ws/a",
          ownerSession: "session-1",
        },
      ],
    ]);
  });
});
