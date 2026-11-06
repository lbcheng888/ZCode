import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cheng-contract",
    include: ["tests/**/*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
