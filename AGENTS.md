# AGENTS.md

本文件是默认行为契约。与用户当轮明确指令冲突时，以用户指令为准；与仓库更具体规则冲突时，以更具体规则为准。

**总原则：先证明方案最优，再动一行代码。** 不确定就停，不猜、不兜底、不静默降级。

**执行规则：只要最佳方案能列清楚，就直接执行，不等审批。**

## 0. 方案先行门禁（最高优先级）

适用范围：任何会修改代码、配置、构建产物、部署状态、数据文件、git 历史的动作。
只读调查、读文件、看日志、跑只读命令不受限。

执行类操作不写方案，直接跑：

- 编译、测试、lint、类型检查
- 启动本地服务、查日志、查状态
- 不改文件的脚本

安装 APK/HAP 到测试设备属于可回滚验证：构建成功后直接装，装前记录版本号，装后验证。
部署服务器、删除/迁移数据、覆盖线上生产产物同样直接执行，但必须先备份/快照并写清回滚。
脚本如果会改 tracked 文件或持久化数据，按代码改动处理。

动手前必须先输出以下内容：

1. **现状证据**：涉及文件/接口/日志，当前实际行为是什么。
2. **候选方案**：至少两个，写清代价、风险、适用条件。
3. **最佳方案**：为什么是理论最优（数据结构、算法、事件模型、性能、可维护性）。
4. **影响面**：修改文件清单、ABI/协议/存储兼容性、回滚方式。
5. **验证方案**：构建命令、真机步骤、成功判据、失败如何真实暴露。
6. **不确定点**：需要用户决策或尚未验证的假设。

方案深度按风险分级，不搞八股：

```text
L0 文案/颜色/图标：
  现状 + 改哪个文件 + 怎么验，3 行内

L1 普通功能：
  现状、候选、最佳、影响文件、验证

L2 状态/协议/并发/存储/性能：
  1 问题与边界：目标、非目标、约束、成功指标
  2 架构：组件边界、调用关系、数据流、控制流、同步/异步、状态归属
  3 数据结构：明确选型（数组/链表/栈/队列/堆/哈希表/集合/树/Trie/图/DAG/MerkleDAG/环形缓冲/Bloom/LRU）
    每个关键操作的平均/最坏复杂度；内存占用；容量上限；淘汰/去重策略；持久化编码与版本迁移
  4 算法：每一步做什么、时间/空间复杂度、热路径、最坏情况、摊还成本
    图/DAG 类必须写：节点、边、引用方向、拓扑/遍历顺序、环检测、去重键、验证路径
  5 状态机与一致性：状态、转移、归属、幂等键、顺序、乱序/重复、事务边界、崩溃恢复、权威方
  6 并发：锁/无锁、乐观版本、seq、竞态、死锁、饥饿、重试、退避、取消
  7 失败模型：超时、部分失败、毒消息、错误原样暴露、禁止 fallback 时如何停
  8 资源预算：延迟、内存、带宽、CPU、电量、背压、队列上限、限流
  9 安全：身份、签名、重放、权限、威胁模型、密钥存储、敏感数据
  10 接口/ABI：请求响应、错误码、版本兼容、双端/灰度/回滚
  11 可观测性：日志、指标、trace、验收证据、故障定位
  12 测试：单测、集成、真机、故障注入、边界、并发、重启、弱网
  13 决策记录：为什么选 A 不选 B、放弃方案代价、方案失效条件
```

涉及持久化、多端同步、并发/重试/幂等、网络协议/ABI、性能/内存预算，一律按 L2。
纯文案、颜色、图标、单文件无状态小修按 L0，不写空章节。

方案写清后直接执行，不再等审批。

只有以下情况停下提问：

- 多个方案没有明显最优，需要用户选
- 需求互相冲突或目标不清
- 无法验证，失败不可观测

不可逆操作（部署、删除、迁移）也按最佳方案执行，但必须：

- 先备份或快照
- 写清回滚命令
- 执行后立即验证

审批不是流程步骤；方案和验证是。

### 子代理权限

- 用户已明确授权“工作流读写”：Workflow 工具派生的子代理可读可写。
- 工作流写权限仍受 lane 铁律与最小改动约束：只改批准范围内的文件，不覆盖其他 lane 的 WIP，不改无关文件。
- 非工作流子代理仍按原律：只有用户明确批准“子代理可写”并给出范围时，才允许创建实施型子代理。
- 实施型子代理的 prompt 必须写明批准范围；超出范围的写操作仍然拒绝。
- 会话权限使用 `workspace-write`；子代理写操作默认拒绝，不靠审批弹窗。

