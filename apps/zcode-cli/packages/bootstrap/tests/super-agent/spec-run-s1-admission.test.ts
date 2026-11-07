import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { evaluateChengGate } from "../../../cheng-contract/src/cheng-gate.js";
import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import {
  createSpecRunDispatcher,
  SpecRunGateBlockedError,
  type SpecRunDispatchInput,
  type SpecRunDispatcherDeps,
  type SpecRunLaunchRequest,
  type SuperAgentSpecLaneContract,
} from "../../src/super-agent/spec-lane/index.js";
import {
  createWriteLeases,
  WriteLeaseConflictError,
} from "../../src/super-agent/write-leases/index.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const PROXY_URL = "http://127.0.0.1:6543";
const WORKSPACE_ROOT = "/repo/spec-s1";

function input(triggerId: string, overrides: Partial<SpecRunDispatchInput> = {}): SpecRunDispatchInput {
  return {
    triggerId,
    workspaceIdentity: "ws-s1",
    threadKey: "thread-s1",
    source: "im",
    tier: "speculative",
    ...overrides,
  };
}

function fakeEgress(): {
  contract: SuperAgentSpecLaneContract;
  prepares: string[];
  stops: string[];
} {
  const prepares: string[] = [];
  const stops: string[] = [];
  return {
    prepares,
    stops,
    contract: {
      async prepareSpecRunEgress(request) {
        prepares.push(request.workspaceRoot);
        return {
          workspaceRoot: request.workspaceRoot,
          proxyUrl: PROXY_URL,
          networkPolicy: { httpProxy: PROXY_URL, noProxy: "" },
          allowHosts: request.allowHosts ?? [],
        };
      },
      async stopSpecRunEgress(workspaceRoot) {
        stops.push(workspaceRoot);
      },
    },
  };
}

function baseDeps(
  egress: SuperAgentSpecLaneContract,
  launch: (request: SpecRunLaunchRequest) => Promise<{ runId: string }>,
  overrides: Partial<SpecRunDispatcherDeps> = {},
): SpecRunDispatcherDeps {
  return {
    egress,
    buildProcessEnv: () => ({ HTTP_PROXY: PROXY_URL }),
    launch: { launch },
    resolveWorkspaceRoot: () => WORKSPACE_ROOT,
    ...overrides,
  };
}

describe("S1 spec run admission", () => {
  it("ChengGate red: rejects before lease, egress, or launch (zero outbound)", async () => {
    const egress = fakeEgress();
    const launch = vi.fn(async () => ({ runId: "run-1" }));
    const writeLease = {
      acquire: vi.fn(() => ({ id: "lease-1" })),
      release: vi.fn(() => true),
    };
    const dispatcher = createSpecRunDispatcher(
      baseDeps(egress.contract, launch, { writeLease }),
    );
    // 真实 ChengGate：缺 run/settle 回执的 production 输入必红。
    const redGate = evaluateChengGate({
      error: null,
      run: null,
      settle: null,
      structure: null,
      mode: "production",
    });
    expect(redGate.ok).toBe(false);

    await expect(
      dispatcher.start(input("trig-red", { chengGate: redGate })),
    ).rejects.toBeInstanceOf(SpecRunGateBlockedError);

    expect(writeLease.acquire).not.toHaveBeenCalled();
    expect(egress.prepares).toEqual([]);
    expect(egress.stops).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("write lease: a second spec run is rejected instead of queued, then release unblocks", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const leases = createWriteLeases(db);
    const egress = fakeEgress();
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const launch = vi.fn(async () => {
      await launchGate;
      return { runId: "run-1" };
    });
    const dispatcher = createSpecRunDispatcher(
      baseDeps(egress.contract, launch, { writeLease: leases }),
    );

    const first = dispatcher.start(input("trig-first"));
    expect(leases.getActive("ws-s1").map((row) => row.ownerRunId)).toEqual(["trig-first"]);

    // 第一写者仍持租约：第二写者必须在 acquire 处被拒，不进入 queue/egress/launch。
    await expect(dispatcher.start(input("trig-second"))).rejects.toBeInstanceOf(
      WriteLeaseConflictError,
    );
    expect(egress.prepares).toEqual([WORKSPACE_ROOT]);
    expect(launch).toHaveBeenCalledTimes(1);

    releaseLaunch();
    await first;
    expect(egress.stops).toEqual([WORKSPACE_ROOT]);
    expect(leases.getActive("ws-s1")).toEqual([]);
  });
});
