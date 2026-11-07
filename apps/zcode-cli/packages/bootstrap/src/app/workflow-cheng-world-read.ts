import { WorkflowError } from "@zcode/dynamic-workflow";
import type { ChengPlanResult } from "@zcode/cheng-host";
import type { GoalContinuationChengPlanCard } from "@zcode/contracts";

/**
 * Cheng 数据面的三个 world-read op。generate 是**效应**（引擎落 `world-run` 并关导入缓存），
 * verify/graph 是只读投影（落 `world-read`）；三者的站点身份与 files/git 同构，所以执行侧
 * 只需要把位置实参校验成端口调用，编译/降级/引擎一行不改。
 *
 * 端口**可选**：不带端口的装配（snippet、纯 replay、fake driver、尚未接线的宿主）里
 * `cheng.*` 以命名的 {@link WorkflowError} `ChengHostUnavailable` 拒绝该节点——脚本可 catch，
 * 节点以 failed 落 journal；绝不静默跳过、绝不退回 `world.run` 模板。
 */

export const CHENG_WORLD_READ_OPS = [
  "cheng-generate",
  "cheng-verify",
  "cheng-graph",
] as const;

export type ChengWorldReadOp = (typeof CHENG_WORLD_READ_OPS)[number];

export function isChengWorldReadOp(op: string): op is ChengWorldReadOp {
  return (CHENG_WORLD_READ_OPS as readonly string[]).includes(op);
}

/** 缺省 M5 预算：与 `cheng-host` diagnostic 档的默认口径一致，可被脚本显式覆盖。 */
export const CHENG_DEFAULT_BUDGET = 90_000;

export interface ChengGenerateInput {
  specPath: string;
  task: string;
  budget: number;
  attempt?: string;
}

export interface ChengJobResult {
  jobId: string;
  runId: string | null;
  state: "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  verdict: string;
}

/** 只读快照：模型工具 ChengInspect 的输入事实，不开作业。 */
export interface ChengJobSnapshot {
  jobId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  runId: string | null;
  runDir: string | null;
  exitCode: number | null;
  cancelRequested: boolean;
}

export interface ChengGateVerdict {
  ok: boolean;
  level: "PRODUCTION" | "DIAGNOSTIC_NOT_ACCEPTANCE" | "BLOCKED";
  reasons: string[];
}

export interface ChengVerifyResult {
  level: "PRODUCTION" | "DIAGNOSTIC_NOT_ACCEPTANCE" | "UNKNOWN";
  productionAcceptance: boolean | null;
  verdict: string;
  semanticPass: boolean;
  settlePassed: number;
  settleTotal: number;
  structureGateOk: boolean | null;
  /** host 用原始回执经真实 ChengGate 评估的结果。 */
  gate: ChengGateVerdict;
  artifactRef: string;
}

export interface ChengGraphResult {
  available: boolean;
  reason: string | null;
  nodes: number;
  edges: number;
  roots: number;
  gateOk: boolean | null;
  artifactRef: string;
  digest: string;
}

/** 生产装配实现（见 `workflow-cheng-host-port.ts`）；测试可注入同形的 stub。 */
export interface ChengHostPort {
  /**
   * 启动 generate 作业。`onStarted` 在 host 受理、jobId 确定后同步调用一次；
   * run-scoped 包装靠它把 job 归属到发起它的那个 run，而不是靠全局生命周期广播。
   */
  generate(
    input: ChengGenerateInput,
    onStarted?: (jobId: string) => void,
  ): Promise<ChengJobResult>;
  /** 只读 job 快照；ChengInspect 用。 */
  inspect(jobId: string): Promise<ChengJobSnapshot>;
  verify(jobId: string): Promise<ChengVerifyResult>;
  /** 只读 planner：verify 原始回执 → ChengGate + ChengPlan。 */
  plan(jobId: string, task: string): Promise<ChengPlanResult>;
  graph(
    jobId: string,
    task: string,
    view: "structure" | "decision",
  ): Promise<ChengGraphResult>;
  /** 取消单个 job；host 只有在进程树确认消失后才返回 cancelled。 */
  cancel(jobId: string): Promise<"queued" | "running" | "succeeded" | "failed" | "cancelled">;
  /** 取消本端口当前在途的所有 job（workflow run 取消的接缝）。返回请求数。 */
  cancelActive(): Promise<number>;
  /**
   * 订阅端口上的 job 生命周期广播，供引擎观察。
   * 注意：run-scoped 端口的在途 job 归属来自 `generate` 的 `onStarted`，不依赖此广播。
   * 返回退订函数。
   */
  onJobLifecycle(
    listener: (event: { type: "started" | "terminal"; jobId: string }) => void,
  ): () => void;
  /** 关闭底层 host 连接/进程；装配方持有生命周期时可不实现。 */
  close?(): Promise<void>;
}

