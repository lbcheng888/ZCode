// 组合根级 M4 交接回归：真 triggerSink（owned 直通）→ 控制面投递 → create-app 包装后的
// handleCommand（按 commandId 登记 mandate 结论）→ host handleCommand → app.sendInput →
// input-facade 取出/重新解析 → 真 Core admission → 真 runtime 回合。
//
// 这不是模块单测：任何一处交接断开（未登记 / 未透传 triggerSource / 未交给 Core）都会
// 让 owned 投递回执变成 rejected（Core admission 缺 facts 响亮抛错），事件行落不回 routed。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { promptTriggerSourceOf } from "@zcode/core";
import {
  parseCommandEnvelope,
  type CommandAck,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";

import type { SuperAgentCommandHandle } from "../../src/app/super-agent-control-plane.js";
import { processSuperAgentAdmissionMandateFacts } from "../../src/app/super-agent-admission-facts.js";
import type { ZCodeApp } from "../../src/app/types.js";
import { createRegistryBackedTestApp } from "../helpers/registry-backed-test-app.js";

const THREAD_HINT = "bot:b1+u1";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];
const apps: ZCodeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.close?.();
    } catch {
      // 断言失败不掩盖关闭错误。
    }
  }
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function makeApp(): Promise<{
  app: ZCodeApp;
  root: string;
  threadKey: string;
  setDropAdmissionFacts: (drop: boolean) => void;
}> {
  const root = await mkdtemp(join(tmpdir(), "zcode-sa-handoff-"));
  roots.push(root);
  const userConfigPath = join(root, "config.json");
  await writeFile(
    userConfigPath,
    JSON.stringify({ features: { eventRouter: true, mandateGate: true } }),
  );
  const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
  stores.push(sessionStore);

  let app: ZCodeApp | undefined;
  let dropAdmissionFacts = false;
  // 宿主真实实现：信封 → app.sendInput（与 TUI 宿主同一形态：Core 唯一 admission）。
  const handleCommand: SuperAgentCommandHandle = async (raw) => {
    const parsed = parseCommandEnvelope(raw);
    if (!parsed.ok) throw new Error(`信封校验失败: ${parsed.error.message}`);
    const envelope = parsed.envelope;
    if (envelope.type !== "sendText") throw new Error(`只承载 sendText，收到 ${envelope.type}`);
    const payload = envelope.payload as { text?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      throw new Error("sendText 正文为空");
    }
    // 模拟跨 app / 淘汰后的登记丢失：宿主在交给 Core 前把登记项删掉。
    if (dropAdmissionFacts) processSuperAgentAdmissionMandateFacts.drop(envelope.commandId);
    const result = await app!.sendInput(payload.text, {
      inputId: envelope.commandId,
      triggerSource: promptTriggerSourceOf(envelope),
      delivery: "auto",
    });
    const ack: CommandAck =
      result.kind === "rejected"
        ? {
            commandId: envelope.commandId,
            status: "rejected",
            reasonCode: result.reason,
            revisionAtDecision: 0,
          }
        : { commandId: envelope.commandId, status: "accepted", revisionAtDecision: 0 };
    return ack;
  };

  app = await createRegistryBackedTestApp({
    env: {},
    runtimeConfig: {
      workingDirectory: root,
      modelSelection: {
        providerId: "zai",
        modelId: "glm-4.6",
        options: { reasoningLevel: "medium" },
      },
    },
    sessionStore,
    userConfigPath,
    superAgent: {
      handleCommand,
      autoReplyGuard: { admit: async () => true },
      superAgentDatabasePath: join(root, "super-agent.sqlite"),
    },
    modelExecutor: {
      async generateText() {
        return {
          finishReason: "stop" as const,
          text: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    },
  });
  apps.push(app);
  return {
    app,
    root,
    threadKey: `${root}|${THREAD_HINT}`,
    setDropAdmissionFacts: (drop) => {
      dropAdmissionFacts = drop;
    },
  };
}

function insertSubscription(app: ZCodeApp, workspaceIdentity: string, threadKey: string): void {
  app.superAgentControlPlane!.contracts.trigger.upsertSubscription({
    workspaceIdentity,
    threadKey,
    sessionId: app.sessionId,
    lane: "followup",
    ownerKind: "session",
  });
}

function envelope(workspaceIdentity: string, providerMessageId: string) {
  return {
    workspaceIdentity,
    source: "im" as const,
    provider: "feishu",
    providerMessageId,
    threadKeyHint: THREAD_HINT,
    actor: { kind: "human" as const, id: "u1" },
    payload: { text: "有新的评论", chatType: "group", botId: "b1", chatId: "u1" },
    taint: true as const,
  };
}

function readTriggerRow(
  app: ZCodeApp,
  triggerId: string,
): { fast_path: string | null; final_disposition: string | null } {
  return app.superAgentControlPlane!.database
    .prepare("select fast_path, final_disposition from trigger_events where id = ?")
    .get(triggerId) as { fast_path: string | null; final_disposition: string | null };
}

describe("组合根 M4 交接（真信封 → 包装 handleCommand → 真 Core admission）", () => {
  it("owned 事件：登记 facts → facade 交给 Core → admission started，行落 routed", async () => {
    const { app, root, threadKey } = await makeApp();
    insertSubscription(app, root, threadKey);

    const result = await app.superAgentControlPlane!.triggerSink.ingest(
      envelope(root, "pm-handoff-owned"),
    );
    expect(result.handled).toBe(true);
    if (!result.handled) return;

    const row = readTriggerRow(app, result.triggerId);
    expect(row.fast_path).toBe("owned");
    // 只有 Core admission 真正 accepted 才会落 routed；缺 facts 时 Core 抛错 → rejected。
    expect(row.final_disposition).toBe("routed");
  });

  it("登记在交接前丢失：Core admission 按 trigger 来源响亮失败，事件行保持未决", async () => {
    const { app, root, threadKey, setDropAdmissionFacts } = await makeApp();
    insertSubscription(app, root, threadKey);
    setDropAdmissionFacts(true);

    await expect(
      app.superAgentControlPlane!.triggerSink.ingest(envelope(root, "pm-handoff-drop")),
    ).rejects.toThrow(/缺少 mandateFacts/);

    // 投递失败：行保持未决（不落 routed），留待重放/告警。
    const triggerId = app.superAgentControlPlane!.database
      .prepare("select id from trigger_events where provider_message_id = ?")
      .get("pm-handoff-drop") as { id: string } | undefined;
    expect(triggerId?.id).toBeTruthy();
    expect(readTriggerRow(app, triggerId!.id).final_disposition).toBeNull();
  });
});
