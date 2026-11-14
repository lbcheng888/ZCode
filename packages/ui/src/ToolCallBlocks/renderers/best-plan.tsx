import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

/**
 * ProposeBestPlan 已降级为纯传输通道：super-agent → 门禁/持久化的内部载体。
 * 方案六字段由 worker 在回复正文里向用户陈述，UI 不再渲染这张卡，
 * 避免同一方案出现「卡 + worker 陈述」两份。toolIdentity / resolveRenderer
 * 的注册与硬门禁保留不动，这里只是不再产出可见输出。
 */
export function BestPlanToolCallBlock(_context: ToolCallBlockRenderContext) {
  return null;
}
