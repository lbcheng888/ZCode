/**
 * super-agent-mandate 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const superAgentMandateModule = {
  id: "super-agent-mandate",
  requires: [],
  provides: ["super-agent-mandate"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
