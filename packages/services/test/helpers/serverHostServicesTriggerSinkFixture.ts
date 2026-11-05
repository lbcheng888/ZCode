import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IBotsService } from "@zcode/services";
import type {
  ControlPlaneTriggerEnvelope,
  ScheduleAuditParams,
} from "@zcode/shared/super-agent-control-plane-protocol";
import {
  createServerHostServices,
  disposeServiceResourcesAndWait,
} from "../../src/node.js";
import type { SuperAgentControlPlaneRpcPort } from "../../src/bots/superAgentControlPlaneSink.js";

/**
 * §4.2 装配接缝的真进程证据（与 serverHostServicesFixture 同一隔离方式）：
 * `createServerHostServices` 收到端口后必须把 TriggerSink 传给 botsService；bot 回调
 * 进入端口 trigger.ingest 并跳过 legacy。端口是测试替身（真实传输接缝在
 * server-cli 的 superAgentControlPlanePort 测试里用生产 client 覆盖）。
 */
const home = process.env.HOME!;
const configDir = join(home, ".chengcode", "v2");
await mkdir(configDir, { recursive: true, mode: 0o700 });
const workspacePath = join(home, "repo");
await mkdir(workspacePath, { recursive: true });

await writeFile(
  join(configDir, "bot-config.v3.json"),
  JSON.stringify({
    version: 3,
    bots: [
      {
        id: "webhook-1",
        name: "Webhook",
        provider: "webhook",
        enabled: true,
        providerUserId: "user-1",
        allowedWorkspaces: ["*"],
        allowedCommands: {
          status: true,
          new: true,
          workspace: true,
          model: true,
          thoughtLevel: true,
          sandboxMode: true,
          approvalPolicy: true,
          reply: true,
        },
        currentOptions: {},
        replyMode: "assistant_changes",
        eventRouterEnabled: true,
      },
    ],
  }),
  "utf8",
);
await writeFile(
  join(configDir, "bot-state.v3.json"),
  JSON.stringify({
    version: 3,
    bots: {
      "webhook-1": {
        botId: "webhook-1",
        workspacePath,
        workspaceIdentity: "ws-test",
        hostId: "remote:server:server-owner",
        mode: "draft",
        activeTaskId: null,
        updatedAt: 1,
      },
    },
  }),
  "utf8",
);

const ingested: ControlPlaneTriggerEnvelope[] = [];
const auditParams: ScheduleAuditParams[] = [];
const port: SuperAgentControlPlaneRpcPort = {
  async triggerIngest(params) {
    ingested.push(params);
    return { handled: true, triggerId: "trigger-1", route: "unowned_candidate" };
  },
  async scheduleAudit(params) {
    auditParams.push(params);
    return { inserted: true };
  },
};

const host = await createServerHostServices({
  sourceServerId: "server-owner",
  zcodeBuiltinProviderConfigFilePath: resolve("config/provider/zcode-builtin.json"),
  superAgentControlPlaneRpcPort: port,
});
try {
  const bots = host.services.get(IBotsService);
  const response = await bots.handleProviderCallbackResponse("webhook", {
    botId: "webhook-1",
    messageId: "msg-1",
    text: "hello",
    userId: "user-1",
  });
  const envelope = ingested[0];
  if (
    response.ok !== true ||
    response.replies.length !== 0 ||
    ingested.length !== 1 ||
    envelope?.workspaceIdentity !== "ws-test" ||
    envelope.providerMessageId !== "msg-1" ||
    envelope.taint !== true
  ) {
    throw new Error(
      `trigger sink assembly mismatch: ${JSON.stringify({
        response,
        ingested,
      })}`,
    );
  }
  if (auditParams.length !== 0) throw new Error("schedule.audit must not run on in-memory path");
} finally {
  await disposeServiceResourcesAndWait(host.services);
}
process.stdout.write("TRIGGER_SINK_ASSEMBLY_VERIFIED\n");
process.exit(0);
