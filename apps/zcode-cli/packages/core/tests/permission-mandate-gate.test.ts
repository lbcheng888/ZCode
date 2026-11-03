import { describe, expect, it } from "vitest";

import {
  INFRASTRUCTURE_MANDATE_ID,
  PermissionService,
  type PermissionContext,
  type PermissionToolCapability,
} from "../src/permission/service.js";

const readCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: false,
  readOnly: true,
  riskLevel: "low",
  sideEffectScope: "none",
};

const writeCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "workspace",
};

function context(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    toolName: "Edit",
    input: { file_path: "/tmp/a.ts" },
    riskLevel: "medium",
    mode: "build",
    ...overrides,
  };
}

const service = new PermissionService();

describe("M4 mandate 同步 fail-closed 门（permission/service.ts 管线最前端）", () => {
  it("缺省 user-origin 短路：无 mandate 字段时既有判定完全不变", () => {
    const decision = service.checkPermission(context(), writeCapability);
    // 走既有 build 管线（写操作 ask），不是 mandate 拒绝。
    expect(decision.decision).toBe("ask");
    expect(decision.ruleId).toBe("mode.build.sideEffect");
  });

  it("user-origin 显式声明也短路：事件门不作用于用户回合", () => {
    const decision = service.checkPermission(
      context({ origin: "user" }),
      writeCapability,
    );
    expect(decision.decision).toBe("ask");
    expect(decision.ruleId).not.toMatch(/^mandate\./);
  });

  it("event-origin 写操作缺 mandate → deny（缺失即 fail-closed）", () => {
    const decision = service.checkPermission(
      context({ origin: "event" }),
      writeCapability,
    );
    expect(decision).toMatchObject({
      decision: "deny",
      allowed: false,
      ruleId: "mandate.missing",
    });
  });

  it("event-origin 只读工具不受 mandate 门限制", () => {
    const decision = service.checkPermission(
      context({ origin: "event", toolName: "Read" }),
      readCapability,
    );
    expect(decision.decision).toBe("allow");
    expect(decision.ruleId).toBe("mode.build.readOnly");
  });

  it("基础设施 mandateId 豁免（例外①，裁决 / watchdog 自会话）", () => {
    const decision = service.checkPermission(
      context({
        origin: "event",
        mandate: { tier: "record_only", mandateId: INFRASTRUCTURE_MANDATE_ID },
      }),
      writeCapability,
    );
    expect(decision.decision).toBe("ask");
    expect(decision.ruleId).toBe("mode.build.sideEffect");
  });

  it("过期 mandate → deny（turn 内不中断，下个 admission 边界重新解析）", () => {
    const decision = service.checkPermission(
      context({
        origin: "event",
        mandate: { tier: "auto", mandateId: "m-1", expiresAt: Date.now() - 1 },
      }),
      writeCapability,
    );
    expect(decision).toMatchObject({ decision: "deny", ruleId: "mandate.expired" });
  });

  it("未过期 auto/speculative 带 mandateId → 放行到既有管线", () => {
    for (const tier of ["auto", "speculative"] as const) {
      const decision = service.checkPermission(
        context({
          origin: "event",
          mandate: { tier, mandateId: `m-${tier}`, expiresAt: Date.now() + 60_000 },
        }),
        writeCapability,
      );
      expect(decision.decision).toBe("ask");
      expect(decision.ruleId).toBe("mode.build.sideEffect");
    }
  });

  it("record_only 撞写操作 → deny", () => {
    const decision = service.checkPermission(
      context({
        origin: "event",
        mandate: { tier: "record_only", mandateId: "m-record" },
      }),
      writeCapability,
    );
    expect(decision).toMatchObject({ decision: "deny", ruleId: "mandate.recordOnly" });
  });

  it("speculative/auto 缺 mandateId → deny（例外③）", () => {
    const decision = service.checkPermission(
      context({ origin: "event", mandate: { tier: "auto" } }),
      writeCapability,
    );
    expect(decision).toMatchObject({ decision: "deny", ruleId: "mandate.missingId" });
  });

  it("门在 plan-transition 解析之前：plan 模式也先吃 mandate 拒绝", () => {
    const decision = service.checkPermission(
      context({ origin: "event", mode: "plan", planEnabled: true }),
      writeCapability,
    );
    expect(decision).toMatchObject({ decision: "deny", ruleId: "mandate.missing" });
  });
});
