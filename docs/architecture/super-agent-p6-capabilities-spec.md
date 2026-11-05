# Super-agent P6 能力规格：设备权限矩阵 / 能力票据 / OS 级 egress 围栏

状态：P6 设计实施规格（可选里程碑），2026-11-05 起草并核对现状。对应 [super-agent-harness-design.md](./super-agent-harness-design.md) §5③、§7 Phase 6，以及 [super-agent-spec-lane-spec.md](./super-agent-spec-lane-spec.md) §8-6 的后续路径。

**现状声明（不夸大）**：本文三项能力在本仓均未实现。

- `deviceScope` / `attachmentRole` **代码零命中**；文字命中除本规格外，还有设计文档、`task_plan.md`、[super-agent-milestone-b-spec.md](./super-agent-milestone-b-spec.md)（仅在 P6 边界描述中出现）与调研笔记。
- 能力票据不存在。仓内两个同名近似物都不可复用：off-peak ticket 是服务端配额取号（`packages/shared/src/off-peak-types.ts:107-110`，请求头 `x-off-peak-ticket-id` 见 `apps/zcode-cli/packages/adapters/src/model/runner-network-headers.ts:13`）；`ModelRequestAdmissionTicket` 是模型并发槽位（`apps/zcode-cli/packages/adapters/src/model/request-admission.ts:20-57`）。两者都不携带设备/附件绑定，也不承担凭据换取。
- OS 级 egress 围栏不存在。现有 spec lane 只有「结构隔离（硬）+ 协作式 env 代理」，且 spec-lane 规格 §0/§5/§8-6 已把 `curl --noproxy '*'`、`undici fetch` 直连钉为**已知残留**，测试断言其成功，禁止改成“拦截”。

本文因此只定义目标、威胁模型、接口/协议草案、验收与接缝；任何“实现落点”都是待建项。与实现冲突时以实现为准，并另立偏差记录。

## 0. 范围与共同不变量

P6 三项独立交付、独立灰度，不并入业务灰度批次（[super-agent-grayscale-report.md](./super-agent-grayscale-report.md) §7 的建议顺序是：能力票据 → OS 围栏 → 设备凭据矩阵；本文按任务要求顺序展开，落地顺序见 §4）。

共同硬不变量：

1. **权威在宿主侧，客户端声明不作数**。设备角色、附件身份、票据绑定都必须来自宿主侧连接记录（attachment registry / 设备凭据），不得由命令信封或模型输入自报。
2. **fail-closed**：角色未知、票据缺失/过期/被吊销、围栏建立失败，一律拒绝目标动作；不静默降级到“更宽”的路径。
3. **协议帧与模型上下文零凭据字节**。票据密钥只存在于 broker 与执行端内存，不落库、不落日志、不进 env 之外的任何持久面；`ticketId` 是协议/执行层句柄，是否进入模型上下文待 §5 开放问题 6 裁决（当前不承诺模型可见）。
4. **吊销即时**：至少保证「下一次工具 admission / 下一次票据兑换」前生效；在途长命令按既有取消/杀进程路径处理，不承诺回溯撤销已发生的副作用。
5. **平台能力缺席即关闭能力**：OS 围栏在不可建立的平台拒绝启动 spec run，不用协作式代理冒充硬围栏。
6. 不引入第二准入队列、不新增旁路 CommandInbox、不做云脑拓扑。

## 1. 设备权限矩阵（deviceScope / attachmentRole）

### 1.1 现有接缝与权威问题

