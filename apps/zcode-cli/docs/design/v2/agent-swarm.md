# AgentSwarm：模型面向的同形任务 fan-out

状态：已实现。工具入口是 `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts:412-475` 的
`agentSwarmToolEntry`（handler 经公开入口 `runtime/swarm/index.js` 按需导入 `runAgentSwarm`，
见 `:396-406`），校验/执行/聚合在
`apps/zcode-cli/packages/core/src/runtime/swarm/agent-swarm.ts`（`runAgentSwarm`，`:100-137`），
文件域 lane 的路径校验与 prompt 头在 `runtime/swarm/agent-swarm-file-domains.ts`。
输入/输出 schema 在 `apps/zcode-cli/packages/contracts/src/tools/agent.ts:43-125`。
本文只描述当前代码；未落地能力统一列在「明确未实现」。

## 定位：与 goal swarm、kimi Tower 的区别

AgentSwarm 是**模型可见的并行派发工具**：一次调用把同一段 prompt 模板套到多个输入，为每个输入
启动一个子代理；也可以用 `file_domains` 按文件边界切互不重叠的 lane；或按
`resume_agent_ids` 续跑已有子代理。所有子代理共享调用方的 workspace。

三个相邻能力不是同一个执行器：

| 能力       | 隔离单位                            | 回写方式                                           | 生命周期               |
| ---------- | ----------------------------------- | -------------------------------------------------- | ---------------------- |
| AgentSwarm | 无；共享调用方 workspace            | 子代理直接写共享目录，无 merge                     | 一次工具调用           |
| goal swarm | 每个 worker 一棵 git worktree       | revision CAS 后的串行 merge，journal 记录回合      | 目标回合               |
| kimi Tower | 每个 mission 独立 branch + worktree | 独立 review 通过后按依赖合并，`.tower/` 持久化状态 | 用户显式开启的协作模式 |

goal swarm 的细节见 `apps/zcode-cli/docs/design/v2/goal-swarm.md`：它在回合内分解目标、
为每个任务创建独立 worktree、逐份过 merge 闸门并写 `round_completed` journal
（`goal-swarm.md:34-101`）。Tower 的参考语义是 kimi-code 的实验性多 Agent 协作模式：
per-mission branch/worktree、独立 reviewer、合并检查与 `.tower/` 审计记录
（kimi-code `docs/zh/guides/tower.md`；仓内对照见
`docs/architecture/long-horizon-goal-redesign-plan.md:24`）。AgentSwarm 两者都不是：它没有
worktree、没有 merge/review、没有持久化回合状态，只有一次调用的并行 fan-out。
两个入口都由 `runtime/swarm/index.ts` 导出：goal swarm 面向 target 生命周期，AgentSwarm 面向
模型工具调用（`index.ts:1-19`）。

## 输入语义（与 kimi AgentSwarm 对齐）

```json
{
  "description": "review files",
  "subagent_type": "general-purpose",
  "prompt_template": "Review {{item}} for likely regressions.",
  "items": ["src/a.ts", "src/b.ts", "src/c.ts"]
}
```

| 字段               | 必填           | 语义                                                                                 |
| ------------------ | -------------- | ------------------------------------------------------------------------------------ |
| `description`      | 是             | 整批任务的短描述；非空。                                                             |
| `subagent_type`    | 否             | 只作用于 items 派生出的新子代理；缺省 `general-purpose`。resume 的子代理保留原类型。 |
| `prompt_template`  | items 在场时是 | 每个子代理的 prompt 模板；必须含字面占位符 `{{item}}`。                              |
| `items`            | 否             | 同一段模板的输入值；每个字符串启动一个新子代理。                                     |
| `resume_agent_ids` | 否             | `agentId → 续跑消息` 的映射；每个键续跑一个已有子代理。                              |

schema 是严格模式（`z.object(...).strict()`，`contracts/src/tools/agent.ts:61-91`），未知字段
直接拒绝；没有 `fork`，也没有调用级 `model` 字段。`items` 的 schema 上限是 128
（`contracts/src/tools/agent.ts:44,74-80`），总任务数（items 条数 + resume 键数）的上限同样是 128，
由 handler 在启动任何子代理前统一校验（`runtime/swarm/agent-swarm.ts:140-217`）。
`resume_agent_ids` 的每个键限 1..512 字符、每个值限 1..20_000 字符
（`contracts/src/tools/agent.ts:52-59,81-90`），超出即在 schema 层以 typed
`SWARM_INVALID_INPUT` 拒绝，不会启动任何子代理。输出的 `agent_id` 属性与 resume 键共用
同一个 512 字符上限：512 字符内的 ID 不因长度截断，端口生成的普通 ID 可直接回填
`resume_agent_ids`。

