import type { DatabaseSync } from "node:sqlite";

import {
  runsListParamsSchema,
  runsListResultSchema,
} from "@zcode/shared/super-agent-control-plane-protocol";

import { listBackgroundRunRows } from "./storage/background-run-store.js";

/**
 * `runs.list` 的服务端实现：参数 strict 校验 → 持久表只读查询 → 结果 schema 校验。
 * 读面不经过 registry 实例，所以 app/daemon 任一进程写入的 cheng-job 行都可见。
 */
export function runsList(db: DatabaseSync, rawParams: unknown): unknown {
  const params = runsListParamsSchema.parse(rawParams ?? {});
  return runsListResultSchema.parse({ runs: listBackgroundRunRows(db, params) });
}
