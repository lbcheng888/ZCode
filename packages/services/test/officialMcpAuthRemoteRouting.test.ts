/* OMCP-011 —— desktop-attached remote 的官方 MCP 身份头反向请求路由（spec §7.2 / §7.4）。
 *
 * 验证目标：
 *   1. 远端 workspace（workspaceIdentity 非空）发起的请求能被 host 自动解析并响应；
 *   2. 响应只回到**发起请求的那个** Agent client，不按 workspacePath 串到同路径的其它 workspace；
 *   3. 该请求不产生 renderer event（无 UI 语义），也不写入任何 session/runtime 状态；
 *   4. 无 resolver 时（如 standalone CLI）返回 official_auth_unavailable，绝不降级为匿名请求。
 *
 * 说明：凭证本身是 host 全局状态，不按 workspace 隔离（§7.1），因此这里断言的是**路由**与
 * **响应通道**，不是 per-workspace 的不同凭证。
 */
import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE,
  deriveCapabilityTicketScopeForRole,
  zcodeProtocolMethods,
  type CapabilityTicketBinding,
} from "@zcode/shared";
import type { ZCodeAgentOfficialMcpCapabilityTicketAuthority } from "../src/zcode-agent/zcodeAgentService.js";
// P6 C2 端到端：使用真实的宿主 broker + attachment 签发票据，禁止测试手工注入 scope.resources。
// services 包本身不持有 broker（权威在 Desktop Host），测试以相对路径消费该真实实现。
import { createCapabilityTicketBroker } from "../../desktop/src/host/capabilityTicketBroker.js";
import { createWindowHostAttachmentRegistry } from "../../desktop/src/host/windowHostAttachmentRegistry.js";

const LOCAL_WORKSPACE = {
  workspaceKey: "/workspace/app",
  workspacePath: "/workspace/app",
};
const REMOTE_WORKSPACE = {
  workspaceIdentity: "remote:wsl:ubuntu:/workspace/app",
  workspaceKey: "remote:wsl:ubuntu:/workspace/app",
  // 与 LOCAL 同路径：若实现按 workspacePath 路由就会串台，这正是本用例要挡住的
  workspacePath: "/workspace/app",
};

interface FakeClient {
  onRequestListener?: (request: unknown) => void;
  respond: ReturnType<typeof vi.fn>;
  respondError: ReturnType<typeof vi.fn>;
}

/** 按 workspaceKey 分池的假 client，模拟 local host 与 desktop-attached remote host 两条链路。 */
async function createServiceWithClients(options: {
  officialMcpAuthHeadersResolver?: {
    resolveHeaders(
      request?: unknown,
    ): Promise<
      | { ok: true; headers: Record<string, string> }
      | { ok: false; reason: "official_auth_unavailable" | "official_auth_plan_required" }
    >;
  };
  /** 缺省为"全部可信"，以便既有路由用例聚焦响应通道。 */
  officialMcpTrustedOrigins?: {
    isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
      detail?: string;
      trusted: boolean;
    }>;
  };
  /** 真正省略 validator（模拟装配遗漏）；`undefined` 会落回"全部可信"缺省，无法表达该场景。 */
  omitTrustedOrigins?: boolean;
  /** P6 C2：带票据请求的宿主校验端口。 */
  officialMcpCapabilityTicketAuthority?: ZCodeAgentOfficialMcpCapabilityTicketAuthority;
}): Promise<{
  clients: Map<string, FakeClient>;
  dispose: () => Promise<void>;
  initializeWorkspace: (workspace: {
    workspaceIdentity?: string;
    workspacePath: string;
  }) => Promise<void>;
}> {
  const clients = new Map<string, FakeClient>();

  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      async getClient(params: { workspaceIdentity?: string; workspacePath: string }) {
        const key = params.workspaceIdentity ?? params.workspacePath;
        const existing = clients.get(key);
        if (existing) return toProtocolClient(existing);
        const record: FakeClient = {
          respond: vi.fn(async () => {}),
          respondError: vi.fn(async () => {}),
        };
        clients.set(key, record);
        return toProtocolClient(record);
      }
      getExistingClient(params: { workspaceIdentity?: string; workspacePath: string }) {
        const record = clients.get(params.workspaceIdentity ?? params.workspacePath);
        return record ? toProtocolClient(record) : undefined;
      }
      getRuntimeIdentity() {
        return undefined;
      }
      markReady() {}
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      disposeWorkspace() {}
      disposeAll() {}
      async disposeAllAndWait() {}
    },
  }));

  function toProtocolClient(record: FakeClient) {
    return {
      onClose: () => ({ dispose() {} }),
      onNotification: () => ({ dispose() {} }),
      onRequest: (listener: (request: unknown) => void) => {
        record.onRequestListener = listener;
        return { dispose() {} };
      },
      request: async (method: string) => {
        if (method === zcodeProtocolMethods.initialize) {
          return {
            available: true,
            protocolName: "ZCode Protocol",
            protocolVersion: 1,
            workspaceKey: "/workspace/app",
          };
        }
        throw new Error(`Unexpected request method: ${method}`);
      },
      respond: record.respond,
      respondError: record.respondError,
      transportKind: "stdio",
    };
  }

  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    // initialize 会先确认当前模型选择 View 中存在可执行模型，否则以
    // provider_not_ready 提前返回、不建 client。
    modelSelectionReadinessSource: {
      async getView() {
        return {
          providers: [
            {
              providerId: "account:zai-start-plan",
              config: {
                kind: "account" as const,
                api: {
                  type: "anthropic-messages" as const,
                  baseUrl: "https://zcode.z.ai/api/v1/zcode-plan",
                },
                models: ["GLM-5.2"],
              },
              models: [{ modelId: "GLM-5.2", config: {} }],
            },
          ],
          revision: 1,
        };
      },
    },
    ...(options.officialMcpAuthHeadersResolver
      ? { officialMcpAuthHeadersResolver: options.officialMcpAuthHeadersResolver }
      : {}),
    ...(options.officialMcpCapabilityTicketAuthority
      ? {
          officialMcpCapabilityTicketAuthority: options.officialMcpCapabilityTicketAuthority,
        }
      : {}),
    ...(options.omitTrustedOrigins
      ? {}
      : {
          officialMcpTrustedOrigins: options.officialMcpTrustedOrigins ?? {
            isTrusted: async () => ({ trusted: true }),
          },
        }),
  });

  return {
    clients,
    dispose: () => service.disposeAllAndWait(),
    initializeWorkspace: async (workspace) => {
      const result = await service.initialize(workspace);
      if (!result.available) {
        throw new Error(`agent initialize failed: ${result.reason ?? "unknown"}`);
      }
    },
  };
}

