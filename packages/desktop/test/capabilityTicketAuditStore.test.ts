import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCapabilityTicketBroker,
  type CapabilityTicketAuditPort,
} from "../src/host/capabilityTicketBroker.js";
import { createCapabilityTicketAuditStore } from "../src/host/capabilityTicketAuditStore.js";
import type { CapabilityTicketBinding } from "@zcode/shared";

const BINDING: CapabilityTicketBinding = {
  workspaceIdentity: "remote:ssh:dev:/work/demo",
  attachmentId: "mobile-1",
  deviceId: "device-1",
  surfaceKind: "mobileRemote",
  subject: { kind: "run", id: "run-1" },
};

const tempDirs: string[] = [];

function auditDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "capability-ticket-audit-"));
  tempDirs.push(dir);
  return join(dir, "capability-tickets.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("capability ticket audit store", () => {
  it("记录公开字段与状态迁移，绝不落 secret", () => {
    const databasePath = auditDbPath();
    const store = createCapabilityTicketAuditStore({ databasePath });
    const broker = createCapabilityTicketBroker({
      audit: store,
      createTicketId: () => "ticket-1",
      createSecret: () => "super-secret-value",
      now: () => 1_000,
    });
    broker.issue({
      binding: BINDING,
      scope: { toolClasses: ["read"] },
      role: "read_mostly",
      mode: "single_use",
    });
    expect(broker.redeem({
      ticketId: "ticket-1",
      ticketSecret: "super-secret-value",
      binding: BINDING,
      action: { toolName: "Read" },
      nonce: "nonce-1",
      revocationEpoch: 0,
    }).ok).toBe(true);
    store.close();

    const db = new DatabaseSync(databasePath);
    const rows = db.prepare("SELECT * FROM capability_tickets").all() as Record<string, unknown>[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticket_id: "ticket-1",
      workspace_identity: BINDING.workspaceIdentity,
      attachment_id: BINDING.attachmentId,
      state: "consumed",
    });
    // 审计库没有 secret 列，整行序列化也不能出现 secret 值。
    expect(Object.keys(rows[0]!)).not.toContain("secret");
    expect(JSON.stringify(rows[0])).not.toContain("super-secret-value");
  });

  it("broker 重启把上一进程未终态行标记 expired，不复活票据", () => {
    const databasePath = auditDbPath();
    const firstStore = createCapabilityTicketAuditStore({ databasePath });
    const first = createCapabilityTicketBroker({
      audit: firstStore,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
      now: () => 1_000,
    });
    first.issue({ binding: BINDING, scope: { toolClasses: ["read"] }, role: "read_mostly" });
    firstStore.close();

    const invalidated: number[] = [];
    const secondStore = createCapabilityTicketAuditStore({ databasePath });
    const second = createCapabilityTicketBroker({
      audit: secondStore,
      now: () => 2_000,
      onAuditRestartInvalidated: (count) => invalidated.push(count),
    });
    expect(invalidated).toEqual([1]);
    expect(second.status("ticket-1")).toBeUndefined();

    const db = new DatabaseSync(databasePath);
    const row = db.prepare("SELECT state FROM capability_tickets WHERE ticket_id = ?").get(
      "ticket-1",
    ) as { state: string };
    db.close();
    secondStore.close();
    expect(row.state).toBe("expired");
  });

  it("审计写失败让签发失败，不留下无法审计的内存票据", () => {
    const failingAudit: CapabilityTicketAuditPort = {
      record: () => {
        throw new Error("audit unavailable");
      },
      invalidateNonTerminal: () => 0,
    };
    const broker = createCapabilityTicketBroker({
      audit: failingAudit,
      createTicketId: () => "ticket-1",
      createSecret: () => "secret-1",
    });
    expect(() =>
      broker.issue({ binding: BINDING, scope: { toolClasses: ["read"] }, role: "read_mostly" }),
    ).toThrow("audit unavailable");
    expect(broker.status("ticket-1")).toBeUndefined();
  });
});
