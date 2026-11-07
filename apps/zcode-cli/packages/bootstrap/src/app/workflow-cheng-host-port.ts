import {
  StdioHostClient,
  evaluateVerifyGate,
  evaluateVerifyPlan,
  type ChengPlanResult,
  type MethodResult,
} from "@zcode/cheng-host";
import { WorkflowError } from "@zcode/dynamic-workflow";

import { CHENG_DEFAULT_BUDGET, type ChengGenerateInput, type ChengGraphResult, type ChengHostPort, type ChengJobResult, type ChengJobSnapshot, type ChengVerifyResult } from "./workflow-cheng-world-read.js";
import type { ChengJobObserver } from "../super-agent/cheng-job-observer.js";

/**
 * 生产 ChengHostPort：在本 run 里拉起一个 **stdio 作用域** 的 `cheng-host` 子进程，
 * 用它的 typed RPC 执行 generate/verify/graph，并在 run 结算时关闭。
 *
 * 为什么是 per-run 子进程而不是复用 per-workspace 常驻 host：P3 的 driver 没有跨 run 的
 * 生命周期钩子，复用一个长命 host 会把关闭责任留在一个没人持有的地方；stdio 作用域与
 * 会话同生共死，符合 P2 的 scope 决策。常驻 host 的复用留给 S1 的 spec-lane 接线。
 *
 * 端口本身不判断能否运行：host 在启动时对 `ZCODE_CHENG_ROOT`、git work tree、runner、
 * driver 全量 fail-closed；本层只负责把错误原样上抛（引擎落成节点失败）。
 */
export interface ChengHostPortConfig {
  /** cheng-lang checkout，同时作为 host 的 workspace root 与子进程 cwd。 */
  readonly chengRoot: string;
  /** ZCode 数据根；job journal 落 `<dataBaseDir>/.chengcode/v2/cheng/...`。 */
  readonly dataBaseDir: string;
  /** `cheng-host` 的入口文件（dist/main.js）；与 {@link cliCommand} 二选一。 */
  readonly hostEntry?: string;
  /**
   * CLI 自 re-exec 前缀（安装产物路径）：`["dist/zcode.cjs", "__zcode-cheng-host"]` 或
   * SEA 下的 `["__zcode-cheng-host"]`；与 {@link hostEntry} 二选一。
   */
  readonly cliCommand?: readonly string[];
  readonly jobTimeoutMs?: number;
  readonly pollMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** S0：job 生命周期观察者；生产装配传 createChengJobObserver(registry/ledger)。 */
  readonly observer?: ChengJobObserver;
}

/** 构造 spawn 的 command/argv 前缀；纯函数便于在装配测试里断言两种入口。 */
export function chengHostSpawnArgs(
  config: Pick<ChengHostPortConfig, "hostEntry" | "cliCommand">,
  extraArgs: readonly string[],
): { command: string; args: string[] } {
  const prefix =
    config.hostEntry !== undefined ? [config.hostEntry] : config.cliCommand;
  if (prefix === undefined || prefix.length === 0) {
    throw new WorkflowError(
      "DriverError",
      "Cheng host launch is not configured: pass hostEntry or cliCommand.",
    );
  }
  return { command: process.execPath, args: [...prefix, ...extraArgs] };
}