| 接缝 | 现状 | 结论 |
| --- | --- | --- |
| `packages/shared/src/zcode-protocol-v4/transport.ts:74` `clientHelloSchema.clientKind` | 枚举 `desktop \| web \| mobileRemote \| mobileApp`，**客户端自报且 optional** | 只能作提示，不能作权限权威；远端缺失/未知按最受限角色，本地宿主进程不受影响 |
| `apps/zcode-cli/packages/contracts/src/interfaces/permission.port.ts:24-35` `PermissionRuleset` | 现有 `allow/deny/ask`，另有开放索引签名 `[key: string]: unknown` | 可 additive 扩字段不破坏解析；但 enforcement 必须在类型化层落地，不能靠索引签名“漂过” |
| `apps/zcode-cli/packages/core/src/permission/service.ts:80-89` `PermissionContext` | 已有 `mandate` / `origin`，无附件/设备面 | 增 additive-optional `attachment`，在 prompt admission 边界绑定 |
| `apps/zcode-cli/packages/core/src/permission/service.ts:208-211` | mandate 同步 fail-closed 门已插在 plan-transition 解析之前 | 设备门放同一前端位置；缺省 host 时字节兼容 |
| `packages/desktop/src/main/webRemoteControlManager.ts:61-72,199,1056-1139` | `attachmentId` 的取得/释放已有宿主侧记录 | 附件身份的权威来源；角色从该记录派生 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1605` | clientHello 能力位已用于可信注入，但同一连接的 clientKind 未参与权限 | 接线点：连接登记时把 attachmentId + role 绑到会话/客户端身份 |

关键取舍：**`clientKind` 不是身份**。同一设备可能通过不同客户端形态连接；攻击者也能改 hello。宿主必须把连接与 `attachmentId`（以及设备凭据指纹）绑定，角色从宿主记录派生；客户端自报与宿主记录不一致时，按更受限角色处理并计数告警，不得信任自报。

### 1.2 威胁模型

| 威胁 | 攻击面 | 影响 | 本项对策 |
| --- | --- | --- | --- |
| 被攻破的手机/web attachment 继承桌面全量工具权 | 远端 attachment 连到同一 host | 读任意文件、跑 Bash、取凭据、改仓库 | 默认 `read_mostly`；裸 Bash/凭据工具 deny；写操作强制宿主确认 |
| 伪造 `clientKind=desktop` 提权 | clientHello 自报 | 同上 | 角色只认宿主 attachment 记录；不一致降级 + 告警 |
| 重放旧协议帧/旧附件 | 协议帧无附件绑定 | 已吊销设备继续操作 | 命令/输入绑定 attachmentId；每次 admission 复核；吊销 epoch |
| 吊销传播延迟 | 多窗口/多进程 | 吊销后仍能执行若干步 | 吊销先改宿主权威记录并断连接；票据同步失效；待批 ask 直接拒绝 |
| 跨 workspace 附件 | 一个 attachment 连多 workspace | 越界读/写 | 角色与 workspace 绑定；跨 workspace 请求 fail-closed |
| 同 UID 本机攻击者 | 本机其他进程 | 不承诺防护 | 明确非目标（与设计 §5 一致） |

### 1.3 数据模型与接口草案

角色枚举（宿主派生，不由客户端输入）：

| 角色 | 缺省对应 | 语义 |
| --- | --- | --- |
| `host` | desktop | 宿主本机；沿用既有 PermissionRuleset（现有无 scope 规则按 host 解释） |
| `interactive` | 无缺省；须宿主显式授予 | 可信交互设备；可在设备上回答 ask，但凭据/裸命令仍 deny |
| `read_mostly` | web / mobileRemote / mobileApp / 远端未知或缺失 | 只读为主；写操作必须宿主确认；裸 Bash、凭据工具、出站信道工具 deny |

设计原文写「PermissionRuleset 增 deviceScope/attachmentRole」。本文把 `attachmentRole` 落为 `PermissionContext` 的**附件上下文**（权威来自宿主连接记录），规则侧只保留 `deviceScope`——角色不能由规则或客户端自报。

规则级设备范围（additive，缺省 = 仅 host）：

```text
deviceScope?: {
  roles?: AttachmentRole[];        // 命中角色才应用该规则
  kinds?: ClientKind[];            // 仅提示层过滤，不作权威
  deviceIds?: string[];            // 宿主登记的设备指纹
  attachmentIds?: string[];        // 精确附件
}
```

匹配与优先级：

1. 先算附件上下文：`attachmentId`、`role`、`deviceKind`、`deviceId`、`workspaceIdentity`。
2. 规则只在其 `deviceScope` 命中当前上下文时参与匹配；**无 `deviceScope` 的既有规则只对 `host` 生效**。这条是防“桌面 allow 规则被手机继承”的关键，迁移期必须成立。
3. 同层命中内 `deny > ask > allow`；跨层沿用既有权限管线（alwaysAsk 不可被 hook 抹除）。
4. 本地宿主进程（CLI/TUI/Desktop 进程内会话，无远端 attachment）按 `host` 处理，保持现状字节兼容；远端连接但 attachmentId/role 缺失或无法解析时按 `read_mostly` 处理并告警，且不得命中任何无 scope 规则。二者由宿主侧的连接来源判定，不能只看字段是否存在。

`PermissionContext` 增：

```text
attachment?: {
  attachmentId: string;
  role: "host" | "interactive" | "read_mostly";
  deviceKind?: "desktop" | "web" | "mobileRemote" | "mobileApp";
  deviceId?: string;               // 宿主登记的稳定设备身份；缺失不等于 host
}
```

协议面草案：**不新增“客户端自报角色”的帧**；角色是宿主连接事实。命令/输入信封可 additive-optional 携带 `attachmentId` 供宿主侧复核（不携带 role，避免客户端伪造）；如需在 UI 展示，v4 snapshot 增 additive-optional `attachmentId` / `attachmentRole` 投影，只读、不含设备凭据。

工具类矩阵（缺省值，可按 workspace 收紧，不能放宽到 host 等价）：

| 工具类 | host | interactive | read_mostly |
| --- | --- | --- | --- |
| 纯读（Read/Glob/Grep/TodoRead） | 按既有规则 | allow（限 workspace） | allow（限 workspace） |
| 工作区写（Write/Edit） | 按既有规则 | ask（设备本地可答） | **ask（必须宿主确认）** |
| 命令执行（Bash / 子进程） | 按既有规则 | **deny**（除非显式设备规则） | **deny** |
| 出站网络（WebFetch/WebSearch） | 按既有规则 | deny（缺省） | deny |
| 信道/消息（SendMessage/ReplyToChannel/Workflow 族） | 按既有规则 | deny（除 thread 内 reply policy） | deny |
| 凭据/CUA/插件/MCP（含 `mcp__*`） | 按既有规则 | **deny** | **deny** |
| 权限管理（permission update / always-allow） | 按既有规则 | **deny**，且不得为 read_mostly 持久化 allow | **deny** |
| goal/scheduler/后台 run 控制 | 按既有规则 | deny | deny |

“写操作降确认”的含义是**降级为需要确认，不是自动放行**：read_mostly 的写请求必须回到宿主侧确认面（desktop host UI / host 终端），不得由远端设备自答，也不得被持久化 allow 规则吸收。

### 1.4 吊销与生命周期

- 吊销入口：附件断开、用户显式撤销、设备凭据失效、host 侧判定失窃。权威动作顺序 = 先标记附件 `revoked` 并关闭连接，再吊销该附件的全部能力票据，最后拒绝该附件的待批 permission ask。
- 每次 admission / 每次票据兑换复核 attachment 状态，不只在连接建立时复核。排队输入的提升边界也要复核（与 mandate facts 在提升边界重新解析同一纪律）。
- 在途长命令（已执行的 Bash/子进程）不承诺回溯撤销；需要立即止损时走既有取消/杀进程路径。文档与 UI 不得宣称“吊销即杀正在跑的一切”。
- 角色变更（host 授予/收回 interactive）走显式操作并审计；不允许客户端自升级。

### 1.5 验收用例

| # | 用例 | 判据 |
| --- | --- | --- |
| D1 | 手机 attachment 连入后请求 Bash / 凭据工具 | deny，拒绝原因可审计；桌面同会话不受影响 |
| D2 | web attachment 请求 Write/Edit | ask 且确认只投递到宿主确认面；设备侧自答无效 |
| D3 | 伪造 `clientKind=desktop` | 仍按宿主记录的 read_mostly 处理 + 告警计数 |
| D4 | 远端连接缺失 clientKind / 未知角色 | 按 read_mostly；无 scope 的 allow 规则不命中；本地宿主会话不受影响 |
| D5 | 吊销后立即再次请求工具 / 兑换票据 | 下一次 admission 前 deny；待批 ask 直接失败 |
| D6 | 旧协议帧重放（含旧 attachmentId） | 拒绝；不得因 commandId 幂等而绕过附件复核 |
| D7 | 跨 workspace 请求 | fail-closed |
| D8 | flag 关 / 无附件上下文（本机 CLI） | 与现状 bit-exact（additive-optional 语义） |
| D9 | 真机双端矩阵（macOS 宿主 + iOS/Android/web） | 上述矩阵逐格一致；吊销延迟有实测记录 |

### 1.6 接缝与分阶段

- P6-D1 协议/类型：`transport.ts` 保留 clientKind 仅为提示；`permission.port.ts` 增类型化 `deviceScope`；`PermissionContext` 增 `attachment`；v4 连接登记处绑定 attachmentId。
- P6-D2 enforcement：`core/src/permission/service.ts` 的同一前端门插入设备判定；`permission-flow.ts` 的 hook-modified-input recheck 复用同一结论；无 scope 规则仅 host 生效。
- P6-D3 确认面：宿主确认路由（desktop permission broker / host 终端），read_mostly 的 ask 不得回流设备自答；权限持久化路径拒绝来自非 host 的 always-allow。
- P6-D4 吊销：附件 registry 发吊销事件 → 票据 broker + permission broker + 待批 ask 联动。
- P6-D5 真机 E2E：`packages/desktop/test/e2e/` 与远端 attachment 套件扩展。

依赖：D3/D4 需要 §2 票据 broker 的吊销面；D1/D2 可独立先行（即使没有票据，也能 deny 工具）。

**2026-11-05 落地状态（如实登记，不夸大）**：D1/D2 已接线——Host 把 registry 派生的附件事实写入可信 v4 连接元数据（`ZCodeAgentV4ConnectionContext.attachment`），hello 带只读投影，CLI prompt admission 绑定事实，`PermissionService` 在既有管线结论之后只收紧地叠加矩阵；unknown/缺失角色 fail-closed，吊销（role 缺失）直接 deny。仍缺：D3 宿主确认面路由（read_mostly 写操作的 ask 仍走既有 permission broker）、D4 票据联动、D5 真机矩阵；**已知 fail-open 缺口**：CLI 内部 auto-drain 提升与 goal/scheduler 续跑 turn 不携带可信连接附件事实（这些不是客户端命令 admission），上线前必须把附件绑定随队列项保存并在提升边界复核，或对非 host 来源 fail-closed 禁止这类自动 turn。远端 zcode-server 直连（无 Desktop registry）由可信 `clientMode=web-remote-replayable` 兜底为 read_mostly；`desktop-continuous` 且无附件记录时仍按 host 现状。

## 2. 能力票据（capability tickets）

### 2.1 威胁模型

| 威胁 | 攻击面 | 影响 | 对策 |
| --- | --- | --- | --- |
| 协议帧/日志泄漏票据 | 帧、日志、rollout | 攻击者异地重放 | 帧只见公开 ticketId；密钥只走 broker/执行端内存；日志零字节 |
| 模型上下文被注入索取凭据 | prompt injection | 模型吐出 token | 模型永远拿不到凭据；票据 ID 单独不可用 |
| 跨设备/跨 workspace 重放 | 票据无绑定 | 越权执行 | 绑定 workspaceIdentity + attachmentId + subject(run/trigger/session) + scope |
| 过期票据继续使用 | 长 TTL | 扩大窗口 | 短 TTL + 每次兑换校验；过期即 deny |
| 吊销不传播 | 多进程/多宿主 | 失窃设备继续跑 | 吊销 epoch + broker 权威；broker 不可达即 deny |
| broker 重启后旧票据复活 | 内存权威丢失 | 旧权限延续 | 重启使所有未完成票据失效（fail-closed），需重新签发 |
| 票据被用于不同工具 | scope 过宽 | 权限扩散 | scope 限定工具族/资源；兑换时校验动作面 |

### 2.2 与既有“票据”的边界

- off-peak ticket：服务端配额与限流，不含设备/附件绑定，也没有可吊销语义；不得复用其 ID 或请求头通道。
- `ModelRequestAdmissionTicket`：模型请求并发槽位，生命周期是“一次尝试”；不得作为设备执行授权。
- 能力票据是**设备/附件 → 执行面**的授权句柄，唯一用途是换取一次受限执行所需的凭据注入或特权动作。

### 2.3 票据模型

```text
ticketId       公开、不可猜测（随机 128-bit 以上）；协议帧/执行层可见，模型上下文可见性待 §5 开放问题 6 裁决
ticketSecret   仅 broker 与目标执行端持有；永不进协议帧、日志、SQLite、模型上下文
binding        workspaceIdentity + attachmentId + deviceId? + subject(runId|triggerId|sessionId)
scope          允许的工具族/资源集（如 "credential:<provider>" / "tool:Bash" / "none"）
issuedAt / expiresAt
revokeEpoch    broker 侧的单调 epoch；吊销即 +1
state          issued | active | consumed | expired | revoked
```

规则：

1. **签发**：只由 edge broker（daemon/受管边缘进程）在宿主侧完成。输入 = 设备/附件凭据 + subject + scope；凭据在 broker 内解密，绝不回传。
2. **兑换**：执行端携带 `ticketId + ticketSecret + 请求 nonce + 当前 binding` 向 broker 兑换。broker 原子校验 binding/epoch/expiry/scope；单次工具用票据兑换后置 `consumed`，run 级票据校验 seq 单调，防重放。
3. **注入**：broker 只把凭据注入到**本次子进程/本次调用**的受限面（env 或既有 CUA broker 通道），不写回全局 env、不写文件、不写日志。执行结束即失效。
4. **吊销**：`revokeTicket(ticketId)` / `revokeByAttachment(attachmentId)` / `revokeByDevice(deviceId)`；epoch +1；待兑换请求立即 deny。
5. **TTL 草案**（需标定，不写成承诺值）：工具级缺省 ≤5 分钟；run 级缺省 ≤15 分钟、硬上限 60 分钟。短于一次模型回合的常规时长，宁可重签。
6. **权威与持久化**：broker 内存是权威；`~/.zcode/v2/super-agent.sqlite` 增 `capability_tickets` 表只存 `ticket_id / workspace_identity / attachment_id / subject / scope / issued_at / expires_at / state / revoke_epoch / revoked_at`，**不存 secret**。broker 重启后表中未终态行一律标记失效并告警。
7. **协议面**：命令/输入信封增 additive-optional `capabilityTicketId`；票据密钥永不出现。v4 snapshot 可投影 `capabilityTicketId` 的可用状态（不投影 scope 细节也可）。

接口草案（一个意图一个方法）：

| 方法 | 调用方 | 语义 |
| --- | --- | --- |
| `issue(binding, scope, ttl)` | 宿主/edge broker | 返回 `{ticketId, ticketSecret, expiresAt}`；secret 只返回一次 |
| `redeem(ticketId, ticketSecret, binding, action, nonce, seq?)` | 执行适配器 | 成功返回一次性注入句柄；失败给 typed reason |
| `revoke(ticketId)` | 宿主/用户 | 立即使其不可兑换 |
| `revokeByAttachment(attachmentId)` / `revokeByDevice(deviceId)` | 附件生命周期 | 批量吊销 |
| `sweepExpired(now)` | broker 定时 | 清理终态行并审计 |
| `status(ticketId)` | 审计/UI | 只读状态，不含 secret |

失败码（全部 deny，不降级）：`ticket.unknown` / `ticket.expired` / `ticket.revoked` / `ticket.binding_mismatch` / `ticket.replayed` / `ticket.scope_denied` / `ticket.broker_unavailable`。

### 2.4 验收用例

| # | 用例 | 判据 |
| --- | --- | --- |
| C1 | 正常签发→兑换→执行 | 凭据只出现在子进程受限面；调用结束失效 |
| C2 | 换 attachmentId/workspace/subject 兑换 | binding_mismatch deny |
| C3 | 过期票据 | expired deny |
| C4 | 吊销后兑换 | revoked deny；待兑请求同步失败 |
| C5 | 重放同一单次票据 | replayed deny；seq 票据乱序/倒退 deny |
| C6 | 协议帧/日志/DB/模型上下文扫描 | 零 secret 字节；只有 ticketId |
| C7 | broker 重启 | 未终态票据全部失效；重新签发才可执行 |
| C8 | broker 不可达 | broker_unavailable deny；无本地缓存兜底 |
| C9 | 跨设备失窃模拟 | revokeByDevice 后所有票据与待批 ask 失效 |
| C10 | flag 关 | 既有路径零行为变化 |

### 2.5 接缝与分阶段

- 票据表迁移进 `apps/zcode-cli/packages/bootstrap/src/super-agent/storage/migrations.ts`；broker 固定落**受管 headless 控制面子进程（bootstrap 组合根）或独立 edge 进程**。daemon 本体只做入站接收、scheduler claim、租约心跳与子进程监管，不承载签发凭据的 broker（trigger spec §7-7 裁决；里程碑 B 规格 §1.2 同边界）。
- 执行注入复用既有通道：env 白名单构造（`packages/shared/src/runtimeEnv.ts:212` `sanitizeZCodeRuntimeEnv`）、`apps/zcode-cli/packages/adapters/src/exec/execution-command.ts:47-53`、CUA broker 模式；spec run 的零凭据 env 仍优先（`buildSpecRunEnv`）。
- 协议扩字段：`packages/shared/src/zcode-protocol-v4/` command/input-intent；snapshot additive。
- 与 §1 联动：read_mostly 不得申请凭据类票据；interactive 只能申请宿主预批 scope。
- 分阶段：C1 表+broker 签发/兑换（无凭据注入先打通）→ C2 注入接线（CUA/执行适配器）→ C3 吊销传播 → C4 设备维度批量吊销。

**2026-11-05 落地状态（如实登记，不夸大）**：宿主内存 broker + attachment MessagePort 受控通道已实现；`ZCODE_P6_CAPABILITY_TICKETS=1` 时 `desktop-continuous` 的 remote attachment 签发/投递/兑换/吊销生效。**执行侧 admission 已接线**：带 `capabilityTicketId` 的命令在宿主入口经 broker 校验（存在性/绑定/TTL/吊销/角色 scope），通过后把公开授权域（scope + binding + expiry + 票据自身 epoch，**无 secret**）随可信 carrier 下发给 CLI；CLI prompt admission 绑定该域，工具准入在既有权限管线与附件矩阵之后按 scope 只收紧（过期/越界 deny）。无 ticketId 保持字节兼容；带票据命令强制真正起轮（忙时拒绝，不落队列，避免授权域脱离 turn）；edit/retry 的 idle 判定在 branch cut **之前**执行，忙时拒绝不截断历史，rewind 后的恢复分支也不再降级到会丢票据的 queue 路径。仍未接线：凭据注入（C2）——broker 在 Desktop main、执行在 CLI 进程且无控制面通道，结构不可达；scope 命中 credential 类工具时返回 typed `ticket.credential_injection_unimplemented` 并拒绝，不伪造注入。SQLite `capability_tickets` 持久表、edge/headless 独立 broker 进程亦未实现。因此开启该 flag 是 **execution gated by capabilityTicketId（C2 credential injection unimplemented）**；宿主启动会输出一条明确告警，运维不得按“凭据注入已生效”宣传。平台覆盖：web/mobile 的 `web-remote-replayable` relay 只转发 `Uint8Array` RPC 帧，secret 控制帧不可达，登记为 **secret delivery 未实现**——该形态不签发、不投递，并记录 typed `transport-unimplemented`。epoch 校验按票据自身快照判定，避免同一 broker 下其他 attachment 的吊销误伤未受影响的票据。**已知残留（本批如实登记）**：①吊销只在下一条命令 admission 生效——CLI 进程与 Desktop broker 无控制面通道，turn 运行中无法复核新 epoch，已绑定的授权域按 `expiresAt` TTL 收敛（在途长命令走既有取消/杀进程路径），不宣称“吊销即中止运行中 turn”；②客户端命令信封尚未接线——renderer 没有调用 `capabilityTickets.protocolFields()`，生产 UI 命令不携带 `capabilityTicketId`，因此该 flag 只对携带票据的命令 gate（当前没有生产客户端携带），宿主启动告警逐条列出这两条限制。

## 3. OS 级 egress 围栏

### 3.1 现状与残留（必须先读清的边界）

- 结构隔离（硬）：`apps/zcode-cli/packages/core/src/subagent/tool-policy.ts` 的 `buildSpecRestrictedProfile()`；出站工具/信道句柄/编排工具/`mcp__*` 全剔除。这是工具面事实。
- 协作式 egress（env 级）：`apps/zcode-cli/packages/bootstrap/src/super-agent/spec-lane/egress-proxy.ts` + `apps/zcode-cli/packages/adapters/src/network/subprocess-env.ts` 的 `buildSpecRunEnv()`；`applyNetworkEgressEnv` 注入代理变量，缺省零 egress（allowlist 空）。
- 已知残留（spec-lane §0/§5/§8-6，测试 `apps/zcode-cli/packages/bootstrap/tests/super-agent-spec-lane.test.ts` 明确断言其成功）：`curl --noproxy '*'`、`env -u HTTP_PROXY`、不读代理 env 的客户端（undici `fetch` 类）可直连非白名单 host。**env 代理不是安全边界**；对外文案禁用“物理隔绝出站”。
- `resolveAllowHosts` 生产未接（`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:1106-1108` 原文注释），当前缺省 = 零 egress，且没有任何方式配置非零白名单。因此 P6 之前 spec lane 只能跑零 egress 场景。

### 3.2 威胁模型

| 威胁 | 说明 | 本项对策 |
| --- | --- | --- |
| Bash 内 `curl --noproxy` / `env -u` 绕过 env 代理 | 复现任务必须保留 Bash，Bash 是唯一可执行出站的工具面 | 内核/OS 层默认拒绝，只有围栏内 broker 可达 |
| 恶意依赖/构建脚本直连 | npm/pip postinstall、编译脚本 | 子进程整体进围栏，不按客户端行为分层 |
| DNS 外泄 | 直接查外部 resolver | 围栏内 DNS 只指向 broker stub 或被拒绝；broker 负责解析并套 allowlist |
| 直连 IP/任意端口 | 跳过代理 | 内核按目标地址/端口拒绝 |
| 围栏启动失败后静默回退 | 端口占用、权限不足 | 拒绝启动 spec run，不回落协作式代理 |
| allowlisted host 被滥用 | 白名单过宽 | 白名单按 host:port 精确、per-repo 配置、默认空 |

非目标：同 UID 本机 root 攻击者、内核被攻破、物理侧信道；也不承诺阻断所有数据外泄（允许的 mirror host 仍可承载数据）。

### 3.3 平台选型对比

判据：per-run 隔离强度、是否需要 root/管理员、是否按进程/进程组生效、对构建兼容性、部署复杂度、是否可 fail-closed 判定。

| 平台 | 候选 | 强度 | 代价/限制 | 结论 |
| --- | --- | --- | --- | --- |
| Linux | **network namespace + veth + nftables 默认拒绝** | 高（内核级、按 namespace） | 需 CAP_NET_ADMIN；rootless 依赖 user namespace（`unshare -Urn`）是否可用需实测；要管 DNS | **首选** |
| Linux | seccomp / Landlock | 无网络覆盖面（Landlock 主盯文件系统） | 不能阻断网络 | 否决为围栏主方案 |
| Linux | 纯 iptables/nftables 按 uid 规则 | 中 | 全局防火墙变更，按 uid 不按 run，多个 run 互相影响 | 仅作组织级补充 |
| macOS | **`sandbox-exec` profile：deny network-outbound，仅放行 broker loopback** | 中高（按进程） | 系统已标记 deprecated，profile 语法需 spike 验证；Apple 未来可能移除 | **试点首选，需 spike 门禁** |
| macOS | pf anchor + 专用 uid | 中 | 需 root、改全局防火墙；按 uid 分组而非按 run | 组织托管替代，不作缺省 |
| macOS | Network Extension（内容过滤） | 高 | 需 entitlement + 系统扩展用户批准，CLI 形态不可行 | 否决 |
| macOS | `socketfilterfw` 按程序规则 | 中低 | 全局、需 root、粒度粗 | 不作主方案 |
| Windows | **WFP（Windows Filtering Platform）按 run/进程过滤** | 高 | 需管理员/常驻服务；实现与调试成本高 | **首选（有托管服务时）** |
| Windows | AppContainer 去掉 `internetClient` 能力 | 中高 | 默认阻断 loopback，需要 `CheckNetIsolation LoopbackExempt`（管理员）；Win32 构建兼容需实测 | 无 WFP 时的备选，必须验证 loopback broker 可达 |
| Windows | 防火墙按程序规则 | 中 | 需管理员、全局、粒度粗 | 组织策略补充 |

选择规则：**每平台只允许一个“主围栏实现”**；不可用即该平台关闭 spec lane（`fence-unavailable`），不得自动改用 env 代理。平台矩阵与 win32/WSL/Docker 的既有可达性门禁（trigger spec §4-A8）分开评估：daemon 可达不等于围栏可用。

### 3.4 围栏架构

```text
edge daemon / fence supervisor
  ├─ per-run fence: netns|sandbox|WFP session
  │    └─ spec child (restricted profile, zero-cred env)
  │         └─ 唯一可达外部: broker loopback (HTTP proxy / CONNECT)
  └─ broker (fence 外): allowlist + DNS 解析 + 审计
