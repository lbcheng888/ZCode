import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  insertPendingDispatchRequest,
  readControlPlaneGate,
  recordScheduleTriggerAudit,
  shouldWriteScheduleAudit,
} from "../src/scheduler/index.js";

const sqliteRequire = createRequire(import.meta.url);
const { DatabaseSync } = sqliteRequire("node:sqlite") as typeof import("node:sqlite");

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-scheduler-gate-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 域库 DDL 镜像（权威 = bootstrap super-agent-storage 迁移 §1.2/§1.8；desktop 不依赖
 * @zcode/bootstrap，测试按 spec 表面自建同形表——结构变更由 bootstrap storage 迁移测试兜底）。
 */
function createDomainDb(path: string): InstanceType<typeof DatabaseSync> {
  const db = new DatabaseSync(path);
  db.exec(`
    create table trigger_events (
      id text primary key,
      workspace_identity text not null,
      source text not null,
      thread_key text not null,
      actor_kind text not null,
      actor_id text,
      payload text not null,
      payload_digest text not null,
      taint integer not null default 1,
      provider text,
      provider_message_id text,
      fast_path text,
      adjudication_status text,
      final_disposition text,
      settled_at integer,
      created_at integer not null,
      updated_at integer not null
    );
    create unique index trigger_events_provider_message_uidx
      on trigger_events(provider, provider_message_id)
      where provider_message_id is not null;
    create table control_plane_leases (
      workspace_identity text primary key,
      owner_id text not null,
      role text not null,
      expires_at integer not null,
      heartbeat_at integer not null
    );
  `);
  return db;
}

/** §1.6 dispatch_requests DDL 镜像（权威 = services 0007_dispatch_requests）。 */
function createTasksIndexLikeDb(path: string): InstanceType<typeof DatabaseSync> {
  const db = new DatabaseSync(path);
  db.exec(`
    create table dispatch_requests (
      id text primary key,
      run_id text not null unique,
      command_id text not null unique,
      workspace_identity text not null,
      session_id text,
      payload text,
      status text not null,
      skip_reason text,
      dispatch_policy text not null,
      attempts integer not null default 0,
      claimed_at integer,
      pushed_at integer,
      acked_at integer,
      settled_at integer,
      created_at integer not null,
      updated_at integer not null
    );
  `);
  return db;
}

