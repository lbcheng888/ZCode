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

/**
 * Cheng 生成端口：ChengGenerate 的效应面。装配层从完整 host 端口**窄化**出这一个方法——
 * 模型侧拿不到 inspect/cancel/close 等其余面。specPath 由 handler 落盘产生（绝对路径，
 * 宿主可读）；budget 缺省由装配层按 host 缺省档补齐。缺席时 ChengGenerate 与只读工具
 * 同款返回 `capability_absent`，不伪造受理。
 */
export interface ChengGeneratePort {
  generate(input: {
    specPath: string;
    task: string;
    budget?: number;
  }): Promise<{ jobId: string; runId: string | null; state: string }>;
}
