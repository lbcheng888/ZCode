/**
 * headless child 的裁决 model-only 会话装配（milestone-b-spec §8-7）：
 * 复用 bootstrap 既有 model-only 面（`createRuntimeAdjudicationSession` +
 * `AgentRuntime.generateWorkspaceText`，tools 恒 `[]`），不 import
 * `@zcode/services` / `@zcode/server-cli`。
 *
 * provider 装配沿用 `create-app` 的同一条链：进程 Provider Registry
 * （`startProcessProviderRegistryRuntime`，standalone 凭据面）→ 真模型 adapter
 * （`createModelAdapter`）→ `ApiProviderModelRuntime.modelFactory`。选择 pin 走既有
 * Registry 校验 + `completeAuxiliaryRegistryModelSelection`（最低推理档 = 轻量档；
 * M12③ adjudicator=轻量档）。
 *
 * 失败语义：provider 配置/凭据不可用、或没有可执行默认模型时返回 **typed 失败端口**
 * （{@link AdjudicationSessionUnavailableError}）；候选留 pending，绝不伪造 verdict。
 *
 * 装配时点：daemon 启动期 Core 可能尚未物化 Built-in Config
 * （`{dataBaseDir}/.zcode/v2/runtime/provider/bundled/zcode-builtin.json`），因此入口
 * 用 {@link createLazyAdjudicationSession} 把 provider Registry 启动推迟到首个裁决批；
 * shutdown 先 abort 该信号再 dispose，在途模型请求随 abort 取消。
 *
 * 已知接缝（如实登记，不假装已接）：① 轻量档 pin = Registry 最低推理档，不是产品级
 * 「adjudicator 模型档位」配置（design 开放问题①）；② `scheduling=background-low-priority`
 * 无独立低优先槽，走同一 provider 通道（与里程碑 A §8-3 同缺口）；③ 请求的
 * toolAllowlist/toolDisallowlist 被忽略——tools 恒 `[]` 是更严的零工具主闸。
 */
import { join } from "node:path";

import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { createSessionId, type ModelSelection } from "@zcode/contracts";
import {
  AgentRuntime,
  type AgentRuntimeConfig,
  type AgentRuntimeDeps,
  type ProviderRuntimeHeadersPort,
} from "@zcode/core";
import {
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";

import { createModelAdapter } from "../../model-factory.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../../model-config.js";
import { startProcessProviderRegistryRuntime } from "../../app/process-provider-registry-runtime.js";
import {
  completeAuxiliaryRegistryModelSelection,
  createRegistrySelectionProtocolError,
} from "../../app/provider-registry-selection.js";
import { ApiProviderModelRuntime } from "../../app/provider-registry-model-runtime.js";
import {
  createRuntimeAdjudicationSession,
} from "../../app/super-agent-control-plane.js";
import {
  ADJUDICATION_MAX_BATCH_SIZE,
  type AdjudicationModelSessionPort,
} from "../adjudication/index.js";

/** 裁决模型会话的 typed 不可用错误：调用方按 session_error 留 pending，不伪造结论。 */
export class AdjudicationSessionUnavailableError extends Error {
  readonly code = "ADJUDICATION_SESSION_UNAVAILABLE";

  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`super-agent daemon 裁决模型会话不可用：${reason}`, options);
    this.name = "AdjudicationSessionUnavailableError";
  }
}

/**
 * verdict 输出预算（resource budget，非启发式）。预算按本批实际候选数推导：
 * 每个候选最坏是一个 accept × M6 五字段方案卡（现状/≥2 候选方案/推荐/影响/验证
 * + JSON 包装），再加固定 JSON 外壳余量。固定 4096 会在满批（32 accept）下截断
 * JSON → 校验失败 → 整批 record-only（fail-closed）；批越忙越必然降级。
 * 模型 spec 更小时由装配层向 spec 钳制（不向上越界）。
 */
export const ADJUDICATION_OUTPUT_TOKENS_PER_CANDIDATE = 256;
export const ADJUDICATION_OUTPUT_TOKENS_OVERHEAD = 256;

/** 满批（{@link ADJUDICATION_MAX_BATCH_SIZE}）的完整预算；小批按实际候选数缩减。 */
export const ADJUDICATION_MAX_OUTPUT_TOKENS =
  ADJUDICATION_OUTPUT_TOKENS_OVERHEAD +
  ADJUDICATION_OUTPUT_TOKENS_PER_CANDIDATE * ADJUDICATION_MAX_BATCH_SIZE;

