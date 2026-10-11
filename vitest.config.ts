import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The test files share one database, so they run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
