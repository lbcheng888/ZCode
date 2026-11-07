import type { AutomationRunProjectionSqlite } from "@zcode/services/node";

export interface ClaimedAutomationRunProjectionInput {
  runId: string;
  workspaceKey: string;
  ownerSession?: string;
}

/**
 * scheduler claim → 共享 super-agent registry 行映射。定时/manual run 同一形状；
 * 终态由 host outcome lifecycle 写，scheduler 只登记 running 行。
 */
export function registerClaimedAutomationRun(
  projection: Pick<AutomationRunProjectionSqlite, "register">,
  input: ClaimedAutomationRunProjectionInput,
): void {
  projection.register({
    id: input.runId,
    kind: "automation",
    owner: "automation",
    ...(input.ownerSession === undefined ? {} : { ownerSession: input.ownerSession }),
    workspaceKey: input.workspaceKey,
  });
}