/** 单批输出预算：固定外壳 + 每候选最坏卡预算（候选数按单批上限钳制防御）。 */
export function adjudicationOutputTokenBudget(candidateCount: number): number {
  const count = Math.max(0, Math.min(candidateCount, ADJUDICATION_MAX_BATCH_SIZE));
  return ADJUDICATION_OUTPUT_TOKENS_OVERHEAD + ADJUDICATION_OUTPUT_TOKENS_PER_CANDIDATE * count;
}

/**
 * 一次装配产出的会话与其可释放资源（provider Registry/模型运行时）。
 * `available=false` = typed 不可用端口（配置/凭据瞬时缺失）：本批仍按 typed 错误
 * 留 pending，但惰性装配不得缓存它，下一批必须重新装配。
 */
export interface AdjudicationSessionAssembly {
  readonly session: AdjudicationModelSessionPort;
  readonly available?: boolean;
  dispose(): Promise<void> | void;
}

/** 装配钩子：入口生产缺省 = {@link createEnvironmentAdjudicationSessionAssembly}。 */
export type CreateAdjudicationSessionAssembly = (input: {
  abortSignal: AbortSignal;
}) => Promise<AdjudicationSessionAssembly>;

export interface HeadlessAdjudicationModelSource {
  readonly modelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]>;
  /** 装配期 pin 的轻量档选择；undefined = 无可用默认模型（会话 run 时 typed 失败）。 */
  resolveSelection(): ModelSelection | undefined;
  /** 模型 spec 的 maxOutputTokens 上限（装配期从 Registry 读取）；预算按批推导后向此钳制。 */
  readonly maxOutputTokensSpecLimit?: number;
  readonly providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  dispose(): void;
}

/** 不可用端口：每次 run 都以同一 typed 错误响亮失败，destroy 为空操作。 */
export function createUnavailableAdjudicationSession(
  reason: string,
  cause?: unknown,
): AdjudicationModelSessionPort {
  const error = new AdjudicationSessionUnavailableError(reason, cause === undefined ? undefined : { cause });
  return {
    async run() {
      throw error;
    },
    destroySession() {
      // 无会话可销毁。
    },
  };
}

/**
 * 用既有 model-only 面构造裁决会话：`AgentRuntime.generateWorkspaceText`（tools 恒
 * `[]`，比 toolAllowlist 更严的零工具主闸）+ `createRuntimeAdjudicationSession`
 * 的 abort/缺模型检查。事件存储用内存实现（短命回合，不落会话历史）。
 */
export function createHeadlessAdjudicationSession(input: {
  modelSource: HeadlessAdjudicationModelSource;
  abortSignal: AbortSignal;
  workingDirectory: string;
}): AdjudicationModelSessionPort {
  const config: AgentRuntimeConfig = {
    workingDirectory: input.workingDirectory,
  };
  const runtime = new AgentRuntime(
    createSessionId("super-agent-adjudication"),
    config,
    {
      eventStore: createInMemorySessionEventStore(),
      modelFactory: input.modelSource.modelFactory,
      ...(input.modelSource.providerRuntimeHeadersPort
        ? { providerRuntimeHeadersPort: input.modelSource.providerRuntimeHeadersPort }
        : {}),
    },
  );
  return createRuntimeAdjudicationSession({
    // model-only 辅助生成不经过 turn 的输出预算绑定，adapter 要求显式值；预算按本批
    // 实际候选数推导（tools=[] / prompt 语义保持组合根 helper 原样）。
    generateWorkspaceText: (textInput, options) => runtime.generateWorkspaceText(textInput, options),
    resolveSelection: () => input.modelSource.resolveSelection(),
    abortSignal: input.abortSignal,
    resolveMaxOutputTokens: (request) => {
      const budget = adjudicationOutputTokenBudget(request.candidateCount);
      const specLimit = input.modelSource.maxOutputTokensSpecLimit;
      return specLimit === undefined ? budget : Math.min(budget, specLimit);
    },
  });
}

/**
 * 懒装配端口：首个 `run` 才启动 provider Registry。构造期只持有创建钩子，
 * 避免与 Core 物化 Built-in Config 的启动顺序竞态，也不为无人裁决的 child 付启动成本。
 * shutdown 时先 abort abortSignal（在途模型请求取消），再 dispose 已装好的资源。
 */
