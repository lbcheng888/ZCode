/**
 * Cheng data-plane facade: generation, verification and graph projection.
 *
 * 只进完整 facade。生成是**效应**（journal 落 `world-run` 并关闭 amend 导入缓存），
 * verify/graph 是只读投影（journal 落 `world-read`）。片段（EvalWorkflowSnippet）没有 run，
 * 也就不该有能开出真实作业的入口，故整段缺席——`cheng.*` 在片段里是 TS2304。
 *
 * 注释只写参考层（形状、何时拒绝、缓存语义）；判断层（何时该用、与 ChengGate/planner 的
 * 关系）在技能正文里只说一次。
 */
export const FACADE_CHENG_SEGMENT = String.raw`
/** One Cheng job request. Generation is an effect; P2 accepts diagnostic mode only. */
declare interface ChengGenerateInput {
  /** Absolute spec path inside the Cheng runtime's allowlisted roots. */
  specPath: string;
  /** Task name from the spec index. */
  task: string;
  /** M5 expansion budget; omitted = the host's diagnostic default. */
  budget?: number;
  /**
   * Rerun nonce. The same inputs replay the terminal job (no rerun); a new attempt
   * mints a new job, which is the only way to retry a cancelled or failed job.
   */
  attempt?: string;
}

/** Terminal outcome of one diagnostic Cheng job. */
declare interface ChengJobResult {
  jobId: string;
  runId: string | null;
  state: "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  /** The run verdict ("DIAGNOSTIC_NOT_ACCEPTANCE", "FAILED", ...). Never a production claim. */
  verdict: string;
}

/** Read-only projection of a finished run. A diagnostic run is never production acceptance. */
declare interface ChengVerifySummary {
  level: "PRODUCTION" | "DIAGNOSTIC_NOT_ACCEPTANCE" | "UNKNOWN";
  productionAcceptance: boolean | null;
  verdict: string;
  semanticPass: boolean;
  settlePassed: number;
  settleTotal: number;
  /** null when the run has no modules ledger (single-module run); never invented. */
  structureGateOk: boolean | null;
  artifactRef: string;
}

/** Bounded graph summary; the full graph stays on disk behind artifactRef. */
declare interface ChengGraphSummary {
  available: boolean;
  reason: string | null;
  nodes: number;
  edges: number;
  roots: number;
  gateOk: boolean | null;
  artifactRef: string;
  digest: string;
}

/**
 * The pinned Cheng host. generate runs the M5/driver pipeline as one journaled effect and
 * resolves with the terminal job; verify and graph are read-only projections of its run
 * volume. Each call is recorded once and replayed on resume; a missing host makes the node
 * fail loudly, never silently skipped.
 */
declare const cheng: {
  generate(input: ChengGenerateInput): Promise<ChengJobResult>;
  verify(jobId: string): Promise<ChengVerifySummary>;
  graph(jobId: string, task: string, view?: "structure" | "decision"): Promise<ChengGraphSummary>;
};
`;
