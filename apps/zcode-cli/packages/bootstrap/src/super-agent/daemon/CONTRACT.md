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
