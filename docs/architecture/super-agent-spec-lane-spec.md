# Super-agent spec lane 实施规格（M5 受限 profile + 结构隔离与协作式 egress 代理）

状态：实施级 spec（对应 [super-agent-harness-design.md](./super-agent-harness-design.md) M5，Phase 3 批）。本文定五样：spec restricted profile 的形状与解析、本地 egress 代理的语义、spec run 环境的凭据真空构造、fail-closed 检查点、对抗验收测试。与设计冲突时以设计为准，差异登记在 §8。

**强制等级（裁定 B，2026-11-02）**：出站约束分两层，措辞不得混用——
① **结构隔离（硬）**：spec 工具面不持有任何出站工具/信道句柄（WebFetch/WebSearch/ReplyToChannel/SendMessage/Workflow 族、`mcp__*` 动态名全剔），这是结构性事实，不可绕过；
② **协作式 egress 代理（env 级）**：per-workspace 本地代理 + 子进程 env 注入 proxy 变量，对**读取代理 env 的客户端**（默认 curl、大多数 CLI）生效；`curl --noproxy '*'`、`env -u HTTP_PROXY`、不读代理 env 的客户端（undici `fetch` 类）是**已知残留**，绕过对抗测试如实钉住（§5）。对外文案禁用「物理隔绝出站」「物理隔离」。OS 级围栏（网络命名空间/防火墙）见 §8-6 后续路径。

## 0. 范围与不变量

里程碑交付（本 lane）：

1. **spec restricted profile**：`core/src/subagent/tool-policy.ts` 的 `buildSpecRestrictedProfile()`——workspace 写工具面 + 出站/信道句柄全量剔除 + `permissionMode: "dontAsk"`（静默 run 不弹窗）。
2. **本地 egress 代理**：`bootstrap/src/super-agent/spec-lane/` 托管 per-workspace HTTP/CONNECT 代理——allowlist host 直通、其余 403；默认零 egress。
3. **spec run 环境构造**：`adapters/src/network/subprocess-env.ts` 的 `buildSpecRunEnv()`——allowlist 白名单拷贝（非 denylist）+ 强制代理注入（复用 `applyNetworkEgressEnv` 通道）；无代理地址即抛。
4. **对抗验收**：spec run 环境内默认 curl（读代理 env）非白名单 host 必失败、白名单 mirror host 通过；env 零凭据字节；toolface 零出站工具。绕过型客户端（`--noproxy`、不读代理 env）能直连是**已知残留**，由 §5 绕过测试钉住，不假称拦截。

硬不变量：

- **fail-closed，无降级**：无代理地址 ⇒ `buildSpecRunEnv` 抛错；代理端口起不来 ⇒ `prepareSpecRunEgress` 抛 `SpecEgressStartupError`。任何路径都不回退到直连。
- **零 egress 缺省**：代理 allowlist 缺省为空数组 ⇒ 一切转发被拒；白名单只能来自调用方显式传入（per-repo 依赖镜像配置，见 §4 接缝）。
- **env 凭据真空**：spec run 子进程 env 用**白名单拷贝**构造（PATH/HOME 等运行必需键），不是 denylist——未列出的键（GITHUB_TOKEN、npm authToken、ZCODE_TOOL_ENV_PASSTHROUGH_JSON…）结构性不存在，测试断言凭据字节缺席。
- **出站工具面为零**：spec profile 的工具面不含 WebFetch/WebSearch/ReplyToChannel/SendMessage/escalate/submit_result/js/node_repl/`mcp__*`，且剔除会派生未受限子运行的编排与调度工具（Agent/Task/CreateWorkflow/…，理由见 §2.2）。
- **代理只绑 loopback**：127.0.0.1，不监听外部接口；代理自身只说 HTTP 代理协议（absolute-form + CONNECT），不开任意 TCP 转发。

