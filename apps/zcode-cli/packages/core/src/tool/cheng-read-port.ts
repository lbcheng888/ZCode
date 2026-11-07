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