/**
 * ChengPlan → goal continuation 的 compact 路线卡：只保留 plan_id/run_id/frontier/
 * recommended/evidence_refs（证据去重、上限 8），不把候选全集塞进 continuation prompt。
 */
export function toGoalContinuationChengPlanCard(
  plan: ChengPlanResult["plan"],
  planId: string,
  runId?: string,
): GoalContinuationChengPlanCard {
  const recommendedEvidence =
    plan.candidates.find(
      (candidate) =>
        candidate.action === plan.recommended.action &&
        candidate.target === plan.recommended.target,
    )?.evidence ?? [];
  return {
    planId,
    ...(runId === undefined ? {} : { runId }),
    frontier: {
      stage: plan.frontier.stage,
      target: plan.frontier.target,
      evidence: plan.frontier.evidence,
    },
    recommended: {
      action: plan.recommended.action,
      target: plan.recommended.target,
    },
    evidenceRefs: [
      ...new Set([...plan.frontier.evidence, ...recommendedEvidence]),
    ].slice(0, 8),
  };
}

export async function executeChengWorldRead(
  port: ChengHostPort | undefined,
  op: ChengWorldReadOp,
  args: unknown[],
): Promise<unknown> {
  if (port === undefined) {
    throw new WorkflowError(
      "ChengHostUnavailable",
      `Cheng ${op} requires a wired Cheng host port; this runtime has none.`,
    );
  }

  switch (op) {
    case "cheng-generate":
      return await port.generate(parseGenerateArgs(op, args));
    case "cheng-verify":
      return await port.verify(singleStringArg(op, args, "jobId"));
    case "cheng-graph": {
      const [jobId, task, view] = graphArgs(op, args);
      return await port.graph(jobId, task, view);
    }
    default: {
      const unknownOp: never = op;
      throw new WorkflowError(
        "DriverError",
        `Unsupported Cheng world-read op "${String(unknownOp)}".`,
      );
    }
  }
}

function parseGenerateArgs(op: ChengWorldReadOp, args: unknown[]): ChengGenerateInput {
  exactlyOneArg(op, args);
  const raw = args[0];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw driverError(op, "expects one object argument");
  }
  const record = raw as Record<string, unknown>;
  const allowed = new Set(["specPath", "task", "budget", "attempt"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw driverError(op, `unexpected argument "${key}"`);
    }
  }
  const specPath = requiredString(op, record.specPath, "specPath");
  const task = requiredString(op, record.task, "task");
  const budget =
    record.budget === undefined ? CHENG_DEFAULT_BUDGET : boundedBudget(op, record.budget);
  const attempt =
    record.attempt === undefined ? undefined : attemptNonce(op, record.attempt);
  return {
    specPath,
    task,
    budget,
    ...(attempt === undefined ? {} : { attempt }),
  };
}

function graphArgs(
  op: ChengWorldReadOp,
  args: unknown[],
): [string, string, "structure" | "decision"] {
  if (args.length < 2 || args.length > 3) {
    throw driverError(op, "expects (jobId, task, view?)");
  }
  const jobId = requiredString(op, args[0], "jobId");
  const task = requiredString(op, args[1], "task");
  if (args.length === 2 || args[2] === undefined) {
    return [jobId, task, "decision"];
  }
  const view = args[2];
  if (view !== "structure" && view !== "decision") {
    throw driverError(op, 'view must be "structure" or "decision"');
  }
  return [jobId, task, view];
}

function singleStringArg(op: ChengWorldReadOp, args: unknown[], label: string): string {
  exactlyOneArg(op, args);
  return requiredString(op, args[0], label);
}

function exactlyOneArg(op: ChengWorldReadOp, args: unknown[]): void {
  if (args.length !== 1) {
    throw driverError(op, "expects exactly one argument");
  }
}

function requiredString(op: ChengWorldReadOp, value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw driverError(op, `${label} must be a non-empty string`);
  }
  return value;
}

function boundedBudget(op: ChengWorldReadOp, value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 900_000
  ) {
    throw driverError(op, "budget must be an integer in 1..900000");
  }
  return value;
}

function attemptNonce(op: ChengWorldReadOp, value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(value)) {
    throw driverError(op, "attempt must match [A-Za-z0-9._:-]{1,64}");
  }
  return value;
}

function driverError(op: ChengWorldReadOp, detail: string): WorkflowError {
  return new WorkflowError("DriverError", `Cheng ${op} ${detail}.`);
}
