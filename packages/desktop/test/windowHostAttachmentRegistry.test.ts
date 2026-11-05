import { describe, expect, it, vi } from "vitest";
import { createWindowHostAttachmentRegistry } from "../src/host/windowHostAttachmentRegistry.js";

function createPort() {
  let closeListener: (() => void) | null = null;
  return {
    port: {
      once(event: "close", listener: () => void) {
        if (event === "close") {
          closeListener = listener;
        }
      },
    },
    close() {
      closeListener?.();
    },
  };
}

describe("WindowHostAttachmentRegistry", () => {
  it("base 与 remote scope 在同一个 Host 内解析各自 services", () => {
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: (scope) =>
        scope.kind === "local"
          ? { services: "local-services", generation: 1 }
          : { services: `remote-services:${scope.remoteSessionId}`, generation: 7 },
      expose,
    });
    const localPort = createPort();
    const remotePort = createPort();

    registry.attach({
      requestId: "attach-local",
      attachmentId: "local-1",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: localPort.port,
    });
    registry.attach({
      requestId: "attach-remote",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      },
      port: remotePort.port,
    });

    expect(expose).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ services: "local-services", clientMode: "desktop-continuous" }),
    );
    expect(expose).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        services: "remote-services:remote-session-1",
        clientMode: "desktop-continuous",
        generation: 7,
      }),
    );
    expect(registry.size()).toBe(2);
  });

  it("每个 attachment 注入自己的可信 clientMode", () => {
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
    });

    registry.attach({
      requestId: "desktop-1",
      attachmentId: "desktop-1",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });
    registry.attach({
      requestId: "mobile-1",
      attachmentId: "mobile-1",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: createPort().port,
    });

    expect(expose.mock.calls.map(([call]) => call.clientMode)).toEqual([
      "desktop-continuous",
      "web-remote-replayable",
    ]);
  });

  it("将 remote connection capabilities 一并注入 attachment，供媒体服务按 clientMode 分流", () => {
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({
        services: "services",
        generation: 1,
        capabilities: { remoteMediaPreview: "available" },
      }),
      expose,
    });

    registry.attach({
      requestId: "remote-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      },
      port: createPort().port,
    });

    expect(expose).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: { remoteMediaPreview: "available" } }),
    );
  });

  it("相同 attachmentId 替换时只释放旧 port，其他 port 不受影响", () => {
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const mobileDispose = vi.fn();
    const expose = vi
      .fn()
      .mockReturnValueOnce({ dispose: firstDispose })
      .mockReturnValueOnce({ dispose: mobileDispose })
      .mockReturnValueOnce({ dispose: secondDispose });
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
    });

    registry.attach({
      requestId: "desktop-old",
      attachmentId: "desktop",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });
    registry.attach({
      requestId: "mobile",
      attachmentId: "mobile",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: createPort().port,
    });
    registry.attach({
      requestId: "desktop-new",
      attachmentId: "desktop",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(mobileDispose).not.toHaveBeenCalled();
    expect(secondDispose).not.toHaveBeenCalled();
    expect(registry.size()).toBe(2);
  });

  it("port close 和显式 detach 均只释放自身且幂等", () => {
    const dispose = vi.fn();
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose }),
    });
    const port = createPort();
    registry.attach({
      requestId: "mobile-1",
      attachmentId: "mobile-1",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: port.port,
    });

    port.close();
    registry.detach("mobile-1");
    registry.detach("mobile-1");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
  });

  it("Source 离线时只释放该 Source 的 settings attachments", () => {
    const sourceDispose = vi.fn();
    const localDispose = vi.fn();
    const expose = vi
      .fn()
      .mockReturnValueOnce({ dispose: sourceDispose })
      .mockReturnValueOnce({ dispose: localDispose });
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
    });
    registry.attach({
      requestId: "source-settings",
      attachmentId: "source-settings",
      clientMode: "desktop-continuous",
      scope: { kind: "source-settings", sourceServerId: "source-1" },
      port: createPort().port,
    });
    registry.attach({
      requestId: "local",
      attachmentId: "local",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });

    registry.detachSourceSettingsAttachments("source-1");

    expect(sourceDispose).toHaveBeenCalledOnce();
    expect(localDispose).not.toHaveBeenCalled();
    expect(registry.size()).toBe(1);
  });

  it("rejects Source settings services from mobile replayable attachments", () => {
    const expose = vi.fn();
    const resolveScope = vi.fn(() => ({ services: "services", generation: 1 }));
    const registry = createWindowHostAttachmentRegistry({ resolveScope, expose });

    expect(() =>
      registry.attach({
        requestId: "mobile-source-settings",
        attachmentId: "mobile-source-settings",
        clientMode: "web-remote-replayable",
        scope: { kind: "source-settings", sourceServerId: "source-1" },
        port: createPort().port,
      }),
    ).toThrow("Desktop-only");
    expect(resolveScope).not.toHaveBeenCalled();
    expect(expose).not.toHaveBeenCalled();
  });

  it("scope 验证失败时不暴露 port", () => {
    const expose = vi.fn();
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => {
        throw new Error("远程 attachment scope 与 logical session 不匹配");
      },
      expose,
    });

    expect(() =>
      registry.attach({
        requestId: "remote-invalid",
        attachmentId: "remote-invalid",
        clientMode: "desktop-continuous",
        scope: {
          kind: "remote",
          remoteSessionId: "remote-session-1",
          workspacePath: "/work/demo",
          workspaceIdentity: "remote:ssh:wrong:/work/demo",
        },
        port: createPort().port,
      }),
    ).toThrow("远程 attachment scope 与 logical session 不匹配");
    expect(expose).not.toHaveBeenCalled();
  });

  it("logical session generation 变化时只释放该 session 的旧 attachment", () => {
    const oldDispose = vi.fn();
    const otherDispose = vi.fn();
    const localDispose = vi.fn();
    const expose = vi
      .fn()
      .mockReturnValueOnce({ dispose: oldDispose })
      .mockReturnValueOnce({ dispose: otherDispose })
      .mockReturnValueOnce({ dispose: localDispose });
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: (scope) => ({
        services: "services",
        generation: scope.kind === "remote" && scope.remoteSessionId === "remote-1" ? 1 : 2,
      }),
      expose,
    });
    registry.attach({
      requestId: "old",
      attachmentId: "old",
      clientMode: "web-remote-replayable",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-1",
        workspacePath: "/old",
        workspaceIdentity: "remote:ssh:old",
      },
      port: createPort().port,
    });
    registry.attach({
      requestId: "other",
      attachmentId: "other",
      clientMode: "desktop-continuous",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-2",
        workspacePath: "/other",
        workspaceIdentity: "remote:ssh:other",
      },
      port: createPort().port,
    });
    registry.attach({
      requestId: "local",
      attachmentId: "local",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });

    registry.detachStaleRemoteSessionAttachments("remote-1", 2);

    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(otherDispose).not.toHaveBeenCalled();
    expect(localDispose).not.toHaveBeenCalled();
    expect(registry.size()).toBe(2);
  });

  it("宿主 attachment 记录是角色权威：本机连续连接 host，可重放连接默认 read_mostly", () => {
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
    });
    registry.attach({
      requestId: "desktop-local",
      attachmentId: "desktop-local",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });
    registry.attach({
      requestId: "mobile-local",
      attachmentId: "mobile-local",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: createPort().port,
    });
    registry.attach({
      requestId: "desktop-remote",
      attachmentId: "desktop-remote",
      clientMode: "desktop-continuous",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      },
      port: createPort().port,
    });
    registry.attach({
      requestId: "mobile-remote",
      attachmentId: "mobile-remote",
      clientMode: "web-remote-replayable",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      },
      port: createPort().port,
    });

    expect(registry.getRole("desktop-local")).toBe("host");
    expect(registry.getRole("mobile-local")).toBe("read_mostly");
    expect(registry.getRole("desktop-remote")).toBe("host");
    expect(registry.getRole("mobile-remote")).toBe("read_mostly");
  });

  it("角色只由宿主 clientMode 派生，attach 结构上没有客户端自报角色的入口", () => {
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
    });
    // 即便客户端伪造 clientKind（握手提示位）也到不了这里：attach 只接受宿主注入的 clientMode。
    registry.attach({
      requestId: "remote-a",
      attachmentId: "remote-a",
      clientMode: "web-remote-replayable",
      scope: { kind: "remote", remoteSessionId: "r1", workspacePath: "/w", workspaceIdentity: "ws" },
      port: createPort().port,
    });

    expect(registry.getRole("remote-a")).toBe("read_mostly");
    // 远端连接无法被 setRole 升级为 host。
    expect(() => registry.setRole("remote-a", "host")).toThrow("desktop-continuous");
  });

  it("宿主显式授予 interactive 即时生效，吊销/断连后角色立即失效", () => {
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
    });
    const port = createPort();
    registry.attach({
      requestId: "mobile-1",
      attachmentId: "mobile-1",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: port.port,
    });

    expect(registry.getRole("mobile-1")).toBe("read_mostly");
    // 宿主显式授予后下一次读取立即是 interactive（不缓存旧结论）。
    expect(registry.setRole("mobile-1", "interactive")).toBe(true);
    expect(registry.getRole("mobile-1")).toBe("interactive");
    expect(registry.list().map((attachment) => attachment.role)).toContain("interactive");

    // 收回 interactive 也是即时生效。
    expect(registry.setRole("mobile-1", "read_mostly")).toBe(true);
    expect(registry.getRole("mobile-1")).toBe("read_mostly");

    // 断连（port close）后记录被移除，角色不可再读取（准入层按 read_mostly fail-closed）。
    port.close();
    expect(registry.getRole("mobile-1")).toBeUndefined();

    // 显式 detach 与吊销同样即时。
    registry.detach("mobile-1");
    expect(registry.getRole("mobile-1")).toBeUndefined();
  });

  it("setRole 原地更新同一 params 对象，expose 持有的引用不会停留在旧角色", () => {
    let captured: { role: string } | undefined;
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: (params) => {
        captured = params;
        return { dispose: vi.fn() };
      },
    });
    registry.attach({
      requestId: "mobile-1",
      attachmentId: "mobile-1",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: createPort().port,
    });

    expect(captured?.role).toBe("read_mostly");
    registry.setRole("mobile-1", "interactive");
    // 同一个引用：任何缓存了 expose 参数的消费者也能看到宿主的新授权。
    expect(captured?.role).toBe("interactive");
    expect(registry.getRole("mobile-1")).toBe("interactive");
  });

  it("invalid host role updates crash instead of silently escalating/downgrading", () => {
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
    });
    registry.attach({
      requestId: "mobile-1",
      attachmentId: "mobile-1",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: createPort().port,
    });

    expect(() => registry.setRole("mobile-1", "full" as never)).toThrow("Invalid attachment role");
    // 远端连接不得被升级成 host。
    expect(() => registry.setRole("mobile-1", "host")).toThrow("desktop-continuous");
    expect(registry.getRole("mobile-1")).toBe("read_mostly");
    expect(registry.setRole("missing", "interactive")).toBe(false);
  });

  it("deviceScope 键按 workspaceIdentity\\0surfaceKind 记录", () => {
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose: vi.fn() }),
    });
    const remoteScope = {
      kind: "remote" as const,
      remoteSessionId: "remote-1",
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:ssh:dev:/work/demo",
    };
    registry.attach({
      requestId: "desktop-remote",
      attachmentId: "desktop-remote",
      clientMode: "desktop-continuous",
      scope: remoteScope,
      port: createPort().port,
    });
    registry.attach({
      requestId: "mobile-remote",
      attachmentId: "mobile-remote",
      clientMode: "web-remote-replayable",
      scope: remoteScope,
      port: createPort().port,
    });
    registry.attach({
      requestId: "local",
      attachmentId: "local",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });

    const list = registry.list();
    expect(list.find((item) => item.attachmentId === "desktop-remote")?.deviceScopeKey).toBe(
      "remote:ssh:dev:/work/demo\u0000desktop",
    );
    expect(list.find((item) => item.attachmentId === "mobile-remote")?.deviceScopeKey).toBe(
      "remote:ssh:dev:/work/demo\u0000web",
    );
    expect(list.find((item) => item.attachmentId === "local")?.deviceScopeKey).toBeUndefined();
  });

  it("remote session 失效时释放该 session 的所有 desktop/mobile attachment 且保持幂等", () => {
    const desktopDispose = vi.fn();
    const mobileDispose = vi.fn();
    const otherRemoteDispose = vi.fn();
    const localDispose = vi.fn();
    const expose = vi
      .fn()
      .mockReturnValueOnce({ dispose: desktopDispose })
      .mockReturnValueOnce({ dispose: mobileDispose })
      .mockReturnValueOnce({ dispose: otherRemoteDispose })
      .mockReturnValueOnce({ dispose: localDispose });
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
    });
    const attachRemote = (
      attachmentId: string,
      remoteSessionId: string,
      clientMode: "desktop-continuous" | "web-remote-replayable",
    ) =>
      registry.attach({
        requestId: `request-${attachmentId}`,
        attachmentId,
        clientMode,
        scope: {
          kind: "remote",
          remoteSessionId,
          workspacePath: "/work/demo",
          workspaceIdentity: `remote:ssh:${remoteSessionId}:/work/demo`,
        },
        port: createPort().port,
      });

    attachRemote("desktop-old", "remote-old", "desktop-continuous");
    attachRemote("mobile-old", "remote-old", "web-remote-replayable");
    attachRemote("desktop-current", "remote-current", "desktop-continuous");
    registry.attach({
      requestId: "request-local",
      attachmentId: "local",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });

    registry.detachRemoteSessionAttachments("remote-old");
    registry.detachRemoteSessionAttachments("remote-old");

    expect(desktopDispose).toHaveBeenCalledTimes(1);
    expect(mobileDispose).toHaveBeenCalledTimes(1);
    expect(otherRemoteDispose).not.toHaveBeenCalled();
    expect(localDispose).not.toHaveBeenCalled();
    expect(registry.list().map((attachment) => attachment.attachmentId)).toEqual([
      "desktop-current",
      "local",
    ]);
  });
});
