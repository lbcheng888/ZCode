// lane B：would-accept 可见面最后一公里 + 一键批转（spec super-agent-trigger-subsystem-spec
// §5.5 / §2.1 promoteWouldAccept、design M4；§8-11 可见面）。真域库 + 真 CommandInbox +
// 真裁决批产卡；TUI 命令面直接消费控制面读/写缝（tui 源相对引入，与本包 tests 跨包引入
// adapters/core 同惯例）。断言：列表渲染真实卡 → promote 后读面收敛 + mandate 行落库 +
// decision_log 转化行 + 重复 promote 幂等 + 能力缺席如实 unavailable。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandInbox } from "../../src/zcode-protocol-v4/command-inbox.js";
import {
  createSuperAgentControlPlane,
  type SuperAgentCommandHandle,
  type SuperAgentControlPlane,
} from "../../src/app/super-agent-control-plane.js";
import type { TriggerSpecRunPort } from "../../src/super-agent/trigger/index.js";
import type { Message } from "../../../tui/src/app-model.js";
import {
  WOULD_ACCEPT_UNAVAILABLE_TEXT,
  WouldAcceptUnavailableError,
  submitWouldAcceptInboxCommand,
  submitWouldAcceptPromoteCommand,
} from "../../../tui/src/app-would-accept.js";

const WS = "ws-would-accept";
const SESSION = "session-would-accept";
const THREAD_HINT = "bot:b1+u1";
const THREAD_KEY = `${WS}|${THREAD_HINT}`;
const SCHEME_CARD = {
  currentEvidence: "nightly failed 的日志",
  candidateOptions: [
    { option: "修复 flaky 用例", cost: "低" },
    { option: "重试任务", cost: "中" },
  ],
  recommendation: "修复 flaky 用例",
  impact: "仅测试文件",
  verification: "pnpm test",
};

const planes: SuperAgentControlPlane[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const plane of planes.splice(0)) {
    try {
      plane.stop();
    } catch {
      // 已关/重复关不掩盖用例失败。
    }
  }
  void Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function makeInboxHandle(): SuperAgentCommandHandle {
  const inbox = new CommandInbox({
    getRevision: () => 1,
    getLogEpoch: () => "epoch-would-accept",
  });
  return async (raw) => {
    const outcome = await inbox.handle(raw);
    if (outcome.kind === "ack") return outcome.ack;
    outcome.settle({ status: "accepted" });
    return outcome.ack;
  };
}

/** 真域库装配 + 脚本化裁决会话（零 LLM）：ingest unowned 候选 → runBatch 落 would-accept 卡。 */
async function makePlaneWithCard(
  options: { specRun?: TriggerSpecRunPort; mandateGate?: boolean } = {},
): Promise<{ plane: SuperAgentControlPlane; cardId: string }> {
  const root = await mkdtemp(join(tmpdir(), "zcode-sa-promote-"));
  roots.push(root);
  const verdictTriggerIds: string[] = [];
  const adjudicationRun = vi.fn(async (request: { prompt: string }) => {
    expect(request.prompt.length).toBeGreaterThan(0);
    return {
      outputText: JSON.stringify({
        decisions: verdictTriggerIds.map((id) => ({
          triggerId: id,
          disposition: "accept",
          reason: "可修复",
          evidence: ["payload 摘要"],
          scheme: SCHEME_CARD,
        })),
      }),
    };
  });
  const errors: Array<{ error: unknown; context: string }> = [];
  const plane = await createSuperAgentControlPlane({
    workspaceIdentity: WS,
    ownerId: `owner-${root}`,
    onError: (error, context) => errors.push({ error, context }),
    sessionFace: { sessionId: SESSION, isIdle: () => true },
    hostPorts: {
      handleCommand: makeInboxHandle(),
      autoReplyGuard: { admit: async () => true },
      superAgentDatabasePath: join(root, "super-agent.sqlite"),
    },
    adjudicationSession: { run: adjudicationRun, destroySession: vi.fn() },
    ...(options.mandateGate === true ? { mandateGate: true } : {}),
    ...(options.specRun === undefined ? {} : { specRun: options.specRun }),
  });
  planes.push(plane);
  await plane.start();

  const result = await plane.triggerSink.ingest({
    workspaceIdentity: WS,
    source: "im",
    provider: "feishu",
    providerMessageId: "pm-promote-1",
    threadKeyHint: THREAD_HINT,
    actor: { kind: "bot", id: "b1" },
    payload: { text: "构建机器人通报：nightly failed", chatType: "private", botId: "b1" },
    taint: true,
  });
  if (!result.handled) throw new Error(`候选未入链: ${JSON.stringify(result)}`);
  verdictTriggerIds.push(result.triggerId);
  const outcome = await plane.contracts.adjudication.runBatch(WS);
  expect(outcome.status).toBe("applied");
  expect(errors).toEqual([]);

  const cards = plane.listPendingWouldAccept();
  expect(cards).toHaveLength(1);
  return { plane, cardId: cards[0]!.cardId };
}

