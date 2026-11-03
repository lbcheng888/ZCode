# Super-Agent 上下文召回规格（M9：引用图链式召回 + compact recoveryPointer）

来源：`super-agent-harness-design.md` §M9。本文是实现级规格，落在 zcode monorepo
`apps/zcode-cli`。只写类型与测试表达不了的三样：意图、不变量、与其它模块的交集点。

## 1. 意图与边界

- **意图**：长内容不进模型上下文，注入只给「稳定 ID + 摘要 + 下一跳 ID」；完整内容留在
  窗口外，模型按需经 `Recall` 只读工具分页取回。编程对象关系（target ↔ 事件 ↔
  workflow run ↔ artifact）本就是显式引用图，比相似度检索确定可审计。
- **意图二**：compact 摘要强制输出结构化恢复指针（recoveryPointer），随 CompactionPart
  持久化；compact 之后与进程重启 resume 时由**程序**重挂 anchor——目标锚点跨压缩存活
  不再押模型自由文本。
- **非目标**：不建向量库；不建 trigger/subscription 表（那是 super-agent storage/intake
  lane 的活）；不做跨月长程记忆。

## 2. 资源 ID 与引用图

统一形态 `<kind>:<id>`（contracts `tools/recall.ts` 为唯一定义源）：

| kind          | 形态                          | 解析读面（全部只读）                          |
| ------------- | ----------------------------- | --------------------------------------------- |
| `session`     | `session:<sessionId>`         | `SessionStorePort.getSession/listSessions`    |
| `target`      | `target:<targetID>`           | `SessionStorePort.readTarget`（当前会话行）   |
| `target-event`| `target-event:<targetID>/<n>` | `SessionStorePort.readTargetEvents`           |
| `wf-run`      | `wf-run:<runId>`              | `DynamicWorkflowRunPort.listEvents`（journal）|
| `wf-event`    | `wf-event:<runId>/<startSeq>` | 同上（startSeq 含首事件；journal 序号可为 0） |
| `artifact`    | `artifact:<sessionId>/<id>`   | `ToolArtifactStorePort.readToolResultArtifact`|
| `trigger`     | `trigger:<triggerId>`         | 预留：storage lane 端口接入后启用（seam）     |
| `subscription`| `subscription:<subId>`        | 预留：同上（seam）                            |

`artifact:` ID 与溢写产物 URI `zcode-artifact://<session>/<id>` 一一对应；Recall 两种写法
都接受。`target-event` 的 `<n>` 是 `session_target_event.id`（会话内单调递增整数）。

**链式召回归一不变量**：一页输出里出现的每个 `refs` ID，都能用同一次 Recall 的 `ids`
模式再次解析（dsh `orchestrator_read` 形状）。这是图走查测试钉住的契约。两个推论：
`target:` ref 只随**当前会话**的 session 行发出（`resolveTarget` 只读当前会话的
readTarget 行，别的会话的 target ref 跟进必然 missing）；`wf-event` 下一跳锚在最后一条
**完整渲染**的事件序号上（文本预算中途耗尽早于端口页尾时同样发下一跳；首条即超预算
按整页硬上限渲染首条再截断，保证链上有推进）。

**Scope 过滤**：一切解析按当前会话 + workspace 过滤。跨会话 `session:` 读取仅当目标行
的 `workspaceID` 与当前 `workspaceIdentity` 一致（或任一侧缺席时不因此拒绝）；越界给
结构化 `scope_denied`，不静默给空。

## 3. Recall 工具契约

`Recall`（`core/src/tool/handlers/recall.ts`），普通只读内建工具（与 ReadSessionContext
同档：always-on、无审批、ToolSearch 下非 resident）：

- input（strict）：`ids: string[]`（链式解析，≤32 个）**或** `kind`（列页面）+
  `cursor` + `limit`（默认 20，≤50）。两者互斥。
- output（strict）：`status: success | capability_absent | scope_denied | list_unsupported`、
  `items[]`（`{ id, kind, summary, refs[] }`）、`nextCursor?`、`truncated`、`missing[]`
  （ids 模式下解析不到的 ID 原样回报，不吞）。
- 文本页预算：单 item summary 截断到固定界；artifact 内容按字符分页
  （默认 4000、上限 8000），cursor 为续读偏移。列表页 cursor 为 opaque 字符串。
- `kind` 列表面只开有天然列表读面的资源：`session`、`target`（单行，无分页）、
  `target-event`、`wf-run`（端口 `listRunsForSession` 可选成员，缺席即
  `capability_absent`）。`wf-event` / `artifact` 只走 ids 模式。
- `trigger` / `subscription`：ID 形态已预留；在 storage lane 端口接入 ToolExecutionContext
  之前，解析这两个 kind 返回 `capability_absent`（诚实的能力缺席，不是降级）。

## 4. compact recoveryPointer

