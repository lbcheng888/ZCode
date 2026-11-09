/**
 * super-agent-storage 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const superAgentStorageModule = {
  id: "super-agent-storage",
  // spec §1.1 强制 schema 版本化走既有 sqlite-migrations（database.ts/migrations.ts 实际 import）；
  // architecture-policy.yaml 的 super-agent-storage.requires 需同步加 sqlite-migrations（中心 lane 维护）。
  requires: ["sqlite-migrations", "super-agent-watchdog"],
  provides: ["super-agent-storage"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
