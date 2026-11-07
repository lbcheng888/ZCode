import {
  backgroundRunViewSchema,
  type BackgroundRunView,
} from "@zcode/shared/zcode-protocol-v4";

import type { BackgroundRunRow } from "../super-agent/watchdog/index.js";

/** UI 快照一次最多发布的背景行数（有界读面；running 行优先，不被终态行挤掉）。 */
export const BACKGROUND_RUNS_VIEW_LIMIT = 50;
const MAX_BACKGROUND_RUNS_VIEW_LIMIT = 200;

/**
 * registry 行 → v4 `backgroundRuns[]` 投影。running 行先于终态行，组内按 updatedAt 新到旧；
 * 超出 limit 的终态行被截断，running 行在 limit 内优先。逐行经 schema 解析：未知
 * kind/owner/state 原样抛错（不静默塞进 UI）。
 */
export function projectBackgroundRuns(
  rows: readonly BackgroundRunRow[],
  limit: number = BACKGROUND_RUNS_VIEW_LIMIT,
): BackgroundRunView[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`backgroundRuns projection limit must be a non-negative integer: ${limit}`);
  }
  const bounded = Math.min(limit, MAX_BACKGROUND_RUNS_VIEW_LIMIT);
  const running = rows.filter((row) => row.state === "running").sort(compareRows);
  const terminal = rows.filter((row) => row.state !== "running").sort(compareRows);
  return [...running, ...terminal].slice(0, bounded).map((row) =>
    backgroundRunViewSchema.parse({
      id: row.id,
      kind: row.kind,
      owner: row.owner,
      state: row.state,
      ...(row.ownerSession === undefined ? {} : { ownerSession: row.ownerSession }),
      ...(row.workspaceKey === undefined ? {} : { workspaceKey: row.workspaceKey }),
      ...(row.narrowResultRef === undefined ? {} : { narrowResultRef: row.narrowResultRef }),
      ...(row.terminalReason === undefined ? {} : { terminalReason: row.terminalReason }),
      ...(row.stalledSince === undefined ? {} : { stalledSince: row.stalledSince }),
      registeredAt: row.registeredAt,
      updatedAt: row.updatedAt,
      ...(row.terminalAt === undefined ? {} : { terminalAt: row.terminalAt }),
    }),
  );
}

function compareRows(a: BackgroundRunRow, b: BackgroundRunRow): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
