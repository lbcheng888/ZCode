import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createRootTraceContext, createSessionId, createTurnId } from "@zcode/contracts";

import {
  createWorkspaceWriteLeaseAdmission,
  WorkspaceWriteLeaseRejectedError,
} from "../../src/app/create-app.js";
import { createSpecRunSubagentLaunchPort } from "../../src/super-agent/spec-lane/index.js";
import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createWriteLeases } from "../../src/super-agent/write-leases/index.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("workspace write lease admission", () => {
  it("rejects a manual writer while a spec run owns the lease; owner and release unblock", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const leases = createWriteLeases(db);
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const lease = leases.acquire({
      workspaceIdentity: "ws-canonical",
      ownerRunId: "run-spec-1",
      scope: JSON.stringify(["/repo"]),
      leaseExpiresAt: now + 30 * 60_000,
      now,
    });

    const port = createWorkspaceWriteLeaseAdmission({
      getLeases: () => leases,
      getWorkspaceIdentity: () => "ws-canonical",
    });

    // 手动 session/subagent：没有 ownerRunId，即使 workspaceRoot 不同也命中同一 canonical lease。
    expect(() =>
      port.assertWriteAllowed({
        toolName: "Write",
        workspaceRoot: "/repo",
        paths: ["/repo/a.ts"],
      }),
    ).toThrow(WorkspaceWriteLeaseRejectedError);
    try {
      port.assertWriteAllowed({
        toolName: "Edit",
        workspaceRoot: "/repo",
        paths: ["/repo/a.ts"],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceWriteLeaseRejectedError);
      expect((error as WorkspaceWriteLeaseRejectedError).activeOwnerRunId).toBe("run-spec-1");
      expect((error as WorkspaceWriteLeaseRejectedError).code).toBe(
        "workspace_write_lease_conflict",
      );
    }

    // spec run owner 自己的写必须放行；错误 owner 仍拒绝。
    expect(() =>
      port.assertWriteAllowed({
        toolName: "Write",
        workspaceRoot: "/repo",
        ownerRunId: "run-spec-1",
        paths: ["/repo/a.ts"],
      }),
    ).not.toThrow();
    expect(() =>
      port.assertWriteAllowed({
        toolName: "Write",
        workspaceRoot: "/repo",
        ownerRunId: "run-manual",
        paths: ["/repo/a.ts"],
      }),
    ).toThrow(WorkspaceWriteLeaseRejectedError);

    leases.release(lease.id, now);
    expect(() =>
      port.assertWriteAllowed({
        toolName: "Write",
        workspaceRoot: "/repo",
        paths: ["/repo/a.ts"],
      }),
    ).not.toThrow();
  });

  it("fails closed before the late-bound repository is initialized", () => {
    const port = createWorkspaceWriteLeaseAdmission({
      getLeases: () => undefined,
      getWorkspaceIdentity: () => "ws-canonical",
    });
    expect(() =>
      port.assertWriteAllowed({ toolName: "Write", workspaceRoot: "/repo", paths: [] }),
    ).toThrow(/not initialized/);
  });

  it("passes the spec trigger id as the child run write-lease owner", async () => {
    const sessionId = createSessionId("lease-launch-owner");
    const turnId = createTurnId("lease-launch-owner");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const launchSubagent = vi.fn(async () => ({ status: "completed", agentId: "run-child" }));
    const close = vi.fn(async () => {});
    const port = createSpecRunSubagentLaunchPort({
      parentSessionId: sessionId,
      traceContext,
      launchSubagent: launchSubagent as never,
      createExecutionPort: () => ({ close }) as never,
    });
    const proxyUrl = "http://127.0.0.1:6543";
    await port.launch({
      workspaceRoot: "/repo",
      form: "subagent",
      profile: { name: "spec" } as never,
      processEnv: { HTTP_PROXY: proxyUrl },
      network: { httpProxy: proxyUrl, noProxy: "" },
      prompt: "spec run",
      trigger: {
        triggerId: "trig-lease-owner",
        workspaceIdentity: "ws-canonical",
        threadKey: "thread",
        source: "im",
        tier: "speculative",
      },
    });

    expect(launchSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: "/repo" }),
      expect.objectContaining({ writeLeaseOwnerRunId: "trig-lease-owner" }),
    );
  });
});
