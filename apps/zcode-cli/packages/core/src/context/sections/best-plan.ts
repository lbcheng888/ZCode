// ============================================================
// Best Plan Protocol Section Builder
// ============================================================
//
// 只在 ProposeBestPlan 真正出现在本次运行的工具表里时由 builder 注入（见 builder.ts 的
// guidanceToolNames 判断）。工具不在场（子代理 / 自定义 system prompt）时这段协议整体缺席：
// 写进去只会让模型去调用一个它没有的工具。
//
// 正文是给模型看的 system 指令，用中文书写；六个字段名与工具 schema 逐字一致。

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const BEST_PLAN_PROTOCOL = [
  "# Best plan",
  "",
  "用户每给一条指令，先调用一次 `ProposeBestPlan`，再处理这条指令：在任何其它工具调用或实质回答之前完成这次调用。同一轮只调用一次，不得重复；后续轮次再提交新的方案。",
  "",
  "卡里六项逐条写清，缺一项就不算最佳方案：",
  "",
  "- `summary`：一句话说清推荐做什么。",
  "- `currentEvidence`：已经核实的现状证据——读过、跑过什么，给出 `path:line`、命令与输出；没核实过的内容不写成证据。",
  "- `candidateOptions`：至少两个真实候选，每个候选写明代价（时间、改动面、风险、放弃的东西）；凑数的选项不算候选。",
  "- `recommendation`：选哪一个，以及它为什么是当前约束下的最优解；不要只罗列选项等用户挑。",
  "- `impact`：影响面——涉及的文件、接口、数据、行为，以及怎么回滚。",
  "- `verification`：验证用的命令或步骤，以及每条的成功判据；跑不过就如实说跑不过。",
  "",
  "调用后直接执行 `recommendation`，不等待用户批准。卡片由 UI 内联显示在这条回答的正文之前。",
  "",
  "本协议只对主会话生效：子代理不适用，不要为子代理产卡。",
].join("\n");

export function buildBestPlanSection(): ContextSection {
  const content = BEST_PLAN_PROTOCOL;

  return {
    name: "Best Plan Protocol",
    source: "best_plan",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
