import type { ToolSearchMode } from "@zcode/contracts";
import { promptTriggerSourceOf } from "@zcode/core";
import { getDefaultConfigPath, updateUiLocaleInFileConfig } from "@zcode/adapters/config";
import type { SessionEvent } from "@zcode/contracts";
import type { SendInputOptions, ZCodeApp, ZCodeAppOptions } from "@zcode/bootstrap";
import { getSuperAgentDatabasePath } from "@zcode/bootstrap/paths";
import { DEFAULT_LOCALE, type SupportedLocale } from "@zcode/i18n";
import {
  parseCommandEnvelope,
  type CommandAck,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import type { TuiRequestPermission } from "@zcode/tui";
import type { GlobalOptions } from "@zcode/shared-types";
import type { DynamicWorkflowMode } from "@zcode/shared";
import { createCommandCenter, parseSlashCommand } from "./command-center.js";
import type { CommandCenterApp } from "./command-center.js";
import { resolveDisplayLocale } from "./locale.js";
import { createCliHeadlessBrowserRuntime } from "./headless-browser.js";
// 复用防御式 runtime 读取：subscribeEvents 不在 app 的静态类型面上，
// 两处各写一份「怎么把它读出来」就会在方法改名时只修好一处。
import { readRuntimeEventSubscriber } from "./runtime-event-subscriber.js";
import { createTuiSessionEventRelay } from "./tui-session-event-relay.js";
import { attachTuiAppQueries, readTuiSessionMetadata } from "./tui-prompt-handler-queries.js";
import {
  createTuiProcessRuntimeState,
  prepareTuiAppRuntime,
} from "./tui-prompt-handler-runtime.js";
import { DEFAULT_CLI_CLEANUP_TIMEOUT_MS, runCliCleanupWithTimeout } from "./shutdown.js";
import {
  configureApiKeyForTui,
  loginBigmodelForTui,
  loginForTui,
  logoutForTui,
} from "./tui-auth.js";
import {
  listCustomCommandsForTui,
  listSessionsForTui,
  listSkillsForTui,
  loadCustomCommandForTui,
} from "./tui-command-data.js";
import {
  currentCliMode,
  readTuiMode,
  TUI_TITLE_GENERATION_CONFIG,
  type TuiPromptHandler,
} from "./tui-command-state.js";
import { createTuiModelAvailabilityChecker } from "./tui-login-state.js";
import { withTuiMetadata } from "./tui-submit-metadata.js";
import { DEFAULT_CLI_WORKFLOW_MODE, resolveWorkflowModeRuntimeConfig } from "./workflow-mode.js";
import { resolveGoalLayerRuntimeConfig, type CliGoalLayerMode } from "./goal-layer.js";
import { resolveSwarmRuntimeConfig } from "./swarm/index.js";
import type {
  CliModeState,
  CliPermissionMode,
  CliResumeRequest,
  CliRuntimeMode,
  ModeCapableApp,
  RunDependencies,
} from "./cli-types.js";

// ── TUI 进程内 super-agent 宿主注入面（spec §8-2/§8-14④）──
//
// TUI 不走协议宿主的 ConversationV4Gateway：它直接持有 create-app 返回的 ZCodeApp，
// 单会话、进程内。因此这里提供 handleCommand 的 TUI 侧命令入口——把 super-agent
// 控制面发出的 sendText 信封投给 `app.sendInput`，由 Core 完成唯一 prompt admission；
// 不做第二套调度、不旁路 Core。
//
// 绑定时机：create-app 在返回 app 之前就会启动控制面（leader 抢占/回填/派发桥续推），
// 此时 app 变量尚未赋值。因此 handleCommand 是「延迟绑定」闭包：投递期现读 getApp()，
// 未就绪就响亮失败，不排队、不降级、绝不静默吞掉一次触发。

// 与协议 CommandInbox 的 512/session LRU 同预算：TUI 是单会话进程内宿主，幂等事实
// 不跨进程持久化，这里只吸收同进程内的重投/重试。
const TUI_COMMAND_ACK_MEMORY_LIMIT = 512;

type TuiSuperAgentHostApp = Pick<ZCodeApp, "sessionId" | "sendInput">;

interface CreateTuiSuperAgentHostPortsOptions {
  /** 延迟绑定：投递期现读当前 app（/new、/resume 换 app 后自动指向新实例）。 */
  getApp: () => TuiSuperAgentHostApp | undefined;
}

class BoundedAckMemory {
  private readonly entries = new Map<string, CommandAck>();

  constructor(private readonly limit: number) {}

  get(commandId: string): CommandAck | undefined {
    return this.entries.get(commandId);
  }

  set(commandId: string, ack: CommandAck): void {
    this.entries.delete(commandId);
    this.entries.set(commandId, ack);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

function rejectedAck(commandId: string, reasonCode: string, message: string): CommandAck {
  return {
    commandId,
    status: "rejected",
    reasonCode,
    message,
    revisionAtDecision: 0,
  };
}

/**
 * requestedDelivery → Core admission 参数（M1 车道表，spec §8-4）：
 * - queue = followup：busy 时强制 FIFO 入队（`queueDelivery: "queue"` 关掉 steer 分流），
 *   idle 时照常起轮；`auto` 只是让 Core 自行判 busy。
 * - guide = 步边界行内：busy 且可 steer 走 guide，否则 Core 回退 queue。
 * - startNow / 缺省（dispatch push 信封不带 requestedDelivery）：start_turn；TUI 没有
 *   协议宿主的 foreground promotion lease，busy 时 Core 会按既有准入入队而不是抢占。
 */
function deliveryOptionsOf(
  requestedDelivery: "startNow" | "queue" | "guide" | undefined,
): SendInputOptions {
  if (requestedDelivery === "queue") {
    return { delivery: "auto", queueDelivery: "queue" };
  }
  if (requestedDelivery === "guide") {
    return { delivery: "steer_active_turn", queueDelivery: "guide" };
  }
  return { delivery: "start_turn" };
}

function createTuiSuperAgentHostPorts(
  options: CreateTuiSuperAgentHostPortsOptions,
): NonNullable<ZCodeAppOptions["superAgent"]> {
  const superAgentDatabasePath = getSuperAgentDatabasePath();
  const ackMemory = new BoundedAckMemory(TUI_COMMAND_ACK_MEMORY_LIMIT);
  const inFlight = new Map<string, Promise<CommandAck>>();

  const executeSendText = async (envelope: CommandEnvelope): Promise<CommandAck> => {
    const app = options.getApp();
    if (!app) {
      throw new Error(
        "TUI super-agent handleCommand 在 app 绑定前被调用（延迟绑定未就绪；spec §8-2 禁止静默降级）",
      );
    }
    if (envelope.sessionId === null || envelope.sessionId !== app.sessionId) {
      // TUI 只承载本进程这一条会话；订阅里其他 session 的投递不能在本宿主伪造 admission。
      return rejectedAck(
        envelope.commandId,
        "tui.sessionNotHosted",
        `TUI 宿主未承载会话 ${envelope.sessionId ?? "(null)"}`,
      );
    }
    const payload = envelope.payload as { text?: unknown; requestedDelivery?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      return rejectedAck(
        envelope.commandId,
        "proto.invalidPayload",
        "super-agent sendText 正文为空",
      );
    }
    const requestedDelivery =
      payload.requestedDelivery === "startNow" ||
      payload.requestedDelivery === "queue" ||
      payload.requestedDelivery === "guide"
        ? payload.requestedDelivery
        : undefined;
    const result = await app.sendInput(payload.text, {
      inputId: envelope.commandId,
      // M4：控制面投递带 triggerId = 事件回合；来源交给 Core，facts 缺席即响亮失败。
      ...(envelope.triggerId ? { triggerSource: promptTriggerSourceOf(envelope) } : {}),
      ...deliveryOptionsOf(requestedDelivery),
    });
    if (result.kind === "rejected") {
      return rejectedAck(envelope.commandId, result.reason, `Core 拒绝投递: ${result.reason}`);
    }
    return {
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: 0,
    };
  };

  const handleCommand = async (rawParams: unknown): Promise<CommandAck> => {
    const parsed = parseCommandEnvelope(rawParams);
    if (!parsed.ok) {
      // 校验失败是宿主接线错误（super-agent 只会造 sendText），响亮抛错而不是伪造 ACK。
      throw new Error(`TUI super-agent 信封校验失败: ${parsed.error.message}`);
    }
    const envelope = parsed.envelope;
    if (envelope.type !== "sendText") {
      throw new Error(
        `TUI super-agent 宿主只承载 sendText，收到 ${envelope.type}（spec §8-14④）`,
      );
    }
    const duplicate = ackMemory.get(envelope.commandId);
    if (duplicate) return { ...duplicate, status: "duplicate" };
    const pending = inFlight.get(envelope.commandId);
    if (pending) {
      const settled = await pending;
      return settled.status === "accepted" ? { ...settled, status: "duplicate" } : settled;
    }

    const execution = executeSendText(envelope);
    inFlight.set(envelope.commandId, execution);
    try {
      const ack = await execution;
      // 只缓存 accepted：rejected 的同 id 重投必须继续如实拒绝，不能把 duplicate
      // 当成「已准入」（派发桥把 duplicate 视为 settle 成功）。
      if (ack.status === "accepted") ackMemory.set(envelope.commandId, ack);
      return ack;
    } finally {
      inFlight.delete(envelope.commandId);
    }
  };

  return {
    handleCommand,
    autoReplyGuard: {
      async admit(envelope) {
        // 守卫适用面与 admitAutoReplyTurn 同式：只有群内 IM 且非卡片回调、非 elicitation
        // 才消耗互答占额（intake/contract.ts AutoReplyGuardPort 合同：其余适用面原样 true）。
        // TUI 进程不承载 botsService 状态，适用面一旦被咨询就响亮失败（不伪造占额）。
        const isGuardScope =
          envelope.source === "im" &&
          envelope.payload.chatType === "group" &&
          envelope.payload.groupCardAction !== true &&
          envelope.payload.elicitation !== true;
        if (!isGuardScope) return true;
        throw new Error(
          "TUI 宿主缺 bots 互答守卫状态（admitAutoReplyTurn 未接入，spec §8-2/§8-10②）",
        );
      },
    },
    superAgentDatabasePath,
    // 不注入 tasksIndexDatabasePath：派发桥循环尚未接线（spec ws7 偏差：桥行延后），
    // 生产唯一价值是构造期 prepare SQL；注入后一旦 tasks-index 文件存在但迁移未落地
    // （旧 Desktop 遗留文件），createDispatchBridge 会在 `no such table: dispatch_requests`
    // 上让 flag-on TUI 启动失败。「文件存在」不能当迁移证明，接线前干脆不建可选桥。
  };
}

export function createTuiSubmitPrompt(
  deps: RunDependencies,
  modeState: CliModeState,
  version: string,
  resumeRequest: CliResumeRequest = { continueSession: false },
  uiLocale?: GlobalOptions["locale"],
  uiDetectedLocale?: GlobalOptions["detectedLocale"],
  startupLocale: SupportedLocale = DEFAULT_LOCALE,
  toolDisallowlist?: readonly string[],
  forceMcs = false,
  toolsearchMode: ToolSearchMode = "off",
  browserUse?: GlobalOptions["browserUse"],
  browserExecutable?: GlobalOptions["browserExecutable"],
  workflowMode: DynamicWorkflowMode = DEFAULT_CLI_WORKFLOW_MODE,
  goalLayer?: CliGoalLayerMode,
  swarm?: boolean,
): TuiPromptHandler {
  let app: Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>> | undefined;
  let activeUiLocale = uiLocale;
  // 进程级句柄（telemetry / Provider Registry / endpoint 路由）跨 App 替换复用，见 runtime 文件。
  const processRuntime = createTuiProcessRuntimeState();
  let closeHandlerPromise: Promise<void> | undefined;
  const closePromises = new WeakMap<object, Promise<void>>();
  const browserRuntimes = new WeakMap<
    object,
    NonNullable<ReturnType<typeof createCliHeadlessBrowserRuntime>>
  >();
  // Bug 根因：审批入口原先只在单次 submitPrompt/sendInput 调用内有效，调用结束即恢复为空；
  // 通知驱动的回合和 CreateSession 建的后台会话在这之外询问，只能被 fail closed 拒绝。
  // 现在由 TUI 挂载时登记、卸载时注销，入口只有这一个 owner，不再按提交切换。
  let registeredRequestPermission: TuiRequestPermission | undefined;
  const cleanupTimeoutMs = Math.max(
    1,
    Math.trunc(deps.shutdownCleanupTimeoutMs ?? DEFAULT_CLI_CLEANUP_TIMEOUT_MS),
  );
  const permissionBroker: NonNullable<ZCodeAppOptions["permissionBroker"]> = {
    requestPermission: async (request, requestOptions) => {
      const requestPermission = registeredRequestPermission;
      if (!requestPermission) {
        return {
          decision: "deny",
          reason: `No interactive approval handler configured for ${request.toolName}`,
          resolvedAt: new Date(),
        };
      }

      return await requestPermission(request, requestOptions);
    },
  };

  // super-agent 宿主注入面（spec §8-2/§8-14④）：flag 关时 create-app 完全忽略该字段，
  // 字节兼容；flag 开时 handleCommand 延迟绑定到当前 app，避免启动期缺注入响亮失败。
  const superAgentHost = createTuiSuperAgentHostPorts({
    getApp: () => app as TuiSuperAgentHostApp | undefined,
  });

  const closeApp = async (targetApp = app): Promise<void> => {
    if (!targetApp) return;
    const closeKey = targetApp as object;
    let closePromise = closePromises.get(closeKey);
    if (!closePromise) {
      closePromise = (async () => {
        await runCliCleanupWithTimeout(async () => targetApp.close?.(), cleanupTimeoutMs);
        // App/session 关闭悬空或失败时仍需释放 CLI 自己启动的 Chromium。
        await runCliCleanupWithTimeout(
          async () => browserRuntimes.get(closeKey)?.close(),
          cleanupTimeoutMs,
        );
      })();
      closePromises.set(closeKey, closePromise);
    }
    await closePromise;
  };

  // ── 跨回合常驻的会话事件订阅──
  // per-turn 的 onEvent 在回合结束即死，收不到出回合事件（dwf 进度、后台通知驱动的回合）。
  const sessionEventRelay = createTuiSessionEventRelay({
    currentRuntime: () => (app as { runtime?: unknown } | undefined)?.runtime,
    readSubscriber: readRuntimeEventSubscriber,
  });

  const replaceApp = async (
    factory: () => Promise<Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>>>,
  ): Promise<CommandCenterApp> => {
    const previousApp = app;
    const nextApp = await factory();
    app = nextApp;
    if (previousApp && previousApp !== nextApp) {
      await closeApp(previousApp);
    }
    // 常驻订阅要跟着换 app 重挂：这里是 /new、/resume、/fork 共同的唯一收口，
    // 漏挂的后果是换 session 后 TUI 再也收不到出回合事件（dwf 进度、通知驱动回合）。
    sessionEventRelay.reattach();
    modeState.current = readTuiMode(app, currentCliMode(modeState));
    return app as unknown as CommandCenterApp;
  };

  const createApp = async (request: CliResumeRequest) => {
    if (closeHandlerPromise) throw new Error("TUI prompt handler is closed");
    const {
      appEnv,
      configuredDefaultModelSelection,
      createAppFactory,
      providerRegistryRuntime,
      sessionId,
      workingDirectory,
    } = await prepareTuiAppRuntime(deps, version, request, processRuntime);
    const providerEndpointRoutingPort = processRuntime.providerEndpointRoutingPort;
    const browserRuntime = createCliHeadlessBrowserRuntime({ browserExecutable, browserUse }, deps);
    let createdApp: Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>>;
    try {
      createdApp = await createAppFactory({
        modelSelectionMode: "cli-default",
        standaloneSessionControl: true,
        browserControlPort: browserRuntime?.browserControlPort,
        env: appEnv,
        projectConfigPath: deps.projectConfigPath,
        ...(providerEndpointRoutingPort ? { providerEndpointRoutingPort } : {}),
        providerRegistry: providerRegistryRuntime.runtime.registryService,
        configuredDefaultModelSelection,
        ...(providerRegistryRuntime.providerRuntimeHeadersPort
          ? {
              providerRuntimeHeadersPort: providerRegistryRuntime.providerRuntimeHeadersPort,
            }
          : {}),
        resume: sessionId !== undefined,
        runtimeConfig: {
          ...(modeState.override ? { mode: modeState.override } : {}),
          ...(toolDisallowlist ? { toolDisallowlist } : {}),
          toolSearch: { mode: toolsearchMode },
          ...(forceMcs ? { midConversationSystem: { mode: "force" as const } } : {}),
          // 首个 app 与 /new、/resume、fork 都经这里创建，mode 因此在进程内一致。
          ...resolveWorkflowModeRuntimeConfig(workflowMode),
          ...resolveGoalLayerRuntimeConfig(goalLayer),
          ...resolveSwarmRuntimeConfig(swarm),
          modelStreaming: "on",
          titleGeneration: TUI_TITLE_GENERATION_CONFIG,
          workingDirectory,
        },
        permissionBroker,
        superAgent: superAgentHost,
        sessionId,
        skipUserConfig: deps.skipUserConfig,
        uiDetectedLocale,
        uiLocale: activeUiLocale,
        userConfigPath: deps.userConfigPath,
        version,
      });
    } catch (error) {
      await runCliCleanupWithTimeout(async () => browserRuntime?.close(), cleanupTimeoutMs);
      throw error;
    }
    if (browserRuntime) browserRuntimes.set(createdApp as object, browserRuntime);
    // 初始化在等待旧身份导入时 TUI 可能已关闭；迟到 App 不能重新成为当前会话。
    if (closeHandlerPromise) {
      await closeApp(createdApp);
      throw new Error("TUI prompt handler is closed");
    }
    modeState.current = readTuiMode(createdApp, currentCliMode(modeState));
    return createdApp;
  };

  const getApp = async (): Promise<CommandCenterApp> => {
    app ??= await createApp(resumeRequest);
    modeState.current = readTuiMode(app, currentCliMode(modeState));
    return app as unknown as CommandCenterApp;
  };

  const resumeApp = async (sessionId?: string): Promise<CommandCenterApp> => {
    return await replaceApp(
      async () =>
        await createApp(
          sessionId
            ? {
                continueSession: false,
                resumeSessionId: sessionId,
              }
            : {
                continueSession: true,
              },
        ),
    );
  };

  const newApp = async (): Promise<CommandCenterApp> => {
    return await replaceApp(
      async () =>
        await createApp({
          continueSession: false,
        }),
    );
  };

  const setCliMode = async (nextMode: CliPermissionMode): Promise<CliRuntimeMode> => {
    modeState.override = nextMode;

    if (app) {
      const modeCapableApp = app as ModeCapableApp;
      if (modeCapableApp.setMode) {
        const result = await modeCapableApp.setMode(nextMode);
        modeState.current = readTuiMode(modeCapableApp, result.mode);
        return modeState.current;
      }

      modeCapableApp.runtime.updateConfig({ mode: nextMode });
    }

    modeState.current = app ? readTuiMode(app, nextMode) : nextMode;
    return modeState.current;
  };

  const commandCenter = createCommandCenter({
    forkApp: async (targetCheckpointId) => {
      const activeApp = await getApp();
      const result = await activeApp.forkFromCheckpoint?.({ targetCheckpointId });
      if (!result) {
        throw new Error("Forking is not available in this client.");
      }
      await replaceApp(
        async () =>
          await createApp({
            continueSession: false,
            resumeSessionId: result.forkedSessionId,
          }),
      );
      return {
        copiedMessageCount: result.copiedMessageCount,
        forkedSessionId: result.forkedSessionId,
        response: `${result.response}\nSwitched to forked session ${result.forkedSessionId}.`,
        restoredFileCount: result.restoredFileCount ?? result.restoredFiles?.length ?? 0,
      };
    },
    getApp,
    getMode: () => currentCliMode(modeState),
    getLocale: () =>
      app?.getLocale?.() ?? resolveDisplayLocale(activeUiLocale, uiDetectedLocale) ?? startupLocale,
    hasSelectableModels: createTuiModelAvailabilityChecker(getApp),
    listCustomCommands: () => listCustomCommandsForTui(deps),
    listSessions: () => listSessionsForTui(deps),
    listSkills: () => listSkillsForTui(deps),
    configureApiKey: (options) => configureApiKeyForTui(deps, options),
    login: (options) => loginForTui(deps, options),
    loginBigmodel: (options) => loginBigmodelForTui(deps, options),
    loadCustomCommand: (name) => loadCustomCommandForTui(deps, name),
    newApp,
    recordInputHistory: async (input, kind) => {
      await app?.recordInputHistory?.(input, kind);
    },
    resumeApp,
    saveDefaultModelSelection: async (selection) => {
      const runtime = await processRuntime.providerRegistryRuntimePromise;
      if (!runtime?.modelSelectionConfigRepository) {
        throw new Error("Default model configuration storage is unavailable.");
      }
      await runtime.modelSelectionConfigRepository.saveConfiguredDefault(selection);
    },
    logout: () => logoutForTui(deps),
    setLocale: async (locale) => {
      if (app?.setLocale) {
        const result = await app.setLocale(locale);
        activeUiLocale = locale;
        return result;
      }
      activeUiLocale = locale;
      const persisted = await updateUiLocaleInFileConfig(
        deps.userConfigPath ?? getDefaultConfigPath(),
        locale,
      );
      return {
        configPath: persisted.path,
        locale: resolveDisplayLocale(locale, uiDetectedLocale) ?? "en-US",
        requestedLocale: locale,
      };
    },
    setMode: setCliMode,
    workflowMode,
  });

  const submitPrompt: TuiPromptHandler = async (input, options) => {
    const result = await commandCenter(input, options);
    return app ? { ...result, ...(await readTuiSessionMetadata(await getApp())) } : result;
  };

  submitPrompt.setMode = async (nextMode) => ({ mode: await setCliMode(nextMode) });

  submitPrompt.registerPermissionRequester = (requestPermission) => {
    registeredRequestPermission = requestPermission;
    return () => {
      // 只注销自己：重新挂载时新入口先登记，旧入口的迟到注销不能把它清掉。
      if (registeredRequestPermission === requestPermission)
        registeredRequestPermission = undefined;
    };
  };

  submitPrompt.sendInput = async (input, options) => {
    // Model/effort changes configure subsequent requests, including during an active turn.
    const command = parseSlashCommand(typeof input === "string" ? input : input.text);
    if (command?.type === "known" && (command.name === "model" || command.name === "effort")) {
      return {
        kind: "command_result",
        result: await submitPrompt(input, {
          ...options,
          abortSignal: options?.abortSignal ?? new AbortController().signal,
        }),
      };
    }
    const activeApp = await getApp();
    if (activeApp.sendInput) {
      const result = await activeApp.sendInput(input, options);
      if (result.kind !== "started_turn") return result;
      return withTuiMetadata(result.result, activeApp, currentCliMode(modeState));
    }

    return withTuiMetadata(
      await activeApp.submitPrompt(input, options),
      activeApp,
      currentCliMode(modeState),
    );
  };

  attachTuiAppQueries(submitPrompt, getApp);

  submitPrompt.subscribeSessionEvents = (sink: (event: SessionEvent) => void) => {
    const unsubscribe = sessionEventRelay.addSink(sink);
    // app 还没建好时首次实挂会落空；建好后再挂一次（reattach 幂等，不会重复扇出）。
    void getApp().then(
      () => sessionEventRelay.reattach(),
      () => undefined,
    );
    return unsubscribe;
  };

  // 主会话 id：给 TUI 做会话闸门用（actor/子会话事件保留子 sessionId 投进同一个 sink 集）。
  // 每次现读而不是缓存：replaceApp 换 app 就换会话，缓存下来的 id 会把整条转写判成外来。
  submitPrompt.getMainSessionId = () => {
    const runtime = (app as { runtime?: { getSessionId?: () => string } } | undefined)?.runtime;
    const sessionId = runtime?.getSessionId?.();
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  };

  submitPrompt.close = async () => {
    closeHandlerPromise ??= (async () => {
      await closeApp();
      // Bug 根因：TUI 的 Session 切换和进程退出共用了 App close，不能在 /new 等路径
      // 提前关闭共享 Owner；只有整个 Prompt Handler 终态才做对称 shutdown。
      await runCliCleanupWithTimeout(
        async () => processRuntime.shutdownTelemetry?.(),
        cleanupTimeoutMs,
      );
      const providerRegistryRuntime = await processRuntime.providerRegistryRuntimePromise;
      providerRegistryRuntime?.dispose();
    })();
    await closeHandlerPromise;
  };

  return submitPrompt;
}
