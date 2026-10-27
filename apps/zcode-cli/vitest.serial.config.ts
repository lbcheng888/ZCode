import { defineConfig } from "vitest/config";

export default defineConfig({
  // 与 vitest.config.ts 相同:作为根 project 被引用时,相对 include 必须以本目录为基准。
  root: import.meta.dirname,
  test: {
    name: "zcode-cli-serial",
    // 故障矩阵用例真实启动 provider 服务、缩放时钟与子进程，并对成功请求数做精确断言；harness 与
    // lifecycle 单独成串行 project 放最后一组，限制同机压力。串行不是计数漂移的修复手段（harness 在
    // 本组唯一文件时仍复现过 9 vs 8）：漂移只在高负载下出现，诊断证据指向格子把 adapter 的流空闲
    // 超时压到 300ms——调度延迟被当成 stream_idle_timeout 后 adapter 重发一次；其余格已改回生产
    // 缺省，非 hang 格的零 stall 由 assertCommonInvariants 断言（helpers/fault-provider-model.ts）。
    // retry / stop 不在此收集：它们留在 zcode-cli project，包级 test / test:fault-matrix 才能收集到。
    // include 与 vitest.config.ts 的 exclude 必须成对维护。
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
