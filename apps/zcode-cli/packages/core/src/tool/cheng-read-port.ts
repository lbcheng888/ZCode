import type {
  ChengExplainInput,
  ChengExplainOk,
  ChengInspectOk,
  ChengPlanInput,
  ChengPlanOk,
  ChengVerifyOk,
} from "@zcode/contracts";

/**
 * Cheng 只读工具端口（Inspect / Verify / Explain / Plan）。
 *
 * 独立于工作流的 `ChengHostPort`：模型工具只读已有 job，绝不能拿到 `generate`。端口缺席时
 * handler 返回 `capability_absent`，而不是伪造空结果或退回 `world.run`。
 */
export interface ChengReadPort {
  inspect(jobId: string): Promise<ChengInspectOk>;
  verify(jobId: string): Promise<ChengVerifyOk>;
  explain(input: ChengExplainInput): Promise<ChengExplainOk>;
  plan(input: ChengPlanInput): Promise<ChengPlanOk>;
}

export const CHENG_READ_PORT_UNAVAILABLE_REASON =
  "Cheng host is not wired in this runtime (ZCODE_CHENG_ROOT + cheng host entry are required)";

export type ChengGenerateMode = "production" | "diagnostic";
export type ChengGenerateWaitMode = "sync" | "bounded";

export interface ChengSurfaceViolation {
  ruleId: string;
  line: number;
  column?: number;
  message: string;
}

export interface ChengSurfaceReport {
  schema?: "cheng.contract.surface_report.v1";
  filePath: string;
  fileSha256?: string;
  v4Ok: boolean;
  budgetOk: boolean;
  lineCount: number;
  lineCapOk: boolean;
  violations: ChengSurfaceViolation[];
  truncatedCount?: number;
}

export interface ChengLeafProbeReceipt {
  schema?: "cheng.contract.leaf_probe.v1";
  filePath: string;
  driverSha256?: string;
  exitCode: number;
  objBytes: number;
  compileMaxRssBytes: number;
  wallMs: number;
  admissionTicketId?: string;
  firstError: string | null;
}

export interface ChengBundlePrepareInput {
  draft: Record<string, unknown>;
}

export interface ChengBundlePrepareResult {
  bundleSha256: string;
  bundleDir: string;
  specPath: string;
  task: string;
  cached: boolean;
}

export interface ChengGraphDiffInput {
  runDirA: string;
  runDirB: string;
}

export interface ChengGraphDiffResult {
  added: number;
  removed: number;
  changed: number;
  digestA: string;
  digestB: string;
}

export interface ChengGeneratePortInput {
  specPath: string;
  task: string;
  budget?: number;
  bundleDir?: string;
  mode?: ChengGenerateMode;
  moves?: "macro";
  useLiblearn?: boolean;
  allowDraftUnowned?: boolean;
  waitMode?: ChengGenerateWaitMode;
  maxWaitMs?: number;
}

export interface ChengGeneratePortResult {
  status?: "ok" | "accepted_running";
  jobId: string;
  runId: string | null;
  state: string;
  nextTool?: "ChengInspect";
}

/**
 * Cheng 生成端口：ChengGenerate 的效应面。装配层从完整 host 端口**窄化**出这一个方法——
 * 模型侧拿不到 inspect/cancel/close 等其余面。specPath 由 handler 落盘产生（绝对路径，
 * 宿主可读）；budget 缺省由装配层按 host 缺省档补齐。缺席时 ChengGenerate 与只读工具
 * 同款返回 `capability_absent`，不伪造受理。
 */
export interface ChengGeneratePort {
  generate(input: ChengGeneratePortInput): Promise<ChengGeneratePortResult>;
  bundlePrepare?(input: ChengBundlePrepareInput): Promise<ChengBundlePrepareResult>;
}

/**
 * 统一向后兼容的 Cheng Host 工具端口：包含只读、生成与 v2 密封 Bundle / 表面门 / 叶子探针 / 图差分。
 */
export interface ChengHostToolPort extends ChengReadPort, ChengGeneratePort {
  bundlePrepare?(input: ChengBundlePrepareInput): Promise<ChengBundlePrepareResult>;
  checkSurface?(input: { filePath: string }): Promise<ChengSurfaceReport>;
  probeLeaf?(input: { filePath: string; allowClosureProbe?: boolean }): Promise<ChengLeafProbeReceipt>;
  graphDiff?(input: ChengGraphDiffInput): Promise<ChengGraphDiffResult>;
}
