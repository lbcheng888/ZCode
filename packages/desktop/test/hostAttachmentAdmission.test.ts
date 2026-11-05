import { describe, expect, it } from "vitest";
import { createHostAttachmentAdmissionContext } from "../src/host/hostAttachmentAdmission.js";

describe("P6 Desktop host attachment 连接事实", () => {
  it("remote attachment：source=remote，附件字段是实时 getter", () => {
    let role: "host" | "interactive" | "read_mostly" | undefined = "read_mostly";
    const facts = createHostAttachmentAdmissionContext(
      {
        attachmentId: "mobile-1",
        deviceScopeKey: "ws\0web",
        resolveRole: () => role,
      },
      "web-remote-replayable",
    );
    expect(facts?.source).toBe("remote");
    expect(facts?.attachment).toEqual({
      attachmentId: "mobile-1",
      role: "read_mostly",
      deviceScopeKey: "ws\0web",
      deviceKind: "web",
    });
    // 角色变更必须在下一次求值时可见（不做 attach 快照）。
    role = "interactive";
    expect(facts?.attachment?.role).toBe("interactive");
  });

  it("吊销（role undefined）：附件在场但省略 role，供 CLI 直接 deny", () => {
    const facts = createHostAttachmentAdmissionContext(
      { attachmentId: "mobile-1", resolveRole: () => undefined },
      "web-remote-replayable",
    );
    expect(facts?.attachment).toEqual({ attachmentId: "mobile-1", deviceKind: "web" });
    expect(facts?.attachment?.role).toBeUndefined();
  });

  it("local desktop attachment：source=local-host + desktop deviceKind", () => {
    const facts = createHostAttachmentAdmissionContext(
      { attachmentId: "desktop-1", resolveRole: () => "host" },
      "desktop-continuous",
    );
    expect(facts).toMatchObject({
      source: "local-host",
      attachment: { attachmentId: "desktop-1", role: "host", deviceKind: "desktop" },
    });
  });

  it("无 attachment 连接：不产生事实（保持现状字节兼容）", () => {
    expect(createHostAttachmentAdmissionContext(undefined, "desktop-continuous")).toBeUndefined();
  });
});
