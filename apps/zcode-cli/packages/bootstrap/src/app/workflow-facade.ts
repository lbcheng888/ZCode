import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { ConfigResult } from "@zcode/adapters/config";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import {
  createNodeWorkflowDefinitionStore,
  createNodeWorkflowStore,
} from "@zcode/adapters/workflow";
import {
  AgentRuntime,
  ExpertWorkflowRuntime,
  createExpertWorkflowDefinition,
  type AgentRuntimeConfig,
  type AgentRuntimeDeps,
  type PermissionService,
  type WorkflowAgentRunner,
} from "@zcode/core";
import {
  type AgentExecutionTelemetryPort,
  createChildTraceContext,
  createSessionId,
  type ContextSourcePort,
  type ExecutionPort,
  type FileSystemPort,
  type HttpClientPort,
  type ImageProcessorPort,
  type PdfDocumentPort,
  type Logger,
  type McpPort,
  type SessionEventSink,
  type SessionId,
  type SessionStorePort,
  type ToolArtifactStorePort,
  type TraceContext,
  type WorkflowDefinition,
} from "@zcode/contracts";
import type { AgentProfile } from "@zcode/shared";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import type { PrepareUserExecutionBoundary, ZCodeAppOptions } from "./types.js";
import { filterWorkflowChildToolface } from "./workflow-actor-tools.js";
import { createWorkflowMethods, type WorkflowFacade } from "./workflow-methods.js";

interface CreateWorkflowFacadeDeps {
  agentTelemetry: AgentExecutionTelemetryPort;
  appOptions: ZCodeAppOptions;
  appVersion: string;
  artifactStore?: ToolArtifactStorePort;
  cliStorageRoot: string;
  configResult: ConfigResult;
  contextSourcePort?: ContextSourcePort;
  eventSink?: SessionEventSink;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  logger: Logger;
  mcpPort?: McpPort;
  /** 父会话的 model factory（与 script-workflow-child-runtime.ts 同一约定）。 */
  modelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]>;
  permissionService: PermissionService;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  runtime: AgentRuntime;
  runtimeConfig: AgentRuntimeConfig;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  storageRoot: string;
  traceContext: TraceContext;
  workingDirectory: string;
}

