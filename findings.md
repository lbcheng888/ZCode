# findings — super-agent-harness-design 落地

- lessons.md 不存在（本仓无该文件），无历史教训可回顾；用户指正时按 AGENTS.md §5 建立。
- background-notifications 唤醒账本自开源起就有（saveSessionInput kind=backgroundNotification）；「崩溃丢通知」的真缺口是终态结果不再投喂，不是账本缺失（批量 1 修正了这一误判）。
- unmanaged-new-file 门禁：`managed: true` 模块才放行新文件；两个收口姿势——`pnpm architecture:adopt <id> --root <dir>`（会写 architecture-policy.yaml）或 policy `exceptions` 条目（批量 1 先例）。
- adopt 要求 root 目录已存在，且会 scaffold 五件套（module.ts/contract.ts/contract.example.ts/contract.test.ts/CONTRACT.md）。
- zcode 测试从仓库根 `npx vitest run <paths>` 跑；包目录内直接 vitest 会因缺配置启动失败。
- 控制面组合根：packages/server 不依赖 @zcode/bootstrap（现状核查属实），daemon 承载走「受管子进程」而非包依赖注入（规格 §7-7 裁决）。
- 两把消费锁不同源：provider 连接消费锁（目录锁+owner.json+nonce）已跨进程；消息级 markInboundDelivery 是进程内 Map——权威去重靠 trigger_events UNIQUE 约束。
