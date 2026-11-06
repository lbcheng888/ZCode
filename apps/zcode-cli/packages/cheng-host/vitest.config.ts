import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cheng-host",
    include: ["tests/**/*.test.ts"],
    hookTimeout: 120_000,
    testTimeout: 300_000,
    fileParallelism: false,
  },
});