「workspace-write-only」的精确含义：spec run 可写工作区（复现-修复的使命）、持有零凭据、零出站。文件系统越界写不是 M5 的隔离目标（并发归 M12 写租约、审批归 path policy）；M5 的隔离承诺只针对**出站副作用**（设计 M5：被注入的群消息最多让 agent 在沙箱里复现一个失败测试，发不出任何外部副作用）。

## 1. 组件与文件落点

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| 受限 profile | `core/src/subagent/tool-policy.ts` | `SPEC_RESTRICTED_TOOLFACE` / `SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS` / `filterSpecRestrictedToolNames` / `buildSpecRestrictedProfile` |
| spec run env | `adapters/src/network/subprocess-env.ts` | `buildSpecRunEnv({ proxyUrl, sourceEnv?, platform? })` |
| egress 代理 | `bootstrap/src/super-agent/spec-lane/egress-proxy.ts` | `startEgressProxy`：HTTP absolute-form + CONNECT，allowlist 门禁 |
| spec-lane 契约 | `bootstrap/src/super-agent/spec-lane/{contract,spec-lane,index}.ts` | `prepareSpecRunEgress` / `stopSpecRunEgress` + per-workspace 注册表 |

分层：spec-lane 是 app 层 managed 模块（`requires: []`，与 policy 一致）——**模块内不得 import 其它 workspace 模块**，代理只用 node 内建；profile 与 env 的集成由组合根（dispatcher lane）完成，见 §6 接缝。

## 2. spec restricted profile（core/src/subagent/tool-policy.ts）

### 2.1 工具面

```ts
/** workspace 写工具面：复现-修复所需全集；除此以外的工具一律不进面。 */
const SPEC_RESTRICTED_TOOLFACE = [
  "Read", "Glob", "Grep", "Write", "Edit", "Bash", "TodoWrite", "TodoRead",
] as const;
```

### 2.2 出站/信道/逃逸剔除表

```ts
const SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS = [
  // 出站网络（sideEffectScope=network）与别名（web_search 经 normalizeToolNameAlias 归一）。
  "WebFetch", "WebSearch",
  // 信道句柄：会话回复、跨 agent 消息、升级、结果投递——spec run 不持有任何对外发声通道。
  "ReplyToChannel", "SendMessage", "RespondToCoordinator", "escalate", "submit_result",
  // node_repl：进程内任意 JS（fetch 不走代理 env），是出站旁路。
  "js",
  // 会派生未受限子运行的编排/调度工具：子运行不继承本 profile 的工具面与 env，是出站旁路。
  "Agent", "Task", "Workflow", "CreateWorkflow", "AmendWorkflow", "ResumeWorkflowRun",
  "CronCreate", "CronUpdate", "CronDelete", "OffPeakCreate",
  // goal 层续跑会派生未来的自主 run（同样绕过 verdict 前零出站）。
  "GoalCreate", "GoalUpdate", "GoalBlock", "GoalChengBind",
  // mcp__* 前缀规则：动态 MCP 名（任意 server 可出站）精确表覆盖不了，必须前缀剔除。
  // 同时进 disallowedTools——tools:["*"] 展开路径（resolveSubagentToolAllowlist）只吃这份规则。
  "mcp__*",
] as const;
```

`mcp__` 前缀工具（任意 MCP server 可出站）双保险：`filterSpecRestrictedToolNames` 按前缀剔除（显式工具面），`filterSubagentChildToolNames` 识别 `mcp__*` 前缀规则（`tools:["*"]` 展开路径——`resolveSubagentToolAllowlist` 只消费 `disallowedTools` 精确规则，动态名 `mcp__x__y` 必须靠前缀规则挡住）。

**为什么剔除编排/调度工具**：`Agent`/`Task`/`CreateWorkflow` 派生的子运行拿的是 general-purpose profile（`tools:["*"]`）与常规 env——父 profile 的约束不向下遗传；`Cron*`/`OffPeakCreate`/`Goal*` 在 verdict 前武装未来的自主 run。留着它们，「verdict 前零出站」就只是断言。

### 2.3 profile 与权限模式的合流

