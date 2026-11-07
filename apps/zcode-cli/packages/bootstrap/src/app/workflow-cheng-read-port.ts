import type {
  ChengExplainInput,
  ChengExplainOk,
  ChengInspectOk,
  ChengPlanInput,
  ChengPlanOk,
  ChengVerifyOk,
} from "@zcode/contracts";
import type { ChengReadPort } from "@zcode/core";

import type { ChengHostPort } from "./workflow-cheng-world-read.js";

/**
 * 工作流 run 端口 → 模型只读工具端口。ChengInspect/Verify/Explain/Plan 只消费已有 jobId，
 * 所以适配器只暴露 inspect/verify/graph/plan，**不转发 generate**：模型工具面无法通过
 * 这条通道开出新作业。
 */
export function createChengReadPort(host: ChengHostPort): ChengReadPort {
  return {
    async inspect(jobId: string): Promise<ChengInspectOk> {
      const snapshot = await host.inspect(jobId);
      return { status: "ok", ...snapshot };
    },

    async verify(jobId: string): Promise<ChengVerifyOk> {
      return { status: "ok", ...(await host.verify(jobId)) };
    },

    async explain(input: ChengExplainInput): Promise<ChengExplainOk> {
      const graph = await host.graph(input.jobId, input.task, input.view ?? "decision");
      return { status: "ok", ...graph };
    },

    async plan(input: ChengPlanInput): Promise<ChengPlanOk> {
      return { status: "ok", ...(await host.plan(input.jobId, input.task)) };
    },
  };
}