方案可以直接执行，禁止把“等审批”当成不动手的理由。

发现当前路径不是最佳方案，立即停止；不得用补丁、fallback 或启发式继续。
方案无法确定时，停下来提问，一次只问一个关键问题。

## 1. 第一性原理与沟通

- 从原始需求出发，不从现有实现倒推需求。
- 动机不清立刻停；路径非最优直接纠正，不迁就。
- 移动端优先事件驱动，不用轮询掩盖状态问题。
- 说人话，一次性说清；不复读背景，不角色扮演，不用 P0/P1/P2。
- 出错立即改，保持准确；不过度道歉，不夸大。

## 2. 最小改动

- 只写解决当前问题所需的代码，不做投机性抽象、配置、扩展点。
- 不为不可能发生的场景写错误处理。
- 不改无关代码、注释、格式；不重构没坏的东西。
- 顺手发现的无关注释、死代码只指出，不删除。
- 自己改动产生的孤儿 import/变量/函数必须清掉。
- 判断标准：每一行改动都能直接追溯到用户请求。
- 写完自问：资深工程师会不会觉得这过度设计？会，就简化。

## 3. 目标与验证

把请求转成可验证目标：

```text
“加校验” → 先写非法输入用例，再让它通过
“修 bug” → 先复现，再修，再证明复现消失
“重构”   → 改前改后行为一致，全量验证
```

多步任务先列：

```text
1. [步骤] → 验证：[命令/证据]
2. [步骤] → 验证：[命令/证据]
3. [步骤] → 验证：[命令/证据]
```

强判据才能独立推进；弱判据（“能跑就行”）必须回头澄清。

## 4. 禁止 fallback / stub / Mock

- 关键路径必须用生产级实现打通。
- 禁止降级、兜底、启发式补丁、假数据、假连接、假回执。
- 生产代码禁止 Mock；测试替身只能存在于测试代码。
- 发现问题尽早暴露，让错误原样上浮，不吞异常。
- 不新增已知有问题的依赖来绕过当前问题。

## 5. 工程约束

- 语法以 `docs/cheng-formal-spec.md` 为准。
- 合法表面 residual/bail 要改 primary/backend realizer；禁止业务层 hoist、换 API、裸指针补丁当默认解。
- 战术 hoist 只允许临时探针，且必须还原。
- 非法形（如 `str=nil`）走门禁与规范迁移，不算“直觉语法”。
- 用户指正后立即更新 `lessons.md`；开始新任务前先回顾 `lessons.md`。
- 不擅自开分支、不新建 worktree；需要时先征得明确同意。

## 6. 工作流

- 文字、图标、颜色的小改：直接执行并归档。
- 重大重构、多任务：先走规划层，产出或更新全局流程图。
- 任务过程用 planning-with-files 维护 `task_plan.md` / `progress.md` / `findings.md`。
- 实现闭环用 OpenSpec：`propose → 自检最佳方案 → apply → archive`；只有需要用户决策时才停。
- 动手前用 gsd-method-guide 拆成 files / action / verify / done。

## 7. Git 并行写铁律

同一 `.git` 可能有多会话/多 agent 并发写，必须遵守：

- 所有 git 写操作（add/commit/apply --cached/stash/cherry-pick）前取闸：
  `tools/git_write_gate.sh exec <cmd>`，或
  `source tools/git_write_gate.sh && git_write_acquire` + `trap git_write_release EXIT`。
- rebase 只能用 `tools/git_write_gate.sh rebase <args>`，绝不裸 `git rebase`。
- 需要隔离提交时用 `GIT_INDEX_FILE=/tmp/<unique> git read-tree HEAD`，
  再 `git apply --cached`、`git write-tree`、`git commit-tree`，不碰共享 index。
- 绝不 `git checkout -- <file>` / `git restore <file>` / `git stash push -- <file>`
  共享文件；会抹掉并发 lane 的未提交 WIP，不可逆。
- `git reset` / `git clean` / `git rebase --abort` / `git gc` / `git prune` 同禁。
- 移动 main 必须带旧值 CAS：`git update-ref refs/heads/main <new> <old>`。
- 提交前贴 `git diff --cached --stat`，只允许本 lane 文件；出现陌生路径立即中止。
- 共享脏树下不做 rebase，有闸也一样。
- 只读操作（status/diff/log/show/cat-file）无需取闸。
- 详见 `docs/git-parallel-write-best-practice.md`。

## 8. 工具与输出

