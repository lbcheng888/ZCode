import {
  REPAIR_ACTIONS,
  type BackgroundRunRow,
  type RepairAction,
  type WatchdogRepairCommandSurface,
} from "./contract.js";

/**
 * repair 枚举校验：LLM 提案与程序动作共用的唯一入口。
 * 未知值 ⇒ null——调用方拒绝执行并记 invalidProposal；不执行、不计入熔断失败
 * （没执行过的东西没有失败，spec §4）。
 */
export function validateRepairAction(proposal: unknown): RepairAction | null {
  if (typeof proposal !== "string") return null;
  return (REPAIR_ACTIONS as readonly string[]).includes(proposal)
    ? (proposal as RepairAction)
    : null;
}

export function isRepairAction(value: unknown): value is RepairAction {
  return validateRepairAction(value) !== null;
}

/**
 * 执行前的资格复核：cancel-stalled 仅允许带 stall 时钟的 run（spec §0 不变量）。
 * 行缺席 / 无 stallClockRef ⇒ 拒绝执行（ok=false，error 原样上浮）。
 */
export async function executeRepair(
  surface: WatchdogRepairCommandSurface,
  action: RepairAction,
  target: { id: string; row?: BackgroundRunRow; workspaceKey?: string; message?: string },
): Promise<{ ok: boolean; error?: string }> {
  switch (action) {
    case "cancel-stalled": {
      const row = target.row;
      if (!row) return { ok: false, error: `cancel-stalled 目标行不存在：${target.id}` };
      if (!row.stallClockRef) {
        return { ok: false, error: `cancel-stalled 拒绝：run 无 stall 时钟指针 ${target.id}` };
      }
      if (row.state !== "running") {
        return { ok: false, error: `cancel-stalled 拒绝：run 非 running ${target.id}` };
      }
      return surface.cancelStalledRun(target.id);
    }
    case "pause-automation": {
      const workspaceKey = target.workspaceKey;
      if (!workspaceKey) {
        return { ok: false, error: `pause-automation 拒绝：目标缺 workspaceKey ${target.id}` };
      }
      return surface.pauseWorkspaceAutomation(workspaceKey, target.id);
    }
    case "notify-user":
      return surface.notifyUser(
        target.message ?? `watchdog repair：${target.id}`,
        {
          ownerSession: target.row?.ownerSession,
          workspaceKey: target.workspaceKey,
        },
      );
  }
}