```ts
buildSpecRestrictedProfile(overrides?) => AgentProfile {
  name: "spec-restricted",
  tools: [...SPEC_RESTRICTED_TOOLFACE],
  disallowedTools: [...SPEC_RESTRICTED_OUTBOUND_DISALLOWED_TOOLS],
  permissionMode: "dontAsk",   // → resolveSubagentPermissionMode 映射 yolo（guarded 父收紧为 guarded）
  ...
}
```

- **工具面与权限模式双保险**：`tools` 显式白名单封顶（`runner.resolveAllowedTools` 走 profile.tools 过滤），`disallowedTools` 兜底——即使调用方把 tools 改写成 `"*"`，出站工具仍被 `filterSubagentChildToolNames` 剔除。
- **`dontAsk` 而非 `edit`**：spec run 是程序驱动的静默 run，`edit` 模式下 Bash（sideEffectScope=system）会 ask ⇒ 挂到权限超时，CI 复现直接残废。静默不弹窗由 `dontAsk` 承担；**严格性由工具面 ∩ 无凭据 env ∩ egress 代理三层承担**——这个组合严格强于任何单一既有 `AgentPermissionMode`（`plan` 拦写、`yolo` 放任出站、`edit` 挂静默，无一同时给出「可写工作区 + 零出站 + 零凭据」）。
- 既有机械自动生效，零改动：子代理路径经 `runner.resolveAllowedTools(profile)`；权限经 `resolveSubagentPermissionMode(profile.permissionMode)`。

## 3. spec run env（adapters/src/network/subprocess-env.ts）

```ts
buildSpecRunEnv({ proxyUrl, sourceEnv?, platform? }): Record<string, string>
```

1. `proxyUrl` 为空 ⇒ 抛错（fail-closed：无代理即拒绝启动，不回退直连）。
2. **白名单拷贝**（case-insensitive，win32 兼容既有 setEnvKey/getEnvValue）：
   `PATH, HOME, USERPROFILE, USER, LOGNAME, SHELL, LANG, LC_ALL, LC_CTYPE, TERM, TZ, TMPDIR, TMP, TEMP, SYSTEMROOT, WINDIR, COMSPEC, PATHEXT`。
   `USERPROFILE` 是 Windows 的 HOME 等价键（shell/工具在 win32 靠它定位用户目录），必须在表内；`PWD` 不在表内——子进程 cwd 由 spawn 的 cwd 参数决定，env 里的 PWD 是父进程的陈旧快照，传下去反而误导（以实现为准，2026-11-02 对齐）。
   不在表内的键（一切凭据形态：token/authKey/Authorization/OTEL headers/ZCODE_TOOL_ENV_PASSTHROUGH_JSON…）结构性不进 env——这是「无凭据」的机械保证，不靠 denylist 猜键名。
3. 调既有 `applyNetworkEgressEnv(env, { network: { httpProxy: proxyUrl, noProxy: "" }, sourceEnv: {}, toolEnvPassthrough: false, platform })`：
   - 复用既有通道 ⇒ HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 及小写变体统一注入，与执行适配器的 `network` 策略同源；
   - `sourceEnv: {}` ⇒ 不回落 `ZCODE_HTTP_PROXY`/`ZCODE_NO_PROXY`/`ZCODE_AGENT_CA_CERT`；
   - `noProxy` 空 ⇒ 不设 NO_PROXY，**读取代理 env 的客户端访问一切主机（含 localhost）都过代理**，由代理 allowlist 统一裁决；不读代理 env 或显式 `--noproxy`/`env -u` 的客户端绕过是已知残留（裁定 B，见 §0/§5/§8-6）。

组合根接线（dispatcher lane）：`createNodeExecutionAdapter({ processEnv: buildSpecRunEnv(...), network: { httpProxy: proxyUrl } })`。

## 4. egress 代理（super-agent-spec-lane）

### 4.1 语义