export function createWorkflowFacade(deps: CreateWorkflowFacadeDeps): WorkflowFacade {
  const workflowStore = createNodeWorkflowStore({
    rootDir: join(deps.cliStorageRoot, "workflows"),
  });
  const workflowDefinitionStore = createNodeWorkflowDefinitionStore({
    rootDir: join(deps.cliStorageRoot, "workflows"),
  });
  const builtInExpertWorkflowDefinition = createExpertWorkflowDefinition();
  const workflowRuntimeCache = new Map<string, ExpertWorkflowRuntime>();
  const workflowAgentRunner: WorkflowAgentRunner = {
    run: async (request) => {
      await deps.prepareUserExecutionBoundary({ traceContext: request.traceContext });
      const workflowKind = request.workflowKind ?? builtInExpertWorkflowDefinition.kind;
      const childSessionId = createSessionId(`workflow_${request.activityId}`);
      const childTraceContext = createChildTraceContext(request.traceContext ?? deps.traceContext, {
        attributes: {
          parentSessionId: deps.sessionId,
          workflowActivityId: request.activityId,
          workflowKind,
          workflowPhase: request.phase,
          workflowRunId: request.runId,
        },
        sessionId: childSessionId,
      });
      const parentSelection = deps.runtime.getSessionModelSelection();
      await request.onChildSessionStarted?.({
        model: parentSelection
          ? `${parentSelection.providerId}/${parentSelection.modelId}`
          : undefined,
        sessionId: childSessionId,
        traceId: childTraceContext.traceId,
      });
      const childRuntime = createWorkflowChildRuntime(deps, {
        childSessionId,
        childTraceContext,
        workflowKind,
        profile: request.profile,
        processEnv: request.processEnv,
      });
      const unsubscribe = request.onEvent
        ? childRuntime.subscribeEvents({ onSessionEvent: request.onEvent })
        : undefined;

      try {
        const result = await childRuntime.executeTurn(request.prompt, undefined, {
          abortSignal: request.abortSignal,
          inputSource: "subagent",
          traceContext: childTraceContext,
        });
        const childSelection = childRuntime.getSessionModelSelection();
        return {
          model: childSelection
            ? `${childSelection.providerId}/${childSelection.modelId}`
            : undefined,
          response: result.response,
          sessionId: childSessionId,
          traceId: result.traceId,
          turnId: result.turnId,
        };
      } finally {
        unsubscribe?.();
      }
    },
  };

  const resolveWorkflowDefinition = async (input?: {
    definitionId?: string;
    workflowKind?: string;
  }): Promise<WorkflowDefinition> => {
    const requestedKind = input?.workflowKind ?? builtInExpertWorkflowDefinition.kind;
    const requestedDefinitionId = input?.definitionId;
    if (!requestedDefinitionId && requestedKind === builtInExpertWorkflowDefinition.kind) {
      return builtInExpertWorkflowDefinition;
    }

    const lookupId = requestedDefinitionId ?? requestedKind;
    const definition = await workflowDefinitionStore.readDefinition(lookupId);
    if (!definition) {
      throw new Error(`Workflow definition not found: ${lookupId}`);
    }
    if (input?.workflowKind && definition.kind !== input.workflowKind) {
      throw new Error(
        `Workflow definition ${definition.definitionId} has kind ${definition.kind}, expected ${input.workflowKind}`,
      );
    }
    return definition;
  };

  const workflowRuntimeForDefinition = (definition: WorkflowDefinition): ExpertWorkflowRuntime => {
    const cacheKey = [definition.definitionId, definition.definitionVersion, definition.kind].join(
      ":",
    );
    const cached = workflowRuntimeCache.get(cacheKey);
    if (cached) return cached;
    const runtimeForDefinition = new ExpertWorkflowRuntime({
      agentRunner: workflowAgentRunner,
      definition,
      onWorkflowEvent: deps.appOptions.onWorkflowEvent,
      store: workflowStore,
    });
    workflowRuntimeCache.set(cacheKey, runtimeForDefinition);
    return runtimeForDefinition;
  };

  const workflowRuntimeForRequest = async (input?: {
    definitionId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowRuntime> =>
    workflowRuntimeForDefinition(await resolveWorkflowDefinition(input));

  const workflowRuntimeForLookup = async (input?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowRuntime> => {
    if (input?.runId) {
      const snapshot = await workflowStore.readRun(input.runId, { signal: input.abortSignal });
      if (snapshot) {
        if (
          snapshot.kind === builtInExpertWorkflowDefinition.kind &&
          (snapshot.definitionId === undefined ||
            snapshot.definitionId === builtInExpertWorkflowDefinition.definitionId)
        ) {
          return workflowRuntimeForDefinition(builtInExpertWorkflowDefinition);
        }
        return workflowRuntimeForDefinition(
          await resolveWorkflowDefinition({
            definitionId: snapshot.definitionId,
            workflowKind: snapshot.kind,
          }),
        );
      }
    }
    return workflowRuntimeForRequest({
      definitionId: input?.definitionId,
      workflowKind: input?.workflowKind,
    });
  };

  const listWorkflowRuns: NonNullable<WorkflowFacade["listWorkflows"]> = async (options) => {
    let workflowKind = options?.workflowKind;
    if (options?.definitionId) {
      const definition = await resolveWorkflowDefinition({
        definitionId: options.definitionId,
        workflowKind,
      });
      workflowKind = definition.kind;
    }
    return workflowStore.listRuns(
      { cwd: deps.workingDirectory, kind: workflowKind, limit: options?.limit },
      { signal: options?.abortSignal },
    );
  };

  const workflowExternalActivityPrompt = (definition: WorkflowDefinition, task: string): string =>
    definition.kind === builtInExpertWorkflowDefinition.kind
      ? `/expert ${task}`
      : `/workflow ${definition.kind} ${task}`;

  const switchWorkflowToYolo = (): void => {
    if (deps.runtime.getMode() !== "yolo" && deps.runtime.getMode() !== "guarded") {
      deps.runtime.updateConfig({ mode: "yolo" });
    }
  };

  const createStartInput = async (
    input: { definitionId?: string; task: string; workflowKind?: string },
    defaultKind?: string,
  ) => {
    const definition = await resolveWorkflowDefinition({
      definitionId: input.definitionId,
      workflowKind: input.workflowKind ?? defaultKind,
    });
    const workflow = workflowRuntimeForDefinition(definition);
    return { definition, workflow };
  };

  const persistWorkflowActivity = async (
    definition: WorkflowDefinition,
    task: string,
    traceContext: TraceContext,
  ): Promise<void> => {
    await deps.runtime.ensureSessionPersistedForExternalActivity(
      workflowExternalActivityPrompt(definition, task),
      { traceContext },
    );
  };

  return createWorkflowMethods({
    builtInExpertWorkflowDefinition,
    createStartInput,
    listWorkflowRuns,
    prepareUserExecutionBoundary: deps.prepareUserExecutionBoundary,
    persistWorkflowActivity,
    sessionId: deps.sessionId,
    switchWorkflowToYolo,
    traceContext: deps.traceContext,
    workflowRuntimeForLookup,
    workingDirectory: deps.workingDirectory,
  });
}

/**
 * 执行适配器的 network 策略：`processEnv` 在场（spec run）时从它派生，缺席时
 * 原样回退用户 config（缺省路径字节不变）。
 *
 * 为什么必须派生：spawn 链路（adapters `buildExecutionEnv`）先按 processEnv 拷贝、
 * 再 `sanitizeZCodeRuntimeEnvInPlace` 剔掉代理键、最后只按这里给的 network 回填。
 * 沿用用户 config 会让子进程拿到用户代理/直连（spec egress 代理被旁路或覆盖），
 * 用户 noProxy 还会注入 NO_PROXY 违反 §3「noProxy 空、含 localhost 也过代理」。
 *
 * fail-closed：processEnv 缺代理键即抛（§3「无代理拒绝启动」），不回退直连。
 * 大小写两态都认——win32 下 `setEnvKey` 的大小写不敏感删除会让 buildSpecRunEnv
 * 只留下小写变体键。与 script-workflow-child-runtime 的同名函数保持同步
 * （两处构造点同一规则）。
 */
function resolveWorkflowChildExecutionNetwork(
  processEnv: Record<string, string> | undefined,
  configNetwork: { caCertFile?: string; httpProxy?: string; noProxy?: string },
): { caCertFile?: string; httpProxy?: string; noProxy?: string } {
  if (processEnv === undefined) {
    return {
      httpProxy: configNetwork.httpProxy,
      noProxy: configNetwork.noProxy,
      caCertFile: configNetwork.caCertFile,
    };
  }
  const httpProxy = processEnv.HTTP_PROXY ?? processEnv.http_proxy;
  if (httpProxy === undefined || httpProxy === "") {
    throw new Error(
      "workflow child processEnv 缺少代理键（HTTP_PROXY）：无代理即拒绝启动（fail-closed），不回退直连",
    );
  }
  return {
    httpProxy,
    noProxy: processEnv.NO_PROXY ?? processEnv.no_proxy ?? "",
    caCertFile: configNetwork.caCertFile,
  };
}

export function createWorkflowChildRuntime(
  deps: CreateWorkflowFacadeDeps,
  options: {
    childSessionId: SessionId;
    childTraceContext: TraceContext;
    workflowKind: string;
    /**
     * spec 受限子代理档案；在场时工具面走 spec 受限链过滤（与 script child 同规则）。
     * 与 `appOptions.executionPort` 互斥（spec 语境的子执行必须走本接缝，见 processEnv）。
     */
    profile?: AgentProfile;
    /**
     * 子执行进程 env；在场直接采用，缺席回落 `appOptions.env ?? process.env`。
     * 调用方约定传 `buildSpecRunEnv` 产出（白名单键、无凭据）。生效前提（fail-closed，
     * 二者同在直接抛错，不降级）：`appOptions.executionPort` 必须缺席——宿主注入共享
     * 执行端口时本入参会被静默忽略，子执行走宿主端口的父 env（含凭据）；且 env 必须
     * 带代理键（HTTP_PROXY）——network 从本 env 派生（super-agent-spec-lane-spec §6-3）。
     */
    processEnv?: Record<string, string>;
  },
): AgentRuntime {
  // fail-closed：共享执行端口携带宿主 env（含凭据），会静默丢弃本接缝的无凭据
  // processEnv / spec profile——spec run「无凭据」失守。二者同在直接拒绝启动。
  if (
    (options.processEnv !== undefined || options.profile !== undefined) &&
    deps.appOptions.executionPort !== undefined
  ) {
    throw new Error(
      "workflow child：processEnv/profile 与 appOptions.executionPort 互斥——共享执行端口携带宿主 env（含凭据），会静默丢弃无凭据的 spec env",
    );
  }
  // profile 生效的工具面：profile.tools 在场才收窄（expert 路径没有 request.opts.tools）。
  const toolAllowlist =
    options.profile?.tools !== undefined
      ? filterWorkflowChildToolface(options.profile.tools, options.profile)
      : undefined;
  // profile.disallowedTools 与继承的 toolDisallowlist 取并集；仅在非空时落键（缺省字节不变）。
  const profileDisallowlist =
    options.profile?.disallowedTools && options.profile.disallowedTools.length > 0
      ? [
          ...new Set([
            ...(deps.runtimeConfig.toolDisallowlist ?? []),
            ...options.profile.disallowedTools,
          ]),
        ]
      : undefined;
  return new AgentRuntime(
    options.childSessionId,
    {
      ...deps.runtimeConfig,
      agentName: options.workflowKind === "expert" ? "zcode-expert" : "zcode-workflow",
      // workflow child 不在 Guarded 合同内；只隔离父任务模式，不继承审批。
      mode: "yolo",
      modelSelection: deps.runtime.getSessionModelSelection(),
      // 父 Shell 在首条输入才解析，不能继承 app 创建时尚未初始化的静态配置。
      bashShellSelection: deps.runtime.getSessionShellSelection(),
      parentSessionId: deps.sessionId,
      taskType: "workflow_child",
      workingDirectory: deps.workingDirectory,
      ...(toolAllowlist === undefined ? {} : { toolAllowlist }),
      ...(profileDisallowlist === undefined
        ? {}
        : { toolDisallowlist: profileDisallowlist }),
    },
    {
      agentTelemetry: deps.agentTelemetry,
      agentTelemetryCausation: deps.agentTelemetry.captureCausation(),
      // Workflow 在父工具返回后独立调度，不能伪装成父 Span 的同步 Child。
      agentTelemetryCausationMode: "linked_root",
      eventStore: createInMemorySessionEventStore(),
      sessionStore: deps.sessionStore,
      logger: deps.logger,
      executionPort:
        deps.appOptions.executionPort ??
        createNodeExecutionAdapter({
          onToolExecResource: deps.appOptions.onToolExecResource,
          // processEnv 在场时 network 从它派生（见 resolveWorkflowChildExecutionNetwork）：
          // spawn 链路 sanitize 后只按这里的 network 回填代理键，沿用用户 config 会让
          // 子进程拿到用户代理/直连，spec egress 代理被旁路。
          network: resolveWorkflowChildExecutionNetwork(
            options.processEnv,
            deps.configResult.config.network,
          ),
          outputRootDir: join(deps.storageRoot, "cli", "exec"),
          bashOutputTempDir: tmpdir(),
          processEnv: options.processEnv ?? deps.appOptions.env ?? process.env,
        }),
      fileSystemPort: deps.appOptions.fileSystemPort ?? createNodeFileSystemAdapter(),
      httpClientPort:
        deps.appOptions.httpClientPort ??
        createNodeWebFetchHttpClientAdapter({
          env: deps.appOptions.env ?? process.env,
          timeoutMs: deps.configResult.config.network.timeout,
          proxyUrl: deps.configResult.config.network.httpProxy,
          noProxy: deps.configResult.config.network.noProxy,
          caCertFile: deps.configResult.config.network.caCertFile,
        }),
      imageProcessorPort: deps.imageProcessorPort,
      pdfDocumentPort: deps.pdfDocumentPort,
      artifactStore: deps.artifactStore,
      contextSourcePort:
        deps.appOptions.contextSourcePort ??
        createNodeContextSourceAdapter({ env: deps.appOptions.env }),
      skillPort:
        deps.configResult.config.features.skill && deps.configResult.config.skills.enabled
          ? (deps.appOptions.skillPort ??
            createNodeSkillAdapter({
              extraRoots: deps.configResult.config.skills.roots,
              // workflow 子 agent 复用同一套 skill 发现逻辑，也必须继承主配置里的禁用路径。
              disabledPaths: collectDisabledPaths(deps.configResult.config.skillOverrides),
            }))
          : undefined,
      mcpPort: deps.mcpPort,
      eventSink: deps.eventSink,
      modelFactory: deps.modelFactory,
      resolveEffectiveModelSelection: deps.appOptions.resolveEffectiveModelSelection,
      // 对外交互端口由父 runtime 派生（permissionBroker + providerRuntimeHeadersPort）：
      // 子会话不是协议客户端认识的身份，直接透传 appOptions 的端口会让反向请求发到一个
      // 客户端找不到的 session 上、response 永不回来。
      ...deps.runtime.createChildClientPorts({
        agentId: options.childSessionId,
        agentType: options.workflowKind === "expert" ? "zcode-expert" : "zcode-workflow",
        childSessionId: options.childSessionId,
        description: `${options.workflowKind} workflow agent`,
        ...(options.childTraceContext.turnId === undefined
          ? {}
          : { parentTurnId: options.childTraceContext.turnId }),
      }),
      permissionService: deps.permissionService,
      appVersion: deps.appVersion,
      traceContext: options.childTraceContext,
    },
  );
}
