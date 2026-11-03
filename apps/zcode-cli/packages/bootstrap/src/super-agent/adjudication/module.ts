/**
 * super-agent-adjudication 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const superAgentAdjudicationModule = {
  id: "super-agent-adjudication",
  requires: [],
  provides: ["super-agent-adjudication"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
