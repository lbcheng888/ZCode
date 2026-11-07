# super-agent-spec-lane

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

意图：M5 投机执行 spec lane 的出站约束——结构隔离（硬，工具面零出站/信道句柄）+ 协作式 egress 代理（env 级，托管 per-workspace 本地代理，白名单 host 直通、其余拒绝），给 dispatcher 一个「无代理即拒绝启动」的 run 准入接缝。受限 profile（core `buildSpecRestrictedProfile`）与无凭据 env（adapters `buildSpecRunEnv`）与本模块共同构成 spec run 的三层约束（工具面 ∩ env ∩ 代理）。**诚实边界（裁定 B）**：env 级代理是协作式第二层——`curl --noproxy '*'`、`env -u HTTP_PROXY`、不读代理 env 的客户端可绕过，属已知残留（spec §0/§5/§8-6），绕过对抗测试如实钉住；对外文案禁用「物理隔绝出站」。

不变量：

- **fail-closed，无降级**：listen 失败抛 `SpecEgressStartupError`，调用方据此拒绝 run 启动；模块内不存在「代理不可用就直连」的路径。
- **零 egress 缺省**：`allowHosts` 缺省 `[]` ⇒ 一切转发被拒；白名单只能来自调用方显式传入（per-repo 依赖镜像配置）。条目形状损坏（非字符串/空串/畸形 host:port）抛错，不静默丢弃。
- **代理只说 HTTP 代理协议**：absolute-form + CONNECT；只绑 loopback；不开任意 TCP 转发。
- **per-workspace 有且仅有一个实例**：同 workspace 再 prepare = 先停旧再起新（替换，不叠加）；配置校验先于停旧，损坏配置不制造无代理窗口。
- **noProxy 恒为空**：networkPolicy 不提供 NO_PROXY 旁路——spec run 一切主机（含 localhost）都过代理，由 allowlist 统一裁决。

与其它模块的交集（hook 点，全部经组合根/dispatcher，本模块不主动接线）：

- **dispatcher（mandate/spec-trigger lane，M4/M2）**：调 `prepareSpecRunEgress` → 拿 plan 接执行适配器（`network`）与 `buildSpecRunEnv`（`processEnv`）；生产 launch 适配器 `createSpecRunSubagentLaunchPort` 把 restricted profile + 无凭据执行端口接到既有 subagent 端口，run 终态调 `stopSpecRunEgress`。S1 起 `input.chengGate` 红在租约/egress/launch 之前抛 `SpecRunGateBlockedError`（静默丢弃、零出站）；`features.specWriteLease=true` 时在 queue/egress 之前 acquire 写租约，第二写者立即 `WriteLeaseConflictError`，run 终态/失败 finally release；launch 同时把 `writeLeaseOwnerRunId=triggerId` 交给 child runtime，写工具 admission 据此放行 spec child 自己的写。未启用租约时 dispatcher 仍按 workspace 串行 prepare→launch→stop（单代理实例不被并发 run 互相关闭）。verdict 门、结果卡交付不在本模块。
- **P6 OS egress 围栏（`fence/`，spec §3）**：可选注入 dispatcher（`deps.fence`，组合根由 `features.specEgressFence=true` 装配）。顺序固定为 egress.prepare → fence.prepare → buildProcessEnv(childBroker) → launch → fence.teardown → egress.stop；围栏准备失败抛 typed `FenceStartupError`，run 拒绝启动，绝不回退协作式代理。围栏包装执行请求时打 `internalFence` 标记，执行适配器据此禁止围栏外 login-shell snapshot / bash prelude，并关闭依赖外层 shell 的 cwd 捕获（避免 rc 绕过与错误 cwd）。平台矩阵机器可读：darwin = sandbox-exec allowlist；linux = rootless per-command `unshare --user --map-root-user --net --fork`（新 netns 只有 loopback、无外部路由），围栏内 Node relay 监听 `127.0.0.1:<relayPort>`，经 fence 临时目录内 0600 的宿主 AF_UNIX socket 转发到宿主 loopback egress broker，`childBroker` 指向该 relay（dispatcher 据此重写代理 env/network）；无需 root/veth/nftables，userns 被禁用或缺少 unshare/ip 时 probe 返回 typed unavailable；win32 = unimplemented。启动时对残留围栏临时目录对账回收（同 runId 存活 = `fence.residual_conflict`；旧版 owner.json 的 `linuxNetwork`/`ipPath` 仍按前缀//30 地址/受信默认值强校验，伪造即 typed 拒绝且不执行任何外部命令；新设计没有持久 netns/veth，死 owner 只删目录）。**已知残留（明确非目标）**：AF_UNIX 是文件系统对象、不受 netns 约束，子进程与宿主同 uid，仍可访问该用户可访问的宿主 unix socket（docker.sock/ssh-agent 等）；同 uid 本机攻击者不在威胁模型，本围栏只约束 IP 网络，不宣称「唯一可达外部 = broker」。
- **adapters `buildSpecRunEnv`**：同源消费 plan.proxyUrl；凭据真空与代理 env 注入在那侧（spec §3）。
- **core `buildSpecRestrictedProfile`**：工具面剔除出站/信道工具（spec §2）；与本模块正交，组合根同时装配两者。
- **contracts config（config lane）**：repo 配置 `specEgress.allowHosts` 由 create-app 启动期调 `resolveSpecEgressAllowHosts` 校验（裸 IPv6/端口越界/空串即拒绝启动），再把同一数组交给 dispatcher `resolveAllowHosts`；本模块只收 `allowHosts` 参数并在 prepare 时归一化。