```

- 子进程内的 proxy env 仍指向 broker（保留协作层，纵深防御），但**硬约束来自内核/围栏**：绕过 env 的客户端撞墙。
- DNS：围栏内只允许向 broker 的 DNS stub 查询；broker 解析后按 allowlist 决定是否转发；外部 resolver 地址被围栏拒绝。
- 生命周期：`prepareFence(workspaceRoot, allowHosts)` → `startBroker` → `spawnChild` → 运行 → `teardown`。任一步失败 → 抛 typed `FenceStartupError` → spec run 拒绝启动；`decision_log` 的 accept 行已提交时，必须由 onError/审计明确标记“accept 已记录但 run 未启动”，不能伪装成执行成功。
- 清理：run 终态、崩溃、daemon 重启都回收 fence/broker；启动时对残留 namespace/session 做对账（可观测、可清理），不静默遗留。
- 平台门禁：`FenceCapability` 探测（权限、内核特性、已存在的残留）在签发 run 前完成；探测不确定 = 拒绝。

接口草案（本地 OS 面，不新增线上协议）：

| 方法/类型 | 调用方 | 语义与失败 |
| --- | --- | --- |
| `probeFenceCapability()` | dispatcher / 启动期 | 返回本平台可用方案与所需权限；不确定 = 不可用 |
| `prepareFence({runId, workspaceRoot, allowHosts})` | spec-lane dispatcher | 建 namespace/profile/WFP 会话并启动 broker；失败抛 `FenceStartupError`，run 不启动 |
| `spawnFenced(plan, childSpec)` | fence supervisor | 在围栏内起子进程；子进程只继承 broker loopback 地址与受限 env |
| `teardownFence(handle)` | 终态/崩溃对账 | 幂等；关闭 broker、回收 namespace/session；失败原样上浮并计数 |
| `status(runId)` | 运维/审计 | 返回 fence 方案、broker 端口、残留状态；不含凭据 |
| 错误码 | — | `fence.permission_denied` / `fence.unsupported_platform` / `fence.startup_failed` / `fence.residual_conflict`；全部拒绝启动，无回退 |

### 3.5 验收用例

| # | 用例 | 判据 |
| --- | --- | --- |
| E1 | 围栏内 `curl --noproxy '*'` 访问非白名单 host | 必须失败（与现有 env 代理测试的“预期成功”相反；这是围栏开启后的新断言） |
| E2 | 围栏内 node `fetch`（undici）访问非白名单 | 必须失败 |
| E3 | 围栏内裸 socket 直连任意 IP:port | 必须失败 |
| E4 | 围栏内查询外部 DNS resolver | 必须失败；域名解析只能经 broker |
| E5 | 访问 allowlist mirror（npm/pip） | 成功，且只经 broker |
| E6 | 围栏建立失败（权限不足/端口占用/特性缺失） | spec run 拒绝启动；无直连回落；onError 可见 |
| E7 | 围栏进程 kill -9 | 残留 fence/session 被启动对账清理；无孤儿 broker |
| E8 | 三平台真机矩阵 | macOS/Linux/Windows 各自方案逐条通过；不可用平台明确显示“spec lane disabled” |
| E9 | 现有 env 代理绕过测试 | 在围栏关闭时保持“已知残留成功”断言；在围栏开启时切换为 E1-E4 的拒绝断言，不得混用 |

### 3.6 接缝与分阶段

- P6-E1 Linux netns + nftables + broker DNS（首个可用平台；先跑通 E1-E5）。
- P6-E2 macOS `sandbox-exec` spike：先验证 profile 能否按进程拒绝出站且只放行 loopback broker；验证不过则该平台关闭 spec lane，不用 pf 静默替代。
- P6-E3 Windows WFP（或 AppContainer + LoopbackExempt 备选）真机验证。
- P6-E4 围栏与 spec-lane dispatcher 接线：`createSpecRunDispatcher` 的 prepare/launch/stop 增加 fence prepare/teardown；失败上浮。
- 配置：建议新 flag `features.specEgressFence`（缺省 false = 现状协作式代理；true = 必须硬围栏，建立失败即拒绝）。不得把 flag=false 说成“安全模式”；对外文案按两档如实描述。
- 依赖：P6 围栏不依赖票据，但高敏感事件建议同时启用票据与设备矩阵。

**2026-11-05 落地状态（如实登记，不夸大）**：E4 组合根接线已落地——`features.specEgressFence`（缺省 false，开启要求 `eventRouter=true`）经 `create-app` 注入围栏并交给 spec-run dispatcher；darwin 路径为 sandbox-exec profile，真跑验证放行端口可达、非放行端口被拒。**Linux 登记为 unimplemented（fail-closed）**：netns/veth/nftables 命令脚手架虽已存在，但建网需要 init user namespace 的 CAP_SYS_ADMIN/CAP_NET_ADMIN（通常等于 root），被围栏子进程与父进程同 UID/同 capabilities，可 `nft flush ruleset` 解除规则或 `nsenter -t 1 -n` 进入宿主 netns 出网，E1/E3 语义不成立；探测只验证建网权限、不验证 relay 可达与逃逸，因此平台矩阵将其标为 `unimplemented`，`probeCapability` 在 Linux 上恒返回 typed `fence.unsupported_platform`，启用围栏即拒绝启动，不再宣称内核级 egress 围栏。后续需先实现子进程降权隔离（专用无 CAP 用户或 user namespace + drop capabilities）并增加逃逸负向探测，才可重新评估启用。win32 保持 typed `unsupported`。

## 4. 落地顺序与依赖

按 [super-agent-grayscale-report.md](./super-agent-grayscale-report.md) §7 的建议：

1. **能力票据**（先）：flag-on 试点一旦触及非 record-only 档，就需要可吊销执行授权；票据与 mandate 行同事务/同审计链。前置：里程碑 A 宿主准入收口、试点无严重事故。
2. **OS 围栏**（次）：现有协作式代理不是安全边界；只有试点需要非零 egress 或处理不可信事件时才值得投入。前置：`specEgress.allowHosts` 配置落地（当前未接）、平台真机方案验证。
3. **设备矩阵**（后）：仅在里程碑 B（远端 daemon/跨设备宿主）进入范围时启动；依赖票据模型定稿。单机桌面场景可缓。

不建议三项并行；每项独立提交、独立灰度，避免把安全机制与业务灰度混在一张开关表里。

## 5. 开放问题

1. 票据 TTL/run 上限的标定值；单次工具票据与 run 级票据的取舍。
2. 吊销 epoch 的传播面：broker RPC 还是带签名的 epoch 校验；broker 不可达时是否允许短窗口缓存（本文定为不允许）。
3. macOS `sandbox-exec` 的 profile 语法与未来可用性；若被移除，是否以 pf 组织托管替代，还是关闭平台 spec lane。
4. Windows WFP 的部署形态（daemon 服务 / 安装器特权组件）与 AppContainer 的构建兼容性。
5. 角色授予的产品面：谁能在宿主上把设备升为 `interactive`，是否需要二次确认与审计。
6. 票据 ID 是否应让模型可见；若模型不需要，是否从模型上下文彻底剔除，只在协议/执行层传递。
7. 围栏 allowlist 的 per-repo 配置键最终形态（`specEgress.allowHosts` vs 复用 network 段），以及是否按端口细分。
8. 设备矩阵与 mandate 的排序：设备 deny 与 mandate deny 谁先判定；本文建议同一前端门内先设备后 mandate，结果都 fail-closed。
