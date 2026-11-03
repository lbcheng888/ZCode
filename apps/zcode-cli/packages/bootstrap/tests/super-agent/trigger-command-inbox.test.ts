// 触发子系统对 CommandInbox 的合同面（spec §2.2 / M1）：
// 1. envelope triggerId/taint additive 透传（parse 不丢、旧信封缺省兼容）；
// 2. admission 回执面 onAdmissionReceipt（派发桥 onHostAck 唯一数据源）；
// 3. 同 commandId 幂等吸收（投递幂等键 triggerId:sessionId 的消费端不变量）。
import { describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { parseCommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { CommandInboxHost } from "../../src/zcode-protocol-v4/command-inbox.js";
import { CommandInbox } from "../../src/zcode-protocol-v4/command-inbox.js";

function makeHost(overrides: Partial<CommandInboxHost> = {}): CommandInboxHost {
  return {
    getRevision: () => 7,
    getLogEpoch: () => "epoch-current",
    ...overrides,
  };
}

function envelope(partial: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    commandId: "trig-1:session-a",
    clientId: "trigger-router",
    sessionId: "session-a",
    type: "sendText",
    payload: { text: "PR #42 需要你跟进" },
    issuedAt: 1,
    ...partial,
  } as CommandEnvelope;
}

describe("envelope triggerId/taint additive 合同（§2.2）", () => {
  it("携带 triggerId/taint 的信封解析后原样保留", () => {
    const parsed = parseCommandEnvelope(
      envelope({ triggerId: "trigger-1", taint: true }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.triggerId).toBe("trigger-1");
    expect(parsed.envelope.taint).toBe(true);
  });

  it("旧信封（无 triggerId/taint）解析不报错，字段缺省（additive-optional）", () => {
    const parsed = parseCommandEnvelope(envelope());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.triggerId).toBeUndefined();
    expect(parsed.envelope.taint).toBeUndefined();
  });

  it("triggerId 空串被 schema 拒绝（幂等键成员不能为空）", () => {
    const parsed = parseCommandEnvelope(envelope({ triggerId: "" }));
    expect(parsed.ok).toBe(false);
  });
});

describe("CommandInbox admission 回执面（onHostAck 源）", () => {
  it("accepted 与 duplicate 各送达一次回执；拒绝路径同样原样送达", async () => {
    const receipts: CommandAck[] = [];
    const inbox = new CommandInbox(makeHost({ onAdmissionReceipt: (ack) => receipts.push(ack) }));

    const command = envelope({ triggerId: "trigger-1", taint: true });
    const first = await inbox.handle(command);
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") throw new Error("expected execute");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ commandId: "trig-1:session-a", status: "accepted" });

    first.settle({ status: "accepted" });
    const retry = await inbox.handle(command);
    expect(retry.kind).toBe("ack");
    if (retry.kind !== "ack") throw new Error("expected ack");
    // 幂等吸收：duplicate 回执（派发桥合法 settle 面）。
    expect(retry.ack.status).toBe("duplicate");
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toMatchObject({ commandId: "trig-1:session-a", status: "duplicate" });

    // 非法 payload 的 rejected 也进回执面。
    await inbox.handle(envelope({ commandId: "cmd-bad", payload: { nope: true } }));
    expect(receipts).toHaveLength(3);
    expect(receipts[2]).toMatchObject({
      commandId: "cmd-bad",
      status: "rejected",
      reasonCode: "proto.invalidPayload",
    });
  });

  it("回执订阅方抛错不影响 admission 返回值", async () => {
    const inbox = new CommandInbox(
      makeHost({
        onAdmissionReceipt: () => {
          throw new Error("subscriber boom");
        },
      }),
    );
    const outcome = await inbox.handle(envelope({ commandId: "trig-1:session-a" }));
    expect(outcome.kind).toBe("execute");
    if (outcome.kind !== "execute") throw new Error("expected execute");
    expect(outcome.ack.status).toBe("accepted");
  });

  it("同 commandId 幂等吸收：重投不二次 execute（fan-out 幂等键消费端不变量）", async () => {
    const prepareDecision = vi.fn(async () => {});
    const inbox = new CommandInbox(makeHost({ prepareDecision }));
    const command = envelope({ commandId: "trigger-1:session-a" });

    const first = await inbox.handle(command);
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") throw new Error("expected execute");
    first.settle({ status: "accepted" });

    const second = await inbox.handle(command);
    expect(second.kind).toBe("ack");
    if (second.kind !== "ack") throw new Error("expected ack");
    expect(second.ack.status).toBe("duplicate");
    // 幂等吸收不重跑准入副作用。
    expect(prepareDecision).toHaveBeenCalledTimes(1);
  });
});