describe("scheduler §5.3 仲裁门控（per-workspace 控制面租约，不再全局暂停）", () => {
  it("域库不存在（回退期/控制面从未运行）→ 空门控、不落审计，保持现状认领", () => {
    const path = join(tempDir(), "super-agent.sqlite");
    const gate = readControlPlaneGate({ now: NOW, databasePath: path });
    expect(gate.store).toBeNull();
    expect([...gate.leasedWorkspaces]).toEqual([]);
    expect(shouldWriteScheduleAudit(gate)).toBe(false);
  });

  it("域库存在但首迁未跑（无表）→ 空门控（probe 不创建空库）", () => {
    const path = join(tempDir(), "super-agent.sqlite");
    const db = new DatabaseSync(path);
    try {
      const gate = readControlPlaneGate({ now: NOW, databasePath: path });
      expect(gate.store).toBeNull();
      expect([...gate.leasedWorkspaces]).toEqual([]);
      expect(shouldWriteScheduleAudit(gate)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("未过期租约 → 对应 workspace 进集合（心跳可见=非回退，可落审计）；过期租约不进集合", () => {
    const path = join(tempDir(), "super-agent.sqlite");
    const db = createDomainDb(path);
    try {
      // 域库就绪但无租约行：心跳不可见 = 回退期（控制面曾运行后崩溃/从未持有）。
      let gate = readControlPlaneGate({ now: NOW, databasePath: path });
      expect(gate.store).not.toBeNull();
      expect([...gate.leasedWorkspaces]).toEqual([]);
      expect(shouldWriteScheduleAudit(gate)).toBe(false);

      // ws-a 未过期（expires_at > now）= 心跳可见；ws-b 已过期（TTL=3×心跳，§1.8）。
      db.prepare(
        `insert into control_plane_leases (workspace_identity, owner_id, role, expires_at, heartbeat_at)
          values ('ws-a', 'daemon-1', 'control_plane', ?, ?)`,
      ).run(NOW + 45_000, NOW);
      db.prepare(
        `insert into control_plane_leases (workspace_identity, owner_id, role, expires_at, heartbeat_at)
          values ('ws-b', 'daemon-1', 'control_plane', ?, ?)`,
      ).run(NOW - 1, NOW - 60_000);
      gate = readControlPlaneGate({ now: NOW, databasePath: path });
      // per-workspace：只收未过期行——ws-a 认领归控制面，ws-b 仍由 Main fork 认领。
      expect([...gate.leasedWorkspaces]).toEqual(["ws-a"]);
      expect(shouldWriteScheduleAudit(gate)).toBe(true);

      // 断连：ws-a 租约按 TTL 到期后 → 空集合，回退纯 legacy（不落审计、照常认领）。
      gate = readControlPlaneGate({ now: NOW + 45_000, databasePath: path });
      expect([...gate.leasedWorkspaces]).toEqual([]);
      expect(shouldWriteScheduleAudit(gate)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("scheduler §5.2 trigger_events 审计行（source=schedule，幂等 per 幂等键）", () => {
  it("cron 首次落行 + 同 runId 重投幂等短路：单行、字段按 §5.2（fast_path NULL、不路由）", () => {
    const path = join(tempDir(), "super-agent.sqlite");
    const db = createDomainDb(path);
    try {
      const input = {
        workspaceIdentity: "ws-a",
        domainKey: "automation-1",
        providerMessageId: "automation-1:1000",
        payloadSummary: {
          automationId: "automation-1",
          runId: "automation-1:1000",
          scheduledAt: NOW,
        },
        now: NOW,
      };
      expect(recordScheduleTriggerAudit(db, input)).toBe(true);
      // 认领重放（同幂等键，时间不同）→ 幂等短路，零新增行。
      expect(recordScheduleTriggerAudit(db, { ...input, now: NOW + 1 })).toBe(false);

      const rows = db.prepare("select * from trigger_events").all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "schedule",
        provider: "scheduler",
        provider_message_id: "automation-1:1000",
        thread_key: "schedule:automation-1",
        actor_kind: "system",
        actor_id: "scheduler",
        fast_path: null,
        adjudication_status: null,
        final_disposition: null,
        taint: 1,
      });
      const payload = JSON.parse(String(rows[0]?.payload)) as Record<string, unknown>;
      expect(payload).toEqual({
        automationId: "automation-1",
        runId: "automation-1:1000",
        scheduledAt: NOW,
        trigger: "schedule",
      });
      // payload 不落 prompt 原文；digest 覆盖落库文本（§1.2）。
      expect(String(rows[0]?.payload)).not.toContain("prompt");
    } finally {
      db.close();
    }
  });

  it("不同 runId 是独立审计行（provider_message_id 幂等键按 run 区分）", () => {
    const path = join(tempDir(), "super-agent.sqlite");
    const db = createDomainDb(path);
    try {
      expect(
        recordScheduleTriggerAudit(db, {
          workspaceIdentity: "ws-a",
          domainKey: "automation-1",
          providerMessageId: "automation-1:1000",
          payloadSummary: { automationId: "automation-1", runId: "automation-1:1000", scheduledAt: NOW },
          now: NOW,
        }),
      ).toBe(true);
      expect(
        recordScheduleTriggerAudit(db, {
          workspaceIdentity: "ws-a",
          domainKey: "automation-1",
          providerMessageId: "automation-1:2000",
          payloadSummary: {
            automationId: "automation-1",
            runId: "automation-1:2000",
            scheduledAt: NOW + 1000,
          },
          now: NOW + 1000,
        }),
      ).toBe(true);
      const count = db.prepare("select count(*) as n from trigger_events").get() as { n: number };
      expect(Number(count.n)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("off-peak 认领审计：thread_key=schedule:<offPeakTaskId>、幂等按任务键收敛单行（裁定 5 只豁免进桥）", () => {
    const path = join(tempDir(), "super-agent.sqlite");
    const db = createDomainDb(path);
    try {
      const input = {
        workspaceIdentity: "ws-a",
        domainKey: "offpeak-1",
        providerMessageId: "offpeak-1",
        payloadSummary: { offPeakTaskId: "offpeak-1", claimedAt: NOW },
        now: NOW,
      };
      expect(recordScheduleTriggerAudit(db, input)).toBe(true);
      // 任务重试/再认领（同 offPeakTaskId）→ 幂等短路，单行（稳定任务键语义）。
      expect(recordScheduleTriggerAudit(db, { ...input, now: NOW + 60_000 })).toBe(false);

      const rows = db.prepare("select * from trigger_events").all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "schedule",
        provider: "scheduler",
        provider_message_id: "offpeak-1",
        thread_key: "schedule:offpeak-1",
        fast_path: null,
        adjudication_status: null,
        taint: 1,
      });
      const payload = JSON.parse(String(rows[0]?.payload)) as Record<string, unknown>;
      expect(payload).toEqual({ offPeakTaskId: "offpeak-1", claimedAt: NOW, trigger: "schedule" });
    } finally {
      db.close();
    }
  });
});

describe("scheduler §1.6 dispatch_requests claim 落行（桥批接线前生产不调用，见 §5.2 实施偏差）", () => {
  it("写 pending_dispatch + commandId=hash(runId)，同 runId 幂等短路返回既有行", () => {
    const path = join(tempDir(), "tasks-index.sqlite");
    const db = createTasksIndexLikeDb(path);
    try {
      const first = insertPendingDispatchRequest(db, {
        runId: "automation-1:1000",
        workspaceIdentity: "ws-a",
        payload: "跑测试",
        now: NOW,
      });
      expect(first.created).toBe(true);
      // 与桥侧 dispatchCommandIdForRun 同算法（sha256(runId)）的独立断言。
      expect(first.commandId).toBe(
        createHash("sha256").update("automation-1:1000").digest("hex"),
      );
      const row = db
        .prepare("select status, dispatch_policy, payload, attempts from dispatch_requests where run_id = ?")
        .get("automation-1:1000") as Record<string, unknown>;
      expect(row).toEqual({
        status: "pending_dispatch",
        dispatch_policy: "in_window",
        payload: "跑测试",
        attempts: 0,
      });

      const second = insertPendingDispatchRequest(db, {
        runId: "automation-1:1000",
        workspaceIdentity: "ws-a",
        payload: "跑测试",
        now: NOW + 1,
      });
      expect(second).toEqual({ ...first, created: false });
      const count = db.prepare("select count(*) as n from dispatch_requests").get() as { n: number };
      expect(Number(count.n)).toBe(1);
    } finally {
      db.close();
    }
  });
});
