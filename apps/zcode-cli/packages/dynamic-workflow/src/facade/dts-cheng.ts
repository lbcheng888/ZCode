/**
 * Cheng data-plane facade: generation, verification, planning, surface/leaf probes, and graph projection.
 * 只进完整 facade；snippet（EvalWorkflowSnippet）整段缺席。
 */
export const FACADE_CHENG_SEGMENT = String.raw`
declare interface ChengGenerateInput {
  specPath: string;
  task: string;
  mode?: "production" | "diagnostic";
  budget?: number;
  moves?: "macro";
  useLiblearn?: boolean;
  attempt?: string;
}

declare interface ChengJobResult {
  jobId: string;
  runId: string | null;
  state: "succeeded" | "failed" | "cancelled";
  mode: "production" | "diagnostic";
  exitCode: number | null;
  verdict: string;
}

declare interface ChengVerifySummary {
  level: "PRODUCTION" | "DIAGNOSTIC_NOT_ACCEPTANCE" | "BLOCKED" | "UNKNOWN";
  productionAcceptance: boolean | null;
  verdict: string;
  semanticPass: boolean;
  settlePassed: number;
  settleTotal: number;
  structureGateOk: boolean | null;
  zeroCProductionOk?: boolean | null;
  artifactRef: string;
}

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

declare interface ChengPlanSummary {
  gate: { ok: boolean; level: "PRODUCTION" | "DIAGNOSTIC_NOT_ACCEPTANCE" | "BLOCKED"; reasons: string[] };
  plan: { kind: "cheng_plan"; recommended: string; blockedBy: string[] };
}

declare interface ChengSurfaceSummary {
  ok: boolean;
  v4Ok: boolean;
  budgetOk: boolean;
  lineCount: number;
  lineCapOk: boolean;
  violations: Array<{ code: string; line: number; message: string }>;
}

declare interface ChengLeafProbeSummary {
  ok: boolean;
  exitCode: number;
  objBytes: number;
  compileMaxRssBytes: number;
  wallMs: number;
  firstError: string | null;
}

declare const cheng: {
  generate(input: ChengGenerateInput): Promise<ChengJobResult>;
  verify(jobId: string): Promise<ChengVerifySummary>;
  plan(jobId: string, task: string): Promise<ChengPlanSummary>;
  graph(jobId: string, task: string, view?: "structure" | "decision"): Promise<ChengGraphSummary>;
  checkSurface(filePath: string): Promise<ChengSurfaceSummary>;
  probeLeaf(filePath: string, allowClosureProbe?: boolean): Promise<ChengLeafProbeSummary>;
};
`;
