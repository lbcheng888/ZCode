# cli-swarm

独立 CLI 的 `--swarm` 灰度旗到 runtime 配置的窄转换。存在意图：让会话级显式开关进入
runtimeConfig，同时不给用户配置文件新增同名键（避免普通配置意外开启蜂群执行）。

不变量：

- 未传旗返回空对象，不写 `swarm` 字段；缺席即由 Host/协议按 fail-closed 处理。
- 作用域与 `--goal-layer` 一致：仅 `--prompt` / `--target` / tui 接受；其它入口报
  `SWARM_SCOPE_ERROR`。
- 不读取 config 文件、不做环境变量回落。