export function createLazyAdjudicationSession(deps: {
  abortSignal: AbortSignal;
  createAssembly: CreateAdjudicationSessionAssembly;
}): AdjudicationSessionAssembly {
  let assemblyPromise: Promise<AdjudicationSessionAssembly> | undefined;
  let loaded: AdjudicationSessionAssembly | undefined;

  const ensureAssembly = (): Promise<AdjudicationSessionAssembly> => {
    if (assemblyPromise) return assemblyPromise;
    const attempt = deps.createAssembly({ abortSignal: deps.abortSignal }).then(
      (assembly) => {
        if (assembly.available === false) {
          // 瞬时不可用（配置/凭据/Registry 启动失败）：本批仍走 typed 失败端口（候选留
          // pending），但只缓存成功装配——否则运行期补上配置后仍永久失效到重启。
          if (assemblyPromise === attempt) assemblyPromise = undefined;
          return assembly;
        }
        loaded = assembly;
        return assembly;
      },
      (error: unknown) => {
        // 拒绝同样不缓存：下一批重新装配（驱动器已有 T 冷却，不会热循环）。
        if (assemblyPromise === attempt) assemblyPromise = undefined;
        throw error;
      },
    );
    assemblyPromise = attempt;
    return attempt;
  };

  const session: AdjudicationModelSessionPort = {
    async run(request) {
      const assembly = await ensureAssembly();
      return await assembly.session.run(request);
    },
    destroySession(sessionKey) {
      // 首回合前窗口结束：没有会话可销毁；已装配时委托真实实现（headless 实现为幂等空操作）。
      loaded?.session.destroySession(sessionKey);
    },
  };

  return {
    session,
    async dispose() {
      // 已装配：直接释放（此时 abort 已由入口先发，在途请求已取消）。
      if (loaded) {
        try {
          await loaded.dispose();
        } catch {
          // 资源释放失败不覆盖 shutdown 的既有收口原因。
        }
        return;
      }
      const pending = assemblyPromise;
      if (!pending) return;
      // 装配本身（Provider Registry 启动/凭据 store）不受模型 abort 约束。dispose 不能
      // 同步等它——shutdown 会被 Registry 启动拖到 Supervisor 超时；用 abort 竞速，
      // 迟到 settle 的装配由后续回调自行释放，避免资源泄漏。
      let onAbort: () => void = () => undefined;
      const aborted = new Promise<"aborted">((resolve) => {
        onAbort = () => resolve("aborted");
        if (deps.abortSignal.aborted) {
          resolve("aborted");
          return;
        }
        deps.abortSignal.addEventListener("abort", onAbort, { once: true });
      });
      const settled = pending.then(
        (assembly) => ({ assembly }),
        () => ({ assembly: undefined }),
      );
      try {
        const outcome = await Promise.race([settled, aborted]);
        if (outcome === "aborted") {
          void pending.then(
            (assembly) => Promise.resolve(assembly.dispose()).catch(() => undefined),
            () => undefined,
          );
          return;
        }
        if (outcome.assembly) await outcome.assembly.dispose();
      } finally {
        deps.abortSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * 生产装配：解析 provider 配置路径 → standalone Provider Registry（含凭据 store）→
 * 真 adapter/modelFactory → pin 轻量档选择 → model-only 会话。
 * 任一步失败返回 typed 不可用端口（候选留 pending），不静默降级。
 */
export async function createEnvironmentAdjudicationSessionAssembly(input: {
  env: Record<string, string | undefined>;
  dataBaseDir: string;
  abortSignal: AbortSignal;
  onUnavailable: (error: unknown) => void;
}): Promise<AdjudicationSessionAssembly> {
  if (input.abortSignal.aborted) {
    return {
      available: false,
      session: createUnavailableAdjudicationSession("daemon 已收口，拒绝启动 provider Registry", input.abortSignal.reason),
      dispose: () => undefined,
    };
  }
  const providerEnv = resolveHeadlessProviderRuntimeEnv(input.env, input.dataBaseDir);
  let providerRuntime: Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>;
  try {
    providerRuntime = await startProcessProviderRegistryRuntime(providerEnv, { standalone: {} });
  } catch (error) {
    input.onUnavailable(error);
    return {
      available: false,
      session: createUnavailableAdjudicationSession(
        `Provider Registry 启动失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
      dispose: () => undefined,
    };
  }
  if (input.abortSignal.aborted) {
    providerRuntime.dispose();
    return {
      available: false,
      session: createUnavailableAdjudicationSession("daemon 已收口，provider Registry 未接入", input.abortSignal.reason),
      dispose: () => undefined,
    };
  }

  let modelRuntime: ApiProviderModelRuntime | undefined;
  try {
    const modelAdapter = createModelAdapter({
      env: providerEnv,
      executionConfig: createRuntimeAiSdkModelExecutionConfig(providerEnv, {}),
    });
    modelRuntime = new ApiProviderModelRuntime({
      registry: providerRuntime.runtime.registryService,
      modelAdapter,
    });
    modelRuntime.start();
    const pinned = resolvePinnedAdjudicatorSelection(providerRuntime);
    if (!pinned) {
      // 没有可执行默认模型 = 装配不可用，不是「装配成功但 run 时普通报错」：
      // 直接返回 typed 失败端口并释放已建模型运行时，调用方按类型区分。
      const error = new AdjudicationSessionUnavailableError(
        "未配置可执行的默认模型（候选保持 pending）",
      );
      input.onUnavailable(error);
      modelRuntime.dispose();
      providerRuntime.dispose();
      return {
        available: false,
        session: createUnavailableAdjudicationSession(error.reason, error),
        dispose: () => undefined,
      };
    }
    const modelSource: HeadlessAdjudicationModelSource = {
      modelFactory: modelRuntime.modelFactory,
      resolveSelection: () => pinned.selection,
      maxOutputTokensSpecLimit: pinned.maxOutputTokensSpecLimit,
      ...(providerRuntime.providerRuntimeHeadersPort
        ? { providerRuntimeHeadersPort: providerRuntime.providerRuntimeHeadersPort }
        : {}),
      dispose() {
        modelRuntime?.dispose();
        providerRuntime.dispose();
      },
    };
    return {
      session: createHeadlessAdjudicationSession({
        modelSource,
        abortSignal: input.abortSignal,
        workingDirectory: input.dataBaseDir,
      }),
      dispose: () => modelSource.dispose(),
    };
  } catch (error) {
    try {
      modelRuntime?.dispose();
    } finally {
      providerRuntime.dispose();
    }
    input.onUnavailable(error);
    return {
      available: false,
      session: createUnavailableAdjudicationSession(
        `裁决模型运行时装配失败: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
      dispose: () => undefined,
    };
  }
}

/**
 * child 侧 provider 配置路径解析（与 CLI `prepareCliProviderRuntimeEnv` 的同一布局）：
 * 显式 env 优先；否则 Built-in = Core 在 `{dataBaseDir}/.zcode/v2/runtime/provider/
 * bundled/zcode-builtin.json` 物化的随包基线（services `getAppConfigDir()` 同根），
 * Personal = `{dataBaseDir}/.zcode/v2/provider_config.json`。
 *
 * 不猜 PATH/不下载：文件缺失由 Provider Registry 原样抛错，装配层转 typed 不可用。
 */
export function resolveHeadlessProviderRuntimeEnv(
  env: Readonly<Record<string, string | undefined>>,
  dataBaseDir: string,
): Record<string, string | undefined> {
  const explicitBuiltin = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const explicitPersonal = env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const configRoot = join(dataBaseDir, ".chengcode", "v2");
  return {
    ...env,
    ZCODE_DATA_BASE_DIR: dataBaseDir,
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]:
      explicitBuiltin ??
      join(configRoot, "runtime", "provider", "bundled", "zcode-builtin.json"),
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]:
      explicitPersonal ?? join(configRoot, PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  };
}

function resolvePinnedAdjudicatorSelection(
  providerRuntime: Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>,
): { selection: ModelSelection; maxOutputTokensSpecLimit: number } | undefined {
  const configured = providerRuntime.configuredDefaultModelSelection;
  if (!configured) return undefined;
  const registry = providerRuntime.runtime.registryService;
  // 轻量档 pin：最低公开推理档，不按名称扫 off/nothink；与 create-app 的
  // completeAuxiliaryRegistryModelSelection 同一 helper（中台单点）。
  const selection = completeAuxiliaryRegistryModelSelection(registry, configured);
  const validation = registry.validateSelection(selection);
  if (!validation.ok) throw createRegistrySelectionProtocolError(validation);
  const specMax = registry.getModel(selection.providerId, selection.modelId)?.config.optionSpecs
    .maxOutputTokens.max;
  if (!Number.isInteger(specMax) || specMax === undefined || specMax <= 0) {
    throw new Error(
      `裁决模型缺少有效 maxOutputTokens spec：${selection.providerId}/${selection.modelId}`,
    );
  }
  return {
    selection,
    maxOutputTokensSpecLimit: specMax,
  };
}
