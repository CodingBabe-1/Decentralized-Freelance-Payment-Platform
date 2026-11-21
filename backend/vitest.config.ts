import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests import modules that read `config` (which validates env vars at
// import time), so provide safe defaults for the test run. No network or DB is
// touched by the tests.
export default defineConfig({
  resolve: {
    alias: {
      "@stellar/stellar-sdk": path.resolve(__dirname, "node_modules/@stellar/stellar-sdk"),
    },
  },
  test: {
    include: [
      "src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../tests/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../packages/sdk/src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    hookTimeout: 30000,
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/__tests__/**"],
    },
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test",
      JWT_SECRET: "test_secret_that_is_at_least_32_chars_long!",
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    },
  },
});
