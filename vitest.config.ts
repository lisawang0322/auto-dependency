import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["skills/throughline-reader/tests/**/*.test.ts", "skills/throughline-analyzer/tests/**/*.test.ts", "skills/throughline-status/tests/**/*.test.ts", "skills/throughline-starter/tests/**/*.test.ts", "server/**/*.test.ts", "scripts/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
