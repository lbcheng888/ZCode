/**
 * headless child 裁决 model-only 会话（milestone-b-spec §8-7）：
 * 真 HTTP 假 provider（reuse `tests/helpers/fake-provider-server`）→ 真 Provider
 * Registry/adapter → `AgentRuntime.generateWorkspaceText`（tools 恒空）→ 真裁决驱动器
 * → 真 `applyVerdicts` 落 decision_log。
 *
 * 覆盖：候选批 → verdict JSON → 落行；解析失败整批 record-only 降级；
 * abort（daemon shutdown）中止在途模型请求且候选留 pending/零落行。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";

import { openSuperAgentDatabase } from "../../src/super-agent/storage/index.js";
import { createDecisionLog } from "../../src/super-agent/decision-log/index.js";
import { createMandateContract } from "../../src/super-agent/mandate/index.js";
import { applyVerdicts } from "../../src/super-agent/trigger/verdict-interpret.js";
import {
  createAdjudicationDriver,
  type AdjudicationDeliveryPort,
  type AdjudicationModelSessionPort,
  type SuperAgentAdjudicationContract,
} from "../../src/super-agent/adjudication/index.js";
import {
  ADJUDICATION_MAX_OUTPUT_TOKENS,
  AdjudicationSessionUnavailableError,
  adjudicationOutputTokenBudget,
  createEnvironmentAdjudicationSessionAssembly,
  createHeadlessAdjudicationSession,
  createLazyAdjudicationSession,
  resolveHeadlessProviderRuntimeEnv,
  type AdjudicationSessionAssembly,
} from "../../src/super-agent/daemon/adjudicationSession.js";
import { ADJUDICATION_MAX_BATCH_SIZE } from "../../src/super-agent/adjudication/index.js";
import {
  startFakeProviderServer,
  type FakeProviderServer,
  type FaultProgram,
} from "../helpers/fake-provider-server.js";
import { createFaultModelFactory, FAULT_MODEL_SELECTION } from "../helpers/fault-provider-model.js";

const WS = "ws-1";
const CANDIDATE_1 = "cand-1";
const CANDIDATE_2 = "cand-2";
const BASE = Date.UTC(2026, 10, 5, 12, 0, 0);

let db: DatabaseSync | undefined;
const drivers: SuperAgentAdjudicationContract[] = [];
const servers: FakeProviderServer[] = [];
const disposers: Array<() => void> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const driver of drivers.splice(0)) driver.stop();
  for (const dispose of disposers.splice(0)) dispose();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  db?.close();
  db = undefined;
});

function seedCandidate(input: {
  database: DatabaseSync;
  id: string;
  workspaceIdentity?: string;
  createdAt?: number;
}): void {
  const createdAt = input.createdAt ?? BASE;
  input.database
    .prepare(
      `insert into trigger_events (
        id, workspace_identity, source, thread_key, actor_kind, actor_id, payload,
        payload_digest, taint, provider, provider_message_id, fast_path,
        adjudication_status, final_disposition, settled_at, created_at, updated_at
      ) values (?, ?, 'im', ?, 'human', 'u1', ?, 'digest', 1, 'feishu', ?, 'unowned_candidate', 'pending', null, null, ?, ?)`,
    )
    .run(
      input.id,
      input.workspaceIdentity ?? WS,
      `${input.workspaceIdentity ?? WS}|bot:bot-1+u1`,
      JSON.stringify({ text: `event ${input.id}` }),
      `pm-${input.id}`,
      createdAt,
      createdAt,
    );
}

interface Harness {
  database: DatabaseSync;
  driver: SuperAgentAdjudicationContract;
  session: AdjudicationModelSessionPort;
  errors: Array<{ error: unknown; context: string }>;
}

async function createHarness(options: {
  server: FakeProviderServer;
  abortSignal: AbortSignal;
  seed?: string[];
  /** 已由生产装配产出的会话（缺省 = 直接接线假 provider 的 test harness）。 */
  session?: AdjudicationModelSessionPort;
}): Promise<Harness> {
  const database = await openSuperAgentDatabase({ databasePath: ":memory:" });
  db = database;
  for (const id of options.seed ?? [CANDIDATE_1, CANDIDATE_2]) {
    seedCandidate({ database, id, createdAt: BASE - 120_000 });
  }
  let session = options.session;
  if (!session) {
    const model = createFaultModelFactory({
      baseURL: options.server.baseURL,
      apiFormat: "anthropic-messages",
    });
    disposers.push(() => model.dispose());
    session = createHeadlessAdjudicationSession({
      modelSource: {
        modelFactory: model.modelFactory,
        resolveSelection: () => FAULT_MODEL_SELECTION,
        dispose: () => model.dispose(),
      },
      abortSignal: options.abortSignal,
      workingDirectory: "/tmp",
    });
  }
  const decisionLog = createDecisionLog(database);
  const delivery: AdjudicationDeliveryPort = {
    applyVerdicts: (batchId, decisions) =>
      applyVerdicts({ db: database, decisionLog }, batchId, decisions),
  };
  const errors: Array<{ error: unknown; context: string }> = [];
  const driver = createAdjudicationDriver({
    db: database,
    session,
    delivery,
    mandate: createMandateContract(),
    onError: (error, context) => {
      errors.push({ error, context });
    },
  });
  drivers.push(driver);
  return { database, driver, session, errors };
}