- `startEgressProxy({ allowHosts, port?, host? = "127.0.0.1" })`：起 HTTP 正向代理，返回 `{ url, port, close() }`；listen 失败（端口占用等）抛 `SpecEgressStartupError`。
- **协议面只有 HTTP 代理协议**：absolute-form HTTP 请求 + CONNECT 隧道（HTTPS 走 CONNECT 是 HTTP 代理协议的一部分；不开其它 TCP 转发）。设计里「仅 HTTP 到用户配置的 host」按此解读：只放行 web 流量到用户配置的 host。
- **门禁**：`host` 或 `host:port` 精确匹配（大小写不敏感），命中才转发；未命中 HTTP ⇒ 403，CONNECT ⇒ 403 后断连。空 allowlist ⇒ 全拒（零 egress 缺省）。
- 只绑 loopback；`close()` 关闭 server 并 `closeAllConnections()`。

### 4.2 契约（dispatcher 调用面）

```ts
interface SuperAgentSpecLaneContract {
  /** (re)启动某 workspace 的 egress 代理；同 workspace 已有实例先停后起。失败抛 SpecEgressStartupError。 */
  prepareSpecRunEgress(req: { workspaceRoot: string; allowHosts?: readonly string[]; port?: number }): Promise<SpecRunEgressPlan>;
  /** 停止并清理；幂等（缺席即 no-op）。 */
  stopSpecRunEgress(workspaceRoot: string): Promise<void>;
}
// SpecRunEgressPlan = { workspaceRoot, proxyUrl, networkPolicy: { httpProxy, noProxy: "" }, allowHosts }
```

`normalizeSpecEgressAllowlist(raw)`：把 per-repo 配置值收敛成 host 表——非字符串条目**抛错**（配置损坏必须暴露，不静默丢弃）；缺省 `[]`。

### 4.3 per-repo 依赖镜像白名单（接缝）

预期配置键 `specEgress.allowHosts: string[]`（repo config，如 `["registry.npmjs.org", "pypi.org"]`）。contracts config schema 由 config lane 拥有——本 lane 只收 `allowHosts` 参数 + `normalizeSpecEgressAllowlist` 纯函数，schema 落地是 §6 接缝。

## 5. 对抗验收测试（design Phase 3）

| 测试 | 断言 |
| --- | --- |
| 代理 allow/deny 矩阵 | absolute-form：白名单 host:port 200、非白名单 host 403、host 命中但 port 不符 403、空 allowlist 全拒；CONNECT：白名单 200 Connection Established、非白名单 403 断连 |
| **curl 对抗**（真实子进程） | env=buildSpecRunEnv+代理：`curl -fsS` 到白名单 127.0.0.1 mirror 退出 0；`curl -fsS` 到非白名单 host（同端口的 localhost 字面量）非零退出 |
| **绕过残留钉住**（裁定 B） | 同 env 下 `curl --noproxy '*'` 到非白名单 host **成功**（断言绕过成立，注释标注这是钉住的已知残留，禁止改断言为拦截）；node 内置 `fetch`（undici，不读代理 env）到非白名单 host **成功**（同上钉住）。这两行是 env 级协作式强制的能力边界证据，不是缺陷回归 |
| env 凭据字节 | sourceEnv 塞 GITHUB_TOKEN/ANTHROPIC_API_KEY/npm authToken/ZCODE_TOOL_ENV_PASSTHROUGH_JSON 假凭据 ⇒ 产出 env 无对应键、序列化后无凭据字节；HTTP_PROXY=proxyUrl |
| fail-closed 启动 | `buildSpecRunEnv` 无 proxyUrl 抛错；`prepareSpecRunEgress` 端口被占抛 `SpecEgressStartupError` |
| toolface 零出站 | `filterSpecRestrictedToolNames`（含 `mcp__*` 前缀、web_search 别名）后无出站工具；`filterSubagentChildToolNames(profile.tools, profile.disallowedTools)` 与 profile 解析合流后仍无出站 |

## 6. 接缝（不在本 lane）

