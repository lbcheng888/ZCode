// ============================================================
// Subagent exports
// ============================================================

export * from "./explore.js";
export * from "./context-builder.js";
export * from "./system-prompt.js";
export * from "./general-purpose.js";
export * from "./profile.js";
export * from "./explore-tools.js";
export * from "./runner.js";
export * from "./runtime-task-registry.js";
// spec restricted profile（M5 spec lane）：dispatcher 组合根经 @zcode/core 消费。
export {
  SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS,
  SPEC_RESTRICTED_PERMISSION_MODE,
  SPEC_RESTRICTED_PROFILE_NAME,
  SPEC_RESTRICTED_TOOLFACE,
  buildSpecRestrictedDisallowRules,
  buildSpecRestrictedProfile,
  filterSpecRestrictedToolNames,
  isSpecRestrictedOutboundToolName,
  type SpecRestrictedProfileOverrides,
} from "./tool-policy.js";

export type { AgentDefinitionsSnapshot, GetAgentDefinitions } from "./definitions.js";
