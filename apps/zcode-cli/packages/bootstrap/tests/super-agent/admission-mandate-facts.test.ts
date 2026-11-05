// M4 mandateFacts 生产者：控制面按 triggerId 解析真 mandate 契约，供 create-app 在
// handleCommand 入口登记、input-facade 在 admission 前取出。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSuperAgentControlPlane,
  type SuperAgentControlPlane,
} from "../../src/app/super-agent-control-plane.js";
import {
  createSuperAgentAdmissionMandateFactsRegistry,
  processSuperAgentAdmissionMandateFacts,
} from "../../src/app/super-agent-admission-facts.js";

const WS = "ws-admission-facts";
const THREAD_KEY = `${WS}|bot:b1+u1`;
const TRIGGER_ID = "trigger-admission-facts";
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const roots: string[] = [];
const planes: SuperAgentControlPlane[] = [];

afterEach(async () => {
  for (const plane of planes.splice(0)) {
    try {
      plane.stop();
    } catch {
      // 重复关闭不掩盖断言失败。
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function insertTriggerEvent(
  plane: SuperAgentControlPlane,
  options: { fastPath?: string | null; workspaceIdentity?: string; id?: string } = {},
): void {
  const fastPath = options.fastPath === undefined ? "owned" : options.fastPath;
  plane.database
    .prepare(
      `insert into trigger_events (
        id, workspace_identity, source, thread_key, actor_kind, payload, payload_digest,
        taint, fast_path, created_at, updated_at
      ) values (?, ?, 'bot', ?, 'bot', '{}', 'digest', 1, ?, ?, ?)`,
    )
    .run(
      options.id ?? TRIGGER_ID,
      options.workspaceIdentity ?? WS,
      THREAD_KEY,
      fastPath,
      NOW,
      NOW,
    );
}

async function makePlane(mandateGate: boolean): Promise<SuperAgentControlPlane> {
  const root = await mkdtemp(join(tmpdir(), "zcode-sa-admission-"));
  roots.push(root);
  const plane = await createSuperAgentControlPlane({
    workspaceIdentity: WS,
    ownerId: `owner-${root}`,
    onError: vi.fn(),
    sessionFace: { sessionId: "session-admission-facts", isIdle: () => true },
    hostPorts: {
      handleCommand: async () => ({ commandId: "noop", status: "accepted", revisionAtDecision: 0 }),
      autoReplyGuard: { admit: async () => true },
      superAgentDatabasePath: join(root, "super-agent.sqlite"),
    },
    adjudicationSession: { run: async () => "", destroySession: vi.fn() },
    mandateGate,
    now: () => NOW,
  });
  planes.push(plane);
  return plane;
}

describe("M4 mandateFacts 生产者（resolveAdmissionMandateFacts）", () => {
  it("mandateGate 关（缺省）：恒不产事件事实，flag 关字节兼容", async () => {
    const plane = await makePlane(false);
    insertTriggerEvent(plane);
    expect(plane.resolveAdmissionMandateFacts(TRIGGER_ID)).toBeUndefined();
  });

  it("mandateGate 开 + 显式 auto 行：输出带 mandateId/expiresAt 的 typed 结论", async () => {
    const plane = await makePlane(true);
    insertTriggerEvent(plane);
    const inserted = plane.contracts.mandateRepo.insert({
      workspaceIdentity: WS,
      triggerClass: "bot:b1",
      tier: "auto",
      policyVersion: 1,
      expiresAt: NOW + 60_000,
      now: NOW,
    });

    expect(plane.resolveAdmissionMandateFacts(TRIGGER_ID)).toEqual({
      kind: "mandate",
      facts: {
        triggerId: TRIGGER_ID,
        tier: "auto",
        mandateId: inserted.id,
        expiresAt: NOW + 60_000,
      },
    });
  });

  it("mandateGate 开 + 无显式行：隐式 record_only（expiresAt=null）", async () => {
    const plane = await makePlane(true);
    insertTriggerEvent(plane);
    expect(plane.resolveAdmissionMandateFacts(TRIGGER_ID)).toEqual({
      kind: "mandate",
      facts: {
        triggerId: TRIGGER_ID,
        tier: "record_only",
        expiresAt: null,
      },
    });
  });

  it("human_explicit 直通：免 mandate，返回 exempt（按既有 user-origin 执行）", async () => {
    const plane = await makePlane(true);
    insertTriggerEvent(plane, { fastPath: "human_explicit" });
    expect(plane.resolveAdmissionMandateFacts(TRIGGER_ID)).toEqual({
      kind: "human_explicit_exempt",
    });
  });

  it("mandateGate 开 + trigger 行缺失：响亮抛错，不静默按 record_only 放行", async () => {
    const plane = await makePlane(true);
    expect(() => plane.resolveAdmissionMandateFacts("missing-trigger")).toThrow(
      /缺少 trigger 行/,
    );
  });

  it("跨 workspace 的 trigger 行：响亮抛错，不在本 workspace 执行", async () => {
    const plane = await makePlane(true);
    insertTriggerEvent(plane, { workspaceIdentity: "ws-other" });
    expect(() => plane.resolveAdmissionMandateFacts(TRIGGER_ID)).toThrow(/跨 workspace/);
  });

  it("Fast Path 未收敛（fast_path=NULL）：响亮抛错，不按隐式档放行", async () => {
    const plane = await makePlane(true);
    insertTriggerEvent(plane, { fastPath: null });
    expect(() => plane.resolveAdmissionMandateFacts(TRIGGER_ID)).toThrow(/未路由/);
  });

  it("mandateGate 开：owned 事件的 guide 车道被拒绝，不放行绕过 mandate 门", async () => {
    const plane = await makePlane(true);
    insertTriggerEvent(plane);
    plane.contracts.trigger.upsertSubscription({
      lane: "guide",
      now: NOW,
      ownerKind: "session",
      sessionId: "session-admission-facts",
      threadKey: THREAD_KEY,
      workspaceIdentity: WS,
    });
    const outcome = await plane.contracts.trigger.routeOwned(TRIGGER_ID);
    expect(outcome).toMatchObject({
      kind: "delivery_failed",
      deliveries: [
        { reasonCode: "proto.eventGuideLaneRequiresUserOrigin", status: "rejected" },
      ],
    });
    // 行保持未决（NULL），留给 followup/新回合重投与告警，不假装 routed。
    const row = plane.database
      .prepare("select final_disposition from trigger_events where id = ?")
      .get(TRIGGER_ID) as { final_disposition: string | null };
    expect(row.final_disposition).toBeNull();
  });
});

describe("M4 admission 交接注册表", () => {
  const facts = { triggerId: "t-1", tier: "auto" as const, mandateId: "m-1", expiresAt: null };
  const resolution = { kind: "mandate" as const, facts };

  it("bind/peek/drop/triggerSourceOf：按 commandId 登记与释放", () => {
    const registry = createSuperAgentAdmissionMandateFactsRegistry();
    registry.bind("cmd-1", resolution);
    expect(registry.peek("cmd-1")).toEqual(resolution);
    expect(registry.peek(undefined)).toBeUndefined();
    expect(registry.triggerSourceOf("cmd-1")).toBe("trigger");
    registry.drop("cmd-1");
    expect(registry.peek("cmd-1")).toBeUndefined();
    expect(registry.triggerSourceOf("cmd-1")).toBeUndefined();
  });

  it("human-explicit exempt：不对 Core 声明 trigger 来源", () => {
    const registry = createSuperAgentAdmissionMandateFactsRegistry();
    registry.bind("cmd-exempt", { kind: "human_explicit_exempt" });
    expect(registry.triggerSourceOf("cmd-exempt")).toBeUndefined();
  });

  it("排队项保留：淘汰循环不得丢弃 retained 项", () => {
    const registry = createSuperAgentAdmissionMandateFactsRegistry();
    registry.bind("cmd-retained", resolution);
    registry.retain("cmd-retained");
    registry.bind("cmd-retained", resolution);
    expect(registry.peek("cmd-retained")).toEqual(resolution);
  });

  it("淘汰循环跳过 retained：挤入新项时先丢最旧的非排队项", () => {
    const registry = createSuperAgentAdmissionMandateFactsRegistry();
    const retained = {
      kind: "mandate" as const,
      facts: { triggerId: "t-retained", tier: "record_only" as const, expiresAt: null },
    };
    registry.bind("cmd-retained", retained);
    registry.retain("cmd-retained");
    const fillers = Array.from({ length: 1023 }, (_, index) => `filler-${index}`);
    for (const commandId of fillers) {
      registry.bind(commandId, { kind: "human_explicit_exempt" });
    }
    registry.bind("cmd-new", { kind: "human_explicit_exempt" });
    expect(registry.peek("cmd-retained")).toEqual(retained);
    expect(registry.peek("cmd-new")).toEqual({ kind: "human_explicit_exempt" });
    expect(registry.peek(fillers[0])).toBeUndefined();
  });

  it("全部为待提升项时达到上限：响亮失败，不静默丢授权", () => {
    const registry = createSuperAgentAdmissionMandateFactsRegistry();
    for (let index = 0; index < 1024; index += 1) {
      const commandId = `retained-${index}`;
      registry.bind(commandId, { kind: "human_explicit_exempt" });
      registry.retain(commandId);
    }
    expect(() =>
      registry.bind("cmd-overflow", { kind: "human_explicit_exempt" }),
    ).toThrow(/待提升项/);
  });

  it("进程级登记表跨 app 可见：leader app 登记，目标 session app 的 input-facade 能读到", () => {
    // 协议宿主每个 session 一个 app；这里直接以 two apps 的 deps 闭包形态验证：
    // 两个 app 的 lookup 都指向同一进程级实例（create-app 实际注入的就是它）。
    const leaderAppLookup = (inputId: string | undefined) =>
      processSuperAgentAdmissionMandateFacts.peek(inputId);
    const targetAppLookup = (inputId: string | undefined) =>
      processSuperAgentAdmissionMandateFacts.peek(inputId);
    const targetAppTriggerSource = (inputId: string | undefined) =>
      processSuperAgentAdmissionMandateFacts.triggerSourceOf(inputId);

    processSuperAgentAdmissionMandateFacts.bind("cmd-cross-session", resolution);
    expect(leaderAppLookup("cmd-cross-session")).toEqual(resolution);
    expect(targetAppLookup("cmd-cross-session")).toEqual(resolution);
    expect(targetAppTriggerSource("cmd-cross-session")).toBe("trigger");

    processSuperAgentAdmissionMandateFacts.drop("cmd-cross-session");
    expect(targetAppLookup("cmd-cross-session")).toBeUndefined();
    // facts 丢失 + 来源仍为 trigger 时 Core admission 必须响亮失败，而不是 user-origin
    // 放行（core permission-mandate-admission 已覆盖该分支）。
    expect(targetAppTriggerSource("cmd-cross-session")).toBeUndefined();
  });
});