## 校验与零启动拒绝

以下违规全部在 spawn 之前拒绝，不会留下半批子代理：

- 总任务数为 0；
- 没有 `resume_agent_ids` 时 `items` 少于 2；
- `items` 在场但缺 `prompt_template`；
- `prompt_template` 不含 `{{item}}`；
- 两个 item 填出完全相同的 prompt；
- items + resume 总数超过 128；
- `resume_agent_ids` 的键/值超出 1..512 / 1..20_000 字符。

校验顺序是**先 schema + 语义、再查端口**（`runtime/swarm/agent-swarm.ts:100-137`）：语义非法
输入即使 `context.subagentPort` 缺席，也抛 typed `ToolExecutionFailed` /
`SWARM_INVALID_INPUT`，而不是被 `ConfigurationError` / `SUBAGENT_UNAVAILABLE` 盖掉；只有
语义合法的调用缺端口时才报后者。端口存在但 `sendMessage` 缺席、且调用尚未 abort 时，resume
能力同样在任何 item 启动之前以 typed `ConfigurationError` / `SUBAGENT_UNAVAILABLE` 拒绝
（`:122-134`），不会先跑掉半批 item。校验失败的文本本身也有界：单个路径段截到 80 字符、整条
消息截到 2_000 字符并以 `…` 收尾（`:485-500`），300k 字符的 resume key 不会被原样回显进
tool result。

拒绝抛出 typed `ToolExecutionFailed`，不降级成「部分启动」。测试
`apps/zcode-cli/packages/core/tests/agent-swarm-tool.test.ts` 对每组非法输入断言
`SubagentPort.run` 与 `sendMessage` 调用数均为 0。

## file_domains：按文件边界切 lane

模型可以把一次改动按文件边界切成互不重叠的 lane；每个 domain 启动一个子代理，写域由 harness
硬约束，而不是只靠 prompt 约定。

```json
{
  "description": "repair five file domains",
  "prompt_template": "Fix the regression in the files listed below.",
  "file_domains": [
    { "description": "parser", "files": ["src/parser/a.ts", "src/parser/b.ts"] },
    { "description": "ui", "files": ["src/ui/c.ts"] },
    { "files": ["src/runtime/d.ts"] }
  ]
}
```

- 每个 domain 一个 worker；`files` 必须是 workspaceRoot 内的精确文件路径，跨 domain 两两
  不相交。路径按工具同一套 realpath 规则收敛，符号链接别名也按同一文件去重。同一文件的
  多处修复必须合并成一个 domain，不能拆给两个 worker。
- `prompt_template` 是共享任务模板。模板里可以用 `{{files}}` 让 harness 在该位置展开本 lane
  的文件列表；不写占位符时，harness 在 prompt 头部注入列表。
- harness 在每个 lane 的 prompt 前加一段固定头：`[AgentSwarm file domain i/n]`、允许修改的
  文件、以及“不得创建/修改其它文件，读取不受限”。任务模板附在 `[Task]` 之后。
- 校验在 spawn 前完成：`items` 与 `file_domains` 互斥；至少 2 个 domain（除非同时 resume）；
  domain 数 ≤ 128、单 domain 文件数 ≤ 128、总文件数 ≤ 512；路径不得逃出 workspaceRoot；
  不得含换行/控制字符；重复文件、重复 prompt 都 typed `SWARM_INVALID_INPUT` 拒绝。
- 写域硬约束：每个 lane 的绝对文件路径写进 `SwarmTask.allowedWritePaths`，沿
  `SubagentRunRequest → child runtime → ToolExecutionContext` 下传；`Write` / `Edit` /
  `ApplyPatch` 在 `path-policy` 里按 realpath 比较，白名单外 fail-closed。`Read` / `Glob` /
  `Grep` 不受限，worker 仍可读取领域外上下文。
- Bash 命令字符串不在本层解析：worker 仍可能通过 shell 写域外文件。prompt 明确禁止，
  但这不是命令级沙箱；需要完整隔离时用 goal swarm / Tower，而不是 file_domains。
