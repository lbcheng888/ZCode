/**
 * super-agent-daemon 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const superAgentDaemonModule = {
  id: "super-agent-daemon",
  requires: ["shared", "super-agent-adjudication", "super-agent-intake", "super-agent-trigger", "zcode-cli"],
  provides: ["super-agent-daemon"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