1. **mandate/spec-trigger dispatcher**（M4/触发 lane 拥有）：调 `prepareSpecRunEgress` → `buildSpecRunEnv` → `buildSpecRestrictedProfile` → 建 **subagent run**；verdict 门与结果卡交付不在本 lane。
   **Phase 3 只有 subagent 路径可用**（裁定 A，2026-11-02）：workflow 形态在 profile 接线前禁止启动 spec run——dispatcher 不得以 workflow 形态建 spec run；workflow 的 child runtime 尚不接受 profile/processEnv 注入，起 workflow spec run 等于把受限 profile 与无凭据 env 静默丢掉。接线接缝：给 workflow-facade / script-workflow-child-runtime 增加 `profile` / `processEnv` 入参后再评估 workflow 形态。
2. **contracts config schema**：`specEgress.allowHosts` 的 repo 配置键与读取（config lane）。
3. **执行适配器装配**：`create-app`/workflow-facade 把 `processEnv`+`network` 注入 `createNodeExecutionAdapter`（bootstrap app 组合根）。
4. **`adapters/src/exec/index.ts` 再导出 `buildSpecRunEnv`（已接，2026-11-03）**：生产侧经 `@zcode/adapters/exec` 公共入口消费（create-app 的 spec run 装配）。

## 7. 测试落点

- `packages/core/tests/spec-restricted-profile.test.ts`——profile 形状、剔除矩阵、与 `filterSubagentChildToolNames` 合流。
- `packages/adapters/tests/spec-run-env.test.ts`——白名单拷贝、代理注入、凭据真空、fail-closed。
- `packages/bootstrap/tests/super-agent-spec-lane.test.ts`——代理矩阵、CONNECT、curl 对抗、绕过残留钉住（`--noproxy`/node fetch）、端口占用 fail-closed、契约幂等。
- `spec-lane/contract.test.ts`——治理五件套（模块内；与 watchdog 同规，实施断言以 tests/ 为准）。

## 8. 决策记录与待裁决

1. **代理而非工具面裁剪**：设计 M5 已裁定——CI 复现必须 Bash+装依赖，curl 就破功；工具面只做纵深第二层。
2. **白名单 env 而非 denylist**：凭据形态不可穷举，denylist 无法证明「零凭据字节」；白名单结构性成立。代价：新工具需要的 env 键要显式加表。
3. **`dontAsk` 承担静默、严格性由三层承担**：见 §2.3；若未来出现真正的 workspace-write 权限模式，profile 只改一个字段。
4. **代理随 spec run 生命周期、不进 daemon**：设计 M5 说「daemon 内」；Phase 3 的 spec run 由 dispatcher 在宿主进程内程序化发起，代理与 run 同生命周期最简。迁 daemon（M7/§2.2 组件矩阵）时只动组合根，契约不变。
5. **workflow 路径 Phase 3 不可用**（裁定 A，2026-11-02）：Phase 3 spec run 只走 subagent 路径；workflow 形态在 profile/processEnv 接线前禁止启动 spec run，见 §6-1。接线接缝：workflow-facade / script-workflow-child-runtime 增加 `profile` / `processEnv` 入参。
6. **egress 强制等级与残留**（裁定 B，2026-11-02）：「结构隔离（硬）+ 协作式 egress 代理（env 级）」两层措辞不得混用（§0）。env 级代理的已知残留：`curl --noproxy '*'`、`env -u HTTP_PROXY`、不读代理 env 的客户端（undici `fetch` 类）可直连非白名单 host——协作式第二层对不合作客户端无效，这是设计边界不是缺陷；§5 绕过测试如实钉住。**后续路径**：OS 级围栏（Linux 网络命名空间/netfilter、macOS socketfilterfw/pf、Windows WFP）把残留升级为结构性拦截，列 Phase 6 前置；在 OS 围栏落地前，对外文案禁用「物理隔绝出站」。残留的实际收窄依赖三层组合：工具面结构隔离（出站工具不存在）+ 零凭据（拿不到 secrets）+ 代理拦截默认客户端。
7. 待裁决：per-repo 配置键最终形态（`specEgress.allowHosts` vs 复用 network 段）；CONNECT 是否要按端口细分（当前 host 或 host:port 两档已够 npm/pip mirror）。