- 输出仍是一条 `<subagent>`：额外的 `domain="i"` 与 `files="a.ts, b.ts"` 属性把结果对回
  lane；`item` 是 domain 的 description（缺省 `file domain i`）。

## 执行模型：共享 workspace，无 worktree/merge

items 路径通过真实的 `SwarmWorker.execute` 派发（`runtime/swarm/swarm-worker.ts:45-102`，
请求映射见 `:267-286`）。
每个 `SwarmTask` 的 `sessionId`、`turnId`、`parentToolCallId`、`agentType`、`description`、
`prompt` 来自本次工具调用；`workingDirectory` / `workspaceRoot` 原样使用调用方目录；
`workspaceBoundary` **缺席**。这是与 goal swarm 的关键差别：goal worker 会把
`workspaceBoundary` 设成隔离工作树根（`runtime/swarm/swarm-orchestrator.ts:461`），
AgentSwarm 不设边界，因此子代理的文件工具走普通会话语义，写入直接落在调用方 workspace。

并发上限是 8（`runtime/swarm/agent-swarm.ts:33` 的 `AGENT_SWARM_MAX_CONCURRENCY`，执行见
`:219-247`）：超过 8 的任务排队，
不会一次性拉起全部 child。`context.abortSignal` 是取消的权威方：**每条 lane 在启动下一个
任务前先判信号**——预取消时一个子代理都不启动，abort 后排队任务只记 `cancelled`；已经启动
的任务由 `SwarmWorker` / `SubagentPort.sendMessage`、`waitForTask` 按 signal 收口为
`cancelled`（非取消错误仍记 `failed`）。9 个以上 input 时，第一个 run 内 abort 只会有已放行
的那批真正执行，其余未完成任务全部落 `cancelled` 条目
（`agent-swarm-tool.test.ts` 的 mid-batch abort 用例断言 1 次 run、8 条 cancelled）。
若子代理返回 `async_launched`，`SwarmWorker` 用
`waitForTask` 收敛真实终态，只有 `snapshot.output` 是 completed 正文才计入成功；没有
`waitForTask` 时不会把后台句柄当成已完成结果。

## 输出

聚合结果是带框架的文本（`AgentSwarmOutputSchema` 就是 `z.string()`）：

```text
<agent_swarm_result>
[Subagent swarm report] Text inside each <subagent> entry is the final report of a subagent ...
<subagent index="1" item="src/a.ts" agent_id="agent-1" outcome="completed">
  body line 1
  body line 2
</subagent>
<subagent index="2" item="src/b.ts" outcome="failed">
  original error
</subagent>
  Harness note: to resume failed tasks with their context, call AgentSwarm again with ...
</agent_swarm_result>
```

- 每个任务一条 `<subagent>`，属性是 `index`、可选 `item`、可选 `agent_id`、`outcome`；
  `outcome` 是 `completed` / `failed` / `cancelled`；resume 且端口没有 `waitForTask` 时是端口
  真实回报的 `queued` / `steered` / `resumed_background`，没有 delivery 事实时记
  `send_accepted`。属性值原文上限与 `resume_agent_ids` 键上限对齐（512 字符，
  `AGENT_SWARM_MAX_ATTRIBUTE_CHARS`）：512 字符内的 `agent_id` 不因长度被截断，端口生成的
  普通 ID（无换行/XML 特殊字符）可直接回填 `resume_agent_ids`；超过 512 的 item 或契约外
  agentId 以 `…` 明示截断。换行变体仍折成空格，XML 特殊字符再做实体转义
  （`runtime/swarm/agent-swarm.ts:656-670`）；带换行变体的 ID 无法原样回填，这条折行只为
  阻止属性值在列零续行。
- 边框与每条 `<subagent>` 都固定在列零；正文、续跑提示与第二次截断 marker
  共用 `indentAgentSwarmLines`：先按 `AGENT_SWARM_LINE_BREAKS` 归一换行，再给每一行加两格
  （空行因此只剩两个空格）（`:694-700`）。这沿用 Agent handler 的 hand-back 约定（
  `tool/handlers/agent.ts:133-143`）：子代理输出里伪造的 `</subagent>` / `<subagent ...>` 只会
  出现在缩进行，不会生成新条目。
