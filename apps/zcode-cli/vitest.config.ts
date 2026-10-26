import { defineConfig } from "vitest/config";

export default defineConfig({
  // Bugfix: 本配置会被仓库根 vitest.config.ts 以 project 形式引用;被引用时相对 include/exclude
  // 不再以 cwd 解析,必须显式锚定本目录,否则 apps/zcode-cli 的测试无法被发现。
  // 单独在本目录运行时 root 与 cwd 一致,行为不变。
  root: import.meta.dirname,
  test: {
    name: "zcode-cli",
    // Bugfix: 本配置以 project 路径挂载时,根 vitest.config.ts 的 test 配置不参与合并(Vitest 只注入
    // CLI 覆盖项),未显式设置会回落到 5s/10s。CLI 单测同样会启动真实子进程与定时器,低配/高负载
    // 机器上默认时限易被提前打穿;与根配置及 packages/zcode-server-cli/vitest.config.ts 一致放宽到
    // 30s,保留原断言与时限口径。
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // Bugfix: 外部 zcode-cli 历史里同时存在 test/ 和 tests/ 目录；合入 apps 后需要同时保留两种约定，避免新增包测试被根 include 规则过滤掉。
    include: [
      "test/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
    ],
    // Bugfix: cli、tui、plugin-creator 的测试文件由 node:test 驱动(包内 test 脚本用 node/tsx --test 运行),
    // vitest 收集后必然以 "No test suite found in file" 失败;插件包的 test/ 是真实构建、MCP、
    // 无头浏览器级的集成与边界测试,各包已有自己的 turbo test 入口。两类目录都排除在外,
    // 本配置只收集运行时包(adapters/bootstrap/contracts/core/debug/dynamic-workflow*/i18n/telemetry)的 vitest 单测。
    exclude: [
      "packages/cli/tests/**",
      "packages/tui/tests/**",
      "packages/plugin-creator-plugin/test/**",
      "packages/android-emulator-plugin/test/**",
      "packages/browser-use-plugin/test/**",
      "packages/ios-simulator-plugin/test/**",
      "packages/node-repl-host/test/**",
      // Bugfix: 以下测试以 process.cwd() 为基准解析捆绑官方插件的包根/docs/种子
      // (如 browser-manifest 的 resolve(cwd(), "../browser-use-plugin/docs")),只有
      // cwd=所在包目录时才成立。根级/跨目录调用时 cwd 不是包目录,会解析到回退布局而失败;
      // 它们继续由各包自己的 turbo test 入口(cwd=包目录)覆盖,不进本共享配置。
      "packages/bootstrap/tests/bundled-plugins-resilience.test.ts",
      "packages/bootstrap/tests/plugins-protocol.test.ts",
      "packages/bootstrap/tests/plugins.test.ts",
      "packages/bootstrap/tests/skills.test.ts",
      "packages/bootstrap/tests/visualize-skill-gate.test.ts",
      "packages/core/tests/browser-client.test.ts",
      "packages/core/tests/browser-manifest.test.ts",
      // Bugfix: 故障矩阵用例会真实启动 provider 服务、缩放时钟与子进程;批量并发下调度延迟会让
      // 精确请求计数断言多出重试请求(两个文件单独运行均通过)。改由 vitest.serial.config.ts 的
      // 串行 project 执行,这里排除以避免双跑并保留原断言。
      "packages/bootstrap/tests/fault-matrix-harness.test.ts",
      "packages/bootstrap/tests/workflow-fault-matrix.lifecycle.test.ts",
      "**/node_modules/**",
    ],
    // 根单测入口已有 unit(0)/fork-isolated(1)/cua(2) 三个串行分组;CLI 单测放独立的最后一组,
    // 避免与根项目的 worker 池并发争抢 macOS 的进程启动队列(根配置对并发收紧的原因同此)。
    maxWorkers: 4,
    sequence: { groupOrder: 3 },
  },
});
