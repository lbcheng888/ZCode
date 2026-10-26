import { defineConfig } from "vitest/config";

export default defineConfig({
  // 与 vitest.config.ts 相同:作为根 project 被引用时,相对 include 必须以本目录为基准。
  root: import.meta.dirname,
  test: {
    name: "zcode-cli-serial",
    // Bugfix: 故障矩阵用例会真实启动 provider 服务、缩放时钟与子进程;批量并发下调度延迟会让
    // 精确请求计数断言多出重试请求(两个文件单独运行均通过)。单独成串行 project 放最后一组,
    // 保留真实装配、原时限与精确计数断言。这两个文件已从 vitest.config.ts 的 include 中排除,
    // 避免双跑。
    include: [
      "packages/bootstrap/tests/fault-matrix-harness.test.ts",
      "packages/bootstrap/tests/workflow-fault-matrix.lifecycle.test.ts",
    ],
    // fileParallelism:false 会把 maxWorkers 压到 1;用例自身有 30s 格子时限,这里显式对齐,
    // 避免 hook/默认 5s 在低配机器上先截断。
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    sequence: { groupOrder: 4 },
  },
});