function transcriptHarness() {
  let messages: Message[] = [];
  let status = "";
  return {
    get messages() {
      return messages;
    },
    get status() {
      return status;
    },
    // 结构等价于 React.SetStateAction<Message[]>（本包无 react 类型依赖，不引 React 命名空间）。
    setMessages: (updater: Message[] | ((prev: Message[]) => Message[])) => {
      messages = typeof updater === "function" ? updater(messages) : updater;
    },
    setStatus: (value: string) => {
      status = value;
    },
  };
}

function agentText(io: ReturnType<typeof transcriptHarness>): string {
  return io.messages.map((message) => message.content).join("\n");
}

describe("would-accept 可见面 + 批转（真 DB fixture）", () => {
  it("列表命令从控制面读面渲染真实卡（摘要/档位/cardId/promote 用法）", async () => {
    const { plane, cardId } = await makePlaneWithCard();
    const io = transcriptHarness();

    await submitWouldAcceptInboxCommand({
      listWouldAcceptCards: () => plane.listPendingWouldAccept(),
      setMessages: io.setMessages,
      setStatus: io.setStatus,
    });

    const text = agentText(io);
    expect(text).toContain("Would-accept inbox (1):");
    expect(text).toContain("[im → record_only]");
    expect(text).toContain("构建机器人通报：nightly failed");
    expect(text).toContain(`card=${cardId}`);
    expect(text).toContain("Promote: /would-accept promote <cardId>");
    expect(io.status).toBe("Would-accept inbox: 1 card(s).");
  });

  it("无 mandateGate 也立即派发当前卡，auto mandate 对未来生效", async () => {
    const starts: Parameters<TriggerSpecRunPort["start"]>[0][] = [];
    const specRun: TriggerSpecRunPort = {
      async start(input) {
        starts.push(input);
      },
    };
    const { plane, cardId } = await makePlaneWithCard({ specRun });

    await plane.promoteWouldAccept(cardId);

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      triggerId: expect.any(String),
      workspaceIdentity: WS,
      threadKey: `${WS}|${THREAD_HINT}`,
      source: "im",
      tier: "auto",
      card: SCHEME_CARD,
    });
    expect(plane.listPendingWouldAccept()).toEqual([]);
  });

  it("promote 后读面收敛 + mandate auto 行落库 + decision_log 转化行；重复 promote 幂等", async () => {
    const { plane, cardId } = await makePlaneWithCard();

    const io = transcriptHarness();
    await submitWouldAcceptPromoteCommand({
      cardId,
      promoteWouldAcceptCard: (id) => plane.promoteWouldAccept(id),
      setMessages: io.setMessages,
      setStatus: io.setStatus,
    });
    expect(agentText(io)).toContain(
      `Promoted ${cardId}: auto mandate row recorded; best-plan execution authorized.`,
    );
    expect(io.status).toBe(`Would-accept card ${cardId} promoted to auto.`);

    // 读面收敛：已批卡不再出现在 pending 列表（v4 快照同源，spec §5.5）。
    expect(plane.listPendingWouldAccept()).toEqual([]);

    // mandate 行：显式 auto（M4 一键批转 = 写 mandate 行；执行档 Phase 3 才生效）。
    const mandateRows = plane.database
      .prepare("select workspace_identity, trigger_class, tier, status from mandate")
      .all();
    expect(mandateRows).toEqual([
      { workspace_identity: WS, trigger_class: "bot:b1", tier: "auto", status: "active" },
    ]);

    // decision_log 转化行：唯一写者仍是 decision-log 仓储，origin=would_accept_convert。
    const convertRows = plane.database
      .prepare(
        "select origin, disposition, trigger_id from decision_log where origin = 'would_accept_convert'",
      )
      .all();
    expect(convertRows).toHaveLength(1);
    expect(convertRows[0]).toMatchObject({ origin: "would_accept_convert", disposition: "accept" });

    // 重复 promote 幂等：零新增行、不抛错。
    await plane.promoteWouldAccept(cardId);
    expect(
      plane.database
        .prepare("select count(*) as n from decision_log where origin = 'would_accept_convert'")
        .get(),
    ).toEqual({ n: 1 });
    expect(plane.database.prepare("select count(*) as n from mandate").get()).toEqual({ n: 1 });
    expect(plane.listPendingWouldAccept()).toEqual([]);
  });

  it("promote 未知 cardId 响亮失败；能力缺席（缝抛 unavailable）如实呈现不造数据", async () => {
    const { plane, cardId } = await makePlaneWithCard();
    await plane.promoteWouldAccept(cardId);

    await expect(plane.promoteWouldAccept("card-missing")).rejects.toThrow(/不可批转/);

    // 缝在场但能力缺席（flag 关/宿主未注入）：与缝缺席同一 unavailable 呈现。
    const unavailable = transcriptHarness();
    await submitWouldAcceptInboxCommand({
      listWouldAcceptCards: async () => {
        throw new WouldAcceptUnavailableError();
      },
      setMessages: unavailable.setMessages,
      setStatus: unavailable.setStatus,
    });
    expect(agentText(unavailable)).toContain(WOULD_ACCEPT_UNAVAILABLE_TEXT);
    expect(unavailable.status).toBe("Would-accept inbox is not available.");
  });
});