### 4.1 Schema（contracts `compact/index.ts`）

`compactRecoveryPointerSchema`（strict）：

- `objective: string`（≤4000）——用户主目标一两句。
- `criterion: string`（≤4000）——可验证的完成判据。
- `fileMap: string[]`（≤64 条，续跑最关键文件）。
- `openQuestions: string[]`（≤32 条，阻塞进展的未决问题）。
- `recallSeedIds: string[]`（≤32，必须是合法 Recall 资源 ID；只许抄真实见过的 ID）。

字段并入 `compactBoundaryPayloadSchema` 的可选 `recoveryPointer`。boundary 落在
`CompactionPart.compactBoundary` 上——recoveryPointer 因此随既有 part 持久化，**不改**
`persistCompactSummary` 签名、不改 rewound/preservedSegment 切片语义。旧 boundary 无此
字段，strict schema 仍解析通过（向后兼容）。

### 4.2 Prompt 与解析（core `compact/prompt.ts`）

- `buildCompactPrompt` 追加第 10 节「Recovery Pointer（必填）」：要求 `<summary>` 末尾
  输出 `<recovery_pointer>{json}</recovery_pointer>` 块。
- `extractCompactRecoveryPointer(rawText)`：从模型原文剥离该块并解析。**宽进**：
  块缺失或 JSON 非法 → 不产生指针，compact 照常完成，只落 warn 日志（可观测）。
  决策记录见 §7。
- `formatCompactRecoveryPointerForModel(pointer)`：重挂时给模型的固定投影。

### 4.3 重挂（两条路径，都是程序机制）

1. **compact 当场**（compact-active.ts）：解析成功 → `compactBoundary.recoveryPointer`
   随摘要原子持久化；同时向 `postCompactReminderEntries` 追加一条
   `resume_referenced_session_context` attachment（与 read-state/plan-file 提醒同族、同
   持久化路径），把结构化 anchor 显式交回模型。
2. **resume 冷恢复**（resume.ts 最小改动）：对 activeMessages（已应用 rewind 过滤）反向
   找最新带 `recoveryPointer` 的 active compaction part，找到则
   `messageHistory.addAttachment("resume_referenced_session_context", …)` 重挂。

**rewind 兼容**：指针长在 summary message 的 compaction part 上；分支切片（kept/
branchCut）把它当普通 part 一起过滤，被 rewind 掉的分支不会重挂——与
preservedSegment 语义正交，不碰 `compact-preservation.ts`。re-hang 不改 boundary 事件、
不改 timeline 恢复（`recoverInterruptedCompactTimelines` 原样）。

## 5. result-serialization 溢写与 recall

artifact strategy 溢写 envelope 在既有 `<persisted-output>` 文案后追加一行
`Recall the full output later with Recall: ids=["artifact:<session>/<id>"].`
——路径给 Read，召回 ID 给 Recall，两条取回路径并存（URI 形态不合法时保持原文，
不给假指引）。truncate 截断 suffix 与三级预算本身不动。

## 6. 测试与验收

- contracts：ID 解析/格式化往返、input 互斥与越界、recoveryPointer schema、带/不带
  指针的 boundary 均可 parse。
- core recall：**真 fixture**（sqlite session store + 真 dwf journal）——target →
  target-event → session 链式走查；journal 事件分页 next-hop；artifact URI 解析；
  越界 scope 拒绝。
- core compact：摘要往返（模型吐块 → boundary 落库 → 新 runtime `resumeFromStore` →
  post-resume 上下文含 objective）；rewind/preservedSegment 既有套件保持绿。
- 回归：`compact-preserved-inputs`、`session-history-rewind`、`runtime-compact`、
  `compact-persistence-selection`、`contracts/compact`。

## 7. 决策记录

- **指针放进 compactBoundary 而不是新 part 字段**：`CompactionPart` 契约在
  `session-store.port.ts`（非本 lane 文件）；boundary 本来就是 part 的 metadata 载体且
  归本 lane 所有，零签名改动拿到同一持久化与回放路径。
- **解析宽进（缺失/非法不失败 compact）**：compact 失败在 context-exceeded 场景等于把
  会话楔死；指针是增强不是 compact 的核心契约。非法块与缺失块同档 warn——真实损失
  （anchor 未结构化存活）与今天的自由文本路径持平，不更糟。合法块则全程机制化。
  round-trip 测试钉住合法路径。
- **重挂用 reminder attachment 而非改 boundary 恢复路径**：boundary/timeline/rewind 是
  多 lane 共享的敏感面；reminder attachment 是既有、已测的 post-compact 注入通道，
  语义正好是「恢复出来的上下文」。
- **trigger/subscription 只留 ID 形态**：表和端口归 storage/intake lane；提前假造读面
  就是兜底。能力缺席响亮返回，端口落地后只补解析分支。
