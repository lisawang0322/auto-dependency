import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["skills/release-reader/tests/**/*.test.ts", "skills/release-analyzer/tests/**/*.test.ts", "skills/release-status/tests/**/*.test.ts", "skills/release-starter/tests/**/*.test.ts", "server/**/*.test.ts", "scripts/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
