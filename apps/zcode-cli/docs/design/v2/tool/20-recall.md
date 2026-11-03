# Recall Tool

M9 引用图链式召回（super-agent harness design §M9）。实现规格：
`docs/architecture/super-agent-context-recall-spec.md`。本文记录 tool 链路上的
provider-visible 契约与适配点。

## 能力

- 只读。按稳定 ID 从当前会话的引用图取回完整资源，或按 kind 列一页 scoped 资源。
- 资源：session / target / target-event / wf-run / wf-event / artifact；
  `trigger` / `subscription` 为预留 kind，storage lane 端口接入前回
  `capability_absent(recall_source_not_wired)`。
- `zcode-artifact://<session>/<id>` URI 与 `artifact:<session>/<id>` 是同一个 ID
  （溢写产物因此天然可召回）。

## 输入 / 输出

- input（strict）：`ids[]` XOR `kind`；`cursor`（listing 偏移 / 单 artifact 内容偏移）、
  `limit`（20 默认、50 上限）。
- output（strict）：`status: success|capability_absent|scope_denied|list_unsupported`、
  `items[{id,kind,summary,refs,nextCursor?}]`、`missing[]`、`nextCursor?`、`truncated`。
- 不变量：一页里出现的每个 refs ID 都能用 `ids` 模式再次解析。推论：`target:` ref
  只随当前会话的 session 行发出；`wf-event` 下一跳锚在最后一条完整渲染的事件序号上
  （预算截断早于端口页尾也要发下一跳）。session 列表面取数上限（200）触顶时给
  `truncated:true`（+ `nextCursor`，窗口耗尽时空页收尾），第 200 条之后不静默不可达。

## 注册与权限

- `builtInTools` 常驻注册（紧跟 ReadSessionContext）；ToolSearch 下非 resident
  （与 ReadSessionContext 同档），无灰度门。
- permission：`session.recall.read`，只读、无审批；sideEffectScope=session。
- resultBudget：inline truncate（80KB），不做 artifact 二级溢写——分页本身就是有界手段。
- 不进 workflow child 禁用名单：worker 可用是 M9 的设计前提。

## 溢写联动（result-serialization）

artifact strategy 溢写 envelope 追加一行
`Recall the full output later with Recall: ids=["artifact:<session>/<id>"].`
（URI 形态不合法时保持原文，不给假指引。）truncate 截断 suffix 不变。

## compact 联动

compact prompt 第 10 节强制 `<recovery_pointer>` 结构化块；runtime 剥离后存进
`CompactBoundaryPayload.recoveryPointer`，compact 后与 resume 时以
`resume_referenced_session_context` attachment 重挂，其中的 `recallSeedIds`
直接是本工具的 `ids` 入参。