function adjudicationStatus(database: DatabaseSync, triggerId: string): string | undefined {
  const row = database
    .prepare("select adjudication_status from trigger_events where id = ?")
    .get(triggerId) as { adjudication_status: string } | undefined;
  return row?.adjudication_status;
}

function decisionRows(database: DatabaseSync): Array<{
  trigger_id: string;
  origin: string;
  disposition: string;
  batch_id: string;
  reason: string | null;
}> {
  return database
    .prepare(
      "select trigger_id, origin, disposition, batch_id, reason from decision_log order by created_at, trigger_id",
    )
    .all() as unknown as Array<{
    trigger_id: string;
    origin: string;
    disposition: string;
    batch_id: string;
    reason: string | null;
  }>;
}

const SERVE: FaultProgram = () => ({ kind: "serve" });
const HANG: FaultProgram = () => ({ kind: "hang" });

const BUILTIN_MODEL_ID = "fake-model";
const PERSONAL_PROVIDER_ID = "fake-api";

/** 生产装配的 Built-in 基线：模板指向假服务器 + 完整模型规则（与 config/provider 同型）。 */
function builtinRelease(baseURL: string): object {
  return {
    schemaVersion: ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: 1,
    config: {
      providerConfigRules: {
        providerRules: [],
        templateRules: [
          {
            templateId: "fake-template",
            templateNameMap: { "en-US": "fake", "zh-CN": "fake" },
            config: {
              access: { type: "api-key" },
              api: { type: "anthropic-messages", baseUrl: baseURL },
              builtinModelIds: [BUILTIN_MODEL_ID],
            },
          },
        ],
      },
      modelConfigRules: {
        modelRules: [
          {
            modelMatch: BUILTIN_MODEL_ID,
            config: {
              enabled: true,
              properties: {
                requiresMfjsToolSchema: false,
                contextWindow: 200_000,
                inputFormat: {
                  supportsText: true,
                  supportsImage: false,
                  supportsVideo: false,
                  supportsAudio: false,
                  supportsPdf: false,
                },
                outputFormat: { supportsText: true },
                supportsToolCall: true,
                supportsJsonSchemaOutput: true,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: false,
              },
              optionSpecs: {
                reasoningLevel: { values: ["disabled"], map: "{}" },
                maxOutputTokens: {
                  max: 32_000,
                  map: '{"max_tokens": maxOutputTokens}',
                },
              },
            },
          },
        ],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
}

/** Personal 层：模板派生的 api-key Provider（默认选择可缺省，用于 typed 不可用分支）。 */
function personalRelease(defaultModelSelection: boolean): object {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: PERSONAL_PROVIDER_ID,
            templateId: "fake-template",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "fake-key" },
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      ...(defaultModelSelection
        ? {
            defaultModelSelection: {
              providerId: PERSONAL_PROVIDER_ID,
              modelId: BUILTIN_MODEL_ID,
            },
          }
        : {}),
    },
  };
}