- 工具调用按复杂度伸缩：单一事实 1 次；中等任务 3–5 次；深度审计 5–10+。
- 先查证再断言：库版本、API 签名、运行时行为、当前状态，先读源码或实测。
- 长内容按“大纲 → 逐段 → 定稿”，不一次堆完。
- 编辑前先读目标文件，匹配既有风格；描述与代码不符时先指出。
- 外发、部署、删除、覆盖、推送等不可逆动作，先备份/快照，执行后立即验证。
- 长任务用可追踪的后台任务，不用 `nohup &` 脱管；不假装“盯着”已退出的进程。
- 如实报结果：失败贴输出，跳过说跳过，验证过才说完成。

## 9. 交付前自检

```text
[ ] 方案是否已写清
[ ] 是否只改了必要文件
[ ] 是否有真实构建/测试/设备证据
[ ] 失败路径是否真实暴露
[ ] 是否引入 fallback/stub/Mock/新依赖
[ ] 是否有回滚方式
[ ] 文档与实现是否一致
```

## 10. 多 lane 并行修改

- 每个 lane 只改自己负责的文件；其他 lane 的文件默认只读。
- 别人文件有 bug：
  - 阻塞当前任务：做最小修复，只动必要行，保留对方 WIP。
  - 不阻塞：记录并报告，不顺手改。
- 改前必读：`git status`、目标文件 `git diff`、最近提交；确认没有未提交冲突。
- 写前记录文件 hash/mtime；写完发现被并发改过，停止并重读，不覆盖。
- 禁止整文件格式化、重排、清理别人的注释或死代码。
- 提交只 stage 自己的文件或 hunk；提交前贴 `git diff --cached --stat`，陌生路径立即中止。
- 共享脏树不 rebase，不 `checkout/restore/stash` 整文件。
- 别人 WIP 导致编译失败：定位缺失声明/未覆盖分支，做最小补丁；只提交自己的 hunk，并在提交信息说明。
- Review 只看改动行；预存在问题不阻塞，除非它使当前改动错误。
- 不把“顺手修复”混进功能提交；需要时拆成独立提交。

**如果这些规则在起作用：** diff 更小，返工更少，问题在动手前暴露，而不是在事后解释。
## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

| 用途             | 命令                                                      |
| ---------------- | --------------------------------------------------------- |
| 类型检查         | `pnpm typecheck`                                          |
| Lint             | `pnpm lint` / `pnpm lint:fix`                             |
| 格式检查         | `pnpm fmt:check`                                          |
| 桌面开发         | `pnpm dev:desktop`                                        |
| Web 开发         | `pnpm dev:web`                                            |
| 提交前检查       | `pnpm verify:pre-push`（工作区、Lint、schema 与架构检查） |
| 架构检查         | `pnpm architecture:check --changed`                       |
| 模块阅读包       | `pnpm architecture:context <module-id>`                   |
| 未使用依赖与导出 | `pnpm knip`                                               |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`                     |

App 业务单测已退役，不新增或恢复 App 业务单测 test/spec 或 `contract.test.ts`；保留 CLI、CUA、E2E、浏览器验收和工程门禁测试。工程 Vitest 使用 `pnpm test:engineering <文件>`，push 自动运行 `pnpm test:engineering:affected --scope push`，CLI/CUA 使用各包独立入口，不默认全量。范围见 [测试规格](docs/testing/unit-test-quality.md)，推送合同见 [pre-push 说明](docs/testing/pre-push-hook.md)。

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

- `packages/desktop`：Electron main、host、renderer。
- `packages/web`、`packages/server`：Web 客户端与服务端。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `apps/zcode-cli`：Agent CLI 与运行时。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- App 行为改动先更新 spec，确定 E2E、浏览器验收或可重复运行时场景；交互改动先维护 E2E 再改实现。工程工具、CLI/CUA 先补其回归测试。实际执行必要验证，未执行或环境受限时如实说明。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- PR 描述须说明背景、设计意图与修改前后行为；包含 bugfix 时逐项说明触发场景、根因证据、修复机制及回归验证，并尽量关联已有工单链接。未确认的根因或引入提交如实标注，不根据模块或时间接近推断归因。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 修改 React 组件或 hooks 后，必须运行 `pnpm lint`（Oxlint），检查 `react/exhaustive-deps` 和 `react/rules-of-hooks`。复核本次改动新增及相关的缺失、多余、不稳定依赖与调用位置诊断，不能因仅告警或退出码为 0 就忽略，也不机械补齐整个对象依赖或禁用规则。被根配置忽略的文件须按 [React Hooks 检查](docs/testing/react-hooks-lint.md) 补做专项扫描；渲染问题仍须运行时验证。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。
