# Plan Mode Status（当前事实）

旧 `PlanModeToolPanel` 和“计划/原始数据”tab 已删除。当前 plan/goal/todo 状态统一显示在 V4 `ConversationStatusPanel`；协作模式切换走 `switchCollaborationMode` 和 composer toolbar。

状态面板只渲染 projection，不持有独立计划事实，也不提供旧 raw-data tab。

composer 上方另有一条常驻 todo 进度条 `TodoPanel`（`packages/ui/src/TodoPanel.tsx`），挂在 V4 bottom dock、紧贴输入框，桌面与手机 Web 共用。它同样只消费 `ConversationSnapshot.plan`：显示当前 inProgress 项与 `completed/total`，可展开未完成项，空清单或全部完成时整条隐藏；运行期用 streaming 样式、非运行期降级为 idle 样式。它不新增 todo 事实，也不替代状态面板里的完整 todo 明细。
