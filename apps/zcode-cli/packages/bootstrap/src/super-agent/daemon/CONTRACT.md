# super-agent-daemon 契约

守护进程侧 control-plane 子进程的宿主装配面（super-agent-milestone-b-spec §1–§3）。

## 意图

child 进程内只装配 bootstrap 侧模块：RPC server（`run/super-agent.sock` 双向 JSONL）、
peer 守卫（首帧显式握手 token + 平台 peer 可达时补充）、per-workspace plane 管理
（leader 租约、派发桥、反向 host.* RPC 客户端）。不 import `@zcode/services` /
`@zcode/server-cli`。

## 不变量

1. 域库唯一写者 = child 内的 workspace plane；Core/Supervisor 只经 RPC 读写。
2. 端点“全新启动”：bind 前 unlink 陈旧 socket；存活 peer 探测失败即 fatal，不猜。
3. 不可信连接在首帧前断开并计数；认证失败不进入方法分派。
4. 方法结果/参数全部经 `@zcode/shared/super-agent-control-plane-protocol` 的 zod 校验；
   协议版本不匹配 fatal。
5. child 退出时释放本人 leader 租约并 unlink socket。

## 公开面

- `createControlPlanePeerGuard` / `parseTrustedPids`：peer 判定。
- `createControlPlaneRpcServer`：JSONL 双向 RPC server（方法分派由 entry 注入）。
- `DaemonPlaneManager`：per-workspace plane 生命周期（ensure/ingest/lease 读面）。
- `createLazyAdjudicationSession` / `createEnvironmentAdjudicationSessionAssembly`：
  headless child 的裁决会话；首个裁决批才启动 provider Registry（避开 Core 物化
  Built-in Config 的启动顺序竞态），shutdown 先 abort 信号。`ZCODE_CHENG_ROOT`/host
  entry 在场时挂只读 Cheng host，走 `createToolAdjudicationSession`（allowlist 过滤的
  只读工具，ChengPlan 回执进入交叉校验）；缺席时保持零工具 model-only（能力缺席，
  plan 引用无回执可命中并 fail-closed 降级）。
- `createDaemonWatchdog`：从共享 `super-agent.sqlite` 只恢复本进程有命令面的 kind
  （cheng-job / workflow / automation），使用与 session app 同一
  `createSuperAgentWatchdog`；cheng-job 走 host.cancel，workflow/automation 经 Core RPC
  `host.watchdogCommand` 转 V4 `cancelBackgroundWork` / `automationService.pause`。
  notify-user 真实通道 = `createCoreTaskNotificationPort`：升级通知携路由事实
  （ownerSession/workspaceKey，随 repair 行进入）经 Core `host.watchdogCommand
  notify-user` 转 V4 `notifyUser` 投 owner session runtime task-notification 队列
  （`commandId=daemon-notify:<uuid>` 幂等键透传）；缺路由键不出站。未注入
  `taskNotification` 端口时返回稳定能力阻塞 `daemon_task_notification_unavailable`，
  `onError` 只作诊断、不计作用户已收到通知。用户通知权威仍是会话 app watchdog。
- `AdjudicationSessionUnavailableError` / `createUnavailableAdjudicationSession`：
  provider 配置/凭据不可用的 typed 失败端口；候选留 pending，绝不伪造 verdict。