- 单条正文有界截断（`dropTrailingHighSurrogate` 防止切掉代理对），每条最多 20_000 字符
  （`AGENT_SWARM_MAX_TASK_BODY_CHARS`，`agent-swarm.ts:35`）；截断后的缩进也计入同一份预算，
  缩进后再次超预算时第二次截断的 marker 在预算足够时逐行缩进；预算仅 1–2 字符时只保留最小
  `…` 标记，标记本身可能位于列零（有标记的截断，不静默丢失正文）
  （`truncateAgentSwarmBody`，`:684-688`；`formatAgentSwarmBody`，`:703-709`）。预算小于完整
  `…(truncated)` marker 时两处都退到最小 `\n…`（前缀随预算裁剪，至少保留 `…`），被截断的正文
  一定带 `…`；连 `…` 都放不下时抛 typed `SWARM_INVALID_INPUT`，不返回无标记正文。
- 整个信封（框架、全部标签、提示与正文）上限 200_000 UTF-16 字符
  （`AGENT_SWARM_MAX_OUTPUT_CHARS`，`contracts/src/tools/agent.ts:47`；拼接见
  `runtime/swarm/agent-swarm.ts:598-642`）。固定部分（含提示）本身超限时抛 typed
  `SWARM_INVALID_INPUT`，不是普通 `Error`：512 字符属性 × 实体转义最坏 6× × 128 条可以真实
  越过 200k，因此这个分支可达，错误在分配任何正文之前抛出。
- tool entry 同时声明 `maxModelChars = 200_000`，并把 `metadata.maxOutputBytes`、
  `resultBudget.maxInlineBytes` / `maxModelBytes`（以及 preview）设成 4× 字符上限
  = 800_000 字节（`tool/handlers/agent.ts:388-393,424-433,449-460`）。字符预算是权威，字节预算
  只兜底：200k 汉字约 600 KB、emoji 聚合也不会被 serializer 的字节闸截断。
- 失败任务拿到过 `agentId` 时，信封末尾追加一个续跑提示块：列出最多 8 个可续跑的 agentId、
  自身最多 2_000 字符，超出条数或字符上限都以 `…` 收尾
  （`runtime/swarm/agent-swarm.ts:51-52,543-561`）。提示在正文预算之外单独结算，不会把
  剩余正文预算扣成负数；提示里的 agentId 先按 `AGENT_SWARM_LINE_BREAKS` 归一换行变体（U+2028 /
  U+2029 / U+0085 等不会以原字符出现在 hint 里），再 JSON 编码并把 `<` / `>` 写成 `\u003c` /
  `\u003e`，提示块自身也经同一 helper 逐行缩进（`:567-571,694-700`），因此不能伪造条目。
  item 路径的 agentId 从错误 context 链提取，取不到就不列。
- 部分失败**不抛整批错误**：成功的正文照常聚合，失败任务单独标 `outcome="failed"` 并保留
  原始错误；调用方看到的是带逐任务结局的完成结果，而不是被整批回滚。

## resume 语义

`resume_agent_ids` 的每个键值对走 `SubagentPort.sendMessage`，不重新 spawn：

- `to` 是已有 agentId，`message` 是对应的续跑 prompt；`parentToolCallId`、
  `workingDirectory`、`workspaceRoot`、trace、signal/model/modelOverride 与 items 路径一致
  （`runtime/swarm/agent-swarm.ts:306-340`）。
- `sendMessage` 抛错或返回 `status: "failed"` 时记该任务 failed；若此时调用方已 abort，则记
  cancelled，不静默继续。
- 端口有 `waitForTask` 时等到真实终态：completed 取 `snapshot.output` 正文；failed/cancelled
  取 `snapshot.error`；返回非终态 `running` 或没有 snapshot 都记 failed
  （`:377-456`）。
- 端口没有 `waitForTask` 时**只陈述端口回报的事实**：有 `delivery` 就原样记
  `queued` / `steered` / `resumed_background`；没有 `delivery` 时记 `send_accepted`，正文写
  “send accepted; delivery not reported”，绝不编造 `delivered`
  （`:356-376`）。
- 续跑任务保留原子代理的类型与上下文；`subagent_type` 只影响同批 items 新 spawn 的子代理。

## 适用条件与风险

适用：**相互独立、同形、只读或互不写同一文件**的任务，例如「对一批文件做同一种审查」、
「对一批测试做同一种修复」。items 只是模板的输入值，不是任务间通信通道。

不适用/必须自行规避：

- **items 模式不保证并发写安全**。所有 child 共享同一个 workspace，两个 child 同时改同一
  文件会互相覆盖；没有 worktree、没有 merge 冲突检测、没有整轮回滚。需要文件级硬约束时用
  `file_domains`；需要完整命令级隔离时用 goal swarm 或 Tower。