async function writeProductionProviderConfigs(input: {
  builtinPath: string;
  personalPath: string;
  baseURL: string;
  defaultModelSelection: boolean;
}): Promise<void> {
  await writeFile(input.builtinPath, JSON.stringify(builtinRelease(input.baseURL)), "utf8");
  await writeFile(
    input.personalPath,
    JSON.stringify(personalRelease(input.defaultModelSelection)),
    "utf8",
  );
}

function acceptScheme(triggerId: string, index: number) {
  return {
    currentEvidence: `${triggerId} 现状证据 file:${index}`,
    candidateOptions: [
      { option: "option-a", cost: "cost-a" },
      { option: "option-b", cost: "cost-b" },
    ],
    recommendation: "推荐 option-a",
    impact: "影响面",
    verification: "命令 + 判据",
  };
}

const RUN_REQUEST = {
  workspaceIdentity: WS,
  sessionKey: "k",
  prompt: "x",
  candidateCount: 1,
  toolAllowlist: [] as readonly string[],
  toolDisallowlist: [] as readonly string[],
  modelTier: "adjudicator" as const,
  scheduling: "background-low-priority" as const,
};

describe("headless adjudication model session", () => {
  it("真模型返回 verdict JSON → decision_log 落行 + trigger 状态收敛", async () => {
    const verdict = JSON.stringify({
      decisions: [
        {
          triggerId: CANDIDATE_1,
          disposition: "accept",
          reason: "real environment event",
          evidence: ["payload text"],
        },
        { triggerId: CANDIDATE_2, disposition: "record-only", reason: "noise" },
      ],
    });
    const server = await startFakeProviderServer({
      program: SERVE,
      canned: { textReply: verdict },
    });
    servers.push(server);
    const harness = await createHarness({
      server,
      abortSignal: new AbortController().signal,
    });

    const outcome = await harness.driver.runBatch(WS);
    expect(outcome.status).toBe("applied");
    expect(outcome.verdictDegraded).toBeUndefined();
    expect(outcome.decisions).toEqual([
      {
        triggerId: CANDIDATE_1,
        disposition: "accept",
        reason: "real environment event",
        evidence: ["payload text"],
      },
      { triggerId: CANDIDATE_2, disposition: "record-only", reason: "noise" },
    ]);

    // 真 HTTP 模型请求：一次 non-stream generateText，未携带工具（tools=[]）。
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.stream).toBe(false);
    expect(server.requests[0]!.toolNames).toEqual([]);

    // P2（mandateGate 关）：accept / record-only 均收敛 record_only，decision_log 为 would_accept。
    expect(adjudicationStatus(harness.database, CANDIDATE_1)).toBe("record_only");
    expect(adjudicationStatus(harness.database, CANDIDATE_2)).toBe("record_only");
    const rows = decisionRows(harness.database);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(
      expect.objectContaining({
        trigger_id: CANDIDATE_1,
        origin: "adjudication",
        disposition: "would_accept",
        reason: "real environment event",
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        trigger_id: CANDIDATE_2,
        origin: "adjudication",
        disposition: "would_accept",
        reason: "noise",
      }),
    );
    expect(rows.every((row) => row.batch_id === outcome.batchId)).toBe(true);
    expect(harness.errors).toEqual([]);
  });

  it("满批 32 个 accept：输出预算按批推导，不因旧 4096 固定值截断整批降级", async () => {
    const ids = Array.from(
      { length: ADJUDICATION_MAX_BATCH_SIZE },
      (_, index) => `cand-full-${index}`,
    );
    const decisions = ids.map((triggerId, index) => ({
      triggerId,
      disposition: "accept",
      reason: `event ${index}`,
      evidence: ["payload text"],
      scheme: acceptScheme(triggerId, index),
    }));
    const server = await startFakeProviderServer({
      program: SERVE,
      canned: { textReply: JSON.stringify({ decisions }) },
    });
    servers.push(server);
    const harness = await createHarness({
      server,
      abortSignal: new AbortController().signal,
      seed: ids,
    });

    const outcome = await harness.driver.runBatch(WS);
    expect(outcome.status).toBe("applied");
    expect(outcome.verdictDegraded).toBeUndefined();
    expect(outcome.decisions).toHaveLength(ADJUDICATION_MAX_BATCH_SIZE);
    expect(outcome.decisions.every((decision) => decision.disposition === "accept")).toBe(true);
    // 预算 = 32 × 每卡最坏 + 外壳，且确实高于旧固定值；模型 spec（1M）不钳制本用例。
    expect(adjudicationOutputTokenBudget(ADJUDICATION_MAX_BATCH_SIZE)).toBe(
      ADJUDICATION_MAX_OUTPUT_TOKENS,
    );
    expect(ADJUDICATION_MAX_OUTPUT_TOKENS).toBeGreaterThan(4_096);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.maxOutputTokens).toBe(ADJUDICATION_MAX_OUTPUT_TOKENS);
    expect(server.requests[0]!.maxOutputTokens).toBeGreaterThan(4_096);
    expect(decisionRows(harness.database)).toHaveLength(ADJUDICATION_MAX_BATCH_SIZE);
  });

  it("生产装配（真 builtin/personal 配置 + 真 Registry/adapter）→ runBatch 落行", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-agent-adj-env-"));
    tempDirs.push(root);
    const builtinPath = join(root, "zcode-builtin.json");
    const personalPath = join(root, "provider_config.json");
    const verdict = JSON.stringify({
      decisions: [
        {
          triggerId: CANDIDATE_1,
          disposition: "accept",
          reason: "real environment event",
          evidence: ["payload text"],
          scheme: acceptScheme(CANDIDATE_1, 0),
        },
        { triggerId: CANDIDATE_2, disposition: "record-only", reason: "noise" },
      ],
    });
    const server = await startFakeProviderServer({
      program: SERVE,
      canned: { textReply: verdict },
    });
    servers.push(server);
    await writeProductionProviderConfigs({
      builtinPath,
      personalPath,
      baseURL: server.baseURL,
      defaultModelSelection: true,
    });

    const controller = new AbortController();
    const unavailable: unknown[] = [];
    const assembly = await createEnvironmentAdjudicationSessionAssembly({
      env: {
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: builtinPath,
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalPath,
      },
      dataBaseDir: join(root, "data"),
      abortSignal: controller.signal,
      onUnavailable: (error) => unavailable.push(error),
    });
    disposers.push(() => {
      void Promise.resolve(assembly.dispose()).catch(() => undefined);
    });
    expect(unavailable).toEqual([]);

    const harness = await createHarness({
      server,
      abortSignal: controller.signal,
      session: assembly.session,
    });
    const outcome = await harness.driver.runBatch(WS);

    expect(outcome.status).toBe("applied");
    expect(outcome.modelCalled).toBe(true);
    expect(outcome.verdictDegraded).toBeUndefined();
    expect(outcome.decisions).toHaveLength(2);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.route).toBe("anthropic-messages");
    // M3/T1 零工具主闸在真实 wire 上成立（不只靠会话实现硬编码）。
    expect(server.requests[0]!.toolNames).toEqual([]);
    expect(harness.errors).toEqual([]);
    expect(adjudicationStatus(harness.database, CANDIDATE_1)).toBe("record_only");
    expect(adjudicationStatus(harness.database, CANDIDATE_2)).toBe("record_only");
    const rows = decisionRows(harness.database);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.batch_id === outcome.batchId)).toBe(true);
  });

  it("配置缺少默认模型选择 → typed 不可用端口（不是 run 时普通 Error），资源已释放", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-agent-adj-nomodel-"));
    tempDirs.push(root);
    const builtinPath = join(root, "zcode-builtin.json");
    const personalPath = join(root, "provider_config.json");
    await writeProductionProviderConfigs({
      builtinPath,
      personalPath,
      baseURL: "http://127.0.0.1:1",
      defaultModelSelection: false,
    });
    const unavailable: unknown[] = [];
    const assembly = await createEnvironmentAdjudicationSessionAssembly({
      env: {
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: builtinPath,
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalPath,
      },
      dataBaseDir: join(root, "data"),
      abortSignal: new AbortController().signal,
      onUnavailable: (error) => unavailable.push(error),
    });
    expect(assembly.available).toBe(false);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toBeInstanceOf(AdjudicationSessionUnavailableError);
    await expect(assembly.session.run(RUN_REQUEST)).rejects.toBeInstanceOf(
      AdjudicationSessionUnavailableError,
    );
    await assembly.dispose();
  });

  it("惰性装配只缓存成功：typed 不可用/拒绝后下一批重新装配", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const lazy = createLazyAdjudicationSession({
      abortSignal: controller.signal,
      createAssembly: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient registry failure");
        if (attempts === 2) {
          return {
            available: false,
            session: {
              async run() {
                throw new AdjudicationSessionUnavailableError("provider config missing");
              },
              destroySession() {
                // 无会话。
              },
            },
            dispose: () => undefined,
          };
        }
        return {
          session: {
            async run() {
              return { outputText: '{"decisions":[]}' };
            },
            destroySession() {
              // 无会话。
            },
          },
          dispose: () => undefined,
        };
      },
    });

    await expect(lazy.session.run(RUN_REQUEST)).rejects.toThrow("transient registry failure");
    await expect(lazy.session.run(RUN_REQUEST)).rejects.toBeInstanceOf(
      AdjudicationSessionUnavailableError,
    );
    await expect(lazy.session.run(RUN_REQUEST)).resolves.toEqual({
      outputText: '{"decisions":[]}',
    });
    expect(attempts).toBe(3);
    await lazy.dispose();
  });

  it("装配 hang + shutdown：dispose 随 abort 返回，迟到装配仍被释放", async () => {
    const controller = new AbortController();
    let releaseAssembly!: (assembly: AdjudicationSessionAssembly) => void;
    let lateDisposed = false;
    const lazy = createLazyAdjudicationSession({
      abortSignal: controller.signal,
      createAssembly: () =>
        new Promise<AdjudicationSessionAssembly>((resolve) => {
          releaseAssembly = resolve;
        }),
    });

    const inFlight = lazy.session.run(RUN_REQUEST);
    const disposing = lazy.dispose();
    controller.abort(new Error("control-plane daemon shutting down"));
    await disposing;

    expect(lateDisposed).toBe(false);
    releaseAssembly({
      session: {
        async run() {
          return { outputText: '{"decisions":[]}' };
        },
        destroySession() {
          // 无会话。
        },
      },
      dispose() {
        lateDisposed = true;
      },
    });
    await inFlight;
    await vi.waitFor(() => expect(lateDisposed).toBe(true), { timeout: 5_000 });
  });

  it("模型输出非 JSON → 整批 record-only 降级（verdictDegraded=json），零部分执行", async () => {
    const server = await startFakeProviderServer({
      program: SERVE,
      canned: { textReply: "I think both events are fine." },
    });
    servers.push(server);
    const harness = await createHarness({
      server,
      abortSignal: new AbortController().signal,
    });

    const outcome = await harness.driver.runBatch(WS);
    expect(outcome.status).toBe("applied");
    expect(outcome.verdictDegraded).toBe("json");
    expect(outcome.decisions).toEqual([
      {
        triggerId: CANDIDATE_1,
        disposition: "record-only",
        reason: "verdict-validation-failed:json",
      },
      {
        triggerId: CANDIDATE_2,
        disposition: "record-only",
        reason: "verdict-validation-failed:json",
      },
    ]);
    expect(adjudicationStatus(harness.database, CANDIDATE_1)).toBe("record_only");
    expect(adjudicationStatus(harness.database, CANDIDATE_2)).toBe("record_only");
    expect(decisionRows(harness.database)).toHaveLength(2);
  });

  it("abort（daemon shutdown）中止在途模型请求：session_error、候选留 pending、零落行", async () => {
    const server = await startFakeProviderServer({ program: HANG });
    servers.push(server);
    const controller = new AbortController();
    const harness = await createHarness({
      server,
      abortSignal: controller.signal,
      seed: [CANDIDATE_1],
    });

    const inFlight = harness.driver.runBatch(WS);
    await vi.waitFor(() => expect(server.requests).toHaveLength(1), { timeout: 5_000 });

    controller.abort(new Error("control-plane daemon shutting down"));
    const outcome = await inFlight;

    expect(outcome.status).toBe("session_error");
    expect(outcome.modelCalled).toBe(true);
    expect(outcome.decisions).toEqual([]);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]!.context).toBe(`adjudication session ${WS}`);

    // 真 HTTP 连接被 abort 取消（服务端记账 closedByClient），不是仅返回结果。
    await vi.waitFor(() => expect(server.requests[0]!.closedByClient).toBe(true), {
      timeout: 5_000,
    });
    expect(adjudicationStatus(harness.database, CANDIDATE_1)).toBe("pending");
    expect(decisionRows(harness.database)).toEqual([]);
  });

  it("provider 配置路径：显式 env 优先，否则按 dataBaseDir 推导（Core 物化同根）", () => {
    const dataBaseDir = "/data/base";
    const derived = resolveHeadlessProviderRuntimeEnv({}, dataBaseDir);
    expect(derived[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]).toBe(
      join(dataBaseDir, ".chengcode/v2/runtime/provider/bundled/zcode-builtin.json"),
    );
    expect(derived[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]).toBe(
      join(dataBaseDir, ".chengcode/v2/provider_config.json"),
    );
    expect(derived.ZCODE_DATA_BASE_DIR).toBe(dataBaseDir);

    const explicit = resolveHeadlessProviderRuntimeEnv(
      {
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: "/explicit/builtin.json",
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/explicit/personal.json",
      },
      dataBaseDir,
    );
    expect(explicit[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]).toBe("/explicit/builtin.json");
    expect(explicit[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]).toBe("/explicit/personal.json");
  });

  it("provider 配置不可用 → typed 失败端口（候选留 pending，不伪造 verdict）", async () => {
    const root = await mkdtemp(join(tmpdir(), "super-agent-adj-unavailable-"));
    tempDirs.push(root);
    const unavailable: unknown[] = [];
    const assembly = await createEnvironmentAdjudicationSessionAssembly({
      env: {},
      dataBaseDir: join(root, "data"),
      abortSignal: new AbortController().signal,
      onUnavailable: (error) => unavailable.push(error),
    });
    try {
      expect(unavailable).toHaveLength(1);
      await expect(
        assembly.session.run({
          workspaceIdentity: WS,
          sessionKey: "k",
          prompt: "x",
          candidateCount: 1,
          toolAllowlist: [],
          toolDisallowlist: [],
          modelTier: "adjudicator",
          scheduling: "background-low-priority",
        }),
      ).rejects.toBeInstanceOf(AdjudicationSessionUnavailableError);
    } finally {
      await assembly.dispose();
    }
  });
});