export function createChengHostPort(config: ChengHostPortConfig): ChengHostPort {
  let clientPromise: Promise<StdioHostClient> | null = null;
  const activeJobs = new Set<string>();
  const lifecycleListeners = new Set<
    (event: { type: "started" | "terminal"; jobId: string }) => void
  >();
  const emitLifecycle = (event: { type: "started" | "terminal"; jobId: string }): void => {
    for (const listener of lifecycleListeners) {
      listener(event);
    }
  };

  const client = (): Promise<StdioHostClient> => {
    clientPromise ??= StdioHostClient.connect({
      ...chengHostSpawnArgs(config, [
        "--scope=stdio",
        `--workspace-root=${config.chengRoot}`,
        `--data-base-dir=${config.dataBaseDir}`,
      ]),
      cwd: config.chengRoot,
      // 桌面 agent 由 Electron Helper 运行（execPath 指向 Helper），而 CLI 启动时会把
      // ELECTRON_RUN_AS_NODE 从 env sanitize 掉。不显式带回，子进程会按完整 Electron
      // 启动而不执行 zcode.cjs；纯 Node 下该变量无效。与 dynamic-workflow harness 同处理。
      env: {
        ...(config.env ?? process.env),
        ELECTRON_RUN_AS_NODE: "1",
        ZCODE_CHENG_ROOT: config.chengRoot,
      },
      workspaceRoot: config.chengRoot,
      workspaceIdentity: "cheng-lang",
      clientKind: "workflow",
    }).catch((error: unknown) => {
      clientPromise = null;
      throw asWorkflowError("connect", error);
    });
    return clientPromise;
  };

  const cancelJob = async (
    jobId: string,
  ): Promise<"queued" | "running" | "succeeded" | "failed" | "cancelled"> => {
    const host = await client();
    const result = await request(host, "job.cancel", { jobId }, 30_000);
    return result.state;
  };

  return {
    async inspect(jobId: string): Promise<ChengJobSnapshot> {
      const host = await client();
      const status = await request(host, "job.status", { jobId }, 10_000);
      return {
        jobId: status.jobId,
        state: status.state,
        runId: status.runId,
        runDir: status.runDir,
        exitCode: status.exitCode,
        cancelRequested: status.cancelRequested,
      };
    },

    async generate(
      input: ChengGenerateInput,
      onStarted?: (jobId: string) => void,
    ): Promise<ChengJobResult> {
      const host = await client();
      const started = await request(host, "generate", {
        specPath: input.specPath,
        task: input.task,
        mode: "diagnostic",
        budget: input.budget,
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      });
      // 归属先于观测登记：observer 写库失败时 job 已经被 host 受理，必须先进
      // activeJobs/onStarted，否则异常路径会留下无人跟踪、无人取消的孤儿 job。
      activeJobs.add(started.jobId);
      emitLifecycle({ type: "started", jobId: started.jobId });
      onStarted?.(started.jobId);
      const unsubscribe =
        config.observer === undefined
          ? undefined
          : host.onEvent((event) => {
              if (event.params.jobId !== started.jobId) return;
              if (event.method === "job.progress") {
                config.observer?.progress({ jobId: started.jobId });
              }
            });
      let status: MethodResult<"job.status">;
      try {
        config.observer?.started({ jobId: started.jobId });
        status = await waitTerminal(host, started.jobId, config);
      } catch (error) {
        // observer 失败不能让 host job 继续裸跑；取消失败与原始错误一起上浮。
        try {
          await request(host, "job.cancel", { jobId: started.jobId }, 30_000);
        } catch (cancelError) {
          throw new AggregateError(
            [error, cancelError],
            `Cheng job ${started.jobId} failed its observer and could not be cancelled.`,
          );
        }
        throw error;
      } finally {
        activeJobs.delete(started.jobId);
        emitLifecycle({ type: "terminal", jobId: started.jobId });
        unsubscribe?.();
      }
      if (status.state !== "succeeded" && status.state !== "failed" && status.state !== "cancelled") {
        throw new WorkflowError("DriverError", `Cheng job ${started.jobId} did not settle.`);
      }
      await config.observer?.terminal({
        jobId: started.jobId,
        state: status.state,
        ...(status.runId === null ? {} : { runId: status.runId }),
      });
      return {
        jobId: started.jobId,
        runId: status.runId,
        state: status.state,
        exitCode: status.exitCode,
        verdict: verdictOf(status.state),
      };
    },

    async verify(jobId: string): Promise<ChengVerifyResult> {
      const host = await client();
      const result = await request(host, "verify", { jobId });
      const settles = result.settle?.settles ?? [];
      return {
        level: result.receipt.acceptance.level,
        productionAcceptance: result.receipt.acceptance.productionAcceptance,
        verdict: result.receipt.acceptance.verdict ?? "UNKNOWN",
        semanticPass: result.receipt.judge.every((judge) => judge.status === "semantic_pass"),
        settlePassed: settles.filter((settle) => settle.verdict === "pass").length,
        settleTotal: settles.length,
        structureGateOk: result.structure?.checks.structureGateOk ?? null,
        gate: evaluateVerifyGate({
          receipt: result.receipt,
          settle: result.settle,
          structure: result.structure,
        }),
        artifactRef: result.artifactRef,
      };
    },

    async plan(jobId: string, task: string): Promise<ChengPlanResult> {
      const host = await client();
      const result = await request(host, "verify", { jobId });
      return evaluateVerifyPlan({
        receipt: result.receipt,
        settle: result.settle,
        structure: result.structure,
        task,
        jobId,
      });
    },

    async graph(jobId: string, task: string, view: "structure" | "decision"): Promise<ChengGraphResult> {
      const host = await client();
      const result = await request(host, "graph.query", { jobId, task, view });
      return {
        available: result.available,
        reason: result.reason,
        nodes: result.summary?.nodes ?? 0,
        edges: result.summary?.edges ?? 0,
        roots: result.summary?.roots ?? 0,
        gateOk: result.summary?.gateOk ?? null,
        artifactRef: result.artifactRef,
        digest: result.digest,
      };
    },

    cancel: cancelJob,

    async cancelActive(): Promise<number> {
      const ids = [...activeJobs];
      await Promise.allSettled(ids.map((jobId) => cancelJob(jobId)));
      return ids.length;
    },

    onJobLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => {
        lifecycleListeners.delete(listener);
      };
    },

    async close(): Promise<void> {
      const pending = clientPromise;
      clientPromise = null;
      if (pending !== null) {
        const host = await pending.catch(() => null);
        await host?.close();
      }
    },
  };
}