- **file_domains 只约束文件工具**。`Write` / `Edit` / `ApplyPatch` 拒绝域外目标；Bash
  命令字符串不解析，仍可能通过 shell 写域外文件。lane 内应把 Bash 限制为只读或本域命令。
- 一个 child 的副作用不会因另一个 child 失败而撤销；部分失败只体现在聚合结果里。
- `workspaceBoundary` 缺席意味着没有路径狱；`Bash` 命令字符串也不做解析，AgentSwarm 不是
  命令级沙箱。
- 并发上限 8 只限制同时运行数，排队任务仍会依次启动；abort 后不再启动新任务，已启动任务
  由取消域收口。
- 聚合结果按字符封顶：任务越多、单个正文分到的份额越小；单条正文另受 20k 上界。

## 注册与子代理禁用面

- `AgentSwarm` 进入 `builtInTools`（`tool/handlers/index.ts:153`），与 `Agent` / `Task` 一样受
  `includeAgent` 注册门控制。entry 声明 `shouldDefer: true`：它不是 resident 工具，ToolSearch
  开启时由 ToolSearch 加载定义、再经 DeferredToolCall 调用（与其余非派发内建工具同规）。
- `tool/compat.ts:1-19` 把 `AgentSwarm` 纳入 `isSubagentDispatchToolName`：后台任务投影、
  子代理派发识别与 Agent 走同一条路径。
- 子代理不能再 nested swarm：`subagent/tool-policy.ts:14-20` 的
  `SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS` 与 `SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS`
  （`:89-108`）都包含 `AgentSwarm`，`buildSubagentChildDisallowRules` /
  `filterSubagentChildToolNames` 会把它从 child 工具面剔除。
- `runtime/swarm/CONTRACT.md` 明确 AgentSwarm 共享 workspace、不建 worktree/不 merge，与
  goal swarm 的隔离/合并路径互不替代。

## 明确未实现

- **fork 未实现**：没有「每条 item 继承调用方上下文快照」的 fork 语义。
- **调用级 model alias 未实现**：AgentSwarm 不接受 `model`；子代理模型仍由 profile / 会话
  配置决定。
- 没有 worktree、branch、merge、review 或整轮回滚；也不持久化 task 状态。
- 没有 items 任务级的 exactly-once / 崩溃恢复；一次调用失败后需要模型显式 resume。
- 没有真实桌面端 AgentSwarm E2E；现有证据是工具 handler 单测（真实 `SwarmWorker` +
  测试替身 `SubagentPort`）与注册面断言，异步路径的 `async_launched` 终态由替身端口模拟，
  不是真实后台子代理链路。

## 验证

```bash
cd apps/zcode-cli
pnpm exec vitest run packages/core/tests/agent-swarm-tool.test.ts
```

测试覆盖：3 items 的 prompt 填值与共享 workspace/无 boundary、每次请求的
`parentToolCallId`、file_domains 的 lane/写集/prompt 头/输出 domain 属性、items 与
file_domains 互斥、单 domain 拒绝、跨 domain 重复文件/越界路径/换行路径的零启动拒绝、
`allowedWritePaths` 沿 SwarmWorker → child runtime → path-policy 的写域拒绝与读放行、
items 不足 2 / 缺模板 / 缺占位符 / 重复 prompt / 超 128 的零启动拒绝、
`resume_agent_ids` 的 1..512 与 1..20_000 边界及超限 typed 拒绝、300k key 的有界错误、
`sendMessage + waitForTask` 聚合、没有 `waitForTask` 时只回报 delivery 事实（无 delivery 记
`send_accepted`）、正文/提示的标签注入不产生列零条目、提示 2k/8-id 限界、部分失败仍返回
completed 聚合、预取消与 mid-batch abort（9 items 只放行首批、其余 cancelled）、20k 单条截断、
截断 marker 的两格缩进、512 字符 `agent_id` 的 resume/item 双路径 round-trip、U+2028/U+2029/
U+0085 提示续行不落列零、128 条最大转义 agent_id 的固定信封 typed 拒绝、缺 `sendMessage`
的 resume 零启动配置拒绝、200k 字符与 800k 字节预算下的 CJK 聚合，以及 `builtInTools` 注册、
`isSubagentDispatchToolName` 与子代理/spec 禁用面断言。
