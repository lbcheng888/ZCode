import type { ModelToolSideEffectScope } from "@zcode/contracts";
import type { PermissionToolCapability } from "../../permission/service.js";
import type { ToolEntry, ToolRuntimePermissionCapabilityContext } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

export function resolveRuntimePermissionCapability(
  entry: ToolEntry,
  input: unknown,
  context: ToolRuntimePermissionCapabilityContext,
): PermissionToolCapability {
  const runtimeCapability = entry.resolvePermissionCapability?.(input, context);
  return {
    ...entry.metadata,
    ...runtimeCapability,
    // capability group is provenance, not a runtime/model-controlled override.
    permissionCapabilityGroup: entry.permissionCapabilityGroup,
    permission: {
      ...entry.permission,
      ...runtimeCapability?.permission,
    },
  };
}

/**
 * 一次调用**解析后**的副作用旗标，挂在 `ToolCallStarted` 上：与权限判定同一次解析，所以 Bash 的只读命令判定等运行时结论一并生效。
 * 订阅者（dynamic-workflow 的 driver）据它在 handler 动手之前判断这一笔是否会改写工作区。
 */
export function resolveToolCallCapabilityFlags(
  deps: ToolExecutorDeps,
  entry: ToolEntry,
  input: unknown,
): { readOnly?: boolean; sideEffectScope?: ModelToolSideEffectScope } {
  const capability = resolveRuntimePermissionCapability(
    entry,
    input,
    resolveRuntimePermissionContext(deps),
  );
  return { readOnly: capability.readOnly, sideEffectScope: capability.sideEffectScope };
}

export function resolveRuntimePermissionContext(
  deps: ToolExecutorDeps,
): ToolRuntimePermissionCapabilityContext {
  return {
    runtimeScope: deps.runtimeScope,
    // 能力事件也必须使用实际 shell，否则经审批的 CMD 命令会被重新标成只读。
    bashShellSelection: deps.getBashShellSelection?.() ?? deps.bashShellSelection,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
    // swarm child 的路径狱边界随权限上下文一起透传；普通会话取到 undefined，判定不读它。
    ...(deps.getWorkspaceBoundary === undefined
      ? {}
      : { workspaceBoundary: deps.getWorkspaceBoundary() }),
    // M4：admission 结论随上下文透传；首次判定与 hook recheck 共用同一份事实。
    ...(deps.permissionMandate ? { mandate: deps.permissionMandate } : {}),
    ...(deps.permissionOrigin ? { origin: deps.permissionOrigin } : {}),
  };
}
