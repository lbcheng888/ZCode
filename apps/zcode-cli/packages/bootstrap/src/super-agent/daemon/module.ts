/**
 * super-agent-daemon 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const superAgentDaemonModule = {
  id: "super-agent-daemon",
  requires: [
    "shared",
    "super-agent-adjudication",
    "super-agent-intake",
    "super-agent-storage",
    "super-agent-trigger",
    "super-agent-watchdog",
    "zcode-cli",
    // headless 裁决会话复用进程 Provider Registry 的路径契约（Built-in/Personal
    // Config env 键与文件布局）；不复制字符串。
    "provider-node",
  ],
  provides: ["super-agent-daemon"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