function officialMcpAuthRequest(
  id: string,
  workspace: Record<string, string>,
): Record<string, unknown> {
  return {
    id,
    method: zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
    params: {
      mcpKey: "image-search",
      pluginId: "zcode-tools@zcode-plugins-official",
      requestId: `official-mcp-auth:${id}`,
      targetOrigin: "https://mcp.zcode.example",
      workspace,
    },
  };
}

/** P6 C2：票据绑定是宿主签发的公开事实；请求只带 ticketId + binding，无 secret。 */
const TICKET_BINDING = {
  workspaceIdentity: REMOTE_WORKSPACE.workspaceIdentity,
  attachmentId: "remote-1",
  surfaceKind: "desktop" as const,
  subject: { kind: "session" as const, id: "remote-1" },
};

function officialMcpTicketAuthRequest(
  id: string,
  workspace: Record<string, string>,
  ticketId: string,
): Record<string, unknown> {
  const base = officialMcpAuthRequest(id, workspace);
  return {
    ...base,
    params: {
      ...(base["params"] as Record<string, unknown>),
      capabilityTicketId: ticketId,
      capabilityTicketBinding: TICKET_BINDING,
    },
  };
}

describe("official mcp auth headers over desktop-attached remote", () => {
  it("OMCP-011: answers a remote agent on its own client, not the same-path local one", async () => {
    const headers = {
      Authorization: "Bearer remote-jwt",
      "Bigmodel-Target-Type": "PERSONAL",
      "X-Bigmodel-Authorization": "Bearer remote-maas-jwt",
    };
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({ headers, ok: true }),
      },
    });

    try {
      await harness.initializeWorkspace(LOCAL_WORKSPACE);
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      // 同 workspacePath、不同 workspaceIdentity 必须是两个独立 client
      expect(harness.clients.size).toBe(2);

      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      const local = harness.clients.get(LOCAL_WORKSPACE.workspacePath);
      expect(remote).toBeDefined();
      expect(local).toBeDefined();

      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", { headers, ok: true });
      // 关键：同路径的 local client 不能收到任何东西
      expect(local?.respond).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it("keeps local and remote responses on separate channels under interleaved requests", async () => {
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({
          headers: { Authorization: "Bearer shared-jwt" },
          ok: true,
        }),
      },
    });

    try {
      await harness.initializeWorkspace(LOCAL_WORKSPACE);
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      const local = harness.clients.get(LOCAL_WORKSPACE.workspacePath);

      local?.onRequestListener?.(officialMcpAuthRequest("local-1", LOCAL_WORKSPACE));
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));
      local?.onRequestListener?.(officialMcpAuthRequest("local-2", LOCAL_WORKSPACE));

      await vi.waitFor(() => {
        expect(local?.respond).toHaveBeenCalledTimes(2);
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      // 每个响应都必须回到自己的 request id，不能交叉
      expect(local?.respond.mock.calls.map((call) => call[0])).toEqual(["local-1", "local-2"]);
      expect(remote?.respond.mock.calls.map((call) => call[0])).toEqual(["remote-1"]);
    } finally {
      await harness.dispose();
    }
  });

  it("propagates a plan-required refusal to the remote agent unchanged", async () => {
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({ ok: false, reason: "official_auth_plan_required" }),
      },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", {
        ok: false,
        reason: "official_auth_plan_required",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("OMCP-009: reports official_auth_unavailable when no resolver is wired", async () => {
    const harness = await createServiceWithClients({});
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      // 绝不降级为匿名：没有 resolver 就明确不可用
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", {
        ok: false,
        reason: "official_auth_unavailable",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: rejects an untrusted origin without invoking the resolver at all", async () => {
    // host 是身份权威边界：Origin 不匹配时必须在**读取凭据之前**拒绝，
    // 否则 agent adapter 的 fetch wrapper 就成了唯一防线（远端 runtime 可绕过）。
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      officialMcpTrustedOrigins: { isTrusted: async () => ({ trusted: false }) },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", {
        ok: false,
        reason: "official_mcp_origin_untrusted",
      });
      const payload = remote?.respond.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(JSON.stringify(payload)).not.toContain("must-not-leak");
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: fails closed when no trusted-origin validator is injected", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      omitTrustedOrigins: true,
    });
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: validates all three dimensions, not just one", async () => {
    // 逐维度只错一项，其余正确——防止实现只比较其中某一项。
    const seen: Array<{ mcpKey: string; origin: string; pluginId: string }> = [];
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({ headers: { Authorization: "Bearer ok" }, ok: true }),
      },
      officialMcpTrustedOrigins: {
        isTrusted: async (input) => {
          seen.push(input);
          return {
            trusted:
              input.pluginId === "zcode-tools@zcode-plugins-official" &&
              input.mcpKey === "image-search" &&
              input.origin === "https://mcp.zcode.example",
          };
        },
      },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      const variants: Array<{ id: string; overrides: Record<string, string> }> = [
        { id: "bad-plugin", overrides: { pluginId: "evil@third-party" } },
        { id: "bad-key", overrides: { mcpKey: "unregistered" } },
        { id: "bad-origin", overrides: { targetOrigin: "https://attacker.example" } },
      ];
      for (const variant of variants) {
        const base = officialMcpAuthRequest(variant.id, REMOTE_WORKSPACE);
        const params = base["params"] as Record<string, unknown>;
        remote?.onRequestListener?.({
          ...base,
          params: { ...params, ...variant.overrides },
        });
      }
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(3);
      });
      for (const call of remote?.respond.mock.calls ?? []) {
        expect(call[1]).toEqual({ ok: false, reason: "official_mcp_origin_untrusted" });
      }
      // validator 三个字段都收全了。origin 是唯一的判定依据，pluginId / mcpKey 只用于日志
      // 与凭证解析归属，但仍必须完整传到 host——否则日志答不出"是哪个插件在要凭证"。
      expect(seen).toHaveLength(3);
      expect(seen.every((input) => input.pluginId && input.mcpKey && input.origin)).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: forwards the request context to the resolver once trusted", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer ok" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
    });
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));
      await vi.waitFor(() => {
        expect(resolveHeaders).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpKey: "image-search",
          pluginId: "zcode-tools@zcode-plugins-official",
          targetOrigin: "https://mcp.zcode.example",
          workspace: expect.objectContaining({
            workspaceIdentity: REMOTE_WORKSPACE.workspaceIdentity,
          }),
        }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it("rejects malformed params without invoking the resolver", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer jwt" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.({
        id: "remote-bad",
        method: zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
        // 走私凭证字段 + 缺 targetOrigin：strict schema 必须拒绝
        params: {
          jwt: "leaked",
          mcpKey: "image-search",
          pluginId: "zcode-tools@zcode-plugins-official",
          requestId: "official-mcp-auth:bad",
          workspace: REMOTE_WORKSPACE,
        },
      });

      await vi.waitFor(() => {
        expect(remote?.respondError).toHaveBeenCalledTimes(1);
      });
      // schema 失败走 respondError 而非 respond，且凭证解析不得被触发
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(remote?.respond).not.toHaveBeenCalled();
      expect(remote?.respondError).toHaveBeenCalledWith(
        "remote-bad",
        expect.objectContaining({ code: -32602 }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it("P6 C2: admits a ticket and resolves headers only when scope names the credential resource", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const admitted: Array<{ ticketId: string; binding: unknown }> = [];
    const authority: ZCodeAgentOfficialMcpCapabilityTicketAuthority = {
      admit: (input) => {
        admitted.push(input);
        return {
          ok: true,
          authorization: {
            ticketId: input.ticketId,
            binding: input.binding,
            scope: {
              toolClasses: ["credential"],
              resources: ["credential:image-search"],
            },
            expiresAt: Date.now() + 60_000,
            revocationEpoch: 0,
            credentialInjection: "host-interaction",
          },
        };
      },
    };
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      officialMcpCapabilityTicketAuthority: authority,
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(
        officialMcpTicketAuthRequest("remote-ticket", REMOTE_WORKSPACE, "ticket-ok"),
      );
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).toHaveBeenCalledTimes(1);
      expect(remote?.respond).toHaveBeenCalledWith("remote-ticket", {
        ok: true,
        headers: { Authorization: "Bearer must-not-leak" },
      });
      expect(admitted).toEqual([{ ticketId: "ticket-ok", binding: TICKET_BINDING }]);
    } finally {
      await harness.dispose();
    }
  });

  it("P6 C2: rejects unknown/expired tickets and scope mismatch before reading credentials", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const authority: ZCodeAgentOfficialMcpCapabilityTicketAuthority = {
      admit: ({ ticketId, binding }) => {
        if (ticketId === "unknown") return { ok: false, code: "ticket.unknown" };
        if (ticketId === "expired") return { ok: false, code: "ticket.expired" };
        return {
          ok: true,
          authorization: {
            ticketId,
            binding,
            // ticket 有效，但 scope 没有声明本次凭据资源。
            scope: {
              toolClasses: ["credential"],
              resources: ["credential:other-mcp"],
            },
            expiresAt: Date.now() + 60_000,
            revocationEpoch: 0,
            credentialInjection: "host-interaction",
          },
        };
      },
    };
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      officialMcpCapabilityTicketAuthority: authority,
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      for (const [index, ticketId] of ["unknown", "expired", "scope-mismatch"].entries()) {
        remote?.onRequestListener?.(
          officialMcpTicketAuthRequest(`reject-${index}`, REMOTE_WORKSPACE, ticketId),
        );
      }
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(3);
      });
      expect(resolveHeaders).not.toHaveBeenCalled();
      for (const call of remote?.respond.mock.calls ?? []) {
        expect(call[1]).toEqual({ ok: false, reason: "official_auth_scope_denied" });
      }
      // 拒绝帧零 secret 字节。
      expect(JSON.stringify(remote?.respond.mock.calls)).not.toContain("must-not-leak");
    } finally {
      await harness.dispose();
    }
  });

  it("P6 C2: admits the host-level credential resource the real broker issues", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer host-level" },
      ok: true as const,
    }));
    const authority: ZCodeAgentOfficialMcpCapabilityTicketAuthority = {
      admit: (input) => ({
        ok: true,
        authorization: {
          ticketId: input.ticketId,
          binding: input.binding,
          // 真实签发路径：host 角色票据声明主机级 credential 资源，不枚举 mcpKey。
          scope: {
            toolClasses: ["read", "credential"],
            resources: [CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE],
          },
          expiresAt: Date.now() + 60_000,
          revocationEpoch: 0,
          credentialInjection: "host-interaction",
        },
      }),
    };
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      officialMcpCapabilityTicketAuthority: authority,
    });
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(
        officialMcpTicketAuthRequest("host-level", REMOTE_WORKSPACE, "ticket-host"),
      );
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).toHaveBeenCalledTimes(1);
      expect(remote?.respond).toHaveBeenCalledWith("host-level", {
        ok: true,
        headers: { Authorization: "Bearer host-level" },
      });
    } finally {
      await harness.dispose();
    }
  });

  it("P6 C2: denies ticket-less header requests on a ticket-enabled execution surface", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const admit = vi.fn(() => ({ ok: false as const, code: "ticket.unknown" as const }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      officialMcpCapabilityTicketAuthority: {
        admit,
        requireTicketForRequests: () => true,
      },
    });
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("no-ticket-required", REMOTE_WORKSPACE));
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      // 漏带票据不能静默退回无票据旧路径；resolver 不被调用。
      expect(admit).not.toHaveBeenCalled();
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(remote?.respond).toHaveBeenCalledWith("no-ticket-required", {
        ok: false,
        reason: "official_auth_scope_denied",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("P6 C2: rejects ticket-bearing requests when the host has no authority", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
    });
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(
        officialMcpTicketAuthRequest("no-authority", REMOTE_WORKSPACE, "ticket-any"),
      );
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(remote?.respond).toHaveBeenCalledWith("no-authority", {
        ok: false,
        reason: "official_auth_scope_denied",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("P6 C2: ticket authority does not change the no-ticket path", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer jwt" },
      ok: true as const,
    }));
    const admit = vi.fn(() => ({ ok: false as const, code: "ticket.unknown" as const }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      officialMcpCapabilityTicketAuthority: { admit },
    });
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("no-ticket", REMOTE_WORKSPACE));
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(admit).not.toHaveBeenCalled();
      expect(resolveHeaders).toHaveBeenCalledTimes(1);
      expect(remote?.respond).toHaveBeenCalledWith("no-ticket", {
        ok: true,
        headers: { Authorization: "Bearer jwt" },
      });
    } finally {
      await harness.dispose();
    }
  });

  it("P6 C2: real issue→admit path grants official MCP credential and invokes the resolver", async () => {
    let sequence = 0;
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => `ticket-${++sequence}`,
      createSecret: () => `secret-${++sequence}`,
    });
    const deliveries: Array<{
      ticketId: string;
      binding: CapabilityTicketBinding;
      resources: readonly string[] | undefined;
    }> = [];
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: () => {} }),
      capabilityTickets: {
        broker,
        credentialResources: [CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE],
        deliverSecret: (_attachmentId, delivery) => {
          deliveries.push({
            ticketId: delivery.ticketId,
            binding: delivery.binding,
            resources: delivery.scope.resources,
          });
        },
      },
    });
    registry.attach({
      requestId: "remote-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-1",
        workspacePath: REMOTE_WORKSPACE.workspacePath,
        workspaceIdentity: REMOTE_WORKSPACE.workspaceIdentity,
      },
      port: { once: () => {} },
    });
    // 签发路径真实写入宿主声明的 credential 资源；不是测试手工塞进 admit 的 scope。
    expect(deliveries[0]?.resources).toEqual([
      CAPABILITY_TICKET_OFFICIAL_MCP_CREDENTIAL_RESOURCE,
    ]);

    const ticket = deliveries[0]!;
    // 与 Desktop Host 的组合根同一接线：broker.admit，角色从 attachment registry 现取。
    const authority: ZCodeAgentOfficialMcpCapabilityTicketAuthority = {
      admit: ({ ticketId, binding }) => {
        const role = registry.getRole(binding.attachmentId);
        return broker.admit({
          ticketId,
          binding,
          ...(role !== undefined ? { role } : {}),
        });
      },
    };
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      officialMcpCapabilityTicketAuthority: authority,
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(
        officialMcpTicketAuthRequest("real-ticket", REMOTE_WORKSPACE, ticket.ticketId),
      );
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).toHaveBeenCalledTimes(1);
      expect(remote?.respond).toHaveBeenCalledWith("real-ticket", {
        ok: true,
        headers: { Authorization: "Bearer must-not-leak" },
      });
      // 协议帧只有公开 ticketId+binding，secret 字节不进入请求/响应。
      expect(JSON.stringify(remote?.respond.mock.calls)).not.toContain("secret-1");
      expect(JSON.stringify(ticket)).not.toContain("secret-1");
    } finally {
      await harness.dispose();
      registry.dispose();
    }
  });

  it("P6 C2: a host ticket without credential resources is denied before the resolver", async () => {
    const broker = createCapabilityTicketBroker({
      now: () => 1_000,
      createTicketId: () => "ticket-no-credential",
      createSecret: () => "secret-no-credential",
    });
    // 未授予 credential 资源的 host 票据（例如宿主没装配可注入通道）：仍须 fail-closed。
    broker.issue({
      binding: TICKET_BINDING,
      scope: deriveCapabilityTicketScopeForRole("host"),
      role: "host",
      mode: "sequential",
    });
    const authority: ZCodeAgentOfficialMcpCapabilityTicketAuthority = {
      admit: ({ ticketId, binding }) =>
        broker.admit({ ticketId, binding, role: "host" }),
    };
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      officialMcpCapabilityTicketAuthority: authority,
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(
        officialMcpTicketAuthRequest("no-credential-resource", REMOTE_WORKSPACE, "ticket-no-credential"),
      );
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(remote?.respond).toHaveBeenCalledWith("no-credential-resource", {
        ok: false,
        reason: "official_auth_scope_denied",
      });
    } finally {
      await harness.dispose();
    }
  });
});
