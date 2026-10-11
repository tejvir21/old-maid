import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000, include: ["tests/**/*.test.{ts,tsx}"], setupFiles: ["./tests/setup.ts"], environment: "node" },
});