type HostMethod = "generate" | "job.status" | "job.cancel" | "verify" | "graph.query";

async function request<M extends HostMethod>(
  host: StdioHostClient,
  method: M,
  params: unknown,
  deadlineMs = 30_000,
): Promise<MethodResult<M>> {
  try {
    return await host.request(method, params, deadlineMs);
  } catch (error) {
    throw asWorkflowError(method, error);
  }
}

async function waitTerminal(
  host: StdioHostClient,
  jobId: string,
  config: ChengHostPortConfig,
): Promise<MethodResult<"job.status">> {
  const timeoutMs = config.jobTimeoutMs ?? 15 * 60 * 1000;
  const pollMs = config.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await request(host, "job.status", { jobId }, 10_000);
    if (status.state === "succeeded" || status.state === "failed" || status.state === "cancelled") {
      return status;
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new WorkflowError("DriverError", `Cheng job ${jobId} did not settle within ${String(timeoutMs)}ms.`);
}

function verdictOf(state: "succeeded" | "failed" | "cancelled"): string {
  switch (state) {
    case "succeeded":
      return "DIAGNOSTIC_NOT_ACCEPTANCE";
    case "cancelled":
      return "CANCELLED";
    case "failed":
      return "FAILED";
  }
}

function asWorkflowError(op: string, error: unknown): WorkflowError {
  if (error instanceof WorkflowError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : null;
  return new WorkflowError(
    "DriverError",
    `Cheng ${op} failed${code === null ? "" : ` (${code})`}: ${message}`,
    { cause: error },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 供装配方统一口径；与 facade 注释里的缺省值同源。 */
export const CHENG_HOST_DEFAULT_BUDGET = CHENG_DEFAULT_BUDGET;
