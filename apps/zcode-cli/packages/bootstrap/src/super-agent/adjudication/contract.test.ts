import { describe, expect, it } from "vitest";

import {
  ADJUDICATION_BACKLOG_THRESHOLD,
  ADJUDICATION_DAILY_TOKEN_BUDGET,
  ADJUDICATION_EVALUATION_TICK_MS,
  ADJUDICATION_KV_WINDOW_MS,
  ADJUDICATION_MAX_BATCH_SIZE,
  ADJUDICATION_OLDEST_AGE_MS,
  ADJUDICATION_PROMPT_PAYLOAD_MAX_CHARS,
} from "./contract.js";
import { superAgentAdjudicationModule } from "./module.js";
import { ADJUDICATION_TOOL_ALLOWLIST, ADJUDICATION_TOOL_DISALLOWLIST } from "./toolface.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("super-agent-adjudication contract", () => {
  it("declares its module manifest", () => {
    expect(superAgentAdjudicationModule.id).toBe("super-agent-adjudication");
    expect(superAgentAdjudicationModule.requires).toEqual([]);
    expect(superAgentAdjudicationModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("M3 阈值与预算常量集中在 contract 一处（N=8 / T=60s / tick=5min）", () => {
    expect(ADJUDICATION_BACKLOG_THRESHOLD).toBe(8);
    expect(ADJUDICATION_OLDEST_AGE_MS).toBe(60_000);
    expect(ADJUDICATION_EVALUATION_TICK_MS).toBe(5 * 60_000);
    expect(ADJUDICATION_KV_WINDOW_MS).toBe(5 * 60_000);
    expect(ADJUDICATION_MAX_BATCH_SIZE).toBe(32);
    expect(ADJUDICATION_PROMPT_PAYLOAD_MAX_CHARS).toBe(2_000);
    // 初值待标定（design 开放问题①），与 M12③ 独立微预算对齐。
    expect(ADJUDICATION_DAILY_TOKEN_BUDGET).toBe(500_000);
  });

  it("工具面双闸：白名单只有 M3 只读面，黑名单覆盖全部已知执行工具且与白名单零交集", () => {
    expect([...ADJUDICATION_TOOL_ALLOWLIST]).toEqual([
      "Recall",
      "GoalRead",
      "ChengInspect",
      "ChengPlan",
    ]);
    // fail-closed 主闸：任何执行/副作用工具都不得出现在白名单。
    for (const tool of ["Bash", "Write", "Edit", "Read", "Agent", "WebFetch", "js"]) {
      expect(ADJUDICATION_TOOL_ALLOWLIST).not.toContain(tool);
      expect(ADJUDICATION_TOOL_DISALLOWLIST).toContain(tool);
    }
    // turn 级纵深：sendPrompt 同型黑名单必须枚举已知副作用面（T1 零副作用锚点）。
    for (const tool of [
      "NotebookEdit",
      "ApplyPatch",
      "Glob",
      "Grep",
      "Skill",
      "SendMessage",
      "WebSearch",
      "CronCreate",
      "CronUpdate",
      "CronDelete",
      "CronList",
      "OffPeakCreate",
      "GoalCreate",
      "GoalUpdate",
      "GoalBlock",
      "GoalChengBind",
      "AskUserQuestion",
      "Workflow",
      "ListModels",
    ]) {
      expect(ADJUDICATION_TOOL_DISALLOWLIST).toContain(tool);
    }
    const allow = new Set<string>(ADJUDICATION_TOOL_ALLOWLIST);
    expect(ADJUDICATION_TOOL_DISALLOWLIST.filter((tool) => allow.has(tool))).toEqual([]);
  });
});
