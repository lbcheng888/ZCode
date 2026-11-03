import { describe, expect, it } from "vitest";

import { SpecEgressStartupError, type SuperAgentSpecLaneContract } from "./contract.js";
import { normalizeSpecEgressAllowlist } from "./egress-proxy.js";
import { createSuperAgentSpecLane } from "./spec-lane.js";
import { superAgentSpecLaneModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("super-agent-spec-lane contract", () => {
  it("declares its module manifest", () => {
    expect(superAgentSpecLaneModule.id).toBe("super-agent-spec-lane");
    expect(superAgentSpecLaneModule.requires).toEqual([]);
    expect(superAgentSpecLaneModule.provides).toContain("super-agent-spec-lane");
  });

  it("exposes the contract methods on the implementation", () => {
    const lane: SuperAgentSpecLaneContract = createSuperAgentSpecLane();
    expect(typeof lane.prepareSpecRunEgress).toBe("function");
    expect(typeof lane.stopSpecRunEgress).toBe("function");
  });

  it("fails closed when the proxy cannot start and keeps no partial state", async () => {
    const lane = createSuperAgentSpecLane();
    // 先占住端口，再让 prepare 绑同一端口：listen 失败必须抛 SpecEgressStartupError。
    const blocker = await import("node:net").then(
      ({ createServer }) =>
        new Promise<import("node:net").Server>((resolve) => {
          const server = createServer();
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    );
    const address = blocker.address();
    if (address === null || typeof address === "string") throw new Error("无法解析监听端口");
    const port = address.port;
    try {
      await expect(
        lane.prepareSpecRunEgress({ workspaceRoot: "/repos/blocked", port }),
      ).rejects.toBeInstanceOf(SpecEgressStartupError);
      // fail-closed 后 stop 是幂等 no-op（没有半开的代理泄漏）。
      await expect(lane.stopSpecRunEgress("/repos/blocked")).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("stops idempotently when the workspace was never prepared", async () => {
    const lane = createSuperAgentSpecLane();
    await expect(lane.stopSpecRunEgress("/repos/never")).resolves.toBeUndefined();
  });

  it("rejects malformed allowlist entries instead of dropping them", () => {
    expect(() => normalizeSpecEgressAllowlist(["ok.example"])).not.toThrow();
    expect(() => normalizeSpecEgressAllowlist(undefined)).not.toThrow();
    expect(() => normalizeSpecEgressAllowlist([42])).toThrow(/必须是字符串/);
    expect(() => normalizeSpecEgressAllowlist([""])).toThrow(/空串/);
    expect(() => normalizeSpecEgressAllowlist(["host:"])).toThrow(/形状非法/);
    expect(() => normalizeSpecEgressAllowlist([":8080"])).toThrow(/形状非法/);
    expect(() => normalizeSpecEgressAllowlist(["host:abc"])).toThrow(/形状非法/);
    expect(() => normalizeSpecEgressAllowlist(["host:70000"])).toThrow(/端口越界/);
    expect(() => normalizeSpecEgressAllowlist("not-an-array")).toThrow(/字符串数组/);
  });
});
