import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createMandateContract, createMandateRepo } from "../../src/super-agent/mandate/index.js";

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("super-agent-mandate 隐式 record-only（P2 查询语义）", () => {
  it("表为空时 resolveFor 恒为隐式 record_only（M4 缺省）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const mandate = createMandateContract();

    const verdict = mandate.resolveFor("bot:bot-1");
    expect(verdict).toEqual({ tier: "record_only", source: "implicit" });
    // 分派器查空表不产生任何写行（隐式缺省不写表）。
    const rows = db.prepare("select count(*) as n from mandate").get() as { n: number };
    expect(Number(rows.n)).toBe(0);
  });

  it("即便已有显式 auto 行，P2 仍按隐式 record_only 收敛（执行档 Phase 3 才启用）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const repo = createMandateRepo(db);
    const mandate = createMandateContract();

    const inserted = repo.insert({
      workspaceIdentity: "ws-a",
      triggerClass: "bot:bot-1",
      tier: "auto",
      policyVersion: 1,
    });
    expect(inserted.status).toBe("active");
    expect(repo.getActive("ws-a", "bot:bot-1")).toMatchObject({
      id: inserted.id,
      tier: "auto",
      status: "active",
    });

    const verdict = mandate.resolveFor("bot:bot-1");
    expect(verdict).toEqual({ tier: "record_only", source: "implicit" });
  });

  it("注入 repo + workspaceIdentity：显式行 UNION 隐式缺省（M4 三档）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const repo = createMandateRepo(db);
    const now = Date.UTC(2026, 10, 3, 12, 0, 0);
    const inserted = repo.insert({
      workspaceIdentity: "ws-a",
      triggerClass: "bot:bot-1",
      tier: "speculative",
      policyVersion: 1,
      expiresAt: now + 60_000,
      now,
    });
    const mandate = createMandateContract({
      repo,
      workspaceIdentity: "ws-a",
      now: () => now,
    });

    expect(mandate.resolveFor("bot:bot-1")).toEqual({
      tier: "speculative",
      source: "explicit",
      mandateId: inserted.id,
      // expiresAt 与 tier/mandateId 同一读快照导出（避免二次查询 TOCTOU）。
      expiresAt: now + 60_000,
    });
    // 未命中显式行 → 查询层 UNION 缺省（不写表）。
    expect(mandate.resolveFor("bot:bot-2")).toEqual({
      tier: "record_only",
      source: "implicit",
    });
  });

  it("显式行过期 → 回退隐式 record_only（fail-closed 方向）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const repo = createMandateRepo(db);
    const now = Date.UTC(2026, 10, 3, 12, 0, 0);
    repo.insert({
      workspaceIdentity: "ws-a",
      triggerClass: "cron:job-1",
      tier: "auto",
      policyVersion: 1,
      expiresAt: now + 1_000,
      now,
    });
    const mandate = createMandateContract({
      repo,
      workspaceIdentity: "ws-a",
      now: () => now + 2_000,
    });
    expect(mandate.resolveFor("cron:job-1")).toEqual({
      tier: "record_only",
      source: "implicit",
    });

    // 单次调用注入的 resolving 参数覆盖工厂缺省（admission 边界逐次解析）。
    expect(
      mandate.resolveFor("cron:job-1", { workspaceIdentity: "ws-a", now }),
    ).toMatchObject({ tier: "auto", source: "explicit" });
  });

  it("未注入 repo 时即便表内有显式行也恒隐式（flag 关字节兼容）", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const repo = createMandateRepo(db);
    repo.insert({
      workspaceIdentity: "ws-a",
      triggerClass: "bot:bot-1",
      tier: "auto",
      policyVersion: 1,
    });
    const mandate = createMandateContract();
    expect(mandate.resolveFor("bot:bot-1", { workspaceIdentity: "ws-a" })).toEqual({
      tier: "record_only",
      source: "implicit",
    });
  });

  it("仓储：active partial unique、revoke 与过期回收", async () => {
    db = await openSuperAgentDatabase({ databasePath: ":memory:" });
    const repo = createMandateRepo(db);
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);

    const first = repo.insert({
      workspaceIdentity: "ws-a",
      triggerClass: "cron:job-1",
      tier: "record_only",
      policyVersion: 1,
      expiresAt: now + 1_000,
      now,
    });
    // 同键第二条 active 行撞 partial unique index，SQLite 原样抛错（不静默覆盖）。
    expect(() =>
      repo.insert({
        workspaceIdentity: "ws-a",
        triggerClass: "cron:job-1",
        tier: "speculative",
        policyVersion: 1,
        now,
      }),
    ).toThrow();

    // 过期行不被 getActive 命中，sweep 后转 revoked 保留审计。
    expect(repo.getActive("ws-a", "cron:job-1", now + 2_000)).toBeUndefined();
    expect(repo.sweepExpired(now + 2_000)).toBe(1);
    expect(
      db.prepare("select status from mandate where id = ?").get(first.id) as { status: string },
    ).toMatchObject({ status: "revoked" });

    // 撤销后同键可重新 insert（partial unique 只约束 active 行）。
    const second = repo.insert({
      workspaceIdentity: "ws-a",
      triggerClass: "cron:job-1",
      tier: "auto",
      policyVersion: 2,
      now,
    });
    expect(repo.revoke(second.id, now)).toBe(true);
    expect(repo.revoke(second.id, now)).toBe(false);
  });
});
