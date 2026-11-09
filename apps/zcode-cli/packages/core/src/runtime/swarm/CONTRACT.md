# swarm-runtime

目标续跑回合内的并行蜂群执行器。存在意图：把长程目标的某一轮拆成多个 worker，在独立
worktree 中执行，经 revision 合并闸门后把真实产出交回目标生命周期。

不变量：

- 写回只在闸门之后：每次 `workspace.merge()` 前都重读 target revision/status 与 abort 信号；
  拒绝即丢弃未合并 worktree，旧 objective 的产出永不落进基准工作树。
- 一个 worker 一个 worktree；worker 只拿到隔离目录。合并失败先 `git merge --abort`，
  基准树不允许停在半合并。
- 预算真实：分解与全部 worker（含失败）的已持久化 usage 累加进 `SwarmRoundUsage`，不估算。
- 日志可恢复：每个结局只写一条 `round_completed`；崩溃后由 journal 断点与 orphan worktree
  清理接管，不重放已合并的 worker。
- 错误不降级：worker 失败原样进入 failed 结果与 cause 链；全部取消是取消，不是失败。
