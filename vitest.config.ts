import { defineConfig } from "vitest/config";

const COVERAGE_THRESHOLD_PERCENT = 90;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The executable entry only wires process signals to cli.main, which is tested directly.
      exclude: ["src/bin.ts"],
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        lines: COVERAGE_THRESHOLD_PERCENT,
        branches: COVERAGE_THRESHOLD_PERCENT,
      },
    },
  },
});
